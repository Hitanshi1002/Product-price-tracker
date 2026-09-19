const { chromium } = require("playwright");

/**
 * Dismiss cookie consent banner if present on the mock storefront.
 */
async function dismissCookiePopup(page) {
    const possibleButtons = [
        "Accept",
        "Accept All",
        "Allow",
        "Allow All",
        "I Agree",
        "Agree"
    ];

    for (const text of possibleButtons) {
        try {
            const button = page.getByRole("button", { name: text, exact: true });
            if (await button.count()) {
                await button.first().click({ timeout: 1500 });
                await page.waitForTimeout(300);
                return true;
            }
        } catch {
            // Popup may not exist. Continue normally.
        }
    }
    return false;
}

/**
 * Extract INR price from text (e.g. ₹11,435 or ₹ 14,570).
 */
function extractPrices(text) {
    const rawMatches = text.match(/₹\s*[\d,]+(?:\.\d{1,2})?/g) || [];
    const parsed = rawMatches.map(str => {
        const num = Number(str.replace(/₹\s*/, "").replace(/,/g, "").trim());
        return Number.isFinite(num) ? num : null;
    }).filter(n => n !== null);

    if (parsed.length === 0) {
        return { currentPrice: null, mrpPrice: null };
    }

    // On the INE mock store, if multiple prices are shown (e.g. MRP ₹14,570 and Sale ₹11,435),
    // the lower/sale price or current selling price is rendered.
    // In the price block: [₹14,570, ₹11,435, 24% off] -> selling price is ₹11,435 or the first non-MRP price.
    let currentPrice = parsed[0];
    let mrpPrice = null;

    if (parsed.length >= 2) {
        // If there's MRP and Sale price, MRP is typically higher
        const maxPrice = Math.max(...parsed);
        const minPrice = Math.min(...parsed);
        if (maxPrice !== minPrice) {
            mrpPrice = maxPrice;
            currentPrice = minPrice;
        }
    }

    return { currentPrice, mrpPrice };
}

/**
 * Extract stock status and quantity from text.
 * Examples: "IN STOCK · 190 LEFT", "ONLY 5 LEFT", "12 IN STOCK", "OUT OF STOCK".
 */
function extractStock(text) {
    const quantityPatterns = [
        /(\d+)\s+left/i,
        /(\d+)\s+in\s+stock/i,
        /in\s+stock\s*[·•-]\s*(\d+)\s+left/i,
        /only\s+(\d+)\s+left/i
    ];

    for (const pat of quantityPatterns) {
        const match = text.match(pat);
        if (match) {
            return {
                status: "in_stock",
                quantity: Number(match[1])
            };
        }
    }

    if (/out\s+of\s+stock/i.test(text)) {
        return {
            status: "out_of_stock",
            quantity: 0
        };
    }

    if (/in\s+stock/i.test(text)) {
        return {
            status: "in_stock",
            quantity: null
        };
    }

    return null;
}

/**
 * Extract store load attempts from message (e.g. "Loaded in 1 attempt" or "after 3 attempts").
 */
function extractStoreAttempts(text) {
    const match = text.match(/(?:loaded in|after)\s+(\d+)\s+attempts?/i);
    return match ? Number(match[1]) : null;
}

/**
 * Extract discount percentage if present (e.g. "24% off").
 */
function extractDiscount(text) {
    const match = text.match(/(\d+)%\s*off/i);
    return match ? Number(match[1]) : null;
}

/**
 * Extract seller name (e.g. "Sold by Cobblestone Supply").
 */
function extractSeller(text) {
    const match = text.match(/Sold by\s+([^|\n·]+)/i);
    return match ? match[1].replace(/[\u200B-\u200D\uFEFF]/g, "").trim() : null;
}

/**
 * Scrape a product from the INE mock storefront with high reliability.
 * Handles mouse movement physics required by the storefront anti-bot Ar tracker,
 * waits for async price reveal, handles retryable failures, and extracts complete details.
 *
 * @param {string} productUrl - Full URL to product page (e.g. https://demo.inelabteamdev.com/product/292)
 * @param {object} options - Options { headless, slowMo, timeout, logger }
 */
async function scrapeProduct(productUrl, options = {}) {
    const startTime = Date.now();
    const headless = options.headless !== undefined
        ? options.headless
        : (process.env.HEADLESS !== "false");
    const slowMo = options.slowMo || 0;
    const logger = options.logger || console.log;

    logger(`[Scraper] Starting scrape for: ${productUrl} (headless: ${headless})`);

    const browser = await chromium.launch({
        headless,
        slowMo,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-accelerated-2d-canvas",
            "--disable-gpu"
        ]
    });

    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    });

    const page = await context.newPage();

    try {
        // Navigate to product URL
        logger(`[Scraper] Navigating to page...`);
        await page.goto(productUrl, {
            waitUntil: "domcontentloaded",
            timeout: 60000
        });

        // Dismiss cookie banner
        await dismissCookiePopup(page);

        // Wait for price block element
        const priceBlock = page.locator(".price-block");
        try {
            await priceBlock.waitFor({ state: "visible", timeout: 25000 });
        } catch {
            // Check if page returned 404 or product not found
            const bodyContent = await page.innerText("body");
            if (/not found|couldn't load this product/i.test(bodyContent)) {
                return {
                    success: false,
                    error: "Product not found on storefront",
                    durationMs: Date.now() - startTime
                };
            }
            throw new Error("Price block container (.price-block) not found within timeout");
        }

        // Satisfy storefront anti-bot requirement:
        // Ar tracker requires: minMoves: 8, minDwellMs: 600
        // Dispatch mousemove physics both via DOM events and Playwright cursor
        logger(`[Scraper] Performing human-like mouse dwell and movements over price block...`);

        const box = await priceBlock.boundingBox();
        if (box) {
            await page.mouse.move(box.x + 20, box.y + 20);
        }

        // Dispatch series of mousemove events in page context
        await page.evaluate(() => {
            const el = document.querySelector(".price-block");
            if (!el) return;
            const rect = el.getBoundingClientRect();
            el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, clientX: rect.left + 30, clientY: rect.top + 20 }));
            for (let i = 0; i < 16; i++) {
                setTimeout(() => {
                    el.dispatchEvent(new MouseEvent("mousemove", {
                        bubbles: true,
                        clientX: rect.left + 30 + i * 8,
                        clientY: rect.top + 20 + (i % 3) * 6
                    }));
                }, i * 50);
            }
        });

        // Also perform small physical mouse movements with Playwright cursor
        if (box) {
            for (let i = 0; i < 8; i++) {
                await page.waitForTimeout(70);
                await page.mouse.move(box.x + 40 + i * 10, box.y + 25 + (i % 2) * 5);
            }
        }

        // Dwell > 600ms for Ar tracker requirement + React 250ms interval check
        await page.waitForTimeout(900);

        // Find Reveal Price button
        const revealButton = page.getByRole("button", { name: /reveal price/i });
        await revealButton.waitFor({ state: "visible", timeout: 15000 });

        // Check if button is disabled; if still disabled, give one more quick hover cycle
        let isDisabled = await revealButton.isDisabled();
        if (isDisabled) {
            logger(`[Scraper] Button still pending hover dwell, waiting additional 600ms...`);
            await page.waitForTimeout(600);
            isDisabled = await revealButton.isDisabled();
        }

        if (isDisabled) {
            logger(`[Scraper] Re-dispatching mouseenter and mousemoves...`);
            await page.evaluate(() => {
                const el = document.querySelector(".price-block");
                if (!el) return;
                const rect = el.getBoundingClientRect();
                for (let i = 0; i < 10; i++) {
                    el.dispatchEvent(new MouseEvent("mousemove", {
                        bubbles: true,
                        clientX: rect.left + 50 + i * 10,
                        clientY: rect.top + 20
                    }));
                }
            });
            await page.waitForTimeout(600);
        }

        logger(`[Scraper] Clicking Reveal Price button...`);
        await revealButton.click({ timeout: 10000 });

        // Wait for price resolution or error
        logger(`[Scraper] Waiting for storefront price reveal resolution...`);
        await page.waitForFunction(() => {
            const el = document.querySelector(".price-block");
            if (!el) return false;
            const text = el.innerText || "";
            return (
                /REFRESH PRICE/i.test(text) ||
                /₹/.test(text) ||
                /TRY AGAIN/i.test(text) ||
                /COULDN'T LOAD THE PRICE/i.test(text) ||
                /UPSTREAM\s+\d+/i.test(text)
            );
        }, null, { timeout: 45000 });

        await page.waitForTimeout(600);

        const priceBlockText = await priceBlock.innerText();
        logger(`[Scraper] Price block raw content:\n${priceBlockText.replace(/\n/g, " | ")}`);

        // Check for mock store simulated upstream failure
        if (/COULDN'T LOAD THE PRICE/i.test(priceBlockText) || /UPSTREAM\s+\d+/i.test(priceBlockText)) {
            const errorMsg =
                priceBlockText.match(/Couldn't load the price[^\n]*/i)?.[0] ||
                priceBlockText.match(/upstream\s+\d+[^\n]*/i)?.[0] ||
                "Storefront upstream failed to reveal price";

            logger(`[Scraper] Storefront error detected: ${errorMsg}`);
            return {
                success: false,
                error: errorMsg,
                storeAttempts: extractStoreAttempts(priceBlockText),
                durationMs: Date.now() - startTime
            };
        }

        // Parse extracted values
        const { currentPrice, mrpPrice } = extractPrices(priceBlockText);
        const stock = extractStock(priceBlockText);
        const discount = extractDiscount(priceBlockText);
        const seller = extractSeller(priceBlockText);
        const storeAttempts = extractStoreAttempts(priceBlockText);

        if (currentPrice === null) {
            return {
                success: false,
                error: "Price element not found after reveal",
                storeAttempts,
                durationMs: Date.now() - startTime
            };
        }

        if (stock === null) {
            return {
                success: false,
                error: "Stock status not found after reveal",
                storeAttempts,
                durationMs: Date.now() - startTime
            };
        }

        // Get Product Title and Brand from page
        let productName = null;
        try {
            const h1 = page.locator("h1").first();
            if (await h1.count()) {
                productName = (await h1.innerText()).trim();
            }
        } catch {
            productName = null;
        }

        logger(`[Scraper] Successfully extracted: Price ₹${currentPrice}, Stock: ${stock.status} (${stock.quantity ?? "unspecified"}), Store attempts: ${storeAttempts}`);

        return {
            success: true,
            productName,
            price: currentPrice,
            mrp: mrpPrice,
            discount,
            stockStatus: stock.status,
            stockQuantity: stock.quantity,
            seller,
            storeAttempts,
            error: null,
            durationMs: Date.now() - startTime
        };

    } catch (err) {
        logger(`[Scraper] Exception during scrape: ${err.message}`);
        return {
            success: false,
            error: err.message,
            durationMs: Date.now() - startTime
        };
    } finally {
        await browser.close();
    }
}

module.exports = {
    scrapeProduct,
    dismissCookiePopup,
    extractPrices,
    extractStock,
    extractStoreAttempts
};