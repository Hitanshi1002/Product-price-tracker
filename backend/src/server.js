const express = require("express");
const cors = require("cors");
require("dotenv").config();

const supabase = require("./db/supabase");
const productRoutes = require("./routes/products");
const scrapingRoutes = require("./routes/scraping");

const app = express();

// Enable CORS for frontend
app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-cron-secret"]
}));

app.use(express.json());

// Request logger
app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
        console.log(`[${req.method}] ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
});

// Root metadata route
app.get("/", (req, res) => {
    res.json({
        name: "INE Product Price Tracker API",
        version: "1.0.0",
        status: "operational",
        endpoints: {
            health: "/api/health",
            searchProducts: "/api/products/search?q=:query",
            trackedProducts: "/api/products/tracked",
            trackProduct: "POST /api/products/track",
            productHistory: "/api/products/:id/history",
            productLogs: "/api/products/:id/logs",
            productScrapeNow: "POST /api/products/:id/scrape",
            storeLayoutStatus: "/api/products/layout-status",
            scrapeAll: "POST /api/scraping/all",
            cronScrape: "POST /api/scraping/cron",
            stats: "/api/scraping/stats"
        }
    });
});

// Render Keep-Alive and Health Check
app.get("/api/health", async (req, res) => {
    const startedAt = Date.now();
    try {
        const { error } = await supabase
            .from("tracked_products")
            .select("id")
            .limit(1);

        if (error) throw error;

        res.json({
            status: "healthy",
            uptimeSeconds: Math.floor(process.uptime()),
            database: "connected",
            dbLatencyMs: Date.now() - startedAt,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error("Database health check failed:", error);
        res.status(500).json({
            status: "degraded",
            database: "disconnected",
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

app.use("/api/products", productRoutes);
app.use("/api/scraping", scrapingRoutes);

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: "Route not found",
        path: req.originalUrl
    });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);
    res.status(500).json({
        error: "Internal Server Error",
        message: err.message
    });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(` INE Price Tracker API Server running on port ${PORT} `);
    console.log(` Health: http://localhost:${PORT}/api/health        `);
    console.log(`===================================================`);
});

module.exports = app;