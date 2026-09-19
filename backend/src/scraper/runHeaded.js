require("dotenv").config();
const { scrapeProduct } = require("./productScraper");
const supabase = require("../db/supabase");

async function runHeaded() {
    console.log("  Product Price Tracker ");

    const argUrl = process.argv[2];
    let targetUrls = [];

    if (argUrl && argUrl.startsWith("http")) {
        targetUrls = [{ name: "Target Product (CLI)", url: argUrl }];
    } else {
        // Fetch active tracked products from database
        try {
            const { data: products } = await supabase
                .from("tracked_products")
                .select("*")
                .eq("is_active", true)
                .limit(3);

            if (products && products.length > 0) {
                targetUrls = products.map(p => ({
                    id: p.id,
                    name: p.product_name,
                    url: p.product_url
                }));
            }
        } catch (e) {
            console.log("Note: Could not query tracked products from DB:", e.message);
        }

        // Default demo products if none tracked yet
        if (targetUrls.length === 0) {
            targetUrls = [
                { name: "Basecamp Indoor Camera Max", url: "https://demo.inelabteamdev.com/product/292" },
                { name: "Helix AR Glasses Studio", url: "https://demo.inelabteamdev.com/product/900" }
            ];
        }
    }

    console.log(`Found ${targetUrls.length} product(s) to scrape in headed mode:\n`);
    targetUrls.forEach((t, i) => console.log(`  ${i + 1}. ${t.name} -> ${t.url}`));
    console.log("\nLaunching Chromium in visible (headed) mode with slowMo=350ms...\n");

    for (const item of targetUrls) {
        console.log("---------------------------------------------------------------");
        console.log(`[HEADED RUN] Target: ${item.name}`);
        console.log(`[HEADED RUN] URL:    ${item.url}`);
        console.log("---------------------------------------------------------------");

        const result = await scrapeProduct(item.url, {
            headless: false,
            slowMo: 350,
            logger: (msg) => console.log(`  ${msg}`)
        });

        console.log("\n[HEADED RUN RESULT]");
        console.log(`  Status:         ${result.success ? "SUCCESS" : "FAILED"}`);
        if (result.success) {
            console.log(`  Selling Price:  ₹${result.price.toLocaleString("en-IN")}`);
            if (result.mrp) console.log(`  MRP Price:      ₹${result.mrp.toLocaleString("en-IN")}`);
            if (result.discount) console.log(`  Discount:       ${result.discount}% off`);
            console.log(`  Stock Status:   ${result.stockStatus} (${result.stockQuantity ?? "unspecified"} left)`);
            if (result.seller) console.log(`  Seller:         ${result.seller}`);
            if (result.storeAttempts) console.log(`  Store Attempts: ${result.storeAttempts}`);
        } else {
            console.log(`  Error:          ${result.error}`);
        }
        console.log(`  Duration:       ${(result.durationMs / 1000).toFixed(2)}s\n`);

        // If product has a DB id, update database records
        if (item.id) {
            try {
                if (result.success) {
                    await supabase.from("price_history").insert({
                        tracked_product_id: item.id,
                        price: result.price,
                        stock_status: result.stockStatus,
                        stock_quantity: result.stockQuantity,
                        scraped_at: new Date().toISOString()
                    });
                }

                await supabase.from("scrape_logs").insert({
                    tracked_product_id: item.id,
                    attempt_number: 1,
                    status: result.success ? "success" : "failed",
                    message: result.success
                        ? `Headed Run: Price ₹${result.price}; Stock: ${result.stockStatus} (${result.stockQuantity ?? "N/A"})`
                        : `Headed Run Failed: ${result.error}`,
                    started_at: new Date(Date.now() - result.durationMs).toISOString(),
                    finished_at: new Date().toISOString()
                });
            } catch (dbErr) {
                console.log("  (DB sync error:", dbErr.message, ")");
            }
        }
    }

    console.log("   Observable Headed Run Completed Successfully!               ");
}

if (require.main === module) {
    runHeaded().catch(err => {
        console.error("Headed run encountered fatal error:", err);
        process.exit(1);
    });
}

module.exports = { runHeaded };
