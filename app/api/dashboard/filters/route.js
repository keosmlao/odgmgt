import { NextResponse } from "next/server";
import { swrCache } from "@/lib/cache";
import { loadDashboardFilters } from "@/lib/analytics";

export async function GET(request) {
  try {
    const sp = request.nextUrl.searchParams;

    // Filter options rarely change; keep them warm with a long fresh TTL so
    // dropdowns never wait on a DISTINCT scan of the sale-detail table.
    const data = await swrCache(
      "dashboard-filters",
      {
        ttl: 600_000,
        staleTtl: 24 * 3_600_000,
        bypass: sp.get("nocache") === "1",
      },
      loadDashboardFilters,
    );

    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
