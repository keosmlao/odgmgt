import { NextResponse } from "next/server";
import { one } from "@/lib/db";
import { getCurrentUser } from "@/lib/route-auth";
import { swrCache } from "@/lib/cache";
import { LIVE_MAX_DOC_DATE_SQL } from "@/lib/sale-detail-view";

/**
 * Data-source freshness: the newest record date in each source table so an
 * executive can tell at a glance whether sales / AR / targets are current.
 * Cached aggressively — freshness only changes when an import runs.
 */
export async function GET(request) {
  try {
    const user = getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }

    const sp = request.nextUrl.searchParams;
    const data = await swrCache(
      "system:data-sync",
      { ttl: 300_000, staleTtl: 24 * 3_600_000, bypass: sp.get("nocache") === "1" },
      async () => {
        const [sales, monthly, ar, targets] = await Promise.all([
          // The reports read the copy AND the bills written since it was last
          // filled, so freshness is the later of the two dates.
          one(`SELECT GREATEST(MAX(doc_date), ${LIVE_MAX_DOC_DATE_SQL})::text AS latest,
                      COUNT(*)::int AS rows
               FROM public.odg_sale_detail`).catch(() => null),
          one(`SELECT yeardoc AS yr, monthdoc AS mo FROM public.odg_sale_monthly ORDER BY yeardoc DESC, monthdoc DESC LIMIT 1`).catch(() => null),
          one(`SELECT COUNT(*)::int AS rows, COALESCE(SUM(balance_amount),0)::float AS balance FROM public.odg_ar_aging`).catch(() => null),
          one(`SELECT MAX(target_year)::int AS latest FROM public.odg_sales_target`).catch(() => null),
        ]);
        return {
          sale_detail: { latest: sales?.latest || null, rows: sales?.rows || 0 },
          sale_monthly: { latest_year: monthly?.yr || null, latest_month: monthly?.mo || null },
          ar_aging: { rows: ar?.rows || 0, balance: ar?.balance || 0 },
          targets: { latest_year: targets?.latest || null },
          checked_at: new Date().toISOString(),
        };
      },
    );

    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
