import { rows, one } from "./db";
import { parseIntSafe, safeDiv, monthName } from "./helpers";
import { buildFilters, buildMonthlyFilters, channelMap } from "./filters";
import { MONTHLY_TABLE, CHANNEL_NAMES } from "./sale-monthly-sql.mjs";
import { ensureSalesAssignmentTable } from "./migrations";
import { getSaleDetailSchema } from "./sale-detail-schema";
import { swrCache } from "./cache";

// Fresh for 5 minutes, then served stale while it refreshes in the background.
const DASHBOARD_TTL = { ttl: 300_000, staleTtl: 6 * 3_600_000 };

export function buildActionsFromKpi(kpi) {
  const actions = [];
  const ytdAch = safeDiv(kpi.ytd_actual, kpi.ytd_target) * 100;
  const thisAch = safeDiv(kpi.this_month_actual, kpi.this_month_target) * 100;
  const yoy =
    safeDiv(kpi.ytd_actual - kpi.ytd_last_year, kpi.ytd_last_year) * 100;

  if (ytdAch < 90) {
    actions.push({
      level: "high",
      owner: "Dashboard",
      title: "YTD ต่ำกว่า 90% ต้องเร่งปิด GAP",
      detail: "โฟกัส BU/Channel ที่ติดลบและเพิ่ม run-rate รายวัน",
    });
  }
  if (thisAch < 90) {
    actions.push({
      level: "medium",
      owner: "Dashboard",
      title: "เดือนนี้ต่ำกว่าเป้า",
      detail: "ปรับแผนรายสัปดาห์และเร่งยอดพื้นที่หลัก",
    });
  }
  if (yoy < 0) {
    actions.push({
      level: "low",
      owner: "Dashboard",
      title: "YoY ติดลบ",
      detail: "ติดตาม SKU/ลูกค้าหลักที่ลดลงเทียบปีก่อน",
    });
  }
  if (!actions.length) {
    actions.push({
      level: "low",
      owner: "Dashboard",
      title: "ผลรวมอยู่ในเกณฑ์",
      detail: "รักษาจังหวะขายและติดตาม KPI ต่อเนื่อง",
    });
  }

  return actions;
}

function buildHistoricalDetailFilters(year, month, bu, channel, province) {
  const selectedYm = year * 12 + month;
  // Split into a plain range predicate: an arithmetic expression over yeardoc/monthdoc
  // is not indexable and forces a full heap scan of this 2GB table.
  const detailWhere = ["(yeardoc < %s OR (yeardoc = %s AND monthdoc <= %s))"];
  const detailParams = [year, year, month];

  if (bu && bu !== "ALL") {
    detailWhere.push("bu_code = %s");
    detailParams.push(bu);
  }

  if (province && province !== "ALL") {
    const provinceValues =
      typeof province === "string" ? province.split(",").filter(Boolean) : [...province];
    detailWhere.push("(province = ANY(%s) OR province_name = ANY(%s))");
    detailParams.push(provinceValues, provinceValues);
  }

  if (channel && channel !== "ALL") {
    const channelValues =
      typeof channel === "string" ? channel.split(",").filter(Boolean) : [...channel];
    const names = [];
    for (const item of channelValues) {
      const mapped = channelMap[item] || { names: [item], codes: [item] };
      names.push(...mapped.names);
    }
    detailWhere.push(
      "(channel_name = ANY(%s) OR argroup = ANY(%s) OR argroup_main = ANY(%s) OR argroupsub = ANY(%s))",
    );
    detailParams.push(names, names, names, names);
  }

  return {
    selectedYm,
    detailWhere: detailWhere.join(" AND "),
    detailParams,
  };
}

export async function buildDashboardPayload(year, bu, channel, province, month = null) {
  const cacheKey = `dashboard:${year}|${bu}|${channel}|${province}|${month}`;
  return swrCache(cacheKey, DASHBOARD_TTL, () =>
    computeDashboardPayload(year, bu, channel, province, month),
  );
}

async function computeDashboardPayload(year, bu, channel, province, month = null) {
  const now = new Date();
  const yearVal = parseIntSafe(year, now.getFullYear());
  const currentMonthVal = now.getMonth() + 1;
  const selectedMonthVal = month && String(month) !== "ALL"
    ? parseIntSafe(month, currentMonthVal)
    : currentMonthVal;
  let lastMonthVal = selectedMonthVal - 1;
  let lastMonthYear = yearVal;
  if (lastMonthVal <= 0) {
    lastMonthVal = 12;
    lastMonthYear = yearVal - 1;
  }

  const { detailWhere, detailParams, targetWhere, targetParams } = buildFilters(
    yearVal,
    bu,
    channel,
    province,
    month,
  );
  // Money figures come from the pre-aggregated rollup; only distinct-count and
  // per-item panels still touch the 2.7 GB detail table.
  const monthly = buildMonthlyFilters(yearVal, bu, channel, province, month);
  const monthlyBase = buildMonthlyFilters(yearVal, bu, channel, province);
  const monthlyLastYear = buildMonthlyFilters(yearVal - 1, bu, channel, province);
  const monthlyLast2Year = buildMonthlyFilters(yearVal - 2, bu, channel, province);

  // The customer rollup only carries year/month/BU/customer, so BU is the only
  // dimension that can be filtered there.
  const customerFilters = ["yeardoc = %s"];
  const customerParams = [yearVal];
  const customerBuParams = [];
  let customerBuClause = "";
  if (bu && bu !== "ALL") {
    customerFilters.push("bu_code = %s");
    customerParams.push(String(bu));
    customerBuClause = "AND bu_code = %s";
    customerBuParams.push(String(bu));
  }
  if (month && String(month) !== "ALL") {
    customerFilters.push("monthdoc = %s");
    customerParams.push(selectedMonthVal);
  }
  const customerWhere = customerFilters.join(" AND ");

  const historicalFilters = buildHistoricalDetailFilters(
    yearVal,
    selectedMonthVal,
    bu,
    channel,
    province,
  );

  // Two cheap lookups first (both cached / tiny) so every heavy query below can
  // run in one parallel wave instead of waiting on three separate barriers.
  const [, saleDetailSchema, arGroupRows] = await Promise.all([
    ensureSalesAssignmentTable(),
    getSaleDetailSchema(),
    rows(`
      SELECT code, name_1
      FROM public.ar_group
      WHERE code NOT IN ('10', '9', '104', '105')
    `).catch(() => []),
  ]);

  // ── Batch 1: All independent queries in parallel ──
  const [
    kpiComboRow,
    thisMonthLastYearRow,
    lastMonthActualRow,
    ytdLastYearRow,
    monthlyDetailRows,
    lastYearRows,
    last2YearRows,
    targetRowsResult,
    buChannelResult,
    provinceActualRows,
    provinceTargetRows,
    topRevenue,
    topMargin,
    custRows,
    countsRow,
    reactiveRow,
  ] = await Promise.all([
    // Combined: ytdActual, thisMonthActual, counts, discount, cashCreditTotal in 1 scan
    one(
      `SELECT
        COALESCE(SUM(sum_amount), 0)::float AS ytd_actual,
        COALESCE(SUM(CASE WHEN monthdoc = %s THEN sum_amount ELSE 0 END), 0)::float AS this_month_actual,
        COALESCE(SUM(sum_amount), 0)::float AS revenue_total,
        COALESCE(SUM(cash_amount), 0)::float AS cash_total,
        COALESCE(SUM(credit_amount), 0)::float AS credit_total
       FROM ${MONTHLY_TABLE} WHERE ${monthly.where}`,
      [selectedMonthVal, ...monthly.params],
    ),
    one(
      `SELECT COALESCE(SUM(sum_amount), 0)::float AS total
       FROM ${MONTHLY_TABLE} WHERE ${monthlyLastYear.where} AND monthdoc = %s`,
      [...monthlyLastYear.params, selectedMonthVal],
    ),
    one(
      `SELECT COALESCE(SUM(sum_amount), 0)::float AS total
       FROM ${MONTHLY_TABLE} WHERE ${buildMonthlyFilters(lastMonthYear, bu, channel, province).where} AND monthdoc = %s`,
      [...buildMonthlyFilters(lastMonthYear, bu, channel, province).params, lastMonthVal],
    ),
    // Last year over the SAME span the selected year has data for. Summing the
    // whole of last year would put 8 months against 12 and read as a collapse.
    one(
      `SELECT COALESCE(SUM(sum_amount), 0)::float AS total
       FROM ${MONTHLY_TABLE}
       WHERE ${monthlyLastYear.where}
         AND monthdoc <= COALESCE(
           (SELECT MAX(monthdoc) FROM ${MONTHLY_TABLE} WHERE ${monthly.where}),
           12
         )`,
      [...monthlyLastYear.params, ...monthly.params],
    ),
    // Combined: monthly actual + cash/credit breakdown in 1 scan
    rows(
      `SELECT monthdoc AS month,
        COALESCE(SUM(sum_amount), 0)::float AS actual,
        COALESCE(SUM(cash_amount), 0)::float AS cash,
        COALESCE(SUM(credit_amount), 0)::float AS credit
       FROM ${MONTHLY_TABLE} WHERE ${monthlyBase.where} GROUP BY monthdoc`,
      monthlyBase.params,
    ),
    rows(
      `SELECT monthdoc AS month, COALESCE(SUM(sum_amount), 0)::float AS actual
       FROM ${MONTHLY_TABLE} WHERE ${monthlyLastYear.where} GROUP BY monthdoc`,
      monthlyLastYear.params,
    ),
    rows(
      `SELECT monthdoc AS month, COALESCE(SUM(sum_amount), 0)::float AS actual
       FROM ${MONTHLY_TABLE} WHERE ${monthlyLast2Year.where} GROUP BY monthdoc`,
      monthlyLast2Year.params,
    ),
    // All target months in 1 query
    rows(
      `SELECT target_month AS month, COALESCE(SUM(target_amount), 0)::float AS target
       FROM public.odg_sales_target WHERE ${targetWhere} GROUP BY target_month`,
      targetParams,
    ),
    rows(
      `SELECT bu_code AS bu, channel_code,
        COALESCE(SUM(sum_amount), 0)::float AS amount
       FROM ${MONTHLY_TABLE} WHERE ${monthly.where} GROUP BY bu, channel_code`,
      monthly.params,
    ),
    rows(
      `SELECT province AS province_code,
        COALESCE(NULLIF(MIN(province_name), ''), province) AS label,
        COALESCE(SUM(sum_amount), 0)::float AS actual
       FROM ${MONTHLY_TABLE} WHERE ${monthly.where} GROUP BY province`,
      monthly.params,
    ),
    rows(
      `SELECT province_code, COALESCE(SUM(target_amount), 0)::float AS target
       FROM public.odg_sales_target WHERE ${targetWhere} GROUP BY province_code`,
      targetParams,
    ),
    rows(
      `SELECT item_code AS code, item_name AS name, COALESCE(SUM(sum_amount), 0)::float AS revenue
       FROM public.odg_sale_detail WHERE ${detailWhere} GROUP BY code, name ORDER BY revenue DESC LIMIT 5`,
      detailParams,
    ),
    rows(
      `SELECT item_code AS code, item_name AS name,
        COALESCE(SUM(sum_amount), 0)::float AS revenue,
        CASE WHEN COALESCE(SUM(sum_amount), 0) > 0 THEN COALESCE(SUM(profit), 0)::float / SUM(sum_amount) ELSE 0 END AS gp
       FROM public.odg_sale_detail WHERE ${detailWhere} GROUP BY code, name ORDER BY gp DESC NULLS LAST, revenue DESC LIMIT 5`,
      detailParams,
    ),
    rows(
      `SELECT customer_code, COALESCE(SUM(orders), 0)::int AS cnt
       FROM public.odg_sale_customer_month WHERE ${customerWhere} GROUP BY customer_code`,
      customerParams,
    ),
    one(
      `SELECT COUNT(DISTINCT customer_code)::int AS customers, COALESCE(SUM(orders), 0)::int AS orders
       FROM public.odg_sale_customer_month WHERE ${customerWhere}`,
      customerParams,
    ),
    one(
      `WITH scoped AS (
        SELECT customer_code, (yeardoc * 12 + monthdoc) AS ym
        FROM public.odg_sale_customer_month
        WHERE (yeardoc < %s OR (yeardoc = %s AND monthdoc <= %s)) ${customerBuClause}
      ),
      current_customers AS (
        SELECT DISTINCT customer_code FROM scoped WHERE ym = %s
      ),
      previous_purchase AS (
        SELECT cc.customer_code, MAX(s.ym) AS last_ym
        FROM current_customers cc
        LEFT JOIN scoped s ON s.customer_code = cc.customer_code AND s.ym < %s
        GROUP BY cc.customer_code
      )
      SELECT
        COUNT(*) FILTER (WHERE last_ym IS NOT NULL AND %s - last_ym >= 3)::int AS reactive_customers,
        COUNT(*)::int AS current_customers
      FROM previous_purchase`,
      [
        yearVal,
        yearVal,
        selectedMonthVal,
        ...customerBuParams,
        historicalFilters.selectedYm,
        historicalFilters.selectedYm,
        historicalFilters.selectedYm,
      ],
    ),
  ]);

  // ── Process Batch 1 results ──
  const ytdActual = Number(kpiComboRow?.ytd_actual || 0);
  const thisMonthActual = Number(kpiComboRow?.this_month_actual || 0);
  const thisMonthLastYear = Number(thisMonthLastYearRow?.total || 0);
  const lastMonthActual = Number(lastMonthActualRow?.total || 0);
  const ytdLastYear = Number(ytdLastYearRow?.total || 0);

  // Derive target totals from monthly rows
  const targetMap = Object.fromEntries(
    targetRowsResult.map((row) => [Number(row.month), Number(row.target || 0)]),
  );
  // YTD must compare like with like: actuals only exist up to the elapsed
  // month, so the target is summed over the same months. A past year is fully
  // elapsed, a future year has nothing elapsed yet.
  const elapsedMonth =
    yearVal < now.getFullYear() ? 12 : yearVal > now.getFullYear() ? 0 : currentMonthVal;
  const ytdTarget = targetRowsResult.reduce(
    (sum, row) => (Number(row.month) <= elapsedMonth ? sum + Number(row.target || 0) : sum),
    0,
  );
  const thisMonthTarget = Number(targetMap[selectedMonthVal] || 0);
  const lastMonthTarget = Number(targetMap[lastMonthVal] || 0);

  // Monthly actual + cash/credit from combined query
  const actualMap = {};
  const cashCreditMap = {};
  for (const row of monthlyDetailRows) {
    const m = Number(row.month);
    actualMap[m] = Number(row.actual || 0);
    cashCreditMap[m] = { cash: Number(row.cash || 0), credit: Number(row.credit || 0) };
  }
  const cashCreditTotal = { cash: Number(kpiComboRow?.cash_total || 0), credit: Number(kpiComboRow?.credit_total || 0) };
  const thisMonthCash = Number(cashCreditMap[selectedMonthVal]?.cash || 0);
  const thisMonthCredit = Number(cashCreditMap[selectedMonthVal]?.credit || 0);
  const lastMonthCash = Number(cashCreditMap[lastMonthVal]?.cash || 0);
  const lastMonthCredit = Number(cashCreditMap[lastMonthVal]?.credit || 0);
  const lastYearMap = Object.fromEntries(
    lastYearRows.map((row) => [Number(row.month), Number(row.actual || 0)]),
  );
  const last2YearMap = Object.fromEntries(
    last2YearRows.map((row) => [Number(row.month), Number(row.actual || 0)]),
  );
  const buChannel = (buChannelResult || []).map((row) => ({
    bu: row.bu,
    channel: CHANNEL_NAMES[row.channel_code] || row.channel_code,
    amount: Number(row.amount || 0),
  }));

  const counts = { customers: Number(countsRow?.customers || 0), orders: Number(countsRow?.orders || 0) };

  const provinceTargetMap = Object.fromEntries(
    provinceTargetRows.map((row) => [String(row.province_code), Number(row.target || 0)]),
  );
  const provinceRows = provinceActualRows.map((row) => {
    const code = String(row.province_code ?? "").trim();
    const targetValue = Number(provinceTargetMap[code] || 0);
    const actualValue = Number(row.actual || 0);
    const achPct = safeDiv(actualValue, targetValue) * 100;
    const gap = targetValue - actualValue;
    return {
      code,
      // Sales without a province still belong in the totals, but they are not a
      // territory — name them so they never show up as a blank row.
      unassigned: !code,
      label: (code ? row.label || code : "") || "ບໍ່ລະບຸແຂວງ",
      actual: actualValue,
      target: targetValue,
      achPct,
      gap,
      coveragePct: targetValue ? Math.min(Math.round(achPct), 100) : 0,
    };
  });

  // Process dynamicChannelMap from ar_group rows
  const dynamicChannelMap = (arGroupRows || []).reduce((accumulator, row) => {
    const code = row.code == null ? null : String(row.code);
    if (!code) return accumulator;
    const name = row.name_1 == null ? code : String(row.name_1);
    accumulator[code] = { names: [name], codes: [code] };
    accumulator[name] = { names: [name], codes: [code] };
    return accumulator;
  }, {});

  const channelNames = [];
  const channelCodes = [];
  if (channel && channel !== "ALL") {
    const channelValues =
      typeof channel === "string" ? channel.split(",").filter(Boolean) : [...channel];
    for (const entry of channelValues) {
      const mapped = dynamicChannelMap[entry] || { names: [entry], codes: [entry] };
      channelNames.push(...mapped.names);
      channelCodes.push(...mapped.codes);
    }
  }

  const assignFilters = [];
  const assignParams = [];
  if (bu && bu !== "ALL") {
    assignFilters.push("a.bu_code = %s");
    assignParams.push(bu);
  }
  if (province && province !== "ALL") {
    const provinceValues =
      typeof province === "string" ? province.split(",").filter(Boolean) : [...province];
    assignFilters.push("a.province_code = ANY(%s)");
    assignParams.push(provinceValues);
  }
  if (month && String(month) !== "ALL") {
    const monthValue = parseIntSafe(month);
    if (monthValue) {
      assignFilters.push("a.month = %s");
      assignParams.push(monthValue);
    }
  }
  const assignWhere = assignFilters.length ? `WHERE ${assignFilters.join(" AND ")}` : "";

  // The rollup already carries normalized channel codes.
  let channelClauseMonthly = "";
  let channelParamsMonthly = [];
  if (channelCodes.length) {
    channelClauseMonthly = " AND m.channel_code = ANY(%s)";
    channelParamsMonthly = [channelCodes];
  }
  let channelClauseTarget = "";
  let channelParamsTarget = [];
  if (channelCodes.length || channelNames.length) {
    channelClauseTarget =
      " AND (st.sale_channel = ANY(%s) OR st.sale_channel = ANY(%s))";
    channelParamsTarget = [channelCodes.length ? channelCodes : channelNames, channelNames.length ? channelNames : channelCodes];
  }

  // Process saleDetailColumns
  const saleDetailCols = saleDetailSchema.columnSet;
  const custNameExpr = saleDetailSchema.custNameCol
    ? `COALESCE(NULLIF(${saleDetailSchema.custNameCol}, ''), customer_code)`
    : "customer_code";
  const costThbExpr = saleDetailSchema.costCol
    ? `COALESCE(SUM(${saleDetailSchema.costCol}), 0)::float`
    : "0::float";
  const costLaoExpr = saleDetailCols.has("sum_cost_thb_vte")
    ? "COALESCE(SUM(sum_cost_thb_vte), 0)::float"
    : "0::float";
  const brandCol = saleDetailCols.has("item_brand") ? "item_brand" : null;

  // ── Batch 2: Queries that depend on Batch 1 results ──
  const [teamActualRows, teamTargetRows, buProfitRows, subgroupRows, topCustomerRows] = await Promise.all([
    rows(
      `SELECT a.sale_id,
        COALESCE(NULLIF(a.sale_name, ''), a.sale_id) AS sale_name,
        COALESCE(SUM(m.sum_amount), 0)::float AS actual
       FROM public.odg_sales_assignment a
       LEFT JOIN ${MONTHLY_TABLE} m
         ON m.yeardoc = %s AND m.monthdoc = a.month AND m.bu_code = a.bu_code
         AND (a.province_code = 'ALL' OR m.province = a.province_code)
         AND (a.district_code = 'ALL' OR m.amper = a.district_code)
         ${channelClauseMonthly}
       ${assignWhere}
       GROUP BY a.sale_id, sale_name`,
      [yearVal, ...channelParamsMonthly, ...assignParams],
    ),
    rows(
      `SELECT a.sale_id,
        COALESCE(NULLIF(a.sale_name, ''), a.sale_id) AS sale_name,
        COALESCE(SUM(st.target_amount), 0)::float AS target
       FROM public.odg_sales_assignment a
       LEFT JOIN public.odg_sales_target st
         ON st.target_year = %s AND st.target_month = a.month AND st.bu_code = a.bu_code
         AND (a.province_code = 'ALL' OR st.province_code = a.province_code)
         AND (a.district_code = 'ALL' OR st.district_code = a.district_code)
         ${channelClauseTarget}
       ${assignWhere}
       GROUP BY a.sale_id, sale_name`,
      [yearVal, ...channelParamsTarget, ...assignParams],
    ),
    rows(
      `SELECT bu_code AS bu, COALESCE(SUM(sum_amount), 0)::float AS revenue,
        ${costThbExpr} AS cost_thb, ${costLaoExpr} AS cost_lao
       FROM public.odg_sale_detail WHERE ${detailWhere}
       GROUP BY bu ORDER BY revenue DESC NULLS LAST`,
      detailParams,
    ),
    rows(
      `SELECT COALESCE(NULLIF(itemmaingroup, ''), 'UNKNOWN') AS group_name,
        COALESCE(NULLIF(itemsubgroup, ''), 'UNKNOWN') AS subgroup_name,
        COALESCE(SUM(sum_amount), 0)::float AS revenue,
        ${costThbExpr} AS cost_thb, ${costLaoExpr} AS cost_lao
       FROM public.odg_sale_detail WHERE ${detailWhere}
       GROUP BY group_name, subgroup_name ORDER BY revenue DESC NULLS LAST`,
      detailParams,
    ),
    rows(
      `SELECT customer_code,
        ${custNameExpr} AS customer_name,
        COALESCE(SUM(sum_amount), 0)::float AS revenue,
        COUNT(DISTINCT doc_no)::int AS orders
       FROM public.odg_sale_detail
       WHERE ${detailWhere}
         AND customer_code IS NOT NULL
         AND customer_code != ''
       GROUP BY customer_code, ${custNameExpr}
       ORDER BY revenue DESC NULLS LAST
       LIMIT 10`,
      detailParams,
    ),
  ]);

  const buProfit = buProfitRows
    .map((row) => {
      const revenue = Number(row.revenue || 0);
      const costThb = Number(row.cost_thb || 0);
      const costLao = Number(row.cost_lao || 0);
      return {
        bu: row.bu,
        revenue,
        cost_thb: costThb,
        cost_lao: costLao,
        profit_thb: revenue - costThb,
        profit_lao: revenue - costLao,
        brands: [],
      };
    })
    .sort((left, right) => right.profit_thb - left.profit_thb);

  if (brandCol) {
    const brandRows = await rows(
      `SELECT bu_code AS bu, COALESCE(NULLIF(${brandCol}, ''), 'UNKNOWN') AS brand,
        COALESCE(SUM(sum_amount), 0)::float AS revenue,
        ${costThbExpr} AS cost_thb, ${costLaoExpr} AS cost_lao
       FROM public.odg_sale_detail WHERE ${detailWhere}
       GROUP BY bu, brand ORDER BY revenue DESC NULLS LAST`,
      detailParams,
    );
    const brandMap = {};
    for (const row of brandRows) {
      const revenue = Number(row.revenue || 0);
      const costThb = Number(row.cost_thb || 0);
      const costLao = Number(row.cost_lao || 0);
      if (!brandMap[row.bu]) {
        brandMap[row.bu] = [];
      }
      brandMap[row.bu].push({
        brand: row.brand,
        revenue,
        cost_thb: costThb,
        cost_lao: costLao,
        profit_thb: revenue - costThb,
        profit_lao: revenue - costLao,
      });
    }
    for (const item of buProfit) {
      const brands = (brandMap[item.bu] || []).sort(
        (left, right) => right.profit_thb - left.profit_thb,
      );
      item.brands = brands.slice(0, 10);
    }
  }

  const groupMap = {};
  for (const row of subgroupRows) {
    const revenue = Number(row.revenue || 0);
    const costThb = Number(row.cost_thb || 0);
    const costLao = Number(row.cost_lao || 0);
    const profitThb = revenue - costThb;
    const profitLao = revenue - costLao;
    if (!groupMap[row.group_name]) {
      groupMap[row.group_name] = {
        group: row.group_name,
        revenue: 0,
        cost_thb: 0,
        cost_lao: 0,
        profit_thb: 0,
        profit_lao: 0,
        subgroups: [],
      };
    }
    groupMap[row.group_name].revenue += revenue;
    groupMap[row.group_name].cost_thb += costThb;
    groupMap[row.group_name].cost_lao += costLao;
    groupMap[row.group_name].profit_thb += profitThb;
    groupMap[row.group_name].profit_lao += profitLao;
    groupMap[row.group_name].subgroups.push({
      subgroup: row.subgroup_name,
      revenue,
      cost_thb: costThb,
      cost_lao: costLao,
      profit_thb: profitThb,
      profit_lao: profitLao,
    });
  }

  let groupProfit = Object.values(groupMap).sort(
    (left, right) => right.profit_thb - left.profit_thb,
  );
  const totalGroupProfit = groupProfit.reduce(
    (sum, item) => sum + Number(item.profit_thb || 0),
    0,
  );
  groupProfit = groupProfit.slice(0, 10).map((item) => ({
    ...item,
    profit_pct: totalGroupProfit
      ? safeDiv(item.profit_thb, totalGroupProfit) * 100
      : 0,
    subgroups: item.subgroups
      .slice()
      .sort((left, right) => right.profit_thb - left.profit_thb)
      .slice(0, 10),
  }));

  const kpi = {
    year: yearVal,
    ytd_actual: ytdActual,
    ytd_target: ytdTarget,
    ytd_last_year: ytdLastYear,
    this_month_actual: thisMonthActual,
    this_month_target: thisMonthTarget,
    this_month_last_year: thisMonthLastYear,
    last_month_actual: lastMonthActual,
    last_month_target: lastMonthTarget,
    cash_ytd_actual: Number(cashCreditTotal.cash || 0),
    credit_ytd_actual: Number(cashCreditTotal.credit || 0),
    this_month_cash: thisMonthCash,
    this_month_credit: thisMonthCredit,
    last_month_cash: lastMonthCash,
    last_month_credit: lastMonthCredit,
  };

  const trend = [];
  for (let monthIndex = 1; monthIndex <= 12; monthIndex += 1) {
    const cashCredit = cashCreditMap[monthIndex] || {};
    trend.push({
      month: monthIndex,
      name: monthName(monthIndex),
      target: Number(targetMap[monthIndex] || 0),
      actual: Number(actualMap[monthIndex] || 0),
      lastYear: Number(lastYearMap[monthIndex] || 0),
      last2Year: Number(last2YearMap[monthIndex] || 0),
      cash: Number(cashCredit.cash || 0),
      credit: Number(cashCredit.credit || 0),
    });
  }

  const totalActual = ytdActual || 0;
  const totalTarget = ytdTarget || 0;
  const coveragePct = totalTarget
    ? Math.min(Math.round(safeDiv(totalActual, totalTarget) * 100), 100)
    : 0;

  const teamMap = {};
  for (const row of teamActualRows) {
    teamMap[String(row.sale_id)] = {
      name: row.sale_name,
      actual: Number(row.actual || 0),
      target: 0,
    };
  }
  for (const row of teamTargetRows) {
    const key = String(row.sale_id);
    if (!teamMap[key]) {
      teamMap[key] = {
        name: row.sale_name,
        actual: 0,
        target: Number(row.target || 0),
      };
    } else {
      teamMap[key].target = Number(row.target || 0);
    }
  }

  const team = Object.values(teamMap)
    .map((item) => ({
      name: item.name,
      actual: item.actual,
      target: item.target,
      achPct: item.target ? safeDiv(item.actual, item.target) * 100 : 0,
    }))
    .sort((left, right) => right.actual - left.actual)
    .slice(0, 8);

  const customers = Number(counts.customers || 0);
  const orders = Number(counts.orders || 0);
  const topCustomers = (topCustomerRows || []).map((row) => ({
    code: row.customer_code,
    name: row.customer_name,
    revenue: Number(row.revenue || 0),
    orders: Number(row.orders || 0),
  }));
  const avgDeal = orders ? safeDiv(totalActual, orders) : 0;
  const ordersPerCustomer = customers ? safeDiv(orders, customers) : 0;
  const repeatCustomers = custRows.filter((row) => Number(row.cnt || 0) > 1).length;
  const totalCustomers = custRows.length || 0;
  const repeatPct = totalCustomers ? safeDiv(repeatCustomers, totalCustomers) * 100 : 0;
  // The complement of "bought more than once" is "bought exactly once" — not
  // a new customer, which is decided by purchase history, not order count.
  const singlePurchasePct = Math.max(0, 100 - repeatPct);
  const reactiveCustomers = Number(reactiveRow?.reactive_customers || 0);
  const currentMonthCustomers = Number(reactiveRow?.current_customers || 0);
  const reactivePct = currentMonthCustomers
    ? safeDiv(reactiveCustomers, currentMonthCustomers) * 100
    : 0;

  const arFilters = [];
  const arParams = [];
  if (bu && bu !== "ALL") {
    arFilters.push(
      "(a.department_name = %s OR a.department_name ILIKE %s OR sd.bu_code = %s OR sd.bu_name ILIKE %s)",
    );
    arParams.push(bu, `%${bu}%`, bu, `%${bu}%`);
  }
  if (province && province !== "ALL") {
    const provinceValues =
      typeof province === "string" ? province.split(",").filter(Boolean) : [...province];
    if (provinceValues.length) {
      arFilters.push("(logistic_area = ANY(%s) OR logistic_area ILIKE ANY(%s))");
      arParams.push(provinceValues, provinceValues.map((item) => `%${item}%`));
    }
  }
  const arWhere = arFilters.length ? `WHERE ${arFilters.join(" AND ")}` : "";

  // ── Batch 3: AR + Stock queries in parallel ──
  // Dedup scan over every sale row; only pay for it where `sd` is actually read.
  // doc_no maps to at most one (bu_code, bu_name), so the LEFT JOIN never fans out
  // and dropping it leaves the aggregates unchanged.
  const arBuLookup = `LEFT JOIN (SELECT DISTINCT doc_no, bu_code, bu_name FROM public.odg_sale_detail WHERE doc_no IS NOT NULL) sd ON sd.doc_no = a.doc_no`;
  const arJoin = arFilters.some((clause) => clause.includes("sd.")) ? arBuLookup : "";
  const stockJoin = `LEFT JOIN public.ic_inventory ic ON ic.code = a.ic_code LEFT JOIN public.ic_group mg ON mg.code = ic.group_main`;

  const [arResults, stockResults] = await Promise.all([
    Promise.all([
      rows(
        `SELECT a.overdue_group, COALESCE(SUM(a.balance_amount), 0)::float AS balance, COUNT(*) AS count
         FROM public.odg_ar_aging a ${arJoin} ${arWhere}
         GROUP BY a.overdue_group ORDER BY a.overdue_group`,
        arParams,
      ),
      rows(
        `SELECT COALESCE(NULLIF(a.department_name, ''), sd.bu_name, sd.bu_code, 'UNKNOWN') AS department,
          COALESCE(SUM(a.balance_amount), 0)::float AS balance, COUNT(*) AS count
         FROM public.odg_ar_aging a ${arBuLookup} ${arWhere}
         GROUP BY department ORDER BY balance DESC`,
        arParams,
      ),
      one(
        `SELECT COALESCE(SUM(a.balance_amount), 0)::float AS total
         FROM public.odg_ar_aging a ${arJoin} ${arWhere}`,
        arParams,
      ),
    ]).catch((error) => { console.error("ar_aging error:", error); return [[], [], {}]; }),
    Promise.all([
      one(`SELECT COALESCE(SUM(balance_qty), 0)::float AS total_qty,
        COALESCE(SUM(balance_amount), 0)::float AS total_value,
        CASE WHEN COALESCE(SUM(balance_qty), 0) = 0 THEN 0
          ELSE COALESCE(SUM(average_cost * balance_qty), 0)::float / SUM(balance_qty) END AS avg_cost
       FROM public.odg_stock_report`),
      rows(`SELECT a.ic_code, a.item_name, a.unit_code, a.balance_qty, a.balance_amount,
        a.average_cost, a.dim_8, ic.group_main, mg.name_1 AS group_main_name
       FROM public.odg_stock_report a ${stockJoin}
       ORDER BY a.balance_amount DESC NULLS LAST LIMIT 10`),
      rows(`SELECT a.ic_code, a.item_name, a.unit_code, a.balance_qty, a.balance_amount,
        a.average_cost, a.dim_8, ic.group_main, mg.name_1 AS group_main_name
       FROM public.odg_stock_report a ${stockJoin}
       ORDER BY a.balance_qty ASC NULLS LAST LIMIT 10`),
      rows(`SELECT COALESCE(NULLIF(dim_8, ''), 'ບໍ່ລະບຸສາງ') AS warehouse,
        COALESCE(SUM(balance_qty), 0)::float AS qty, COALESCE(SUM(balance_amount), 0)::float AS value
       FROM public.odg_stock_report GROUP BY warehouse ORDER BY value DESC NULLS LAST`),
      rows(`SELECT COALESCE(NULLIF(mg.name_1, ''), ic.group_main, 'ບໍ່ລະບຸກຸ່ມ') AS group_main_name,
        COALESCE(SUM(a.balance_qty), 0)::float AS qty, COALESCE(SUM(a.balance_amount), 0)::float AS value
       FROM public.odg_stock_report a ${stockJoin}
       GROUP BY group_main_name ORDER BY value DESC NULLS LAST`),
    ]).catch((error) => { console.error("stockSummary error:", error); return [{}, [], [], [], []]; }),
  ]);

  const [arBuckets = [], arByDepartment = [], arTotalRow2 = {}] = arResults;
  const arTotal = Number(arTotalRow2?.total || 0);

  const [stockRow = {}, stockTopValue = [], stockLowStock = [], stockByWarehouse = [], stockByGroup = []] = stockResults;
  const scopeDays = (() => {
    if (month && String(month) !== "ALL") {
      const fullMonthDays = new Date(yearVal, selectedMonthVal, 0).getDate();
      const isCurrentScope =
        yearVal === now.getFullYear() && selectedMonthVal === currentMonthVal;
      return isCurrentScope ? now.getDate() : fullMonthDays;
    }

    const yearDays = Math.round(
      (Date.UTC(yearVal + 1, 0, 1) - Date.UTC(yearVal, 0, 1)) / 86400000,
    );
    return yearVal === now.getFullYear()
      ? Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(yearVal, 0, 1)) / 86400000) + 1
      : yearDays;
  })();
  const scopedRevenueForAvgDay =
    month && String(month) !== "ALL"
      ? Number(actualMap[selectedMonthVal] || 0)
      : ytdActual;
  const stockSummary = {
    total_qty: Number(stockRow?.total_qty || 0),
    total_value: Number(stockRow?.total_value || 0),
    avg_cost: Number(stockRow?.avg_cost || 0),
    warehouse_count: (stockByWarehouse || []).length,
    avg_sales_per_day: scopeDays > 0 ? scopedRevenueForAvgDay / scopeDays : 0,
    top_value: stockTopValue || [],
    low_stock: stockLowStock || [],
    by_warehouse: stockByWarehouse || [],
    by_group: stockByGroup || [],
  };

  const result = {
    kpi,
    trend,
    structure: {
      buChannel: buChannel || [],
      buProfit,
      province: provinceRows,
    },
    territory: {
      // Ranked on achievement, so rows without a province target would sit at
      // the top of "risk" at a meaningless 0%.
      risk: provinceRows
        .filter((item) => !item.unassigned && item.target > 0 && item.achPct < 90)
        .sort((left, right) => left.achPct - right.achPct)
        .slice(0, 6),
      opportunity: provinceRows
        .filter((item) => !item.unassigned && item.target > 0 && item.achPct >= 100)
        .sort((left, right) => right.achPct - left.achPct)
        .slice(0, 6),
      coverage: [
        { name: "ເຂົ້າຢ້ຽມ", value: coveragePct },
        { name: "ບໍ່ທັນເຂົ້າ", value: Math.max(0, 100 - coveragePct) },
      ],
    },
    diagnose: {
      team,
      topCustomers,
      // No CRM pipeline is recorded anywhere, so only measures that come out of
      // real invoices are published here.
      conversion: {
        avgDeal,
        ordersPerCustomer,
      },
    },
    product: {
      topRevenue: topRevenue || [],
      topMargin: topMargin || [],
      groupProfit,
      quality: {
        repeatPct,
        singlePurchasePct,
        reactiveCustomers,
        reactivePct,
      },
    },
    ar_aging: {
      total: arTotal,
      buckets: arBuckets,
      by_department: arByDepartment,
    },
    stock: stockSummary,
    actions: buildActionsFromKpi(kpi),
    payment: {
      cash: Number(cashCreditTotal.cash || 0),
      credit: Number(cashCreditTotal.credit || 0),
    },
  };

  return result;
}
