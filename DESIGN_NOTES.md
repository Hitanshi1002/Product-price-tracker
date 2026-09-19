# Architectural Design Notes — INE Product Price Tracker

This document explains the technical rationale, scraping reliability mechanisms, engineering trade-offs, and critical corrections made during the development of the INE Product Price Tracker.

---

## 1. How Scraping Was Made Truly Reliable

The INE mock storefront ([demo.inelabteamdev.com](https://demo.inelabteamdev.com)) is deliberately engineered to defeat naive scrapers. It includes:
- Delayed asynchronous rendering and dynamic React state updates.
- Simulated upstream failures (HTTP 500 / 502 / 504 and rate limits 429).
- An anti-bot movement tracker (`Ar` class in the client bundle) requiring a minimum of 8 cursor move events and 600ms of dwell time before the `Reveal price` button is enabled.
- Obfuscated challenge and authorization token exchange.

### Architectural Solutions:

1. **Human-like Mouse Dwell & Movement Simulation:**
   - Rather than just calling `button.click()`, our scraper waits for `.price-block` to be visible, enters its bounding rect, and dispatches a sequence of 16 cursor movements spaced across ~800ms.
   - It performs both Playwright native mouse coordinates physics and internal DOM mouse events to satisfy `Ar.missing() === null`.
   - It verifies that the button has transitioned out of the `disabled` state before triggering the click.

2. **Async Resolution & State Detection:**
   - After clicking `Reveal price`, the scraper uses `page.waitForFunction` to detect state resolution:
     - **Success:** Price formatted with currency symbols (`₹`), discount badges, or `REFRESH PRICE`.
     - **Simulated Failure:** Upstream errors (`COULDN'T LOAD THE PRICE`, `UPSTREAM \d+`).
   - If the mock store returns an upstream failure or slow response, the scraper handles it gracefully rather than hanging or crashing.

3. **Exponential Backoff & Honest Attempt Logging:**
   - When a scrape attempt encounters a slow response or upstream error, the attempt is logged in `scrape_logs` as `retried` (with the attempt number, timestamp, and store error message).
   - The engine backs off exponentially (`attempt * 1500ms`) before initiating the next retry.
   - If all attempts are exhausted, the attempt is marked as `failed`.
   - **Crucial Rule:** No corrupt, null, or zero price data is ever written to `price_history` upon failure.

---

## 2. Trade-offs Made

### A. Lightweight HTTP Fetching vs. Headless Browser

| Purpose | Chosen Technique | Rationale |
|---|---|---|
| **Catalog Search** | Lightweight HTTP Fetching (`/api/catalog`) | Navigating through 50 paginated DOM pages with a browser takes 5+ minutes and consumes excessive memory. Parallel HTTP requests fetch and cache all 1,000 products in **1.3 seconds**, making search instant (<50ms). |
| **Price & Stock Scraping** | Headless / Headed Browser (Playwright) | Genuinely required because prices are not in the initial HTML or unauthenticated API; they require React execution, mouse physics verification, and async price reveal. |

### B. Free-Tier Backend Scheduling vs. Always-On Loop

- **Constraint:** Free-tier instances on platforms like Render automatically go idle or sleep after 15 minutes of inactivity. An in-process `setInterval` loop dies when the instance sleeps.
- **Solution:** We decoupled the scheduling trigger from the process runtime. We expose a hardened cron endpoint (`/api/scraping/cron` with `x-cron-secret` support) intended to be called every 2 hours by external schedulers like **cron-job.org** or Vercel Cron. A lightweight `/api/health` endpoint serves as a keep-alive monitor.

---

## 3. What AI Tools Got Wrong on the First Attempt and How We Corrected It

During early exploration and prototype generation, AI tools encountered three critical failures:

### 1. The 50-Page DOM Pagination Trap for Search
- **AI Initial Approach:** The initial code attempted to fulfill "Search INE's hosted mock store" by launching Playwright, navigating to the homepage, finding tiles, reading DOM, clicking the "NEXT" button, and iterating through up to 50 pages.
- **Why It Failed:** Each page load and DOM traversal took 3-5 seconds. Searching 50 pages required up to 4 minutes per query, frequently resulting in Playwright navigation timeouts and blocking the Node.js event loop.
- **How We Corrected It:** We inspected network traffic and client bundles, discovering that the storefront is powered by `/api/catalog?page=${p}&pageSize=60`. We replaced the browser pagination loop with a lightweight parallel HTTP fetcher with an in-memory cache. Search latency dropped from **240 seconds to 40 milliseconds**.

### 2. The Disabled "Reveal Price" Button Anti-Bot Tracker
- **AI Initial Approach:** The initial scraper located the button with `page.getByRole("button", { name: /REVEAL PRICE/i })` and called `button.hover()` followed by `button.click()`.
- **Why It Failed:** The click consistently failed or timed out. In-depth decompilation of `index-B9UiQq4X.js` revealed an anti-bot tracker:
  ```javascript
  new Ar({ minMoves: 8, minDwellMs: 600 })
  ```
  The button had `disabled={p !== null}` and only unlocked after receiving 8 distinct mouse movements separated by at least 40ms, with a dwell time greater than 600ms. A simple single `hover()` failed these conditions.
- **How We Corrected It:** We implemented realistic cursor movement physics that dispatches coordinated `mouseenter` and 16+ `mousemove` events over 800ms, waiting for the component's internal 250ms polling cycle to enable the button before clicking.

### 3. Silent Failure and Corrupt History Logging
- **AI Initial Approach:** The initial code used a generic try/catch block that caught errors and either swallowed them or attempted regex extraction on empty error text, resulting in `null` prices or silent terminations.
- **Why It Failed:** The assignment explicitly emphasizes: *"Failures must be recorded honestly, not hidden. Never silently stop or store incorrect data."*
- **How We Corrected It:** We implemented an explicit state machine:
  - Detection of mock store upstream error messages (`UPSTREAM 500`, `Couldn't load the price`).
  - Separation between application-level retries and final failure.
  - Strict database write invariants: `price_history` is only touched on verified success, while `scrape_logs` captures every single attempt truthfully with full error context.
