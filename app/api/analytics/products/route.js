import { NextResponse } from "next/server";
import { rows } from "@/lib/db";
import { parseIntSafe } from "@/lib/helpers";
import { buildFilters } from "@/lib/filters";
import { getCurrentUser } from "@/lib/route-auth";
import { getSaleDetailSchema } from "@/lib/sale-detail-schema";

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

    const cmpMonth = year === now.getFullYear() ? now.getMonth() + 1 : 12;
    const { detailWhere, detailParams } = buildFilters(year, bu, channel, province);
    const restWhere = detailWhere.slice("yeardoc = %s".length);
    const restParams = detailParams.slice(1);

    const { costCol } = await getSaleDetailSchema();
    const costSum = costCol ? `SUM(${costCol})::float` : "0::float";
    const costSumYear = costCol
      ? `SUM(CASE WHEN yeardoc = %s THEN ${costCol} ELSE 0 END)::float`
      : "0::float";

    const [brandRows, groupRows, itemRows] = await Promise.all([
      rows(
        `SELECT COALESCE(NULLIF(item_brand, ''), 'UNKNOWN') AS brand,
           SUM(sum_amount)::float AS revenue,
           ${costSum} AS cost,
           COUNT(DISTINCT customer_code)::int AS customers
         FROM public.odg_sale_detail
         WHERE yeardoc = %s${restWhere}
         GROUP BY 1 ORDER BY revenue DESC NULLS LAST LIMIT 15`,
        [year, ...restParams],
      ),
      rows(
        `SELECT COALESCE(NULLIF(itemmaingroup, ''), 'UNKNOWN') AS grp,
           SUM(CASE WHEN yeardoc = %s THEN sum_amount ELSE 0 END)::float AS cur_rev,
           SUM(CASE WHEN yeardoc = %s AND monthdoc <= %s THEN sum_amount ELSE 0 END)::float AS prev_rev
         FROM public.odg_sale_detail
         WHERE yeardoc IN (%s, %s)${restWhere}
         GROUP BY 1 ORDER BY cur_rev DESC NULLS LAST LIMIT 12`,
        [year, year - 1, cmpMonth, year, year - 1, ...restParams],
      ),
      rows(
        `SELECT item_code, MAX(item_name) AS name, MAX(NULLIF(item_brand, '')) AS brand,
           SUM(CASE WHEN yeardoc = %s THEN sum_amount ELSE 0 END)::float AS cur_rev,
           ${costSumYear} AS cur_cost,
           SUM(CASE WHEN yeardoc = %s AND monthdoc <= %s THEN sum_amount ELSE 0 END)::float AS prev_rev
         FROM public.odg_sale_detail
         WHERE yeardoc IN (%s, %s)${restWhere} AND COALESCE(item_code, '') <> ''
         GROUP BY item_code`,
        // costSumYear only carries a placeholder when a cost column exists.
        [year, ...(costCol ? [year] : []), year - 1, cmpMonth, year, year - 1, ...restParams],
      ),
    ]);

    const brands = brandRows.map((row) => {
      const revenue = Number(row.revenue || 0);
      const cost = Number(row.cost || 0);
      return {
        brand: row.brand,
        revenue,
        cost,
        profit: revenue - cost,
        margin_pct: revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0,
        customers: Number(row.customers || 0),
      };
    });

    const groups = groupRows.map((row) => {
      const cur = Number(row.cur_rev || 0);
      const prev = Number(row.prev_rev || 0);
      return {
        grp: row.grp,
        cur_rev: cur,
        prev_rev: prev,
        yoy_pct: prev > 0 ? ((cur - prev) / prev) * 100 : 0,
      };
    });

    const items = itemRows.map((row) => {
      const cur = Number(row.cur_rev || 0);
      const cost = Number(row.cur_cost || 0);
      const prev = Number(row.prev_rev || 0);
      return {
        item_code: row.item_code,
        name: row.name || row.item_code,
        brand: row.brand || "-",
        cur_rev: cur,
        prev_rev: prev,
        profit: cur - cost,
        margin_pct: cur > 0 ? ((cur - cost) / cur) * 100 : 0,
        change: cur - prev,
      };
    });

    const dropped = items
      .filter((item) => item.prev_rev > 0)
      .sort((a, b) => a.change - b.change)
      .slice(0, 15);
    const topProfit = [...items].sort((a, b) => b.profit - a.profit).slice(0, 15);

    const data = { year, cmp_month: cmpMonth, brands, groups, dropped, topProfit };
    cacheMap.set(cacheKey, { ts: Date.now(), data });
    return NextResponse.json(data);
  } catch (error) {
    console.error("analytics/products error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
