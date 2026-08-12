import { buildDashboardPayload } from "./dashboard";

/**
 * Keeps the default report views warm so the first visitor after a restart
 * doesn't pay for a cold rebuild. Runs from instrumentation.js at boot and
 * then on an interval slightly shorter than the cache TTL.
 */
const WARM_INTERVAL_MS = Number(process.env.ODG_WARM_INTERVAL_MS || 4 * 60_000);

let started = false;

async function warmOnce() {
  const year = String(new Date().getFullYear());
  const started = Date.now();
  try {
    await buildDashboardPayload(year, "ALL", "ALL", "ALL");
    console.log(`[warmer] dashboard ${year} ready in ${Date.now() - started}ms`);
  } catch (error) {
    console.error("[warmer] failed:", error.message);
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
