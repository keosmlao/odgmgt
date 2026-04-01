import { NextResponse } from "next/server";
import { rows, one } from "@/lib/db";
import { parseIntSafe } from "@/lib/helpers";
import { buildFilters } from "@/lib/filters";
import { getCurrentUser } from "@/lib/route-auth";
import { getSaleDetailSchema } from "@/lib/sale-detail-schema";

// Cache for 3 minutes (keyed by all filters)
const cacheMap = new Map();
const TTL = 180_000;

export async function GET(request) {
  try {
    const sp = request.nextUrl.searchParams;
    const now = new Date();
    const year = parseIntSafe(sp.get("year"), now.getFullYear());
    const month = now.getMonth() + 1;
    const today = `${year}-${String(month).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    let bu = sp.get("bu") || "ALL";
    let channel = sp.get("channel") || "ALL";
    const province = sp.get("province") || "ALL";

    // Role-based override
    const user = getCurrentUser(request) || {};
    if (user.role === "sale_bu_manager") {
      if (user.bu_code) bu = user.bu_code;
      if (Array.isArray(user.channel_codes) && user.channel_codes.length) {
        channel = user.channel_codes.map(String).join(",");
      }
    }

    const cacheKey = `${year}|${bu}|${channel}|${province}`;
    const cached = cacheMap.get(cacheKey);
    if (cached && Date.now() - cached.ts < TTL) {
      return NextResponse.json(cached.data);
    }

    // Build WHERE clauses using shared filter builder
    const { detailWhere, detailParams } = buildFilters(year, bu, channel, province);

    const { dateCol, custNameCol, costCol } = await getSaleDetailSchema();

    const custNameExpr = custNameCol ? `COALESCE(NULLIF(${custNameCol}, ''), customer_code)` : "customer_code";
    const todayFilter = dateCol ? `AND ${dateCol}::date = '${today}'` : `AND monthdoc = ${month}`;
    const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
    const weekStr = `${weekAgo.getFullYear()}-${String(weekAgo.getMonth() + 1).padStart(2, "0")}-${String(weekAgo.getDate()).padStart(2, "0")}`;
    const weekFilter = dateCol ? `AND ${dateCol}::date >= '${weekStr}'` : `AND monthdoc = ${month}`;

    // All queries in parallel — using detailWhere/detailParams for BU/Channel/Province filtering
    const [todayRow, weekRow, topCustomers, bottomCustomers, gpRow, collectionRow, dailyTrend] = await Promise.all([
      one(`SELECT COALESCE(SUM(sum_amount),0)::float AS total, COUNT(DISTINCT doc_no)::int AS orders, COUNT(DISTINCT customer_code)::int AS customers
           FROM public.odg_sale_detail WHERE ${detailWhere} ${todayFilter}`, detailParams),

      one(`SELECT COALESCE(SUM(sum_amount),0)::float AS total, COUNT(DISTINCT doc_no)::int AS orders, COUNT(DISTINCT customer_code)::int AS customers
           FROM public.odg_sale_detail WHERE ${detailWhere} ${weekFilter}`, detailParams),

      rows(`SELECT customer_code, ${custNameExpr} AS customer_name, COALESCE(SUM(sum_amount),0)::float AS revenue, COUNT(DISTINCT doc_no)::int AS orders
            FROM public.odg_sale_detail WHERE ${detailWhere}
            GROUP BY customer_code, customer_name ORDER BY revenue DESC LIMIT 10`, detailParams),

      rows(`SELECT customer_code, ${custNameExpr} AS customer_name, COALESCE(SUM(sum_amount),0)::float AS revenue, COUNT(DISTINCT doc_no)::int AS orders
            FROM public.odg_sale_detail WHERE ${detailWhere} AND monthdoc = %s
            GROUP BY customer_code, customer_name HAVING SUM(sum_amount) > 0 ORDER BY revenue ASC LIMIT 10`, [...detailParams, month]),

      costCol
        ? one(`SELECT COALESCE(SUM(sum_amount),0)::float AS revenue, COALESCE(SUM(${costCol}),0)::float AS cost, COALESCE(SUM(profit),0)::float AS profit,
               CASE WHEN COALESCE(SUM(sum_amount),0)>0 THEN (COALESCE(SUM(sum_amount),0)-COALESCE(SUM(${costCol}),0))/SUM(sum_amount)*100 ELSE 0 END AS gp_pct
               FROM public.odg_sale_detail WHERE ${detailWhere}`, detailParams)
        : one(`SELECT COALESCE(SUM(sum_amount),0)::float AS revenue, 0::float AS cost, COALESCE(SUM(profit),0)::float AS profit,
               CASE WHEN COALESCE(SUM(sum_amount),0)>0 THEN COALESCE(SUM(profit),0)/SUM(sum_amount)*100 ELSE 0 END AS gp_pct
               FROM public.odg_sale_detail WHERE ${detailWhere}`, detailParams),

      one(`SELECT COALESCE(SUM(sum_amount),0)::float AS total_sales,
           COALESCE(SUM(CASE WHEN lower(COALESCE(saletype,'')) IN ('cash','cs','cod') OR lower(COALESCE(saletype,'')) LIKE '%cash%' OR lower(COALESCE(saletype,'')) LIKE '%สด%' THEN sum_amount ELSE 0 END),0)::float AS collected,
           CASE WHEN COALESCE(SUM(sum_amount),0)>0 THEN COALESCE(SUM(CASE WHEN lower(COALESCE(saletype,'')) IN ('cash','cs','cod') OR lower(COALESCE(saletype,'')) LIKE '%cash%' OR lower(COALESCE(saletype,'')) LIKE '%สด%' THEN sum_amount ELSE 0 END),0)/SUM(sum_amount)*100 ELSE 0 END AS rate
           FROM public.odg_sale_detail WHERE ${detailWhere} AND monthdoc = %s`, [...detailParams, month]),

      dateCol
        ? rows(`SELECT ${dateCol}::date AS day, COALESCE(SUM(sum_amount),0)::float AS amount, COUNT(DISTINCT doc_no)::int AS orders
                FROM public.odg_sale_detail WHERE ${detailWhere} AND ${dateCol}::date >= (CURRENT_DATE - INTERVAL '14 days')
                GROUP BY day ORDER BY day`, detailParams)
        : [],
    ]);

    const result = {
      today: { sales: Number(todayRow?.total || 0), orders: Number(todayRow?.orders || 0), customers: Number(todayRow?.customers || 0) },
      week: { sales: Number(weekRow?.total || 0), orders: Number(weekRow?.orders || 0), customers: Number(weekRow?.customers || 0) },
      topCustomers: (topCustomers || []).map((c) => ({ code: c.customer_code, name: c.customer_name, revenue: Number(c.revenue || 0), orders: Number(c.orders || 0) })),
      bottomCustomers: (bottomCustomers || []).map((c) => ({ code: c.customer_code, name: c.customer_name, revenue: Number(c.revenue || 0), orders: Number(c.orders || 0) })),
      grossProfit: { revenue: Number(gpRow?.revenue || 0), cost: Number(gpRow?.cost || 0), profit: Number(gpRow?.profit || 0), gpPct: Number(gpRow?.gp_pct || 0) },
      collection: { totalSales: Number(collectionRow?.total_sales || 0), collected: Number(collectionRow?.collected || 0), rate: Number(collectionRow?.rate || 0) },
      dailyTrend: (dailyTrend || []).map((d) => ({ day: d.day, amount: Number(d.amount || 0), orders: Number(d.orders || 0) })),
      hasDateColumn: !!dateCol,
    };

    cacheMap.set(cacheKey, { ts: Date.now(), data: result });
    return NextResponse.json(result);
  } catch (error) {
    console.error("executive dashboard error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
