# INE Product Price Tracker

A full-stack product price and stock tracking application built for the INE Software Engineer Intern Assignment.

The application allows users to search products from the INE mock storefront, track selected products, scrape their current price and stock availability, store historical data, and monitor scraping attempts and failures.

---

## Features

### Product Search

- Search products by partial or full product name.
- Search also supports SKU, brand, and category.
- Product catalog is fetched from the mock storefront catalog API.
- Catalog results are cached in memory to provide fast subsequent searches.

### Product Tracking

- Track any product from the search results.
- Tracked products are stored in Supabase PostgreSQL.
- An initial scrape is automatically triggered when a product is tracked.
- Products can be untracked without deleting their historical records.

### Price & Stock Tracking

For every successful scrape, the application stores:

- Current price
- Stock status
- Stock quantity when available
- Scrape timestamp

Historical data can be viewed for each tracked product.

### Retry & Failure Handling

The scraper handles storefront failures through retries.

Each scrape attempt is recorded as:

- `success`
- `retried`
- `failed`

The application does not silently discard failed scraping attempts.

### Scrape Logs

Each tracked product has a scrape log containing:

- Attempt number
- Status
- Error/success message
- Start time
- Completion time

### Scheduled Scraping

The backend exposes a protected cron endpoint for automated scraping.

An external scheduler such as cron-job.org can call the endpoint every two hours.

This approach avoids depending on a continuously running server process, which is important when using free-tier hosting.

---

## Tech Stack

### Frontend

- React.js
- Vite
- JavaScript
- CSS

### Backend

- Node.js
- Express.js

### Database

- Supabase PostgreSQL

### Scraping

- Playwright
- Chromium

### Scheduling

- cron-job.org
- Protected backend cron endpoint

### Deployment

- Vercel — Frontend
- Render — Backend
- Supabase — Database

### Version Control

- Git
- GitHub

---

## Project Structure

```text
Product-price-tracker/
│
├── backend/
│   ├── src/
│   │   ├── db/
│   │   │   └── supabase.js
│   │   │
│   │   ├── routes/
│   │   │   ├── products.js
│   │   │   └── scraping.js
│   │   │
│   │   ├── scraper/
│   │   │   ├── productScraper.js
│   │   │   └── runHeaded.js
│   │   │
│   │   └── server.js
│   │
│   ├── .gitignore
│   ├── package.json
│   └── package-lock.json
│
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── App.css
│   │   ├── index.css
│   │   └── main.jsx
│   │
│   ├── public/
│   ├── package.json
│   └── vite.config.js
│
├── DESIGN_NOTES.md
├── README.md
└── .gitignore
```
