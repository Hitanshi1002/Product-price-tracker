const express = require("express");
const supabase = require("../db/supabase");
const { scrapeProduct } = require("../scraper/productScraper");

const router = express.Router();

const MOCK_STORE_URL = (process.env.MOCK_STORE_URL || "https://demo.inelabteamdev.com").replace(/\/$/, "");

// In-memory catalog cache for sub-second search responses
let catalogCache = {
    items: [],
    lastFetchedAt: 0
};
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fetch entire 1,000 product catalog from mock store API via parallel HTTP requests.
 * Uses lightweight HTTP fetching as specifically requested in the assignment guidelines.
 */
async function getCatalog() {
    const now = Date.now();
    if (catalogCache.items.length > 0 && (now - catalogCache.lastFetchedAt) < CACHE_TTL_MS) {
        return catalogCache.items;
    }

    try {
        console.log("[Catalog] Fetching fresh catalog from mock store API...");
        const pageSize = 60;
        // 1000 items total / 60 = ~17 pages
        const pages = Array.from({ length: 17 }, (_, i) => i + 1);

        const responses = await Promise.all(
            pages.map(page =>
                fetch(`${MOCK_STORE_URL}/api/catalog?page=${page}&pageSize=${pageSize}`, {
                    headers: { "Accept": "application/json" }
                })
                .then(res => res.ok ? res.json() : { items: [] })
                .catch(() => ({ items: [] }))
            )
        );

        const allItems = [];
        for (const res of responses) {
            if (res && Array.isArray(res.items)) {
                allItems.push(...res.items);
            }
        }

        if (allItems.length > 0) {
            catalogCache = {
                items: allItems,
                lastFetchedAt: now
            };
            console.log(`[Catalog] Successfully cached ${allItems.length} products.`);
            return allItems;
        }

        return catalogCache.items; // Fallback to existing cache if fetch failed
    } catch (err) {
        console.error("[Catalog] Error fetching catalog:", err.message);
        return catalogCache.items;
    }
}

/**
 * 1. SEARCH PRODUCTS
 * Rapid partial/full name or SKU search over the mock store catalog.
 */
router.get("/search", async (req, res) => {
    const query = (req.query.q || "").trim().toLowerCase();

    try {
        const catalog = await getCatalog();

        let filtered = catalog;
        if (query && query !== "*") {
            filtered = catalog.filter(item => {
                const name = (item.name || "").toLowerCase();
                const sku = (item.sku || "").toLowerCase();
                const brand = (item.brand || "").toLowerCase();
                const category = (item.category || "").toLowerCase();

                return name.includes(query) || sku.includes(query) || brand.includes(query) || category.includes(query);
            });
        }

        // Return up to 30 matching products with full details and URLs
        const results = filtered.slice(0, 30).map(item => ({
            productId: item.id,
            productName: item.name,
            productSku: item.sku,
            brand: item.brand,
            category: item.category,
            description: item.description,
            productUrl: `${MOCK_STORE_URL}/product/${item.id}`
        }));

        return res.json({
            query: req.query.q || "",
            totalFound: filtered.length,
            results
        });

    } catch (error) {
        console.error("Search error:", error);
        return res.status(500).json({
            error: "Failed to search mock store catalog",
            message: error.message
        });
    }
});

/**
 * 2. TRACK PRODUCT
 * Persist product in Supabase and kick off an immediate initial scrape.
 */
router.post("/track", async (req, res) => {
    const { productName, productUrl, productSku } = req.body;

    if (!productName || !productUrl) {
        return res.status(400).json({
            error: "productName and productUrl are required"
        });
    }

    try {
        // Check if already tracked
        const { data: existing, error: findError } = await supabase
            .from("tracked_products")
            .select("*")
            .eq("product_url", productUrl)
            .maybeSingle();

        if (findError) throw findError;

        let trackedRecord = existing;

        if (existing) {
            if (!existing.is_active) {
                // Reactivate
                const { data: reactivated, error: updateErr } = await supabase
                    .from("tracked_products")
                    .update({ is_active: true })
                    .eq("id", existing.id)
                    .select()
                    .single();

                if (updateErr) throw updateErr;
                trackedRecord = reactivated;
            }
        } else {
            const { data, error } = await supabase
                .from("tracked_products")
                .insert({
                    product_name: productName,
                    product_url: productUrl,
                    product_sku: productSku || null,
                    is_active: true
                })
                .select()
                .single();

            if (error) throw error;
            trackedRecord = data;
        }

        // Trigger immediate background scrape so user sees initial data right away
        triggerSingleProductScrape(trackedRecord).catch(err => {
            console.error(`Initial scrape failed for ${trackedRecord.product_name}:`, err.message);
        });

        return res.status(201).json({
            message: existing ? "Product tracking updated" : "Product added to tracking",
            product: trackedRecord,
            initialScrapeStarted: true
        });

    } catch (error) {
        console.error("Track product error:", error);
        return res.status(500).json({
            error: "Unable to track product",
            message: error.message
        });
    }
});

/**
 * 3. GET TRACKED PRODUCTS
 * Returns all active products enriched with current price, previous price, trend, and last scrape time.
 */
router.get("/tracked", async (req, res) => {
    try {
        const { data: products, error } = await supabase
            .from("tracked_products")
            .select("*")
            .eq("is_active", true)
            .order("created_at", { ascending: false });

        if (error) throw error;

        if (!products || products.length === 0) {
            return res.json([]);
        }

        // Fetch latest 2 price history entries and scrape stats for each product
        const enriched = await Promise.all(products.map(async (prod) => {
            const [historyRes, logsRes] = await Promise.all([
                supabase
                    .from("price_history")
                    .select("*")
                    .eq("tracked_product_id", prod.id)
                    .order("scraped_at", { ascending: false })
                    .limit(2),
                supabase
                    .from("scrape_logs")
                    .select("status, started_at")
                    .eq("tracked_product_id", prod.id)
                    .order("started_at", { ascending: false })
            ]);

            const history = historyRes.data || [];
            const logs = logsRes.data || [];

            const latestPrice = history[0] ? Number(history[0].price) : null;
            const previousPrice = history[1] ? Number(history[1].price) : null;
            let priceChangePct = null;
            if (latestPrice && previousPrice && previousPrice > 0) {
                priceChangePct = Number((((latestPrice - previousPrice) / previousPrice) * 100).toFixed(2));
            }

            const successfulLogs = logs.filter(l => l.status === "success").length;
            const totalLogs = logs.length;
            const successRate = totalLogs > 0 ? Math.round((successfulLogs / totalLogs) * 100) : 100;

            return {
                ...prod,
                current_price: latestPrice,
                previous_price: previousPrice,
                price_change_pct: priceChangePct,
                stock_status: history[0]?.stock_status || "unknown",
                stock_quantity: history[0]?.stock_quantity ?? null,
                last_scraped_at: history[0]?.scraped_at || logs[0]?.started_at || null,
                total_scrapes: totalLogs,
                success_rate_pct: successRate
            };
        }));

        return res.json(enriched);

    } catch (error) {
        console.error("Tracked products error:", error);
        return res.status(500).json({
            error: "Unable to fetch tracked products",
            message: error.message
        });
    }
});

/**
 * 4. STORE LAYOUT CHANGE DETECTION (BONUS)
 * Detects whether the mock store layout or CSS classes have shifted.
 * Placed BEFORE /:id to prevent route shadowing.
 */
router.get("/layout-status", async (req, res) => {
    try {
        const layoutRes = await fetch(`${MOCK_STORE_URL}/api/layout`, {
            headers: { "Accept": "application/json" }
        });

        if (!layoutRes.ok) {
            return res.json({
                status: "warning",
                message: `Store returned status ${layoutRes.status}`
            });
        }

        const layout = await layoutRes.json();
        return res.json({
            status: "healthy",
            revision: layout.revision,
            variant: layout.variant,
            validUntil: layout.validUntil ? new Date(layout.validUntil).toISOString() : null,
            classes: layout.classes,
            checkedAt: new Date().toISOString()
        });

    } catch (error) {
        return res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

/**
 * 5. GET SINGLE PRODUCT
 */
router.get("/:id", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("tracked_products")
            .select("*")
            .eq("id", req.params.id)
            .single();

        if (error) throw error;
        return res.json(data);
    } catch (error) {
        return res.status(404).json({ error: "Product not found", message: error.message });
    }
});

/**
 * 5. GET PRICE & STOCK HISTORY
 */
router.get("/:id/history", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("price_history")
            .select("*")
            .eq("tracked_product_id", req.params.id)
            .order("scraped_at", { ascending: true });

        if (error) throw error;
        return res.json(data);

    } catch (error) {
        console.error("Price history error:", error);
        return res.status(500).json({
            error: "Unable to fetch price history",
            message: error.message
        });
    }
});

/**
 * 6. GET HONEST SCRAPE LOGS
 */
router.get("/:id/logs", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("scrape_logs")
            .select("*")
            .eq("tracked_product_id", req.params.id)
            .order("started_at", { ascending: false })
            .limit(100);

        if (error) throw error;
        return res.json(data);

    } catch (error) {
        console.error("Scrape logs error:", error);
        return res.status(500).json({
            error: "Unable to fetch scrape logs",
            message: error.message
        });
    }
});

/**
 * 7. ON-DEMAND SCRAPE FOR A PRODUCT
 */
router.post("/:id/scrape", async (req, res) => {
    try {
        const { data: product, error: findError } = await supabase
            .from("tracked_products")
            .select("*")
            .eq("id", req.params.id)
            .single();

        if (findError || !product) {
            return res.status(404).json({ error: "Product not found" });
        }

        const result = await triggerSingleProductScrape(product);
        return res.json({
            message: result.success ? "Scrape successful" : "Scrape completed with issues",
            result
        });

    } catch (error) {
        console.error("Manual scrape error:", error);
        return res.status(500).json({
            error: "Scrape execution failed",
            message: error.message
        });
    }
});

/**
 * 8. UNTRACK / DELETE PRODUCT
 */
router.delete("/:id", async (req, res) => {
    try {
        const { error } = await supabase
            .from("tracked_products")
            .update({ is_active: false })
            .eq("id", req.params.id);

        if (error) throw error;
        return res.json({ message: "Product untracked successfully" });

    } catch (error) {
        console.error("Untrack product error:", error);
        return res.status(500).json({
            error: "Failed to untrack product",
            message: error.message
        });
    }
});


/**
 * Helper to scrape a single product with full logging and Supabase insertion.
 */
async function triggerSingleProductScrape(product, maxAttempts = 2) {
    let finalResult = null;
    let successful = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const startedAt = new Date();

        try {
            const result = await scrapeProduct(product.product_url);
            finalResult = result;

            if (result.success) {
                const finishedAt = new Date();

                // Record price history
                await supabase.from("price_history").insert({
                    tracked_product_id: product.id,
                    price: result.price,
                    stock_status: result.stockStatus,
                    stock_quantity: result.stockQuantity,
                    scraped_at: finishedAt.toISOString()
                });

                // Record scrape log
                await supabase.from("scrape_logs").insert({
                    tracked_product_id: product.id,
                    attempt_number: attempt,
                    status: "success",
                    message: `Price: ₹${result.price.toLocaleString("en-IN")}; Stock: ${result.stockStatus}${result.stockQuantity !== null ? ` (${result.stockQuantity} left)` : ""}${result.storeAttempts ? `; Store attempts: ${result.storeAttempts}` : ""}`,
                    started_at: startedAt.toISOString(),
                    finished_at: finishedAt.toISOString()
                });

                successful = true;
                break;
            }

            // Scraper failed on this attempt
            const hasNextAttempt = attempt < maxAttempts;
            await supabase.from("scrape_logs").insert({
                tracked_product_id: product.id,
                attempt_number: attempt,
                status: hasNextAttempt ? "retried" : "failed",
                message: result.error || "Store failed to reveal price",
                started_at: startedAt.toISOString(),
                finished_at: new Date().toISOString()
            });

            if (hasNextAttempt) {
                // Exponential backoff
                await new Promise(r => setTimeout(r, 1000 * attempt));
            }

        } catch (err) {
            const hasNextAttempt = attempt < maxAttempts;
            await supabase.from("scrape_logs").insert({
                tracked_product_id: product.id,
                attempt_number: attempt,
                status: hasNextAttempt ? "retried" : "failed",
                message: err.message,
                started_at: startedAt.toISOString(),
                finished_at: new Date().toISOString()
            });

            if (hasNextAttempt) {
                await new Promise(r => setTimeout(r, 1000 * attempt));
            }
        }
    }

    return {
        success: successful,
        ...finalResult
    };
}

module.exports = router;
module.exports.triggerSingleProductScrape = triggerSingleProductScrape;