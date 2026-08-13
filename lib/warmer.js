import { buildDashboardPayload } from "./dashboard";
import { swrCache } from "./cache";
import {
  analyticsCacheKey,
  loadCustomersAnalytics,
  loadProductsAnalytics,
  loadArAnalytics,
  loadDashboardAnalytics,
  loadDashboardFilters,
} from "./analytics";

/**
 * Keeps the default report views warm so the first visitor after a restart
 * doesn't pay for a cold rebuild. Runs from instrumentation.js at boot and
 * then on an interval slightly shorter than the cache TTL.
 */
const WARM_INTERVAL_MS = Number(process.env.ODG_WARM_INTERVAL_MS || 4 * 60_000);

let started = false;

async function warmAnalytics(year) {
  const filters = { year, bu: "ALL", channel: "ALL", province: "ALL" };
  const opts = { ttl: 300_000, staleTtl: 24 * 3_600_000 };
  await Promise.all([
    swrCache(analyticsCacheKey("customers", filters), opts, () => loadCustomersAnalytics(filters)),
    swrCache(analyticsCacheKey("products", filters), opts, () => loadProductsAnalytics(filters)),
    swrCache("analytics:ar", opts, loadArAnalytics),
    // Dashboard sidecar endpoints that the Overview tab also fires.
    swrCache(
      `dashboard-analytics:${year}|ALL|ALL|ALL`,
      opts,
      () => loadDashboardAnalytics(filters),
    ),
    swrCache("dashboard-filters", { ttl: 600_000, staleTtl: 24 * 3_600_000 }, loadDashboardFilters),
  ]);
}

async function warmOnce() {
  const year = String(new Date().getFullYear());
  const started = Date.now();
  try {
    await buildDashboardPayload(year, "ALL", "ALL", "ALL");
    console.log(`[warmer] dashboard ${year} ready in ${Date.now() - started}ms`);
  } catch (error) {
    console.error("[warmer] failed:", error.message);
  }
  // Analytics aggregates scan the full sale-detail table; keep them warm too.
  try {
    const t0 = Date.now();
    await warmAnalytics(Number(year));
    console.log(`[warmer] analytics ${year} ready in ${Date.now() - t0}ms`);
  } catch (error) {
    console.error("[warmer] analytics failed:", error.message);
  }
}

export function startReportWarmer() {
  if (started || process.env.ODG_DISABLE_WARMER === "1") return;
  started = true;

  // Fire-and-forget: `register()` must not block the server from accepting
  // requests, and a slow warm-up should never delay startup.
  setTimeout(() => {
    void warmOnce();
  }, 1_000);

  const timer = setInterval(() => {
    void warmOnce();
  }, WARM_INTERVAL_MS);
  timer.unref?.();
}
