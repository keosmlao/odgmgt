import { NextResponse } from "next/server";
import { rows } from "@/lib/db";
import { parseIntSafe } from "@/lib/helpers";
import { buildFilters } from "@/lib/filters";
import { getCurrentUser } from "@/lib/route-auth";

const cacheMap = new Map();
const TTL = 300_000; // 5 min

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

    const cacheKey = `${year}|${bu}|${channel}|${province}`;
    const cached = cacheMap.get(cacheKey);
    if (cached && Date.now() - cached.ts < TTL) return NextResponse.json(cached.data);

    // Compare against the same period of the previous year for fairness.
    const cmpMonth = year === now.getFullYear() ? now.getMonth() + 1 : 12;
    const { detailWhere, detailParams } = buildFilters(year, bu, channel, province);
    // detailWhere always starts with "yeardoc = %s"; keep the remaining filter clauses.
    const restWhere = detailWhere.slice("yeardoc = %s".length);
    const restParams = detailParams.slice(1);

    const customerRows = await rows(
      `WITH cur AS (
         SELECT customer_code, MAX(customername) AS name, SUM(sum_amount)::float AS rev,
           COUNT(DISTINCT doc_no)::int AS orders, MAX(doc_date) AS last_buy
         FROM public.odg_sale_detail
         WHERE yeardoc = %s${restWhere} AND COALESCE(customer_code, '') <> ''
         GROUP BY 1
       ), prev AS (
         SELECT customer_code, MAX(customername) AS name, SUM(sum_amount)::float AS rev,
           MAX(doc_date) AS last_buy
         FROM public.odg_sale_detail
         WHERE yeardoc = %s AND monthdoc <= %s${restWhere} AND COALESCE(customer_code, '') <> ''
         GROUP BY 1
       )
       SELECT COALESCE(c.customer_code, p.customer_code) AS code,
         COALESCE(c.name, p.name) AS name,
         COALESCE(c.rev, 0) AS cur_rev, COALESCE(p.rev, 0) AS prev_rev,
         COALESCE(c.orders, 0) AS orders, c.last_buy AS cur_last, p.last_buy AS prev_last
       FROM cur c FULL OUTER JOIN prev p USING (customer_code)`,
      [year, ...restParams, year - 1, cmpMonth, ...restParams],
    );

    let curTotal = 0;
    let activeCount = 0;
    const lost = [];
    const fresh = [];
    const declining = [];
    const activeSorted = [];
    for (const row of customerRows) {
      const cur = Number(row.cur_rev || 0);
      const prev = Number(row.prev_rev || 0);
      curTotal += cur;
      if (cur > 0) {
        activeCount += 1;
        activeSorted.push(row);
        if (prev === 0) fresh.push(row);
        else if (cur < prev * 0.5) declining.push(row);
      } else if (prev > 0) {
        lost.push(row);
      }
    }

    lost.sort((a, b) => b.prev_rev - a.prev_rev);
    fresh.sort((a, b) => b.cur_rev - a.cur_rev);
    declining.sort((a, b) => (b.prev_rev - b.cur_rev) - (a.prev_rev - a.cur_rev));
    activeSorted.sort((a, b) => b.cur_rev - a.cur_rev);

    const top10Rev = activeSorted.slice(0, 10).reduce((sum, row) => sum + Number(row.cur_rev || 0), 0);
    const pick = (row) => ({
      code: row.code,
      name: row.name || row.code,
      cur_rev: Number(row.cur_rev || 0),
      prev_rev: Number(row.prev_rev || 0),
      orders: Number(row.orders || 0),
      last_buy: row.cur_last || row.prev_last || null,
    });

    const data = {
      year,
      cmp_month: cmpMonth,
      summary: {
        active: activeCount,
        new_count: fresh.length,
        lost_count: lost.length,
        declining_count: declining.length,
        top10_share_pct: curTotal > 0 ? (top10Rev / curTotal) * 100 : 0,
        total_revenue: curTotal,
      },
      lost: lost.slice(0, 30).map(pick),
      newCustomers: fresh.slice(0, 30).map(pick),
      declining: declining.slice(0, 30).map(pick),
      topCustomers: activeSorted.slice(0, 10).map((row) => ({
        ...pick(row),
        share_pct: curTotal > 0 ? (Number(row.cur_rev || 0) / curTotal) * 100 : 0,
      })),
    };

    cacheMap.set(cacheKey, { ts: Date.now(), data });
    return NextResponse.json(data);
  } catch (error) {
    console.error("analytics/customers error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
