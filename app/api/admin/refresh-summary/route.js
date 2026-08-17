import { NextResponse } from "next/server";
import { one } from "@/lib/db";
import { getCurrentUser } from "@/lib/route-auth";
import { MONTHLY_TABLE } from "@/lib/sale-monthly-sql.mjs";
import { ensureFreshRollup } from "@/lib/sale-rollup";
import { clearCache } from "@/lib/cache";

/**
 * Rebuilds the rollups the dashboards read (odg_sale_monthly and
 * odg_sale_customer_month) and drops the in-memory report caches.
 *
 * Auth: a ceo/gm bearer token, or the shared ODG_REFRESH_TOKEN so a cron job
 * can call it without a user session:
 *   curl -X POST -H "x-refresh-token: $ODG_REFRESH_TOKEN" .../api/admin/refresh-summary
 * Optional body/query `years=2025,2026` refreshes only those years.
 */
const ADMIN_ROLES = new Set(["ceo", "gm"]);

function authorize(request) {
  const token = process.env.ODG_REFRESH_TOKEN;
  const header = request.headers.get("x-refresh-token");
  if (token && header && header === token) return true;
  const user = getCurrentUser(request);
  return Boolean(user && ADMIN_ROLES.has(String(user.role || "").toLowerCase()));
}

export async function POST(request) {
  const startedAt = Date.now();
  try {
    if (!authorize(request)) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }

    const raw = request.nextUrl.searchParams.get("years") || "";
    const years = raw
      .split(",")
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value));

    // force: rebuild and stamp the watermark, so page loads see it as current.
    await ensureFreshRollup(years, { force: true });
    await clearCache();

    const stats = await one(
      `SELECT COUNT(*)::int AS monthly_rows,
              (SELECT COUNT(*)::int FROM public.odg_sale_customer_month) AS customer_rows,
              MAX(refreshed_at) AS refreshed_at
       FROM ${MONTHLY_TABLE}`,
    );

    return NextResponse.json({
      success: true,
      years: years.length ? years : "all",
      took_ms: Date.now() - startedAt,
      ...stats,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
