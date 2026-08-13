import { NextResponse } from "next/server";
import { parseIntSafe } from "@/lib/helpers";
import { getCurrentUser } from "@/lib/route-auth";
import { swrCache } from "@/lib/cache";
import { analyticsCacheKey, loadProductsAnalytics } from "@/lib/analytics";

export async function GET(request) {
  try {
    const sp = request.nextUrl.searchParams;
    const now = new Date();
    const year = parseIntSafe(sp.get("year"), now.getFullYear());
    let bu = sp.get("bu") || "ALL";
    let channel = sp.get("channel") || "ALL";
    const province = sp.get("province") || "ALL";

    const user = getCurrentUser(request) || {};
    if (user.role === "sale_bu_manager") {
      if (user.bu_code) bu = user.bu_code;
      if (Array.isArray(user.channel_codes) && user.channel_codes.length)
        channel = user.channel_codes.map(String).join(",");
    }

    // SWR cache: fresh within the TTL, stale served instantly while a
    // background refresh runs, and the Postgres layer survives restarts.
    const data = await swrCache(
      analyticsCacheKey("products", { year, bu, channel, province }),
      {
        ttl: 300_000,
        staleTtl: 24 * 3_600_000,
        bypass: sp.get("nocache") === "1",
      },
      () => loadProductsAnalytics({ year, bu, channel, province }),
    );

    return NextResponse.json(data);
  } catch (error) {
    console.error("analytics/products error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
