const express = require("express");
const supabase = require("../db/supabase");
const { scrapeProduct } = require("../scraper/productScraper");

const router = express.Router();

const MAX_ATTEMPTS = Number(process.env.SCRAPE_MAX_ATTEMPTS || 3);
const CRON_SECRET = process.env.CRON_SECRET || "";

// Track last cron run in memory
let lastCronRun = null;

/**
 * Execute full scraping cycle across all active tracked products.
 * Handles retries, logs attempts honestly, and commits verified prices to price_history.
 */
async function executeBatchScraping(options = {}) {
    const runStartedAt = new Date();
    const logger = options.logger || console.log;

    logger(`[Batch Scraper] Initiating scheduled run at ${runStartedAt.toISOString()} (Max attempts: ${MAX_ATTEMPTS})`);

    const { data: products, error: productsError } = await supabase
        .from("tracked_products")
        .select("*")
        .eq("is_active", true)
        .order("created_at", { ascending: true });

    if (productsError) {
        throw productsError;
    }

    if (!products || products.length === 0) {
        logger("[Batch Scraper] No active products to scrape.");
        return {
            status: "empty",
            message: "No active tracked products found",
            startedAt: runStartedAt.toISOString(),
            completedAt: new Date().toISOString(),
            totalProducts: 0,
            successful: 0,
            failed: 0,
            results: []
        };
    }

    const results = [];

    for (const product of products) {
        let successful = false;
        let lastError = null;
        let successfulResult = null;
        let productAttempts = 0;

        logger(`\n[Batch Scraper] --------------------------------------------------`);
        logger(`[Batch Scraper] Product: ${product.product_name} (${product.product_sku || "No SKU"})`);
        logger(`[Batch Scraper] URL:     ${product.product_url}`);

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            productAttempts = attempt;
            const attemptStartedAt = new Date();
            logger(`[Batch Scraper] Attempt ${attempt}/${MAX_ATTEMPTS}...`);

            try {
                const scrapeResult = await scrapeProduct(product.product_url, {
                    headless: true,
                    logger: (msg) => logger(`  ${msg}`)
                });

                const attemptFinishedAt = new Date();

                if (scrapeResult.success) {
                    // Write to price_history ONLY on verified successful scrape
                    const { error: historyErr } = await supabase
                        .from("price_history")
                        .insert({
                            tracked_product_id: product.id,
                            price: scrapeResult.price,
                            stock_status: scrapeResult.stockStatus,
                            stock_quantity: scrapeResult.stockQuantity,
                            scraped_at: attemptFinishedAt.toISOString()
                        });

                    if (historyErr) {
                        logger(`  [Database Error] Could not save price history: ${historyErr.message}`);
                    }

                    // Log the successful scrape attempt
                    const logMsg = `Price: ₹${scrapeResult.price.toLocaleString("en-IN")}; Stock: ${scrapeResult.stockStatus}${scrapeResult.stockQuantity !== null ? ` (${scrapeResult.stockQuantity} left)` : ""}${scrapeResult.storeAttempts ? `; Store attempts: ${scrapeResult.storeAttempts}` : ""}`;

                    await supabase.from("scrape_logs").insert({
                        tracked_product_id: product.id,
                        attempt_number: attempt,
                        status: "success",
                        message: logMsg,
                        started_at: attemptStartedAt.toISOString(),
                        finished_at: attemptFinishedAt.toISOString()
                    });

                    successful = true;
                    successfulResult = scrapeResult;
                    logger(`[Batch Scraper] SUCCESS: ₹${scrapeResult.price} (${scrapeResult.stockStatus})`);
                    break;
                }

                // Scrape failed on this attempt
                lastError = scrapeResult.error || "Price or stock could not be extracted";
                const hasNextAttempt = attempt < MAX_ATTEMPTS;
                const status = hasNextAttempt ? "retried" : "failed";

                logger(`  [Attempt ${attempt} Failed]: ${lastError} (Recorded as: ${status})`);

                await supabase.from("scrape_logs").insert({
                    tracked_product_id: product.id,
                    attempt_number: attempt,
                    status,
                    message: lastError,
                    started_at: attemptStartedAt.toISOString(),
                    finished_at: attemptFinishedAt.toISOString()
                });

                if (hasNextAttempt) {
                    // Exponential backoff between retries (1.5s, 3s...)
                    const backoffMs = attempt * 1500;
                    logger(`  Waiting ${backoffMs}ms before retrying...`);
                    await new Promise(r => setTimeout(r, backoffMs));
                }

            } catch (err) {
                lastError = err.message;
                const hasNextAttempt = attempt < MAX_ATTEMPTS;
                const status = hasNextAttempt ? "retried" : "failed";

                logger(`  [Attempt ${attempt} Error]: ${err.message}`);

                await supabase.from("scrape_logs").insert({
                    tracked_product_id: product.id,
                    attempt_number: attempt,
                    status,
                    message: `Exception: ${err.message}`,
                    started_at: attemptStartedAt.toISOString(),
                    finished_at: new Date().toISOString()
                });

                if (hasNextAttempt) {
                    await new Promise(r => setTimeout(r, attempt * 1500));
                }
            }
        }

        results.push({
            productId: product.id,
            productName: product.product_name,
            productSku: product.product_sku,
            status: successful ? "success" : "failed",
            attempts: productAttempts,
            price: successfulResult?.price || null,
            stockStatus: successfulResult?.stockStatus || null,
            stockQuantity: successfulResult?.stockQuantity ?? null,
            error: successful ? null : lastError
        });
    }

    const runCompletedAt = new Date();
    lastCronRun = {
        startedAt: runStartedAt.toISOString(),
        completedAt: runCompletedAt.toISOString(),
        totalProducts: products.length,
        successful: results.filter(r => r.status === "success").length,
        failed: results.filter(r => r.status === "failed").length
    };

    logger(`\n[Batch Scraper] Run Complete. Success: ${lastCronRun.successful}/${lastCronRun.totalProducts}, Failed: ${lastCronRun.failed}`);

    return {
        message: "Batch scrape completed",
        ...lastCronRun,
        results
    };
}

/**
 * 1. MANUAL TRIGGER: SCRAPE ALL ACTIVE PRODUCTS
 */
router.post("/all", async (req, res) => {
    try {
        const summary = await executeBatchScraping();
        return res.json(summary);
    } catch (error) {
        console.error("Scraping batch error:", error);
        return res.status(500).json({
            error: "Scraping batch run failed",
            message: error.message
        });
    }
});

/**
 * 2. EXTERNAL CRON TRIGGER
 * Used by cron-job.org or Vercel Cron every 2 hours.
 * Supports secret authorization via query (?secret=...) or header (x-cron-secret).
 */
const handleCron = async (req, res) => {
    const providedSecret = req.headers["x-cron-secret"] || req.query.secret;

    if (CRON_SECRET && providedSecret !== CRON_SECRET) {
        return res.status(401).json({
            error: "Unauthorized: Invalid or missing cron secret"
        });
    }

    try {
        console.log(`[Cron] Scheduled trigger received from ${req.ip || "external"}`);
        const summary = await executeBatchScraping();
        return res.json({
            cronStatus: "success",
            ...summary
        });
    } catch (error) {
        console.error("[Cron] Scheduled scrape failed:", error);
        return res.status(500).json({
            cronStatus: "error",
            message: error.message
        });
    }
};

router.post("/cron", handleCron);
router.get("/cron", handleCron); // Support both GET and POST for simple pinging from free cron services

/**
 * 3. SCRAPING GLOBAL STATS & HEALTH
 */
router.get("/stats", async (req, res) => {
    try {
        const [productsCountRes, recentLogsRes] = await Promise.all([
            supabase.from("tracked_products").select("id", { count: "exact" }).eq("is_active", true),
            supabase.from("scrape_logs").select("status, started_at").order("started_at", { ascending: false }).limit(200)
        ]);

        const totalTracked = productsCountRes.count || 0;
        const recentLogs = recentLogsRes.data || [];

        const totalScrapes = recentLogs.length;
        const successfulScrapes = recentLogs.filter(l => l.status === "success").length;
        const failedScrapes = recentLogs.filter(l => l.status === "failed").length;
        const retriedScrapes = recentLogs.filter(l => l.status === "retried").length;
        const overallSuccessRate = totalScrapes > 0 ? Math.round((successfulScrapes / totalScrapes) * 100) : 100;

        return res.json({
            totalActiveProducts: totalTracked,
            recentScrapesSampled: totalScrapes,
            successfulScrapes,
            failedScrapes,
            retriedScrapes,
            successRatePct: overallSuccessRate,
            lastCronRun,
            serverTime: new Date().toISOString()
        });

    } catch (error) {
        return res.status(500).json({
            error: "Failed to load scraping stats",
            message: error.message
        });
    }
});

module.exports = router;
module.exports.executeBatchScraping = executeBatchScraping;