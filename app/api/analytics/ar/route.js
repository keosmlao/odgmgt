import { NextResponse } from "next/server";
import { swrCache } from "@/lib/cache";
import { loadArAnalytics } from "@/lib/analytics";

export async function GET(request) {
  try {
    const sp = request.nextUrl.searchParams;

    // SWR cache: fresh within the TTL, stale served instantly while a
    // background refresh runs, and the Postgres layer survives restarts.
    const data = await swrCache(
      "analytics:ar",
      {
        ttl: 300_000,
        staleTtl: 24 * 3_600_000,
        bypass: sp.get("nocache") === "1",
      },
      loadArAnalytics,
    );

    return NextResponse.json(data);
  } catch (error) {
    console.error("analytics/ar error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
