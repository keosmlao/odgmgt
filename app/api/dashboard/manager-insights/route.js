import { NextResponse } from "next/server";
import { rows } from "@/lib/db";
import { parseIntSafe, safeDiv } from "@/lib/helpers";
import { buildFilters, channelMap } from "@/lib/filters";
import { ensureSalesAssignmentTable } from "@/lib/migrations";
import { getCurrentUser } from "@/lib/route-auth";
import { getSaleDetailSchema } from "@/lib/sale-detail-schema";

const cacheMap = new Map();
const TTL = 300_000;

function summarizeSegment(rowsList) {
  const totals = rowsList.reduce(
    (accumulator, row) => {
      accumulator.count += 1;
      accumulator.revenue += Number(row.revenue || 0);
      return accumulator;
    },
    { count: 0, revenue: 0 },
  );
  return totals;
}

export async function GET(request) {
  try {
    const sp = request.nextUrl.searchParams;
    const now = new Date();
    const year = parseIntSafe(sp.get("year"), now.getFullYear());
    const currentMonth = now.getMonth() + 1;

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

    const cacheKey = `${year}|${currentMonth}|${bu}|${channel}|${province}`;
    const cached = cacheMap.get(cacheKey);
    if (cached && Date.now() - cached.ts < TTL) {
      return NextResponse.json(cached.data);
    }

    const { detailWhere, detailParams } = buildFilters(year, bu, channel, province);

    const assignFilters = [];
    const assignParams = [];
    if (bu && bu !== "ALL") {
      assignFilters.push("a.bu_code = %s");
      assignParams.push(bu);
    }
    if (province && province !== "ALL") {
      const provinceValues =
        typeof province === "string" ? province.split(",").filter(Boolean) : [...province];
      if (provinceValues.length) {
        assignFilters.push("a.province_code = ANY(%s)");
        assignParams.push(provinceValues);
      }
    }
    const assignWhere = assignFilters.length ? `WHERE ${assignFilters.join(" AND ")}` : "";

    const [saleDetailSchema, arGroupRows] = await Promise.all([
      getSaleDetailSchema(),
      rows(`
        SELECT code, name_1
        FROM public.ar_group
        WHERE code NOT IN ('10', '9', '104', '105')
      `).catch(() => []),
    ]);

    const custNameExpr = saleDetailSchema.custNameCol
      ? `COALESCE(NULLIF(${saleDetailSchema.custNameCol}, ''), customer_code)`
      : "customer_code";
    const profitExpr = saleDetailSchema.costCol
      ? `COALESCE(SUM(sum_amount),0)::float - COALESCE(SUM(${saleDetailSchema.costCol}),0)::float`
      : `COALESCE(SUM(profit),0)::float`;
    const marginExpr = saleDetailSchema.costCol
      ? `CASE WHEN COALESCE(SUM(sum_amount),0)>0 THEN (COALESCE(SUM(sum_amount),0)-COALESCE(SUM(${saleDetailSchema.costCol}),0))/SUM(sum_amount)*100 ELSE 0 END`
      : `CASE WHEN COALESCE(SUM(sum_amount),0)>0 THEN COALESCE(SUM(profit),0)/SUM(sum_amount)*100 ELSE 0 END`;
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
        const mapped =
          dynamicChannelMap[entry] ||
          channelMap[entry] || { names: [entry], codes: [entry] };
        channelNames.push(...mapped.names);
        channelCodes.push(...mapped.codes);
      }
    }

    let channelClauseDetail = "";
    let channelParamsDetail = [];
    if (channelNames.length) {
      channelClauseDetail =
        " AND (d.channel_name = ANY(%s) OR d.argroup = ANY(%s) OR d.argroup_main = ANY(%s) OR d.argroupsub = ANY(%s))";
      channelParamsDetail = [channelNames, channelNames, channelNames, channelNames];
    }
    let channelClauseTarget = "";
    let channelParamsTarget = [];
    if (channelCodes.length || channelNames.length) {
      channelClauseTarget =
        " AND (st.sale_channel = ANY(%s) OR st.sale_channel = ANY(%s))";
      channelParamsTarget = [
        channelCodes.length ? channelCodes : channelNames,
        channelNames.length ? channelNames : channelCodes,
      ];
    }

    const [
      teamActualRows,
      teamTargetRows,
      customerRows,
      salespersonRows,
      branchRows,
      heatmapRows,
    ] = await Promise.all([
      ensureSalesAssignmentTable().then(() =>
        rows(
          `SELECT a.sale_id,
             COALESCE(NULLIF(a.sale_name, ''), a.sale_id) AS sale_name,
             COALESCE(SUM(d.sum_amount), 0)::float AS actual,
             COALESCE(SUM(CASE WHEN a.month = %s THEN d.sum_amount ELSE 0 END), 0)::float AS month_actual,
             COUNT(DISTINCT CASE WHEN a.month = %s THEN d.doc_no END)::int AS month_orders,
             COUNT(DISTINCT CASE WHEN a.month = %s THEN d.customer_code END)::int AS month_customers,
             COUNT(DISTINCT d.doc_no)::int AS orders,
             COUNT(DISTINCT d.customer_code)::int AS customers,
             COALESCE(SUM(d.discount_amount + d.discount_amount_2), 0)::float AS discount_total
           FROM public.odg_sales_assignment a
           LEFT JOIN public.odg_sale_detail d
             ON d.yeardoc = %s
            AND d.monthdoc = a.month
            AND d.bu_code = a.bu_code
            AND (a.province_code = 'ALL' OR d.province = a.province_code)
            AND (a.district_code = 'ALL' OR d.amper = a.district_code)
           ${channelClauseDetail}
           ${assignWhere}
           GROUP BY a.sale_id, sale_name`,
          [currentMonth, currentMonth, currentMonth, year, ...channelParamsDetail, ...assignParams],
        ),
      ),
      ensureSalesAssignmentTable().then(() =>
        rows(
          `SELECT a.sale_id,
             COALESCE(NULLIF(a.sale_name, ''), a.sale_id) AS sale_name,
             COALESCE(SUM(st.target_amount), 0)::float AS target,
             COALESCE(SUM(CASE WHEN a.month = %s THEN st.target_amount ELSE 0 END), 0)::float AS month_target
           FROM public.odg_sales_assignment a
           LEFT JOIN public.odg_sales_target st
             ON st.target_year = %s
            AND st.target_month = a.month
            AND st.bu_code = a.bu_code
            AND (a.province_code = 'ALL' OR st.province_code = a.province_code)
            AND (a.district_code = 'ALL' OR st.district_code = a.district_code)
            ${channelClauseTarget}
           ${assignWhere}
           GROUP BY a.sale_id, sale_name`,
          [currentMonth, year, ...channelParamsTarget, ...assignParams],
        ),
      ),
      rows(
         `WITH customer_base AS (
           SELECT customer_code,
             ${custNameExpr} AS customer_name,
             COALESCE(SUM(sum_amount), 0)::float AS revenue,
             COUNT(DISTINCT doc_no)::int AS orders,
             COUNT(DISTINCT monthdoc)::int AS active_months,
             COALESCE(SUM(CASE WHEN monthdoc = %s THEN sum_amount ELSE 0 END), 0)::float AS current_month_revenue,
             MAX(CASE WHEN COALESCE(register_lineoa, '') LIKE '%ແລ້ວ%' THEN 1 ELSE 0 END)::int AS line_registered
           FROM public.odg_sale_detail
           WHERE ${detailWhere}
             AND customer_code IS NOT NULL
             AND customer_code != ''
           GROUP BY customer_code, ${custNameExpr}
         ),
         ranked AS (
           SELECT *,
             NTILE(10) OVER (ORDER BY revenue DESC NULLS LAST) AS revenue_band
           FROM customer_base
         )
         SELECT
           customer_code,
           customer_name,
           revenue,
           orders,
           active_months,
           current_month_revenue,
           line_registered,
           CASE WHEN orders > 0 THEN revenue / orders ELSE 0 END AS avg_order_value,
           CASE WHEN active_months > 0 THEN revenue / active_months ELSE 0 END AS avg_monthly_revenue,
           CASE
             WHEN revenue_band = 1 THEN 'VIP'
             WHEN revenue_band <= 3 THEN 'Growth'
             WHEN revenue_band <= 6 THEN 'Core'
             ELSE 'Small'
           END AS segment
         FROM ranked
         ORDER BY revenue DESC`,
        [currentMonth, ...detailParams],
      ),
      rows(
        `SELECT
           COALESCE(NULLIF(salename, ''), 'UNKNOWN') AS sales_name,
           COALESCE(SUM(sum_amount), 0)::float AS revenue,
           ${profitExpr} AS profit,
           ${marginExpr} AS margin_pct,
           COUNT(DISTINCT customer_code)::int AS customers,
           COUNT(DISTINCT doc_no)::int AS orders,
           COALESCE(SUM(discount_amount + discount_amount_2), 0)::float AS discount_total
         FROM public.odg_sale_detail
         WHERE ${detailWhere}
         GROUP BY COALESCE(NULLIF(salename, ''), 'UNKNOWN')
         ORDER BY revenue DESC`,
        detailParams,
      ),
      rows(
        `SELECT
           COALESCE(NULLIF(branch_name, ''), 'UNKNOWN') AS branch_name,
           COALESCE(SUM(sum_amount), 0)::float AS revenue,
           ${profitExpr} AS profit,
           ${marginExpr} AS margin_pct,
           COUNT(DISTINCT customer_code)::int AS customers,
           COUNT(DISTINCT doc_no)::int AS orders
         FROM public.odg_sale_detail
         WHERE ${detailWhere}
         GROUP BY COALESCE(NULLIF(branch_name, ''), 'UNKNOWN')
         ORDER BY revenue DESC`,
        detailParams,
      ),
      rows(
        `SELECT
           UPPER(COALESCE(NULLIF(dayname, ''), TO_CHAR(doc_date, 'DY'))) AS day_name,
           LPAD(SPLIT_PART(COALESCE(doc_time, '00:00'), ':', 1), 2, '0') || ':00' AS hour_slot,
           COALESCE(SUM(sum_amount), 0)::float AS revenue,
           COUNT(DISTINCT doc_no)::int AS orders
         FROM public.odg_sale_detail
         WHERE ${detailWhere}
           AND monthdoc = %s
         GROUP BY
           UPPER(COALESCE(NULLIF(dayname, ''), TO_CHAR(doc_date, 'DY'))),
           LPAD(SPLIT_PART(COALESCE(doc_time, '00:00'), ':', 1), 2, '0') || ':00'
         ORDER BY 1, 2`,
        [...detailParams, currentMonth],
      ),
    ]);

    const repMap = new Map();
    for (const row of teamActualRows || []) {
      repMap.set(String(row.sale_id), {
        saleId: String(row.sale_id),
        saleName: row.sale_name,
        ytdActual: Number(row.actual || 0),
        monthActual: Number(row.month_actual || 0),
        ytdOrders: Number(row.orders || 0),
        ytdCustomers: Number(row.customers || 0),
        monthOrders: Number(row.month_orders || 0),
        monthCustomers: Number(row.month_customers || 0),
        discountTotal: Number(row.discount_total || 0),
        ytdTarget: 0,
        monthTarget: 0,
      });
    }
    for (const row of teamTargetRows || []) {
      const key = String(row.sale_id);
      const current = repMap.get(key) || {
        saleId: key,
        saleName: row.sale_name,
        ytdActual: 0,
        monthActual: 0,
        ytdOrders: 0,
        ytdCustomers: 0,
        monthOrders: 0,
        monthCustomers: 0,
        discountTotal: 0,
        ytdTarget: 0,
        monthTarget: 0,
      };
      current.ytdTarget = Number(row.target || 0);
      current.monthTarget = Number(row.month_target || 0);
      repMap.set(key, current);
    }

    const repPerformance = [...repMap.values()]
      .map((item) => {
        const ytdAchPct = safeDiv(item.ytdActual, item.ytdTarget) * 100;
        const monthAchPct = safeDiv(item.monthActual, item.monthTarget) * 100;
        const monthGap = Math.max(Number(item.monthTarget || 0) - Number(item.monthActual || 0), 0);
        const ytdGap = Math.max(Number(item.ytdTarget || 0) - Number(item.ytdActual || 0), 0);
        const avgOrderValue = item.monthOrders ? item.monthActual / item.monthOrders : 0;
        const avgCustomerValue = item.monthCustomers ? item.monthActual / item.monthCustomers : 0;
        const discountPct = item.ytdActual ? safeDiv(item.discountTotal, item.ytdActual) * 100 : 0;
        return {
          saleId: item.saleId,
          saleName: item.saleName,
          actual: item.monthActual,
          target: item.monthTarget,
          achPct: monthAchPct,
          gap: monthGap,
          orders: item.monthOrders,
          customers: item.monthCustomers,
          monthActual: item.monthActual,
          monthTarget: item.monthTarget,
          monthAchPct,
          monthGap,
          ytdActual: item.ytdActual,
          ytdTarget: item.ytdTarget,
          ytdAchPct,
          ytdGap,
          ytdOrders: item.ytdOrders,
          ytdCustomers: item.ytdCustomers,
          avgOrderValue,
          avgCustomerValue,
          discountPct,
        };
      })
      .sort((left, right) => right.actual - left.actual);

    const teamCount = repPerformance.length;
    const onTrackReps = repPerformance.filter((item) => item.achPct >= 100).length;
    const riskReps = repPerformance.filter((item) => item.achPct < 90).length;
    const avgAchievement = teamCount
      ? repPerformance.reduce((sum, item) => sum + item.achPct, 0) / teamCount
      : 0;
    const totalRepRevenue = repPerformance.reduce((sum, item) => sum + item.actual, 0);
    const totalRepOrders = repPerformance.reduce((sum, item) => sum + item.orders, 0);

    const topPerformers = repPerformance
      .slice()
      .sort((left, right) => {
        if (right.achPct !== left.achPct) return right.achPct - left.achPct;
        return right.actual - left.actual;
      })
      .slice(0, 5);

    const needSupport = repPerformance
      .slice()
      .sort((left, right) => {
        if (left.achPct !== right.achPct) return left.achPct - right.achPct;
        if (right.gap !== left.gap) return right.gap - left.gap;
        return left.monthAchPct - right.monthAchPct;
      })
      .slice(0, 5);

    const customerCapacityAll = (customerRows || []).map((row) => {
      const revenue = Number(row.revenue || 0);
      const orders = Number(row.orders || 0);
      const activeMonths = Number(row.active_months || 0);
      const currentMonthRevenue = Number(row.current_month_revenue || 0);
      const avgOrderValue = Number(row.avg_order_value || 0);
      const avgMonthlyRevenue = Number(row.avg_monthly_revenue || 0);
      const potentialGap = Math.max(avgMonthlyRevenue - currentMonthRevenue, 0);
      return {
        customerCode: row.customer_code,
        customerName: row.customer_name,
        revenue,
        orders,
        activeMonths,
        currentMonthRevenue,
        avgOrderValue,
        avgMonthlyRevenue,
        potentialGap,
        segment: row.segment,
        lineStatus: Number(row.line_registered || 0) === 1 ? "Registered" : "Unregistered",
      };
    });
    const activeCustomers = customerCapacityAll.filter(
      (item) => Number(item.currentMonthRevenue || 0) > 0,
    ).length;

    const segmentOrder = ["VIP", "Growth", "Core", "Small"];
    const segments = segmentOrder.map((segment) => {
      const matched = customerCapacityAll.filter((item) => item.segment === segment);
      const { count, revenue } = summarizeSegment(matched);
      return {
        segment,
        customers: count,
        revenue,
        sharePct: customerCapacityAll.length
          ? safeDiv(revenue, customerCapacityAll.reduce((sum, item) => sum + item.revenue, 0)) * 100
          : 0,
      };
    });

    const topBuyers = customerCapacityAll.slice(0, 6);
    const growthOpportunities = customerCapacityAll
      .filter((item) => item.activeMonths >= 2 && item.potentialGap > 0)
      .sort((left, right) => right.potentialGap - left.potentialGap)
      .slice(0, 6);

    const salesperson360 = (salespersonRows || [])
      .map((row) => {
        const revenue = Number(row.revenue || 0);
        const customers = Number(row.customers || 0);
        const orders = Number(row.orders || 0);
        const discountTotal = Number(row.discount_total || 0);
        return {
          saleName: row.sales_name,
          revenue,
          profit: Number(row.profit || 0),
          marginPct: Number(row.margin_pct || 0),
          customers,
          orders,
          avgOrderValue: orders ? revenue / orders : 0,
          avgCustomerValue: customers ? revenue / customers : 0,
          discountPct: revenue ? safeDiv(discountTotal, revenue) * 100 : 0,
        };
      })
      .sort((left, right) => right.revenue - left.revenue);

    const branchPerformance = (branchRows || [])
      .map((row) => {
        const revenue = Number(row.revenue || 0);
        const orders = Number(row.orders || 0);
        return {
          branchName: row.branch_name,
          revenue,
          profit: Number(row.profit || 0),
          marginPct: Number(row.margin_pct || 0),
          customers: Number(row.customers || 0),
          orders,
          avgOrderValue: orders ? revenue / orders : 0,
        };
      })
      .sort((left, right) => right.revenue - left.revenue);

    const dayRank = { MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6, SUN: 7 };
    const dayTimeCells = (heatmapRows || []).map((row) => ({
      day: row.day_name,
      hour: row.hour_slot,
      revenue: Number(row.revenue || 0),
      orders: Number(row.orders || 0),
    }));
    const dayTimeHeatmap = {
      days: [...new Set(dayTimeCells.map((item) => item.day))]
        .sort((left, right) => (dayRank[left] || 99) - (dayRank[right] || 99)),
      hours: [...new Set(dayTimeCells.map((item) => item.hour))].sort(),
      cells: dayTimeCells,
      peakWindows: dayTimeCells
        .slice()
        .sort((left, right) => right.revenue - left.revenue)
        .slice(0, 4),
    };

    const lineRegisteredCustomers = customerCapacityAll.filter(
      (item) => item.lineStatus === "Registered",
    );
    const lineUnregisteredCustomers = customerCapacityAll.filter(
      (item) => item.lineStatus === "Unregistered",
    );
    const lineRegisteredRevenue = lineRegisteredCustomers.reduce(
      (sum, item) => sum + item.revenue,
      0,
    );
    const lineUnregisteredRevenue = lineUnregisteredCustomers.reduce(
      (sum, item) => sum + item.revenue,
      0,
    );
    const lineRegisteredOrders = lineRegisteredCustomers.reduce(
      (sum, item) => sum + item.orders,
      0,
    );
    const lineUnregisteredOrders = lineUnregisteredCustomers.reduce(
      (sum, item) => sum + item.orders,
      0,
    );
    const lineOa = {
      registeredCustomers: lineRegisteredCustomers.length,
      unregisteredCustomers: lineUnregisteredCustomers.length,
      registeredRevenue: lineRegisteredRevenue,
      unregisteredRevenue: lineUnregisteredRevenue,
      registeredRevenuePct:
        lineRegisteredRevenue + lineUnregisteredRevenue > 0
          ? safeDiv(lineRegisteredRevenue, lineRegisteredRevenue + lineUnregisteredRevenue) * 100
          : 0,
      registeredAvgRevenue: lineRegisteredCustomers.length
        ? lineRegisteredRevenue / lineRegisteredCustomers.length
        : 0,
      unregisteredAvgRevenue: lineUnregisteredCustomers.length
        ? lineUnregisteredRevenue / lineUnregisteredCustomers.length
        : 0,
      registeredAvgOrderValue: lineRegisteredOrders
        ? lineRegisteredRevenue / lineRegisteredOrders
        : 0,
      unregisteredAvgOrderValue: lineUnregisteredOrders
        ? lineUnregisteredRevenue / lineUnregisteredOrders
        : 0,
      repeatRateRegistered: lineRegisteredCustomers.length
        ? safeDiv(
            lineRegisteredCustomers.filter((item) => item.activeMonths > 1).length,
            lineRegisteredCustomers.length,
          ) * 100
        : 0,
      repeatRateUnregistered: lineUnregisteredCustomers.length
        ? safeDiv(
            lineUnregisteredCustomers.filter((item) => item.activeMonths > 1).length,
            lineUnregisteredCustomers.length,
          ) * 100
        : 0,
      topUnregistered: lineUnregisteredCustomers
        .slice()
        .sort((left, right) => right.revenue - left.revenue)
        .slice(0, 5),
    };

    const recommendations = [];
    if (needSupport.length > 0) {
      recommendations.push({
        priority: "high",
        title: "Coach ພະນັກງານທີ່ gap ສູງ",
        detail: `${needSupport
          .slice(0, 2)
          .map((item) => item.saleName)
          .join(", ")} ຍັງຕ່ຳກວ່າເປົ້າເດືອນ ແລະ pace ຍັງບໍ່ດີ`,
      });
    }
    if (growthOpportunities.length > 0) {
      recommendations.push({
        priority: "high",
        title: "ດັນລູກຄ້າທີ່ມີ buying power ສູງ",
        detail: `${growthOpportunities[0].customerName} ແລະກຸ່ມທີ່ມີ potential gap ສູງ ຄວນ follow-up ເພີ່ມ`,
      });
    }
    if (topPerformers.length > 0) {
      recommendations.push({
        priority: "medium",
        title: "ເອົາ best practice ຈາກ top performer",
        detail: `${topPerformers[0].saleName} ບັນລຸ ${topPerformers[0].achPct.toFixed(1)}% ຂອງເປົ້າເດືອນ ໃຫ້ແຊຣ໌ວິທີການຂາຍໃນທີມ`,
      });
    }
    if (lineOa.topUnregistered.length > 0) {
      recommendations.push({
        priority: "medium",
        title: "ປິດ gap LINE OA ໃນລູກຄ້າລາຍໃຫຍ່",
        detail: `${lineOa.topUnregistered[0].customerName} ແລະລູກຄ້າລາຍໃຫຍ່ທີ່ຍັງບໍ່ລົງ LINE OA ຄວນເຮັດ CRM follow-up`,
      });
    }

    const result = {
      summary: {
        teamCount,
        onTrackReps,
        riskReps,
        avgAchievement,
        avgRevenuePerRep: teamCount ? totalRepRevenue / teamCount : 0,
        avgOrderValue: totalRepOrders ? totalRepRevenue / totalRepOrders : 0,
        activeCustomers,
      },
      repPerformance,
      coaching: {
        topPerformers,
        needSupport,
      },
      customerCapacity: {
        segments,
        topBuyers,
        growthOpportunities,
      },
      salesperson360,
      branchPerformance,
      dayTimeHeatmap,
      lineOa,
      recommendations,
    };

    cacheMap.set(cacheKey, { ts: Date.now(), data: result });
    return NextResponse.json(result);
  } catch (error) {
    console.error("manager insights API error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
