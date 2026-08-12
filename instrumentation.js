/**
 * Runs once per server instance, before requests are served. Used to start the
 * report cache warmer so the first page open after a deploy/restart is fast.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startReportWarmer } = await import("./lib/warmer");
  startReportWarmer();
}
