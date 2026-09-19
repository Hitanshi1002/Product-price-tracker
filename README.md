# INE Product Price Tracker — Intelligent Web Scraping & Monitoring

An end-to-end full-stack web application designed for tracking product prices and stock availability on INE's deliberately awkward mock storefront ([demo.inelabteamdev.com](https://demo.inelabteamdev.com)).

Built with **React (Vite)** on the frontend, **Node.js (Express)** on the backend, **Playwright** for resilient browser automation, and **Supabase (PostgreSQL)** for persistence.

---

## Architecture Overview

```mermaid
graph TD
    Client["React Frontend (Vercel)"]
    API["Express Backend (Render)"]
    MockStore["INE Mock Store (demo.inelabteamdev.com)"]
    Supabase[("Supabase PostgreSQL DB")]
    CronJob["cron-job.org / Scheduled Cron Service"]

    Client -->|Search Catalog (Fast HTTP Cache)| API
    Client -->|View Portfolio, History & Honest Logs| API
    Client -->|Manual 'Scrape Now' Trigger| API
    CronJob -->|Every 2 Hours (x-cron-secret)| API
    API -->|Fetch /api/catalog (Fast HTTP)| MockStore
    API -->|Check /api/layout (Change Detection)| MockStore
    API -->|Playwright Headless/Headed Scraper| MockStore
    API -->|Persist Price History & Scrape Logs| Supabase
```

---

## Core Features & Engineering Highlights

1. **Lightning-Fast Product Discovery (<100ms):**
   - Utilizes lightweight HTTP fetching to cache and index the 1,000-product catalog.
   - Sub-second partial/full name and SKU search with category filtering.

2. **Resilient Browser Automation (The Core Challenge):**
   - Reverse-engineered the mock storefront's anti-bot mouse tracking engine (`Ar` class requiring `minMoves: 8`, `minDwellMs: 600`, and trusted native click physics).
   - Automatically unlocks the `Reveal price` button, handles async state transitions, and extracts verified selling prices, MRP, discounts, stock levels, and store attempts.
   - Recovers from simulated upstream errors and rate limits (429/500) with exponential backoff retries.

3. **Honest Scrape Logging & Data Integrity:**
   - Every scrape attempt is logged in `scrape_logs` with statuses: `success`, `retried`, or `failed`.
   - Never saves empty, zero, or corrupt price data into `price_history` upon failure.

4. **Executive-Grade Dashboard:**
   - Interactive SVG price volatility and trend chart with hover tooltips.
   - Real-time KPI metrics ribbon (tracked items, reliability %, recent scrapes, layout state).
   - Next 2-hour cron countdown timer and manual batch trigger.
   - Full tabular price & stock history and honest scrape log inspection with status filters.

5. **Observable Headed Run Mode:**
   - Includes a dedicated CLI script (`npm run scrape:headed`) that runs the scraper visibly in headed mode with `slowMo: 350ms` for video demonstration.

6. **Bonus Features Implemented:**
   - **Price-drop alerts:** Automatic percentage change calculation and visual badge indicators.
   - **Store layout change detection:** Actively queries `/api/layout` to monitor revision and CSS class shifts.
   - **Configurable / On-demand scraping:** Instant per-product and global batch scrapers.
   - **CI/CD:** Automated GitHub Actions workflow for testing and verification.

---

## Scraping Schedule

- **Frequency:** Every 2 hours (`0 */2 * * *`).
- **External Cron Trigger:** Because free-tier backends (such as Render) automatically idle or sleep, scheduled scrapes are triggered externally via **cron-job.org** or Vercel Cron against:
  ```http
  POST https://<your-render-api>.onrender.com/api/scraping/cron
  Header: x-cron-secret: <YOUR_CRON_SECRET>
  ```
- **Keep-Alive Endpoint:** Regular health pings to `GET /api/health` keep the instance warm.

---

## Environment Variables

### Backend (`backend/.env`)

```env
PORT=5000
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your-supabase-service-role-key>
HEADLESS=true
MOCK_STORE_URL=https://demo.inelabteamdev.com/
SCRAPE_MAX_ATTEMPTS=3
CRON_SECRET=your_optional_secret_token
```

### Frontend (`frontend/.env`)

```env
VITE_API_URL=http://localhost:5000
# In production on Vercel:
# VITE_API_URL=https://<your-backend-on-render>.onrender.com
```

---

## Local Setup & Development

### 1. Clone & Install Backend

```bash
cd backend
npm install
# Install Playwright browser binaries
npx playwright install chromium
```

### 2. Run Backend Server

```bash
# Start backend server on port 5000
npm start

# Or in development mode with auto-reload
npm run dev
```

### 3. Run Observable Headed Scraper (For Video Recording)

To watch the scraper navigate, dismiss cookie banners, hover over the price area to unlock the button, click reveal, and handle async resolution visibly:

```bash
cd backend
npm run scrape:headed
```

Or target a specific product URL:

```bash
npm run scrape:headed -- https://demo.inelabteamdev.com/product/292
```

### 4. Run Frontend

```bash
cd ../frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## Deployment Instructions

### Deploy Backend to Render.com

1. Create a new **Web Service** on Render connected to your GitHub repository.
2. Configure settings:
   - **Root Directory:** `backend`
   - **Build Command:** `npm install && npx playwright install chromium && npx playwright install-deps`
   - **Start Command:** `npm start`
3. Add Environment Variables (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `HEADLESS=true`, `MOCK_STORE_URL=https://demo.inelabteamdev.com/`).

### Deploy Frontend to Vercel

1. Import your GitHub repository on Vercel.
2. Configure settings:
   - **Root Directory:** `frontend`
   - **Framework Preset:** Vite
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
3. Add Environment Variable:
   - `VITE_API_URL`: Your deployed Render backend URL.

### Setup 2-Hour Cron on cron-job.org

1. Register a free account at [cron-job.org](https://cron-job.org).
2. Create a new Cron Job:
   - **URL:** `https://<your-render-url>/api/scraping/cron`
   - **Schedule:** Every 2 hours (`0 */2 * * *`).
   - **HTTP Method:** `POST` (or `GET`).
   - **Request Headers (Optional):** `x-cron-secret: <YOUR_CRON_SECRET>`

---

## Database Schema (Supabase PostgreSQL)

```sql
-- 1. Tracked Products Table
CREATE TABLE tracked_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name TEXT NOT NULL,
  product_url TEXT UNIQUE NOT NULL,
  product_sku TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Price History Table
CREATE TABLE price_history (
  id BIGSERIAL PRIMARY KEY,
  tracked_product_id UUID REFERENCES tracked_products(id) ON DELETE CASCADE,
  price NUMERIC NOT NULL,
  stock_status TEXT NOT NULL,
  stock_quantity INTEGER,
  scraped_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Scrape Logs Table (Honest Logging)
CREATE TABLE scrape_logs (
  id BIGSERIAL PRIMARY KEY,
  tracked_product_id UUID REFERENCES tracked_products(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL, -- 'success', 'retried', 'failed'
  message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
```
