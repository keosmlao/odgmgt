import { NextResponse } from "next/server";
import { rows } from "@/lib/db";
import { parseIntSafe, safeDiv, CHANNEL_EXPR } from "@/lib/helpers";
import { buildFilters, channelMap } from "@/lib/filters";
import { getCurrentUser } from "@/lib/route-auth";
import { getSaleDetailSchema } from "@/lib/sale-detail-schema";
import { SALE_DETAIL_REPORTED, ensureReportedView } from "@/lib/sale-detail-view";

const cacheMap = new Map();
const TTL = 300_000;

function buildHistoricalDetailFilters(year, month, bu, channel, province) {
  const yearValue = parseIntSafe(year, new Date().getFullYear());
  const monthValue = parseIntSafe(month, new Date().getMonth() + 1);
  const selectedYm = yearValue * 12 + monthValue;
  const detailWhere = ["(yeardoc * 12 + monthdoc) <= %s"];
  const detailParams = [selectedYm];

  if (bu && bu !== "ALL") {
    detailWhere.push("bu_code = %s");
    detailParams.push(bu);
  }

  if (province && province !== "ALL") {
    const provinceValues =
      typeof province === "string" ? province.split(",").filter(Boolean) : [...province];
    if (provinceValues.length) {
      detailWhere.push("(province = ANY(%s) OR province_name = ANY(%s))");
      detailParams.push(provinceValues, provinceValues);
    }
  }

  if (channel && channel !== "ALL") {
    const channelValues =
      typeof channel === "string" ? channel.split(",").filter(Boolean) : [...channel];
    const names = [];
    for (const item of channelValues) {
      const mapped = channelMap[item] || { names: [item] };
      names.push(...mapped.names);
    }
    if (names.length) {
      detailWhere.push(
        "(channel_name = ANY(%s) OR argroup = ANY(%s) OR argroup_main = ANY(%s) OR argroupsub = ANY(%s))",
      );
      detailParams.push(names, names, names, names);
    }
  }

  return {
    detailWhere: detailWhere.join(" AND "),
    detailParams,
    selectedYm,
  };
}

function compactNumber(value) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number(value || 0));
}

function classifyChannel(marginPct, sharePct) {
  if (Number(marginPct || 0) < 10) {
    return {
      key: "repair",
      label: "Repair Margin",
      tone: "rose",
    };
  }
  if (Number(marginPct || 0) >= 18 && Number(sharePct || 0) < 25) {
    return {
      key: "expand",
      label: "Expand",
      tone: "emerald",
    };
  }
  return {
    key: "protect",
    label: "Protect",
    tone: "blue",
  };
}

export async function GET(request) {
  await ensureReportedView();
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
      if (Array.isArray(user.channel_codes) && user.channel_codes.length) {
        channel = user.channel_codes.map(String).join(",");
      }
    }

    const cacheKey = `${year}|${month}|${bu}|${channel}|${province}`;
    const cached = cacheMap.get(cacheKey);
    if (cached && Date.now() - cached.ts < TTL) {
      return NextResponse.json(cached.data);
    }

    const { detailWhere, detailParams, targetWhere, targetParams } = buildFilters(
      year,
      bu,
      channel,
      province,
    );
    const { detailWhere: currentWhere, detailParams: currentParams } = buildFilters(
      year,
      bu,
      channel,
      province,
      month,
    );

    let lastMonth = month - 1;
    let lastMonthYear = year;
    if (lastMonth <= 0) {
      lastMonth = 12;
      lastMonthYear = year - 1;
    }
    const { detailWhere: lastWhere, detailParams: lastParams } = buildFilters(
      lastMonthYear,
      bu,
      channel,
      province,
      lastMonth,
    );
    const historicalFilters = buildHistoricalDetailFilters(year, month, bu, channel, province);

    const { custNameCol, costCol } = await getSaleDetailSchema();
    const custNameExpr = custNameCol
      ? `COALESCE(NULLIF(${custNameCol}, ''), customer_code)`
      : "customer_code";
    const profitExpr = costCol
      ? `COALESCE(SUM(sum_amount),0)::float - COALESCE(SUM(${costCol}),0)::float`
      : `COALESCE(SUM(profit),0)::float`;
    const marginExpr = costCol
      ? `CASE WHEN COALESCE(SUM(sum_amount),0)>0 THEN (COALESCE(SUM(sum_amount),0)-COALESCE(SUM(${costCol}),0))/SUM(sum_amount)*100 ELSE 0 END`
      : `CASE WHEN COALESCE(SUM(sum_amount),0)>0 THEN COALESCE(SUM(profit),0)/SUM(sum_amount)*100 ELSE 0 END`;

    const [provinceGapRows, lostCustomerRows, reactiveCustomerRows, channelRows] =
      await Promise.all([
        rows(
          `WITH actual AS (
             SELECT province AS province_code,
               COALESCE(NULLIF(province_name, ''), province, 'UNKNOWN') AS province_name,
               COALESCE(SUM(sum_amount), 0)::float AS actual
             FROM ${SALE_DETAIL_REPORTED}
             WHERE ${detailWhere}
             GROUP BY province, COALESCE(NULLIF(province_name, ''), province, 'UNKNOWN')
           ),
           target AS (
             SELECT province_code,
               COALESCE(SUM(target_amount), 0)::float AS target
             FROM public.odg_sales_target
             WHERE ${targetWhere}
             GROUP BY province_code
           )
           SELECT
             COALESCE(a.province_code, t.province_code, 'UNKNOWN') AS province_code,
             COALESCE(NULLIF(a.province_name, ''), t.province_code, 'UNKNOWN') AS province_name,
             COALESCE(a.actual, 0)::float AS actual,
             COALESCE(t.target, 0)::float AS target,
             (COALESCE(t.target, 0) - COALESCE(a.actual, 0))::float AS gap,
             CASE
               WHEN COALESCE(t.target, 0) > 0
               THEN COALESCE(a.actual, 0) / t.target * 100
               ELSE 0
             END AS ach_pct
           FROM target t
           FULL OUTER JOIN actual a ON a.province_code = t.province_code
           WHERE COALESCE(a.actual, 0) > 0 OR COALESCE(t.target, 0) > 0
           ORDER BY gap DESC, actual DESC`,
          [...detailParams, ...targetParams],
        ),
        rows(
          `WITH last_m AS (
             SELECT customer_code,
               ${custNameExpr} AS customer_name,
               COALESCE(SUM(sum_amount), 0)::float AS last_revenue,
               COUNT(DISTINCT doc_no)::int AS orders
             FROM ${SALE_DETAIL_REPORTED}
             WHERE ${lastWhere}
               AND customer_code IS NOT NULL
               AND customer_code != ''
             GROUP BY customer_code, ${custNameExpr}
           ),
           this_m AS (
             SELECT DISTINCT customer_code
             FROM ${SALE_DETAIL_REPORTED}
             WHERE ${currentWhere}
               AND customer_code IS NOT NULL
               AND customer_code != ''
           )
           SELECT
             l.customer_code,
             l.customer_name,
             l.last_revenue,
             l.orders
           FROM last_m l
           LEFT JOIN this_m t ON t.customer_code = l.customer_code
           WHERE t.customer_code IS NULL
           ORDER BY l.last_revenue DESC`,
          [...lastParams, ...currentParams],
        ),
        rows(
          `WITH scoped AS (
             SELECT customer_code, (yeardoc * 12 + monthdoc) AS ym
             FROM ${SALE_DETAIL_REPORTED}
             WHERE customer_code IS NOT NULL
               AND customer_code != ''
               AND ${historicalFilters.detailWhere}
           ),
           current_month AS (
             SELECT customer_code,
               ${custNameExpr} AS customer_name,
               COALESCE(SUM(sum_amount), 0)::float AS revenue,
               COUNT(DISTINCT doc_no)::int AS orders
             FROM ${SALE_DETAIL_REPORTED}
             WHERE ${currentWhere}
               AND customer_code IS NOT NULL
               AND customer_code != ''
             GROUP BY customer_code, ${custNameExpr}
           ),
           previous_purchase AS (
             SELECT cm.customer_code, MAX(s.ym) AS last_ym
             FROM current_month cm
             LEFT JOIN scoped s
               ON s.customer_code = cm.customer_code
              AND s.ym < %s
             GROUP BY cm.customer_code
           )
           SELECT
             cm.customer_code,
             cm.customer_name,
             cm.revenue,
             cm.orders,
             GREATEST((%s - pp.last_ym - 1), 0)::int AS idle_months
           FROM current_month cm
           JOIN previous_purchase pp ON pp.customer_code = cm.customer_code
           WHERE pp.last_ym IS NOT NULL
             AND %s - pp.last_ym >= 3
           ORDER BY cm.revenue DESC`,
          [
            ...historicalFilters.detailParams,
            ...currentParams,
            historicalFilters.selectedYm,
            historicalFilters.selectedYm,
            historicalFilters.selectedYm,
          ],
        ),
        rows(
          `SELECT
             ${CHANNEL_EXPR} AS channel,
             COALESCE(SUM(sum_amount), 0)::float AS revenue,
             ${profitExpr} AS profit,
             ${marginExpr} AS margin_pct
           FROM ${SALE_DETAIL_REPORTED}
           WHERE ${detailWhere}
           GROUP BY COALESCE(NULLIF(channel_name, ''), argroup, argroup_main, argroupsub, 'UNKNOWN')
           ORDER BY revenue DESC`,
          detailParams,
        ),
      ]);

    const whitespaceProvincesAll = (provinceGapRows || [])
      .map((row) => ({
        code: row.province_code,
        province: row.province_name,
        actual: Number(row.actual || 0),
        target: Number(row.target || 0),
        gap: Number(row.gap || 0),
        achPct: Number(row.ach_pct || 0),
      }))
      .filter((row) => row.gap > 0);
    const whitespaceProvinces = whitespaceProvincesAll.slice(0, 6);

    const lostCustomersAll = (lostCustomerRows || []).map((row) => ({
      customerCode: row.customer_code,
      customerName: row.customer_name,
      revenue: Number(row.last_revenue || 0),
      orders: Number(row.orders || 0),
    }));
    const lostCustomers = lostCustomersAll.slice(0, 6);

    const reactivatedCustomersAll = (reactiveCustomerRows || []).map((row) => ({
      customerCode: row.customer_code,
      customerName: row.customer_name,
      revenue: Number(row.revenue || 0),
      orders: Number(row.orders || 0),
      idleMonths: Number(row.idle_months || 0),
    }));
    const reactivatedCustomers = reactivatedCustomersAll.slice(0, 6);

    const totalChannelRevenue = (channelRows || []).reduce(
      (sum, row) => sum + Number(row.revenue || 0),
      0,
    );
    const channelStrategyAll = (channelRows || []).map((row) => {
      const revenue = Number(row.revenue || 0);
      const profit = Number(row.profit || 0);
      const marginPct = Number(row.margin_pct || 0);
      const sharePct = totalChannelRevenue ? safeDiv(revenue, totalChannelRevenue) * 100 : 0;
      const strategy = classifyChannel(marginPct, sharePct);
      return {
        channel: row.channel,
        revenue,
        profit,
        marginPct,
        sharePct,
        strategy: strategy.label,
        strategyKey: strategy.key,
        tone: strategy.tone,
      };
    });
    const channelStrategy = channelStrategyAll.slice(0, 6);

    const whitespaceGap = whitespaceProvincesAll.reduce(
      (sum, item) => sum + Math.max(Number(item.gap || 0), 0),
      0,
    );
    const lostRevenue = lostCustomersAll.reduce((sum, item) => sum + Number(item.revenue || 0), 0);
    const reactivatedRevenue = reactivatedCustomersAll.reduce(
      (sum, item) => sum + Number(item.revenue || 0),
      0,
    );
    const bestChannel =
      channelStrategyAll
        .filter((item) => item.revenue > 0)
        .slice()
        .sort((left, right) => right.marginPct - left.marginPct)[0] || null;
    const weakestChannel =
      channelStrategyAll
        .filter((item) => item.revenue > 0)
        .slice()
        .sort((left, right) => left.marginPct - right.marginPct)[0] || null;

    const recommendations = [];
    if (whitespaceProvinces.length > 0) {
      recommendations.push({
        priority: "high",
        title: "ປິດ gap ແຂວງກ່ອນ",
        detail: `${whitespaceProvinces
          .slice(0, 3)
          .map((item) => item.province)
          .join(", ")} ຍັງຂາດລວມ ${compactNumber(
          whitespaceProvinces.slice(0, 3).reduce((sum, item) => sum + item.gap, 0),
        )}`,
      });
    }
    if (lostCustomers.length > 0) {
      recommendations.push({
        priority: "high",
        title: "ກູ້ລາຍຮັບທີ່ຫາຍໄປ",
        detail: `${lostCustomers[0].customerName} ແລະກຸ່ມລູກຄ້າທີ່ຢຸດຊື້ ຄິດເປັນ ${compactNumber(
          lostRevenue,
        )} ຂອງເດືອນກ່ອນ`,
      });
    }
    if (bestChannel) {
      recommendations.push({
        priority: "medium",
        title: "ລົງທຶນໃນ channel ກຳໄລດີ",
        detail: `${bestChannel.channel} margin ${bestChannel.marginPct.toFixed(
          1,
        )}% ແລະຖື share ${bestChannel.sharePct.toFixed(1)}%`,
      });
    }
    if (weakestChannel) {
      recommendations.push({
        priority: "medium",
        title: "ກວດລາຄາຂາຍ ຫຼື mix ໃນ channel ກຳໄລຕ່ຳ",
        detail: `${weakestChannel.channel} margin ${weakestChannel.marginPct.toFixed(1)}% ຕ້ອງກວດ discount ແລະ product mix`,
      });
    }

    const result = {
      focus: {
        whitespaceGap,
        opportunityProvinces: whitespaceProvincesAll.length,
        lostRevenue,
        lostCustomers: lostCustomersAll.length,
        reactivatedRevenue,
        reactivatedCustomers: reactivatedCustomersAll.length,
        bestChannel,
        weakestChannel,
      },
      whitespaceProvinces,
      customerMovement: {
        lostCustomers,
        reactivatedCustomers,
      },
      channelStrategy,
      recommendations,
    };

    cacheMap.set(cacheKey, { ts: Date.now(), data: result });
    return NextResponse.json(result);
  } catch (error) {
    console.error("owner insights API error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
