import { NextResponse } from "next/server";
import { query, one } from "@/lib/db";
import { getCurrentUser } from "@/lib/route-auth";
import { CHANNEL_CODE_SQL, MONTHLY_TABLE } from "@/lib/sale-monthly-sql.mjs";
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

async function refresh(years) {
  const scoped = years.length > 0;
  const yearParam = scoped ? [years] : [];

  if (scoped) {
    await query(`DELETE FROM ${MONTHLY_TABLE} WHERE yeardoc = ANY(%s::int[])`, yearParam);
  } else {
    await query(`TRUNCATE ${MONTHLY_TABLE}`);
  }
  await query(
    `
    INSERT INTO ${MONTHLY_TABLE}
      (yeardoc, monthdoc, bu_code, channel_code, province, province_name, amper,
       sum_amount, sum_cost, qty, cash_amount, credit_amount, orders, customers, refreshed_at)
    SELECT
      yeardoc,
      CAST(monthdoc AS int),
      COALESCE(NULLIF(bu_code, ''), '-'),
      ${CHANNEL_CODE_SQL},
      COALESCE(NULLIF(province, ''), '-'),
      COALESCE(NULLIF(MIN(province_name), ''), ''),
      COALESCE(NULLIF(amper, ''), '-'),
      COALESCE(SUM(sum_amount), 0),
      COALESCE(SUM(sum_of_cost), 0),
      COALESCE(SUM(qty), 0),
      COALESCE(SUM(CASE WHEN lower(COALESCE(saletype, '')) LIKE '%สด%' OR lower(COALESCE(saletype, '')) LIKE '%cash%'
                        OR lower(COALESCE(saletype, '')) LIKE '%cod%' THEN sum_amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN lower(COALESCE(saletype, '')) LIKE '%เชื่อ%' OR lower(COALESCE(saletype, '')) LIKE '%credit%'
                        OR lower(COALESCE(saletype, '')) LIKE '%ติดหนี้%' THEN sum_amount ELSE 0 END), 0),
      COUNT(DISTINCT doc_no),
      COUNT(DISTINCT customer_code),
      now()
    FROM public.odg_sale_detail
    ${scoped ? "WHERE yeardoc = ANY(%s::int[])" : ""}
    GROUP BY 1, 2, 3, 4, 5, 7
    `,
    yearParam,
  );

  if (scoped) {
    await query(
      `DELETE FROM public.odg_sale_customer_month WHERE yeardoc = ANY(%s::int[])`,
      yearParam,
    );
  } else {
    await query(`TRUNCATE public.odg_sale_customer_month`);
  }
  await query(
    `
    INSERT INTO public.odg_sale_customer_month
      (yeardoc, monthdoc, bu_code, customer_code, sum_amount, orders)
    SELECT yeardoc, CAST(monthdoc AS int), COALESCE(NULLIF(bu_code, ''), '-'), customer_code,
           COALESCE(SUM(sum_amount), 0), COUNT(DISTINCT doc_no)
    FROM public.odg_sale_detail
    WHERE COALESCE(customer_code, '') <> ''
    ${scoped ? "AND yeardoc = ANY(%s::int[])" : ""}
    GROUP BY 1, 2, 3, 4
    `,
    yearParam,
  );
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

    await refresh(years);
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
