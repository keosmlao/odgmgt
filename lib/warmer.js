import { buildDashboardPayload } from "./dashboard";
import { swrCache } from "./cache";
import {
  analyticsCacheKey,
  loadArAnalytics,
  loadCashBank,
  loadCustomersAnalytics,
  loadDashboardAnalytics,
  loadDashboardFilters,
  loadProductsAnalytics,
  loadReceivables,
  loadShopMap,
} from "./analytics";

/**
 * Keeps the default report views warm so the first visitor after a restart
 * doesn't pay for a cold rebuild. Runs from instrumentation.js at boot and
 * then on an interval slightly shorter than the cache TTL.
 *
 * The transport reports are warmed by calling the TMS code this app now carries
 * (lib/tms/), not over HTTP — there is no server to talk to at boot, and the
 * point is to fill the same cache the route handlers read.
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

/**
 * The transport reports that cost seconds when cold: the dashboard slices TMS
 * only caches in-process for 15 seconds, and delivery performance, which has no
 * cache of its own at all.
 */
async function warmTransport() {
  const [
    { getDashboardSummary, getDashboardKpi, getDashboardDeliveryPerformance, getDashboardPending },
    { getDeliveryPerformance },
  ] = await Promise.all([import("./tms/queries/dashboard.js"), import("./tms/queries/reports.js")]);

  const opts = { ttl: 300_000, staleTtl: 24 * 3_600_000 };
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  await Promise.all([
    swrCache("transport:overview:summary", opts, () => getDashboardSummary({}, false)),
    swrCache("transport:overview:kpi", opts, () => getDashboardKpi({}, false)),
    swrCache("transport:overview:delivery", opts, () => getDashboardDeliveryPerformance({}, false)),
    swrCache("transport:overview:pending", opts, () => getDashboardPending({}, false)),
    swrCache(
      `transport:delivery-performance:${month}`,
      { ttl: 600_000, staleTtl: 24 * 3_600_000 },
      () => getDeliveryPerformance({}, month),
    ),
  ]);
}

/** The management reports that scan wide: receivables, cash book, shop map. */
async function warmReports() {
  const opts = { ttl: 300_000, staleTtl: 24 * 3_600_000 };
  await Promise.all([
    swrCache("receivables", opts, loadReceivables),
    swrCache("cash-bank:gl:90", opts, () => loadCashBank({ days: 90 })),
    swrCache("shop-map", { ttl: 3_600_000, staleTtl: 24 * 3_600_000 }, loadShopMap),
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
  // Each group is caught on its own: one failing report must not stop the rest
  // from being warmed.
  for (const [label, run] of [["transport", warmTransport], ["reports", warmReports]]) {
    try {
      const t0 = Date.now();
      await run();
      console.log(`[warmer] ${label} ready in ${Date.now() - t0}ms`);
    } catch (error) {
      console.error(`[warmer] ${label} failed:`, error.message);
    }
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
