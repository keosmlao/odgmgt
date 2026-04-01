import { NextResponse } from "next/server";
import { rows, one } from "@/lib/db";
import { parseIntSafe, CHANNEL_EXPR } from "@/lib/helpers";
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
    const month = now.getMonth() + 1;
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

    const { detailWhere, detailParams } = buildFilters(year, bu, channel, province);
    let lastMonth = month - 1;
    let lastMonthYear = year;
    if (lastMonth <= 0) { lastMonth = 12; lastMonthYear = year - 1; }

    const { costCol } = await getSaleDetailSchema();
    const profitExpr = costCol
      ? `COALESCE(SUM(sum_amount),0)::float - COALESCE(SUM(${costCol}),0)::float`
      : `COALESCE(SUM(profit),0)::float`;
    const marginExpr = costCol
      ? `CASE WHEN COALESCE(SUM(sum_amount),0)>0 THEN (COALESCE(SUM(sum_amount),0)-COALESCE(SUM(${costCol}),0))/SUM(sum_amount)*100 ELSE 0 END`
      : `CASE WHEN COALESCE(SUM(sum_amount),0)>0 THEN COALESCE(SUM(profit),0)/SUM(sum_amount)*100 ELSE 0 END`;

    // Build filter for last month
    const { detailWhere: lmWhere, detailParams: lmParams } = buildFilters(lastMonthYear, bu, channel, province, lastMonth);

    const [
      thisMonthRow,
      lastMonthRow,
      arTotalRow,
      ytdRow,
      channelProfitRows,
      newReturnRows,
      churnRows,
      aovRows,
      topCustConcentration,
    ] = await Promise.all([
      // 1. This month total
      one(`SELECT COALESCE(SUM(sum_amount),0)::float AS total, COUNT(DISTINCT doc_no)::int AS orders
           FROM public.odg_sale_detail WHERE ${detailWhere} AND monthdoc=%s`, [...detailParams, month]),

      // 2. Last month total
      one(`SELECT COALESCE(SUM(sum_amount),0)::float AS total, COUNT(DISTINCT doc_no)::int AS orders
           FROM public.odg_sale_detail WHERE ${lmWhere}`, lmParams),

      // 3. AR total for DSO
      one(`SELECT COALESCE(SUM(balance_amount),0)::float AS total FROM public.odg_ar_aging`).catch(() => ({ total: 0 })),

      // 4. YTD for daily revenue calc
      one(`SELECT COALESCE(SUM(sum_amount),0)::float AS total FROM public.odg_sale_detail WHERE ${detailWhere}`, detailParams),

      // 5. Profit margin by channel
      rows(`SELECT
              ${CHANNEL_EXPR} AS channel,
              COALESCE(SUM(sum_amount),0)::float AS revenue,
              ${profitExpr} AS profit,
              ${marginExpr} AS margin_pct
            FROM public.odg_sale_detail WHERE ${detailWhere}
            GROUP BY channel ORDER BY revenue DESC`, detailParams),

      // 6. New vs returning customer revenue split (YTD)
      one(`WITH cust_history AS (
              SELECT customer_code, MIN(monthdoc) AS first_month
              FROM public.odg_sale_detail
              WHERE yeardoc = %s
              GROUP BY customer_code
            )
            SELECT
              COALESCE(SUM(CASE WHEN ch.first_month = d.monthdoc THEN d.sum_amount ELSE 0 END),0)::float AS new_revenue,
              COALESCE(SUM(CASE WHEN ch.first_month < d.monthdoc THEN d.sum_amount ELSE 0 END),0)::float AS returning_revenue,
              COUNT(DISTINCT CASE WHEN ch.first_month = d.monthdoc THEN d.customer_code END)::int AS new_count,
              COUNT(DISTINCT CASE WHEN ch.first_month < d.monthdoc THEN d.customer_code END)::int AS returning_count
            FROM public.odg_sale_detail d
            JOIN cust_history ch ON ch.customer_code = d.customer_code
            WHERE ${detailWhere}`, [year, ...detailParams]),

      // 7. Customer churn: active last month but not this month
      one(`WITH last_m AS (
              SELECT DISTINCT customer_code FROM public.odg_sale_detail
              WHERE yeardoc=%s AND monthdoc=%s ${bu !== "ALL" ? "AND bu_code=%s" : ""}
            ),
            this_m AS (
              SELECT DISTINCT customer_code FROM public.odg_sale_detail
              WHERE yeardoc=%s AND monthdoc=%s ${bu !== "ALL" ? "AND bu_code=%s" : ""}
            )
            SELECT
              (SELECT COUNT(*) FROM last_m)::int AS last_month_customers,
              (SELECT COUNT(*) FROM last_m WHERE customer_code NOT IN (SELECT customer_code FROM this_m))::int AS churned,
              (SELECT COUNT(*) FROM this_m WHERE customer_code NOT IN (SELECT customer_code FROM last_m))::int AS new_acquired`,
        bu !== "ALL"
          ? [lastMonthYear, lastMonth, bu, year, month, bu]
          : [lastMonthYear, lastMonth, year, month]),

      // 8. AOV by month
      rows(`SELECT monthdoc AS month,
              COALESCE(SUM(sum_amount),0)::float AS revenue,
              COUNT(DISTINCT doc_no)::int AS orders,
              CASE WHEN COUNT(DISTINCT doc_no)>0 THEN COALESCE(SUM(sum_amount),0)::float/COUNT(DISTINCT doc_no) ELSE 0 END AS aov
            FROM public.odg_sale_detail WHERE ${detailWhere}
            GROUP BY monthdoc ORDER BY monthdoc`, detailParams),

      // 9. Top 10 customer concentration
      one(`WITH ranked AS (
              SELECT customer_code, SUM(sum_amount)::float AS rev
              FROM public.odg_sale_detail WHERE ${detailWhere}
              GROUP BY customer_code ORDER BY rev DESC LIMIT 10
            )
            SELECT
              COALESCE(SUM(rev),0)::float AS top10_revenue,
              COUNT(*)::int AS top10_count
            FROM ranked`, detailParams),
    ]);

    // Calculate metrics
    const thisMonthTotal = Number(thisMonthRow?.total || 0);
    const lastMonthTotal = Number(lastMonthRow?.total || 0);
    const momGrowth = lastMonthTotal > 0 ? ((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100 : 0;

    const thisMonthOrders = Number(thisMonthRow?.orders || 0);
    const lastMonthOrders = Number(lastMonthRow?.orders || 0);
    const thisMonthAov = thisMonthOrders > 0 ? thisMonthTotal / thisMonthOrders : 0;
    const lastMonthAov = lastMonthOrders > 0 ? lastMonthTotal / lastMonthOrders : 0;

    const ytdTotal = Number(ytdRow?.total || 0);
    const arTotal = Number(arTotalRow?.total || 0);
    const dayOfYear = Math.floor((now.getTime() - new Date(year, 0, 1).getTime()) / 86400000) + 1;
    const dailyRevenue = dayOfYear > 0 ? ytdTotal / dayOfYear : 0;
    const dso = dailyRevenue > 0 ? arTotal / dailyRevenue : 0;

    const top10Rev = Number(topCustConcentration?.top10_revenue || 0);
    const concentrationPct = ytdTotal > 0 ? (top10Rev / ytdTotal) * 100 : 0;

    const churnData = churnRows || {};
    const lastMCust = Number(churnData.last_month_customers || 0);
    const churnedCount = Number(churnData.churned || 0);
    const newAcquired = Number(churnData.new_acquired || 0);
    const churnRate = lastMCust > 0 ? (churnedCount / lastMCust) * 100 : 0;
    const retentionRate = 100 - churnRate;

    const newRev = Number(newReturnRows?.new_revenue || 0);
    const retRev = Number(newReturnRows?.returning_revenue || 0);
    const newCount = Number(newReturnRows?.new_count || 0);
    const retCount = Number(newReturnRows?.returning_count || 0);

    const result = {
      momGrowth: {
        thisMonth: thisMonthTotal,
        lastMonth: lastMonthTotal,
        growthPct: momGrowth,
      },
      dso: {
        value: Math.round(dso),
        arTotal,
        dailyRevenue: Math.round(dailyRevenue),
      },
      concentration: {
        top10Revenue: top10Rev,
        top10Pct: concentrationPct,
        ytdTotal,
      },
      channelProfit: (channelProfitRows || []).slice(0, 10).map(r => ({
        channel: r.channel,
        revenue: Number(r.revenue || 0),
        profit: Number(r.profit || 0),
        marginPct: Number(r.margin_pct || 0),
      })),
      newVsReturn: {
        newRevenue: newRev,
        returningRevenue: retRev,
        newCustomers: newCount,
        returningCustomers: retCount,
        newPct: ytdTotal > 0 ? (newRev / ytdTotal) * 100 : 0,
        returnPct: ytdTotal > 0 ? (retRev / ytdTotal) * 100 : 0,
      },
      churn: {
        lastMonthCustomers: lastMCust,
        churned: churnedCount,
        newAcquired,
        churnRate,
        retentionRate,
      },
      aovTrend: (aovRows || []).map(r => ({
        month: Number(r.month),
        revenue: Number(r.revenue || 0),
        orders: Number(r.orders || 0),
        aov: Number(r.aov || 0),
      })),
      aov: {
        thisMonth: thisMonthAov,
        lastMonth: lastMonthAov,
        changePct: lastMonthAov > 0 ? ((thisMonthAov - lastMonthAov) / lastMonthAov) * 100 : 0,
      },
    };

    cacheMap.set(cacheKey, { ts: Date.now(), data: result });
    return NextResponse.json(result);
  } catch (error) {
    console.error("analytics API error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
