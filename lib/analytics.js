import { rows, one } from "./db";
import { buildFilters } from "./filters";
import { getSaleDetailSchema } from "./sale-detail-schema";
import { parseIntSafe, CHANNEL_EXPR } from "./helpers";
import { SALE_DETAIL_REPORTED, ensureReportedView } from "./sale-detail-view.js";

/**
 * Analytics loaders shared by the /api/analytics/* routes and the cache warmer.
 * Keeping them here means the warmer fills the exact same swrCache entries the
 * routes read, so the first visitor never pays for a cold aggregate.
 */

export const analyticsCacheKey = (name, { year, bu, channel, province }) =>
  `analytics:${name}:${year}|${bu}|${channel}|${province}`;

/**
 * Customer health: active / new / lost / declining vs the same period last year.
 * Single scan of both years with conditional aggregates — previously this ran
 * two full scans joined with a FULL OUTER JOIN.
 */
export async function loadCustomersAnalytics({ year, bu, channel, province }) {
  await ensureReportedView();
  const now = new Date();
  const cmpMonth = year === now.getFullYear() ? now.getMonth() + 1 : 12;
  const { detailWhere, detailParams } = buildFilters(year, bu, channel, province);
  // detailWhere always starts with "yeardoc = %s"; keep the remaining clauses.
  const restWhere = detailWhere.slice("yeardoc = %s".length);
  const restParams = detailParams.slice(1);

  const customerRows = await rows(
    `SELECT customer_code, MAX(customername) AS name,
       SUM(CASE WHEN yeardoc = %s THEN sum_amount ELSE 0 END)::float AS cur_rev,
       SUM(CASE WHEN yeardoc = %s AND monthdoc <= %s THEN sum_amount ELSE 0 END)::float AS prev_rev,
       COUNT(DISTINCT CASE WHEN yeardoc = %s THEN doc_no END)::int AS orders,
       MAX(CASE WHEN yeardoc = %s THEN doc_date END) AS cur_last,
       MAX(CASE WHEN yeardoc = %s THEN doc_date END) AS prev_last
     FROM ${SALE_DETAIL_REPORTED}
     WHERE yeardoc IN (%s, %s)${restWhere} AND COALESCE(customer_code, '') <> ''
     GROUP BY 1`,
    [year, year - 1, cmpMonth, year, year, year - 1, year, year - 1, ...restParams],
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
    row.code = row.customer_code;
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

  return {
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
}

/** Brand profitability, product-group momentum and top/dropping items. */
export async function loadProductsAnalytics({ year, bu, channel, province }) {
  await ensureReportedView();
  const now = new Date();
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
       FROM ${SALE_DETAIL_REPORTED}
       WHERE yeardoc = %s${restWhere}
       GROUP BY 1 ORDER BY revenue DESC NULLS LAST LIMIT 15`,
      [year, ...restParams],
    ),
    rows(
      `SELECT COALESCE(NULLIF(itemmaingroup, ''), 'UNKNOWN') AS grp,
         SUM(CASE WHEN yeardoc = %s THEN sum_amount ELSE 0 END)::float AS cur_rev,
         SUM(CASE WHEN yeardoc = %s AND monthdoc <= %s THEN sum_amount ELSE 0 END)::float AS prev_rev
       FROM ${SALE_DETAIL_REPORTED}
       WHERE yeardoc IN (%s, %s)${restWhere}
       GROUP BY 1 ORDER BY cur_rev DESC NULLS LAST LIMIT 12`,
      [year, year - 1, cmpMonth, year, year - 1, ...restParams],
    ),
    rows(
      `SELECT item_code, MAX(item_name) AS name, MAX(NULLIF(item_brand, '')) AS brand,
         SUM(CASE WHEN yeardoc = %s THEN sum_amount ELSE 0 END)::float AS cur_rev,
         ${costSumYear} AS cur_cost,
         SUM(CASE WHEN yeardoc = %s AND monthdoc <= %s THEN sum_amount ELSE 0 END)::float AS prev_rev
       FROM ${SALE_DETAIL_REPORTED}
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

  return { year, cmp_month: cmpMonth, brands, groups, dropped, topProfit };
}

/** Logical ordering for odg_ar_aging.overdue_group values. */
const BUCKET_ORDER = [
  "Ondue",
  "Overdue < 60",
  "Overdue < 180",
  "Overdue < 360",
  "Overdue < 720",
  "Overdue < 1080",
  "Overdue",
];

/** AR aging buckets, DSO and the top debtors. */
export async function loadArAnalytics() {
  await ensureReportedView();
  const [bucketRows, debtorRows, rev90Row] = await Promise.all([
    rows(`
      SELECT overdue_group, COUNT(*)::int AS bills, COALESCE(SUM(balance_amount), 0)::float AS balance
      FROM public.odg_ar_aging
      WHERE balance_amount > 0
      GROUP BY overdue_group
    `),
    rows(`
      SELECT ar_code, MAX(sale_name) AS sale_name,
        COALESCE(SUM(balance_amount), 0)::float AS balance,
        MAX(date_diff)::int AS max_overdue_days,
        COUNT(*)::int AS bills
      FROM public.odg_ar_aging
      WHERE balance_amount > 0
      GROUP BY ar_code
      ORDER BY balance DESC
      LIMIT 20
    `),
    one(`
      SELECT COALESCE(SUM(sum_amount), 0)::float AS total
      FROM ${SALE_DETAIL_REPORTED}
      WHERE doc_date >= CURRENT_DATE - 90
    `).catch(() => ({ total: 0 })),
  ]);

  // Resolve customer names for the top debtors from sale history.
  const debtorCodes = debtorRows.map((row) => row.ar_code).filter(Boolean);
  let nameMap = {};
  if (debtorCodes.length) {
    const nameRows = await rows(
      `SELECT ar_code, MAX(customername) AS name
       FROM ${SALE_DETAIL_REPORTED}
       WHERE ar_code = ANY(%s)
       GROUP BY ar_code`,
      [debtorCodes],
    ).catch(() => []);
    nameMap = Object.fromEntries(nameRows.map((row) => [row.ar_code, row.name]));
  }

  const buckets = bucketRows
    .map((row) => ({
      bucket: row.overdue_group || "UNKNOWN",
      bills: Number(row.bills || 0),
      balance: Number(row.balance || 0),
    }))
    .sort((a, b) => {
      const ia = BUCKET_ORDER.indexOf(a.bucket);
      const ib = BUCKET_ORDER.indexOf(b.bucket);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

  const totalBalance = buckets.reduce((sum, row) => sum + row.balance, 0);
  const overdueBalance = buckets
    .filter((row) => row.bucket !== "Ondue")
    .reduce((sum, row) => sum + row.balance, 0);
  const rev90 = Number(rev90Row?.total || 0);
  const dso = rev90 > 0 ? totalBalance / (rev90 / 90) : 0;

  return {
    summary: {
      total_balance: totalBalance,
      overdue_balance: overdueBalance,
      overdue_pct: totalBalance > 0 ? (overdueBalance / totalBalance) * 100 : 0,
      dso,
    },
    buckets,
    topDebtors: debtorRows.map((row) => ({
      ar_code: row.ar_code,
      name: nameMap[row.ar_code] || row.ar_code,
      sale_name: row.sale_name || "-",
      balance: Number(row.balance || 0),
      bills: Number(row.bills || 0),
      max_overdue_days: Number(row.max_overdue_days || 0),
    })),
  };
}

/**
 * Dashboard "Business Analytics" sidecar: MoM growth, DSO, concentration,
 * channel profit, new vs returning, churn and AOV trend.
 */
export async function loadDashboardAnalytics({ year, bu, channel, province }) {
  await ensureReportedView();
  const now = new Date();
  const month = now.getMonth() + 1;

  const { detailWhere, detailParams } = buildFilters(year, bu, channel, province);
  let lastMonth = month - 1;
  let lastMonthYear = year;
  if (lastMonth <= 0) { lastMonth = 12; lastMonthYear = year - 1; }

  const { costCol, dateCol } = await getSaleDetailSchema();
  // The running month is only partly done, so month-over-month and churn are
  // compared against the same slice of days in the previous month.
  const dayCutoff = year === now.getFullYear() && month === now.getMonth() + 1 ? now.getDate() : 0;
  const sameDaysClause =
    dayCutoff && dateCol ? ` AND EXTRACT(DAY FROM ${dateCol}::date) <= ${dayCutoff}` : "";
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
         FROM ${SALE_DETAIL_REPORTED} WHERE ${detailWhere} AND monthdoc=%s`, [...detailParams, month]),

    // 2. Last month total, over the same days of the month as this month
    one(`SELECT COALESCE(SUM(sum_amount),0)::float AS total, COUNT(DISTINCT doc_no)::int AS orders
         FROM ${SALE_DETAIL_REPORTED} WHERE ${lmWhere}${sameDaysClause}`, lmParams),

    // 3. AR total for DSO
    one(`SELECT COALESCE(SUM(balance_amount),0)::float AS total FROM public.odg_ar_aging`).catch(() => ({ total: 0 })),

    // 4. YTD for daily revenue calc
    one(`SELECT COALESCE(SUM(sum_amount),0)::float AS total FROM ${SALE_DETAIL_REPORTED} WHERE ${detailWhere}`, detailParams),

    // 5. Profit margin by channel
    rows(`SELECT
            ${CHANNEL_EXPR} AS channel,
            COALESCE(SUM(sum_amount),0)::float AS revenue,
            ${profitExpr} AS profit,
            ${marginExpr} AS margin_pct
          FROM ${SALE_DETAIL_REPORTED} WHERE ${detailWhere}
          GROUP BY channel ORDER BY revenue DESC`, detailParams),

    // 6. New vs returning: "new" means no purchase in any earlier year, so a
    //    customer counts once — the old first-month rule made every customer
    //    new in their first month and returning afterwards.
    one(`WITH prior AS (
            SELECT DISTINCT customer_code
            FROM ${SALE_DETAIL_REPORTED}
            WHERE yeardoc < %s AND COALESCE(customer_code,'') <> ''
          )
          SELECT
            COALESCE(SUM(CASE WHEN p.customer_code IS NULL THEN d.sum_amount ELSE 0 END),0)::float AS new_revenue,
            COALESCE(SUM(CASE WHEN p.customer_code IS NOT NULL THEN d.sum_amount ELSE 0 END),0)::float AS returning_revenue,
            COUNT(DISTINCT CASE WHEN p.customer_code IS NULL THEN d.customer_code END)::int AS new_count,
            COUNT(DISTINCT CASE WHEN p.customer_code IS NOT NULL THEN d.customer_code END)::int AS returning_count
          FROM ${SALE_DETAIL_REPORTED} d
          LEFT JOIN prior p ON p.customer_code = d.customer_code
          WHERE ${detailWhere}`, [year, ...detailParams]),

    // 7. Customer churn: active last month but not this month
    one(`WITH last_m AS (
            SELECT DISTINCT customer_code FROM ${SALE_DETAIL_REPORTED}
            WHERE yeardoc=%s AND monthdoc=%s ${bu !== "ALL" ? "AND bu_code=%s" : ""}${sameDaysClause}
          ),
          this_m AS (
            SELECT DISTINCT customer_code FROM ${SALE_DETAIL_REPORTED}
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
          FROM ${SALE_DETAIL_REPORTED} WHERE ${detailWhere}
          GROUP BY monthdoc ORDER BY monthdoc`, detailParams),

    // 9. Top 10 customer concentration
    one(`WITH ranked AS (
            SELECT customer_code, SUM(sum_amount)::float AS rev
            FROM ${SALE_DETAIL_REPORTED} WHERE ${detailWhere}
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

  return {
    momGrowth: {
      thisMonth: thisMonthTotal,
      lastMonth: lastMonthTotal,
      growthPct: momGrowth,
      // > 0 when both sides are cut to the same day of the month.
      comparedDays: sameDaysClause ? dayCutoff : 0,
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
}

/** Filter dropdown options (years / BU / channel / province). */
export async function loadDashboardFilters() {
  await ensureReportedView();
  const [yearsRows, buRows, channelRows, provinceRows] = await Promise.all([
    rows(`
      SELECT DISTINCT yeardoc AS year FROM ${SALE_DETAIL_REPORTED} WHERE yeardoc IS NOT NULL
      UNION
      SELECT DISTINCT target_year AS year FROM public.odg_sales_target WHERE target_year IS NOT NULL
      ORDER BY year
    `),
    rows(`
      SELECT DISTINCT bu_code AS code, bu_name AS name_1
      FROM ${SALE_DETAIL_REPORTED}
      WHERE bu_code IS NOT NULL AND bu_code != ''
      ORDER BY bu_code
    `),
    rows(`
      SELECT code, name_1 FROM public.ar_group
      WHERE code NOT IN ('10', '9', '104', '105')
      ORDER BY code
    `),
    rows(`SELECT code, name_1 FROM public.erp_province ORDER BY name_1`),
  ]);

  return {
    years: yearsRows.map((r) => parseIntSafe(r.year, null)).filter((v) => v !== null),
    bu: buRows || [],
    channels: channelRows || [],
    provinces: provinceRows || [],
  };
}

/**
 * Receivables management view — the analytics AR tab plus the breakdowns a
 * collections owner needs: who is responsible, where the debt sits, and which
 * bills are worst. Read from public.odg_ar_aging, the same table the tab uses,
 * so the headline figures agree with it.
 */
export async function loadReceivables() {
  await ensureReportedView();
  const [base, salesRows, branchRows, buRows, yearRows, worstRows] = await Promise.all([
    loadArAnalytics(),
    rows(`
      SELECT COALESCE(NULLIF(TRIM(sale_name), ''), 'ບໍ່ລະບຸ') AS sale_name,
             COALESCE(NULLIF(TRIM(department_name), ''), 'ບໍ່ລະບຸ') AS department_name,
             COUNT(*)::int AS bills,
             COUNT(DISTINCT ar_code)::int AS customers,
             COALESCE(SUM(balance_amount), 0)::float AS balance,
             COALESCE(SUM(balance_amount) FILTER (WHERE COALESCE(date_diff, 0) > 0), 0)::float AS overdue,
             MAX(date_diff)::int AS max_overdue_days
      FROM public.odg_ar_aging
      GROUP BY 1, 2
      ORDER BY 5 DESC
      LIMIT 40
    `),
    rows(`
      SELECT COALESCE(NULLIF(TRIM(branch), ''), 'ບໍ່ລະບຸ') AS branch,
             COUNT(*)::int AS bills,
             COALESCE(SUM(balance_amount), 0)::float AS balance,
             COALESCE(SUM(balance_amount) FILTER (WHERE COALESCE(date_diff, 0) > 0), 0)::float AS overdue
      FROM public.odg_ar_aging
      GROUP BY 1
      ORDER BY 3 DESC
    `),
    // odg_ar_aging carries no BU, so it is taken from the sale lines. One bill
    // has many lines, and joining straight to them multiplied the balance 3.5x
    // (267M against a real 76M) — so pick one BU per bill first (the one with
    // the largest value on it), then sum the balance once.
    rows(`
      WITH bill_bu AS (
        SELECT doc_no, (array_agg(bu_code ORDER BY amount DESC))[1] AS bu_code
        FROM (
          SELECT doc_no, bu_code, SUM(sum_amount) AS amount
          FROM ${SALE_DETAIL_REPORTED} GROUP BY 1, 2
        ) lines
        GROUP BY doc_no
      )
      SELECT COALESCE(b.bu_code, 'ບໍ່ລະບຸ') AS bu_code,
             COALESCE(NULLIF(TRIM(bu.name_1), ''), b.bu_code, 'ບໍ່ລະບຸ') AS bu_name,
             COUNT(*)::int AS bills,
             COALESCE(SUM(a.balance_amount), 0)::float AS balance,
             COALESCE(SUM(a.balance_amount) FILTER (WHERE COALESCE(a.date_diff, 0) > 0), 0)::float AS overdue
      FROM public.odg_ar_aging a
      LEFT JOIN bill_bu b ON b.doc_no = a.doc_no
      LEFT JOIN public.odg_bu bu ON bu.code = b.bu_code
      GROUP BY 1, 2
      ORDER BY 4 DESC
    `),
    // Debt by the year the bill was raised — the ageing buckets stop at
    // "over 90 days", which hides that some of this book is 15+ years old.
    rows(`
      SELECT EXTRACT(YEAR FROM doc_date)::int AS year,
             COUNT(*)::int AS bills,
             COUNT(DISTINCT ar_code)::int AS customers,
             COALESCE(SUM(balance_amount), 0)::float AS balance,
             COALESCE(SUM(balance_amount) FILTER (WHERE COALESCE(date_diff, 0) > 0), 0)::float AS overdue
      FROM public.odg_ar_aging
      WHERE doc_date IS NOT NULL
      GROUP BY 1
      ORDER BY 1 DESC
    `),
    rows(`
      SELECT doc_no, ar_code, doc_date::text AS doc_date, due_date::text AS due_date,
             COALESCE(NULLIF(TRIM(sale_name), ''), '-') AS sale_name,
             COALESCE(balance_amount, 0)::float AS balance,
             COALESCE(date_diff, 0)::int AS overdue_days
      FROM public.odg_ar_aging
      WHERE COALESCE(date_diff, 0) > 0 AND COALESCE(balance_amount, 0) > 0
      ORDER BY date_diff DESC, balance_amount DESC
      LIMIT 30
    `),
  ]);

  // Shop name and buying history both key on ar_code, which matches
  // ar_customer / ic_trans exactly (2,391 of 2,391) but never matches
  // odg_sale_detail — resolving names there left every row showing a bare code.
  //
  // "Bought since" is the collections signal that matters: a shop still placing
  // orders while an old bill sits unpaid is the one to chase first.
  // Top debtors come from loadArAnalytics, which resolves names against
  // odg_sale_detail — a table ar_code never matches, so they arrived as bare
  // codes. Resolve them here too, from the same customer master.
  const codes = Array.from(
    new Set([...worstRows.map((row) => row.ar_code), ...base.topDebtors.map((row) => row.ar_code)]),
  );
  const [nameRows, activity] = codes.length
    ? await Promise.all([
        rows(
          `SELECT code AS ar_code, MAX(name_1) AS name
           FROM public.ar_customer WHERE code = ANY(%s::text[]) GROUP BY code`,
          [codes],
        ),
        rows(
          `
          SELECT t.cust_code AS ar_code,
                 MAX(t.doc_date)::text AS last_purchase,
                 COUNT(*) FILTER (WHERE t.doc_date > a.doc_date)::int AS purchases_after,
                 COALESCE(SUM(t.total_amount) FILTER (WHERE t.doc_date > a.doc_date), 0)::float AS bought_after,
                 -- A bill drops out of odg_ar_aging once it is settled, so a
                 -- later bill that is NOT in there was paid while this one was
                 -- left outstanding — the sharpest signal for who to chase.
                 COUNT(*) FILTER (
                   WHERE t.doc_date > a.doc_date
                     AND NOT EXISTS (SELECT 1 FROM public.odg_ar_aging g WHERE g.doc_no = t.doc_no)
                 )::int AS settled_after,
                 COUNT(*) FILTER (
                   WHERE t.doc_date > a.doc_date
                     AND EXISTS (SELECT 1 FROM public.odg_ar_aging g WHERE g.doc_no = t.doc_no)
                 )::int AS unpaid_after
          FROM public.ic_trans t
          JOIN (
            SELECT ar_code, MIN(doc_date) AS doc_date
            FROM public.odg_ar_aging
            WHERE ar_code = ANY(%s::text[]) AND COALESCE(date_diff, 0) > 0
            GROUP BY ar_code
          ) a ON a.ar_code = t.cust_code
          WHERE t.cust_code = ANY(%s::text[])
          GROUP BY t.cust_code
          `,
          [codes, codes],
        ),
      ])
    : [[], []];
  const nameOf = new Map(nameRows.map((row) => [row.ar_code, row.name]));
  const activityOf = new Map(activity.map((row) => [row.ar_code, row]));

  return {
    ...base,
    bySalesperson: salesRows,
    byBranch: branchRows,
    topDebtors: base.topDebtors.map((row) => ({
      ...row,
      name: nameOf.get(row.ar_code) || row.name,
    })),
    byBu: buRows,
    byYear: yearRows,
    worstBills: worstRows.map((row) => {
      const seen = activityOf.get(row.ar_code);
      return {
        ...row,
        name: nameOf.get(row.ar_code) || row.ar_code,
        last_purchase: seen?.last_purchase ?? null,
        purchases_after: Number(seen?.purchases_after || 0),
        bought_after: Number(seen?.bought_after || 0),
        settled_after: Number(seen?.settled_after || 0),
        unpaid_after: Number(seen?.unpaid_after || 0),
      };
    }),
  };
}

/**
 * Cash and bank position, from the general ledger (public.gl_journal_detail).
 *
 * The GL is the book of record, so every figure here is a real accounting
 * movement rather than a payment-method split. On an asset account a debit is
 * money in and a credit is money out, which is what the page colours green and
 * red; balance is the running debit − credit and is meaningful because the
 * opening balances were journalled in (JR24000001, 2023-12-30).
 *
 * Scope is cash and bank only — chart-of-account groups 10101 (cash on hand and
 * petty cash) through 10105. 10106 is deliberately excluded: those are suspense
 * and in-transit accounts, not money you hold.
 *
 * Account names come from gl_chart_of_account, not from the account_name copy
 * carried on each journal line — that copy is HTML-escaped ("P&amp;amp;P").
 *
 * Amounts are in the ledger's base currency (THB); foreign-currency accounts
 * are already converted by the ERP.
 */
const CASH_BANK_SCOPE = `LEFT(account_code, 5) IN ('10101', '10102', '10103', '10104', '10105')`;

export async function loadCashBank({ days = 90 } = {}) {
  await ensureReportedView();
  const window = Math.max(1, Math.min(365, Number(days) || 90));

  const [opening, movement, accounts, daily, monthly, recent] = await Promise.all([
    one(
      `SELECT COALESCE(SUM(debit - credit), 0)::float AS opening
       FROM public.gl_journal_detail
       WHERE ${CASH_BANK_SCOPE} AND doc_date < current_date - %s::int`,
      [window],
    ),
    one(
      `SELECT COALESCE(SUM(debit), 0)::float AS money_in,
              COALESCE(SUM(credit), 0)::float AS money_out,
              COUNT(DISTINCT doc_no)::int AS docs
       FROM public.gl_journal_detail
       WHERE ${CASH_BANK_SCOPE} AND doc_date >= current_date - %s::int`,
      [window],
    ),
    rows(
      `SELECT d.account_code AS code,
              COALESCE(NULLIF(TRIM(c.name_1), ''), d.account_code) AS name,
              LEFT(d.account_code, 5) AS grp,
              COALESCE(SUM(d.debit) FILTER (WHERE d.doc_date >= current_date - %s::int), 0)::float AS money_in,
              COALESCE(SUM(d.credit) FILTER (WHERE d.doc_date >= current_date - %s::int), 0)::float AS money_out,
              COALESCE(SUM(d.debit - d.credit), 0)::float AS balance
       FROM public.gl_journal_detail d
       LEFT JOIN public.gl_chart_of_account c ON c.code = d.account_code
       WHERE LEFT(d.account_code, 5) IN ('10101', '10102', '10103', '10104', '10105')
       GROUP BY 1, 2, 3`,
      [window, window],
    ),
    rows(
      `SELECT to_char(doc_date, 'YYYY-MM-DD') AS day,
              COALESCE(SUM(debit), 0)::float AS money_in,
              COALESCE(SUM(credit), 0)::float AS money_out
       FROM public.gl_journal_detail
       WHERE ${CASH_BANK_SCOPE} AND doc_date >= current_date - 29
       GROUP BY 1 ORDER BY 1`,
    ),
    rows(
      `SELECT to_char(doc_date, 'YYYY-MM') AS month,
              COALESCE(SUM(debit), 0)::float AS money_in,
              COALESCE(SUM(credit), 0)::float AS money_out
       FROM public.gl_journal_detail
       WHERE ${CASH_BANK_SCOPE}
         AND doc_date >= date_trunc('month', current_date) - interval '11 months'
       GROUP BY 1 ORDER BY 1 DESC`,
    ),
    rows(
      `SELECT d.doc_no, d.line_number::int AS line_number,
              to_char(d.doc_date, 'YYYY-MM-DD') AS doc_date,
              d.account_code,
              COALESCE(NULLIF(TRIM(c.name_1), ''), d.account_code) AS account_name,
              NULLIF(TRIM(COALESCE(NULLIF(d.description, ''), h.description, '')), '') AS description,
              COALESCE(d.debit, 0)::float AS money_in,
              COALESCE(d.credit, 0)::float AS money_out
       FROM public.gl_journal_detail d
       LEFT JOIN public.gl_chart_of_account c ON c.code = d.account_code
       LEFT JOIN public.gl_journal h ON h.doc_no = d.doc_no
       WHERE LEFT(d.account_code, 5) IN ('10101', '10102', '10103', '10104', '10105')
         AND d.doc_date >= current_date - %s::int
       ORDER BY d.doc_date DESC, d.doc_no DESC, d.line_number
       LIMIT 60`,
      [window],
    ),
  ]);

  // 10101 is cash in hand and petty cash; 10102-10105 are the bank accounts.
  const live = accounts.filter((row) => row.money_in || row.money_out || row.balance);
  const withKind = live
    .map((row) => ({ ...row, kind: row.grp === '10101' ? 'cash' : 'bank' }))
    .sort((a, b) => b.balance - a.balance);

  const groupOf = (kind) => {
    const members = withKind.filter((row) => row.kind === kind);
    return {
      kind,
      accounts: members.length,
      money_in: members.reduce((sum, row) => sum + row.money_in, 0),
      money_out: members.reduce((sum, row) => sum + row.money_out, 0),
      balance: members.reduce((sum, row) => sum + row.balance, 0),
    };
  };

  const totals = {
    opening: opening.opening,
    money_in: movement.money_in,
    money_out: movement.money_out,
    net: movement.money_in - movement.money_out,
    closing: opening.opening + movement.money_in - movement.money_out,
    docs: movement.docs,
  };

  return {
    days: window,
    totals,
    groups: [groupOf('cash'), groupOf('bank')],
    accounts: withKind,
    daily: daily.map((row) => ({ ...row, net: row.money_in - row.money_out })),
    monthly: monthly.map((row) => ({ ...row, net: row.money_in - row.money_out })),
    recent,
  };
}

/**
 * Every customer shop that has usable coordinates, with how recently it bought.
 *
 * Coordinates live on ar_customer_detail. 2,061 rows carry one, but three are
 * Google's own default (37.4220, -122.0840 — Mountain View), so the query keeps
 * only points that fall inside Laos rather than trusting the column.
 *
 * Buying activity comes from ic_trans on cust_code with trans_flag 44, the sale
 * bill — the same flag the rest of this app treats as a sale. A shop that has
 * never appeared there is kept on the map with a null last_buy rather than
 * dropped, since "mapped but never bought" is the interesting case.
 */
export async function loadShopMap() {
  await ensureReportedView();
  const [shops, provinces] = await Promise.all([
    rows(
      `WITH mapped AS (
         SELECT ar_code, latitude::float AS lat, longitude::float AS lng
         FROM public.ar_customer_detail
         WHERE latitude BETWEEN 13.5 AND 23 AND longitude BETWEEN 99.5 AND 108.5
       ),
       sales AS (
         SELECT cust_code,
                MAX(doc_date) AS last_buy,
                COALESCE(SUM(total_amount) FILTER (WHERE doc_date >= current_date - 365), 0)::float AS amount_12m,
                COUNT(*) FILTER (WHERE doc_date >= current_date - 365)::int AS docs_12m
         FROM public.ic_trans WHERE trans_flag = 44 GROUP BY 1
       )
       SELECT m.ar_code AS code,
              NULLIF(TRIM(c.name_1), '') AS name,
              m.lat, m.lng,
              COALESCE(NULLIF(TRIM(c.province), ''), '') AS province_code,
              COALESCE(NULLIF(TRIM(p.name_1), ''), '') AS province,
              NULLIF(TRIM(c.telephone), '') AS phone,
              NULLIF(TRIM(c.address), '') AS address,
              to_char(s.last_buy, 'YYYY-MM-DD') AS last_buy,
              (current_date - s.last_buy)::int AS days_since,
              COALESCE(s.amount_12m, 0)::float AS amount_12m,
              COALESCE(s.docs_12m, 0)::int AS docs_12m
       FROM mapped m
       JOIN public.ar_customer c ON c.code = m.ar_code
       LEFT JOIN public.erp_province p ON p.code = c.province
       LEFT JOIN sales s ON s.cust_code = m.ar_code
       ORDER BY COALESCE(s.amount_12m, 0) DESC`,
    ),
    rows(
      `SELECT COALESCE(NULLIF(TRIM(p.name_1), ''), '— ບໍ່ລະບຸ —') AS province,
              COUNT(*)::int AS shops
       FROM public.ar_customer_detail d
       JOIN public.ar_customer c ON c.code = d.ar_code
       LEFT JOIN public.erp_province p ON p.code = c.province
       WHERE d.latitude BETWEEN 13.5 AND 23 AND d.longitude BETWEEN 99.5 AND 108.5
       GROUP BY 1 ORDER BY shops DESC`,
    ),
  ]);

  const active90 = shops.filter((row) => row.days_since != null && row.days_since <= 90).length;
  const active365 = shops.filter((row) => row.days_since != null && row.days_since <= 365).length;

  return {
    shops,
    provinces,
    totals: {
      shops: shops.length,
      active90,
      quiet: active365 - active90,
      cold: shops.length - active365,
      provinces: provinces.length,
      amount_12m: shops.reduce((sum, row) => sum + row.amount_12m, 0),
    },
  };
}
