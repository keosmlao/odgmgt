// Runs once when the Next.js server boots (Node.js runtime only).
// Schema migrations live here so individual request handlers never pay the
// migration cost on the hot path.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { runMigrations } = await import("@/lib/migrations");
    await runMigrations();
  } catch (error) {
    console.error("instrumentation register error:", error);
  }
}
