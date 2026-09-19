import { useEffect, useMemo, useState } from "react";
import "./App.css";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";

const Icons = {
  Search: () => <span className="icon">⌕</span>,
  Refresh: ({ spin = false }) => (
    <span className={spin ? "icon spin" : "icon"}>↻</span>
  ),
  Trash: () => <span className="icon">×</span>,
  External: () => <span className="icon">↗</span>,
  Chevron: () => <span className="icon">→</span>,
  Check: () => <span className="icon">✓</span>,
  Alert: () => <span className="icon">!</span>,
};

function formatPrice(value) {
  return value == null ? "—" : `₹${Number(value).toLocaleString("en-IN")}`;
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString([], {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatusBadge({ status }) {
  const label =
    status === "in_stock"
      ? "In stock"
      : status === "out_of_stock"
        ? "Out of stock"
        : status || "Pending";

  return <span className={`stock-badge ${status || "pending"}`}>{label}</span>;
}

function PriceChart({ history }) {
  if (!history?.length) {
    return <div className="empty-chart">No price history yet.</div>;
  }

  const width = 760;
  const height = 220;
  const pad = 34;
  const values = history.map((item) => Number(item.price));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const points = history.map((item, index) => {
    const x =
      history.length === 1
        ? width / 2
        : pad + (index / (history.length - 1)) * (width - pad * 2);
    const y =
      height - pad - ((Number(item.price) - min) / range) * (height - pad * 2);
    return { x, y, item };
  });

  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");

  return (
    <div className="price-chart">
      <div className="chart-summary">
        <div>
          <span>Lowest</span>
          <strong>{formatPrice(min)}</strong>
        </div>
        <div>
          <span>Highest</span>
          <strong>{formatPrice(max)}</strong>
        </div>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg">
        <line
          x1={pad}
          y1={pad}
          x2={width - pad}
          y2={pad}
          className="grid-line"
        />
        <line
          x1={pad}
          y1={height / 2}
          x2={width - pad}
          y2={height / 2}
          className="grid-line"
        />
        <line
          x1={pad}
          y1={height - pad}
          x2={width - pad}
          y2={height - pad}
          className="grid-line"
        />
        <path d={path} className="chart-line" fill="none" />
        {points.map((point, index) => (
          <g key={`${point.item.id}-${index}`}>
            <circle cx={point.x} cy={point.y} r="5" className="chart-point" />
            <title>
              {formatPrice(point.item.price)} ·{" "}
              {formatDate(point.item.scraped_at)}
            </title>
          </g>
        ))}
      </svg>
    </div>
  );
}

function cleanLogMessage(message, status) {
  if (!message) return "No additional information.";

  const text = String(message);

  if (
    text.includes("locator.click: Timeout") ||
    text.includes("waiting for getByRole") ||
    text.includes("waiting for element to be visible")
  ) {
    return status === "retried"
      ? "Retrying: Reveal Price button could not be clicked within 10 seconds."
      : "Failed: Reveal Price button could not be clicked within 10 seconds.";
  }

  if (text.length > 220) {
    return `${text.slice(0, 220).trim()}…`;
  }

  return text;
}

export default function App() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [tracked, setTracked] = useState([]);
  const [stats, setStats] = useState(null);

  const [searching, setSearching] = useState(false);
  const [loadingTracked, setLoadingTracked] = useState(false);
  const [scrapingAll, setScrapingAll] = useState(false);
  const [scrapingId, setScrapingId] = useState(null);
  const [trackingUrl, setTrackingUrl] = useState(null);

  const [backendStatus, setBackendStatus] = useState("checking");
  const [message, setMessage] = useState(null);

  const [selected, setSelected] = useState(null);
  const [history, setHistory] = useState([]);
  const [logs, setLogs] = useState([]);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailTab, setDetailTab] = useState("history");
  const [logFilter, setLogFilter] = useState("all");

  const [layoutStatus, setLayoutStatus] = useState(null);

  const showMessage = (type, text) => {
    setMessage({ type, text });
    window.setTimeout(() => setMessage(null), 4000);
  };

  async function checkHealth() {
    try {
      const response = await fetch(`${API_URL}/api/health`);
      setBackendStatus(response.ok ? "connected" : "offline");
    } catch {
      setBackendStatus("offline");
    }
  }

  async function loadTracked() {
    setLoadingTracked(true);
    try {
      const response = await fetch(`${API_URL}/api/products/tracked`);
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Could not load tracked products.");
      setTracked(Array.isArray(data) ? data : []);
    } catch (error) {
      showMessage("error", error.message);
    } finally {
      setLoadingTracked(false);
    }
  }

  async function loadStats() {
    try {
      const response = await fetch(`${API_URL}/api/scraping/stats`);
      if (response.ok) setStats(await response.json());
    } catch {
      // Stats are secondary to the main dashboard.
    }
  }

  async function loadLayout() {
    try {
      const response = await fetch(`${API_URL}/api/products/layout-status`);
      if (response.ok) setLayoutStatus(await response.json());
    } catch {
      // Bonus endpoint; don't block the dashboard.
    }
  }

  useEffect(() => {
    checkHealth();
    loadTracked();
    loadStats();
    loadLayout();

    const interval = window.setInterval(() => {
      checkHealth();
      loadStats();
      loadTracked();
    }, 45000);

    return () => window.clearInterval(interval);
  }, []);

  async function searchProducts(event) {
    event?.preventDefault();

    const value = query.trim();
    if (!value) {
      setResults([]);
      return;
    }

    setSearching(true);
    try {
      const response = await fetch(
        `${API_URL}/api/products/search?q=${encodeURIComponent(value)}`,
      );
      const data = await response.json();

      if (!response.ok) throw new Error(data.error || "Search failed.");
      setResults(data.results || []);

      if (!data.results?.length) {
        showMessage("info", `No products found for "${value}".`);
      }
    } catch (error) {
      showMessage("error", error.message);
    } finally {
      setSearching(false);
    }
  }

  async function trackProduct(product) {
    setTrackingUrl(product.productUrl);

    try {
      const response = await fetch(`${API_URL}/api/products/track`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productName: product.productName,
          productUrl: product.productUrl,
          productSku: product.productSku,
        }),
      });

      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Could not track product.");

      showMessage("success", `${product.productName} is now being tracked.`);
      await loadTracked();
      await loadStats();
    } catch (error) {
      showMessage("error", error.message);
    } finally {
      setTrackingUrl(null);
    }
  }

  async function scrapeProduct(id) {
    setScrapingId(id);

    try {
      const response = await fetch(`${API_URL}/api/products/${id}/scrape`, {
        method: "POST",
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Scrape failed.");

      if (data.result?.success) {
        showMessage(
          "success",
          `Updated to ${formatPrice(data.result.price)} · ${data.result.stockStatus}`,
        );
      } else {
        showMessage("error", data.result?.error || "Scrape failed.");
      }

      await loadTracked();
      await loadStats();

      if (selected?.id === id) {
        await openDetails({ ...selected });
      }
    } catch (error) {
      showMessage("error", error.message);
    } finally {
      setScrapingId(null);
    }
  }

  async function scrapeAll() {
    setScrapingAll(true);

    try {
      const response = await fetch(`${API_URL}/api/scraping/all`, {
        method: "POST",
      });
      const data = await response.json();

      if (!response.ok) throw new Error(data.error || "Batch scrape failed.");

      showMessage(
        "success",
        `Batch finished: ${data.successful ?? 0} successful, ${data.failed ?? 0} failed.`,
      );

      await loadTracked();
      await loadStats();
    } catch (error) {
      showMessage("error", error.message);
    } finally {
      setScrapingAll(false);
    }
  }

  async function untrackProduct(product) {
    const confirmed = window.confirm(
      `Stop tracking "${product.product_name}"?`,
    );
    if (!confirmed) return;

    try {
      const response = await fetch(`${API_URL}/api/products/${product.id}`, {
        method: "DELETE",
      });
      const data = await response.json();

      if (!response.ok)
        throw new Error(data.error || "Could not untrack product.");

      if (selected?.id === product.id) setSelected(null);
      showMessage("info", `${product.product_name} was removed from tracking.`);
      await loadTracked();
      await loadStats();
    } catch (error) {
      showMessage("error", error.message);
    }
  }

  async function openDetails(product) {
    setSelected(product);
    setDetailsLoading(true);
    setDetailTab("history");
    setLogFilter("all");

    try {
      const [historyResponse, logsResponse] = await Promise.all([
        fetch(`${API_URL}/api/products/${product.id}/history`),
        fetch(`${API_URL}/api/products/${product.id}/logs`),
      ]);

      const historyData = await historyResponse.json();
      const logsData = await logsResponse.json();

      if (!historyResponse.ok)
        throw new Error(historyData.error || "Could not load history.");
      if (!logsResponse.ok)
        throw new Error(logsData.error || "Could not load scrape logs.");

      setHistory(Array.isArray(historyData) ? historyData : []);
      setLogs(Array.isArray(logsData) ? logsData : []);
    } catch (error) {
      showMessage("error", error.message);
      setHistory([]);
      setLogs([]);
    } finally {
      setDetailsLoading(false);
    }
  }

  const filteredLogs = useMemo(() => {
    if (logFilter === "all") return logs;
    return logs.filter((log) => log.status === logFilter);
  }, [logs, logFilter]);

  const trackedUrls = useMemo(
    () => new Set(tracked.map((product) => product.product_url)),
    [tracked],
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">PP</div>
          <div>
            <h1>Product Price Tracker</h1>
          </div>
        </div>

        <div className="top-actions">
          <span className={`connection ${backendStatus}`}>
            <span />
            {backendStatus === "connected"
              ? "API connected"
              : backendStatus === "offline"
                ? "API offline"
                : "Checking API"}
          </span>

          <button
            className="button primary"
            onClick={scrapeAll}
            disabled={scrapingAll || tracked.length === 0}
          >
            <Icons.Refresh spin={scrapingAll} />
            {scrapingAll ? "Running..." : "Run scrape"}
          </button>
        </div>
      </header>

      <main className="content">
        <section className="summary">
          <div>
            <span className="eyebrow">Overview</span>
            <h2>Monitoring dashboard</h2>
          </div>

          <div className="summary-stats">
            <div>
              <strong>{tracked.length}</strong>
              <span>Tracked products</span>
            </div>
            <div>
              <strong>{stats?.successRatePct ?? 100}%</strong>
              <span>Recent success rate</span>
            </div>
            <div>
              <strong>{stats?.recentScrapesSampled ?? 0}</strong>
              <span>Recent scrape records</span>
            </div>
          </div>
        </section>

        <section className="panel search-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Catalog</span>
              <h2>Find a product</h2>
            </div>
            <span className="muted">1,000 products available</span>
          </div>

          <form className="search-form" onSubmit={searchProducts}>
            <div className="input-wrap">
              <Icons.Search />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by product name"
              />
            </div>
            <button
              className="button primary"
              type="submit"
              disabled={searching}
            >
              <Icons.Search />
              {searching ? "Searching..." : "Search"}
            </button>
          </form>

          {results.length > 0 && (
            <div className="results">
              {results.map((product) => {
                const isTracked = trackedUrls.has(product.productUrl);
                const isTracking = trackingUrl === product.productUrl;

                return (
                  <article className="result" key={product.productId}>
                    <div className="result-main">
                      <div className="result-meta">
                        <span>{product.category || "Product"}</span>
                        <code>{product.productSku || "No SKU"}</code>
                      </div>
                      <h3>{product.productName}</h3>
                      {product.brand && <p>{product.brand}</p>}
                    </div>

                    <div className="result-actions">
                      <a
                        href={product.productUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Store page <Icons.External />
                      </a>
                      <button
                        className={`button small ${isTracked ? "secondary" : "primary"}`}
                        onClick={() => trackProduct(product)}
                        disabled={isTracked || isTracking}
                      >
                        {isTracking
                          ? "Adding..."
                          : isTracked
                            ? "Tracking"
                            : "Track"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {!searching && query && results.length === 0 && (
            <div className="empty-state compact">
              No matching products. Try a shorter product name or SKU.
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Tracked products</h2>
            </div>
            <button
              className="button secondary small"
              onClick={loadTracked}
              disabled={loadingTracked}
            >
              <Icons.Refresh spin={loadingTracked} />
              Refresh
            </button>
          </div>

          {loadingTracked && tracked.length === 0 ? (
            <div className="empty-state">Loading tracked products...</div>
          ) : tracked.length === 0 ? (
            <div className="empty-state">
              <strong>No products are being tracked.</strong>
              <span>
                Search the catalog above and add a product to start collecting
                price history.
              </span>
            </div>
          ) : (
            <div className="tracked-grid">
              {tracked.map((product) => {
                const trend = product.price_change_pct;
                const scraping = scrapingId === product.id;

                return (
                  <article
                    className="product-card"
                    key={product.id}
                    onClick={() => openDetails(product)}
                  >
                    <div className="product-card-top">
                      <div>
                        <code>{product.product_sku || "SKU unavailable"}</code>
                        <h3>{product.product_name}</h3>
                      </div>
                      <StatusBadge status={product.stock_status} />
                    </div>

                    <div className="price-row">
                      <div>
                        <span className="label">Current price</span>
                        <strong>{formatPrice(product.current_price)}</strong>
                      </div>

                      {trend !== null && trend !== undefined && (
                        <span
                          className={`trend ${trend < 0 ? "down" : trend > 0 ? "up" : "flat"}`}
                        >
                          {trend > 0 ? "+" : ""}
                          {trend}%
                        </span>
                      )}
                    </div>

                    <div className="product-meta">
                      <div>
                        <span>Last check</span>
                        <strong>{formatDate(product.last_scraped_at)}</strong>
                      </div>
                      <div>
                        <span>Scrapes</span>
                        <strong>{product.total_scrapes ?? 0}</strong>
                      </div>
                      <div>
                        <span>Success</span>
                        <strong>{product.success_rate_pct ?? 100}%</strong>
                      </div>
                    </div>

                    <div
                      className="card-actions"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        className="button secondary small"
                        onClick={() => scrapeProduct(product.id)}
                        disabled={scraping}
                      >
                        <Icons.Refresh spin={scraping} />
                        {scraping ? "Scraping..." : "Scrape now"}
                      </button>
                      <button
                        className="button link small"
                        onClick={() => openDetails(product)}
                      >
                        History & logs <Icons.Chevron />
                      </button>
                      <button
                        className="icon-button danger"
                        title="Stop tracking"
                        onClick={() => untrackProduct(product)}
                      >
                        <Icons.Trash />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="system-row"></section>
      </main>

      {selected && (
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <section
            className="modal"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="modal-header">
              <div>
                <code>{selected.product_sku || "SKU unavailable"}</code>
                <h2>{selected.product_name}</h2>
                <a href={selected.product_url} target="_blank" rel="noreferrer">
                  Open storefront page <Icons.External />
                </a>
              </div>

              <div className="modal-actions">
                <button
                  className="button primary small"
                  onClick={() => scrapeProduct(selected.id)}
                  disabled={scrapingId === selected.id}
                >
                  <Icons.Refresh spin={scrapingId === selected.id} />
                  {scrapingId === selected.id ? "Scraping..." : "Scrape again"}
                </button>
                <button
                  className="close-button"
                  onClick={() => setSelected(null)}
                >
                  ×
                </button>
              </div>
            </header>

            <div className="modal-content">
              {detailsLoading ? (
                <div className="empty-state">
                  Loading history and scrape logs...
                </div>
              ) : (
                <>
                  <PriceChart history={history} />

                  <div className="tabs">
                    <button
                      className={detailTab === "history" ? "active" : ""}
                      onClick={() => setDetailTab("history")}
                    >
                      Price & stock history ({history.length})
                    </button>
                    <button
                      className={detailTab === "logs" ? "active" : ""}
                      onClick={() => setDetailTab("logs")}
                    >
                      Scrape logs ({logs.length})
                    </button>
                  </div>

                  {detailTab === "history" ? (
                    history.length ? (
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Time</th>
                              <th>Price</th>
                              <th>Stock</th>
                              <th>Units left</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[...history].reverse().map((item) => (
                              <tr key={item.id}>
                                <td>{formatDate(item.scraped_at)}</td>
                                <td className="table-price">
                                  {formatPrice(item.price)}
                                </td>
                                <td>
                                  <StatusBadge status={item.stock_status} />
                                </td>
                                <td>{item.stock_quantity ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="empty-state">
                        No price history recorded yet.
                      </div>
                    )
                  ) : (
                    <>
                      <div className="filter-row">
                        {["all", "success", "retried", "failed"].map(
                          (filter) => (
                            <button
                              key={filter}
                              className={logFilter === filter ? "active" : ""}
                              onClick={() => setLogFilter(filter)}
                            >
                              {filter}
                            </button>
                          ),
                        )}
                      </div>

                      {filteredLogs.length ? (
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>Time</th>
                                <th>Attempt</th>
                                <th>Status</th>
                                <th>Message</th>
                              </tr>
                            </thead>
                            <tbody>
                              {filteredLogs.map((log) => (
                                <tr key={log.id}>
                                  <td>{formatDate(log.started_at)}</td>
                                  <td>#{log.attempt_number}</td>
                                  <td>
                                    <span
                                      className={`log-status ${log.status}`}
                                    >
                                      {log.status}
                                    </span>
                                  </td>
                                  <td className="log-message">
                                    {cleanLogMessage(log.message, log.status)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="empty-state">
                          No logs for this filter.
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </section>
        </div>
      )}

      {message && (
        <div className={`message ${message.type}`}>
          <span>
            {message.type === "success"
              ? "✓"
              : message.type === "error"
                ? "!"
                : "i"}
          </span>
          {message.text}
        </div>
      )}

      <footer></footer>
    </div>
  );
}
