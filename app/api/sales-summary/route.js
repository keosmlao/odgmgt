import { NextResponse } from "next/server";
import { rows } from "@/lib/db";
import { getCurrentUser } from "@/lib/route-auth";
import { buildFilters } from "@/lib/filters";
import { parseIntSafe, safeDiv, monthName, formatDate, monthRange, workingDaysBetween, CHANNEL_EXPR } from "@/lib/helpers";
import { ensureSalesAssignmentTable } from "@/lib/migrations";
import { SALE_DETAIL_REPORTED, ensureReportedView } from "@/lib/sale-detail-view";
import { SELLER_TABLE } from "@/lib/sale-monthly-sql.mjs";
import { sellerTargetSql } from "@/lib/sale-seller-target.mjs";
import { ensureFreshRollup } from "@/lib/sale-rollup";

// Cache 3 min
const cache = new Map();
const TTL = 180_000;

export async function GET(request) {
  await ensureReportedView();
  try {
    const sp = request.nextUrl.searchParams;
    let year = sp.get("year");
    let bu = sp.get("bu") || "ALL";
    let channel = sp.get("channel") || "ALL";
    let province = sp.get("province") || "ALL";
    const month = sp.get("month");

    const user = getCurrentUser(request) || {};
    if (user.role === "sale_bu_manager") {
      if (user.bu_code) bu = user.bu_code;
      if (Array.isArray(user.channel_codes) && user.channel_codes.length) channel = user.channel_codes.map(String).join(",");
    }

    const now = new Date();
    const yearVal = parseIntSafe(year, now.getFullYear());
    const monthVal = parseIntSafe(month, now.getMonth() + 1);

    const cacheKey = `${yearVal}|${monthVal}|${bu}|${channel}|${province}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < TTL) return NextResponse.json(cached.data);

    const { detailWhere, detailParams, targetWhere, targetParams } = buildFilters(yearVal, bu, channel, province, monthVal);

    const { start: startDate, end: endDate } = monthRange(yearVal, monthVal);
    const workingDays = workingDaysBetween(startDate, endDate);
    const today = new Date();
    const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    let workingLeft = 0;
    if (todayDate <= endDate) {
      workingLeft = workingDaysBetween(todayDate < startDate ? startDate : todayDate, endDate);
    }

    // YTD filters
    const ytdDetailWhere = detailWhere.replace("monthdoc = %s", "monthdoc <= %s");
    const ytdDetailParams = [...detailParams.slice(0, -1), monthVal];
    const ytdTargetWhere = targetWhere.replace("target_month = %s", "target_month <= %s");
    const ytdTargetParams = [...targetParams.slice(0, -1), monthVal];

    // Channel mapping + assignment filters (sync, no DB)
    const assignFilters = [];
    const assignParams = [];
    if (bu && bu !== "ALL") { assignFilters.push("a.bu_code = %s"); assignParams.push(bu); }
    if (province && province !== "ALL") {
      const vals = typeof province === "string" ? province.split(",").filter(Boolean) : [...province];
      assignFilters.push("a.province_code = ANY(%s)"); assignParams.push(vals);
    }
    if (monthVal) { assignFilters.push("a.month = %s"); assignParams.push(monthVal); }
    const assignWhere = assignFilters.length ? `WHERE ${assignFilters.join(" AND ")}` : "";

    const assignFiltersYtd = [...assignFilters.slice(0, -1)];
    const assignParamsYtd = [...assignParams.slice(0, -1)];
    if (monthVal) { assignFiltersYtd.push("a.month <= %s"); assignParamsYtd.push(monthVal); }
    const assignWhereYtd = assignFiltersYtd.length ? `WHERE ${assignFiltersYtd.join(" AND ")}` : "";

    // Channel clause for assignment joins
    // The rollups store a resolved ar_group code, so they filter on codes; the
    // plan table keeps whichever spelling was typed into it, code or name.
    let chClauseT = "", chParamsT = [], chClauseR = "", chParamsR = [];
    // Build from filter channel info
    if (channel && channel !== "ALL") {
      const chRows = await rows(`SELECT code, name_1 FROM public.ar_group WHERE code NOT IN ('10','9','104','105')`);
      const c2n = {}, n2c = {};
      for (const r of chRows) { if (r.code != null) { const c = String(r.code), n = r.name_1 == null ? c : String(r.name_1); c2n[c] = n; n2c[n] = c; } }
      const vals = typeof channel === "string" ? channel.split(",").filter(Boolean) : [channel];
      const names = [], codes = [];
      for (const v of vals) { names.push(c2n[String(v)] || String(v)); codes.push(n2c[String(v)] || String(v)); }
      if (codes.length || names.length) { chClauseT = " AND (st.sale_channel = ANY(%s) OR st.sale_channel = ANY(%s))"; chParamsT = [codes.length ? codes : names, names.length ? names : codes]; }
      if (codes.length) { chClauseR = " AND sm.channel_code = ANY(%s)"; chParamsR = [codes]; }
    }

    /**
     * Per-salesperson figures, both sides keyed on the person and not just on
     * their area.
     *
     * The assignment table now names every seller who actually sells in a
     * province rather than one owner per area, so several rows can cover the
     * same district. Summing that district's kip once per row counted the same
     * sale for each of them, and summing the plan once per row did the same to
     * the target — the by-sale table added up to several times the company.
     *
     * ຍອດຂາຍ therefore comes from the seller-grained rollup (`sm.sale_id =
     * a.sale_id`), and each plan row is divided between the assignments that
     * claim it. Both then add back up to the company total however the areas
     * are cut. Mirrors app/api/sales-assignments — keep the two in step.
     */
    const saleActualSql = (scope) => `
      SELECT a.sale_id, COALESCE(NULLIF(a.sale_name,''),a.sale_id) AS sale_name,
             COALESCE(SUM(sm.sum_amount),0)::float AS actual
      FROM public.odg_sales_assignment a
      LEFT JOIN ${SELLER_TABLE} sm
        ON sm.yeardoc=%s AND sm.sale_id=a.sale_id AND sm.monthdoc=a.month
       AND sm.bu_code=a.bu_code
       AND (a.province_code='ALL' OR sm.province=a.province_code)
       AND (a.district_code='ALL' OR sm.amper=a.district_code)
       AND (a.channel_codes IS NULL OR array_length(a.channel_codes,1) IS NULL
            OR sm.channel_code = ANY(a.channel_codes))
       ${chClauseR}
      ${scope}
      GROUP BY a.sale_id, sale_name`;

    const saleTargetSql = (scope) => sellerTargetSql({ channelClause: chClauseT, scope });

    // ═══ BATCH 1: All independent queries in parallel (14 → 1 round) ═══
    const [
      , // ensureSalesAssignmentTable
      , // ensureFreshRollup — by_sale reads the seller-grained rollup
      channelLookup,
      actualRowsRes,
      targetRowsRes,
      ytdActualRowsRes,
      ytdTargetRowsRes,
      areaActualRowsRes,
      areaTargetRowsRes,
      areaYtdActualRowsRes,
      areaYtdTargetRowsRes,
      saleActualRowsRes,
      saleTargetRowsRes,
      saleYtdActualRowsRes,
      saleYtdTargetRowsRes,
    ] = await Promise.all([
      ensureSalesAssignmentTable(),
      ensureFreshRollup([yearVal, yearVal - 1]),
      rows(`SELECT code, name_1 FROM public.ar_group WHERE code NOT IN ('10','9','104','105')`),
      rows(`SELECT ${CHANNEL_EXPR} AS channel, COALESCE(SUM(sum_amount),0)::float AS actual FROM ${SALE_DETAIL_REPORTED} WHERE ${detailWhere} GROUP BY channel`, detailParams),
      rows(`SELECT sale_channel, COALESCE(SUM(target_amount),0)::float AS target FROM public.odg_sales_target WHERE ${targetWhere} GROUP BY sale_channel`, targetParams),
      rows(`SELECT ${CHANNEL_EXPR} AS channel, COALESCE(SUM(sum_amount),0)::float AS actual FROM ${SALE_DETAIL_REPORTED} WHERE ${ytdDetailWhere} GROUP BY channel`, ytdDetailParams),
      rows(`SELECT sale_channel, COALESCE(SUM(target_amount),0)::float AS target FROM public.odg_sales_target WHERE ${ytdTargetWhere} GROUP BY sale_channel`, ytdTargetParams),
      rows(`SELECT province AS province_code, COALESCE(NULLIF(province_name,''),province) AS label, COALESCE(SUM(sum_amount),0)::float AS actual FROM ${SALE_DETAIL_REPORTED} WHERE ${detailWhere} GROUP BY province, label`, detailParams),
      rows(`SELECT province_code, COALESCE(SUM(target_amount),0)::float AS target FROM public.odg_sales_target WHERE ${targetWhere} GROUP BY province_code`, targetParams),
      rows(`SELECT province AS province_code, COALESCE(SUM(sum_amount),0)::float AS actual FROM ${SALE_DETAIL_REPORTED} WHERE ${ytdDetailWhere} GROUP BY province`, ytdDetailParams),
      rows(`SELECT province_code, COALESCE(SUM(target_amount),0)::float AS target FROM public.odg_sales_target WHERE ${ytdTargetWhere} GROUP BY province_code`, ytdTargetParams),
      rows(saleActualSql(assignWhere), [yearVal, ...chParamsR, ...assignParams]),
      rows(saleTargetSql(assignWhere), [yearVal, yearVal, ...chParamsT, ...assignParams]),
      rows(saleActualSql(assignWhereYtd), [yearVal, ...chParamsR, ...assignParamsYtd]),
      rows(saleTargetSql(assignWhereYtd), [yearVal, yearVal, ...chParamsT, ...assignParamsYtd]),
    ]);

    // Channel label helper
    const c2n = {}, n2c = {};
    for (const r of (channelLookup || [])) {
      if (r.code != null) {
        const c = String(r.code);
        const n = r.name_1 == null ? c : String(r.name_1);
        c2n[c] = n;
        n2c[n] = c;
      }
    }
    const chLabel = (raw) => {
      if (raw == null) return raw;
      const v = String(raw);
      const mapped = c2n[v] || (n2c[v] ? c2n[n2c[v]] : v) || raw;
      if (["PROJECT", "103", "ຂາຍໂຄງການ", "ໂຄງການ"].includes(String(mapped))) {
        return "ໂຄງການ";
      }
      return mapped;
    };

    // Build maps
    const buildMap = (arr, keyFn, valKey) => {
      const m = {};
      for (const r of arr) { const k = keyFn(r); m[k] = (m[k] || 0) + Number(r[valKey] || 0); }
      return m;
    };

    const actualMap = buildMap(actualRowsRes, r => chLabel(r.channel), "actual");
    const targetMap = buildMap(targetRowsRes, r => chLabel(r.sale_channel), "target");
    const ytdActualMap = buildMap(ytdActualRowsRes, r => chLabel(r.channel), "actual");
    const ytdTargetMap = buildMap(ytdTargetRowsRes, r => chLabel(r.sale_channel), "target");

    const makeRow = (label, target, actual, ytdTarget, ytdActual) => {
      const gap = target - actual;
      return {
        label, target, actual,
        ach_pct: target ? safeDiv(actual, target) * 100 : 0,
        working_days_left: workingLeft,
        daily_remind: workingLeft ? safeDiv(gap, workingLeft) : gap,
        ytd_target: ytdTarget, ytd_actual: ytdActual,
        ytd_ach_pct: ytdTarget ? safeDiv(ytdActual, ytdTarget) * 100 : 0,
      };
    };

    const sumRows = (items) => {
      const tT = items.reduce((s, i) => s + (i.target || 0), 0);
      const tA = items.reduce((s, i) => s + (i.actual || 0), 0);
      const yT = items.reduce((s, i) => s + (i.ytd_target || 0), 0);
      const yA = items.reduce((s, i) => s + (i.ytd_actual || 0), 0);
      return makeRow("TOTAL", tT, tA, yT, yA);
    };

    // Overall (by channel)
    const overallRows = Object.keys({ ...actualMap, ...targetMap }).sort().map(label =>
      makeRow(label, Number(targetMap[label] || 0), Number(actualMap[label] || 0), Number(ytdTargetMap[label] || 0), Number(ytdActualMap[label] || 0))
    );

    // By area (province)
    const areaTargetObj = Object.fromEntries(areaTargetRowsRes.map(r => [String(r.province_code), Number(r.target || 0)]));
    const areaYtdActObj = Object.fromEntries(areaYtdActualRowsRes.map(r => [String(r.province_code), Number(r.actual || 0)]));
    const areaYtdTgtObj = Object.fromEntries(areaYtdTargetRowsRes.map(r => [String(r.province_code), Number(r.target || 0)]));
    const byAreaRows = areaActualRowsRes.map(r => {
      const c = String(r.province_code);
      return makeRow(r.label || c, Number(areaTargetObj[c] || 0), Number(r.actual || 0), Number(areaYtdTgtObj[c] || 0), Number(areaYtdActObj[c] || 0));
    }).sort((a, b) => b.actual - a.actual);

    // By sale
    const saM = Object.fromEntries(saleActualRowsRes.map(r => [String(r.sale_id), r]));
    const stM = Object.fromEntries(saleTargetRowsRes.map(r => [String(r.sale_id), r]));
    const syaM = Object.fromEntries(saleYtdActualRowsRes.map(r => [String(r.sale_id), r]));
    const sytM = Object.fromEntries(saleYtdTargetRowsRes.map(r => [String(r.sale_id), r]));
    const bySaleRows = Object.keys({ ...saM, ...stM }).map(id => {
      const name = saM[id]?.sale_name || stM[id]?.sale_name || id;
      return makeRow(name, Number(stM[id]?.target || 0), Number(saM[id]?.actual || 0), Number(sytM[id]?.target || 0), Number(syaM[id]?.actual || 0));
    }).sort((a, b) => b.actual - a.actual);

    const dateRange = `${formatDate(startDate)} - ${formatDate(endDate)}`;
    const result = {
      success: true,
      data: {
        meta: { year: yearVal, month: monthVal, month_label: monthName(monthVal), date_range: dateRange, working_days: workingDays, working_days_left: workingLeft, ytd_target: sumRows(overallRows).ytd_target, ytd_actual: sumRows(overallRows).ytd_actual },
        overall: { rows: overallRows, total: sumRows(overallRows) },
        by_area: { rows: byAreaRows, total: sumRows(byAreaRows) },
        by_sale: { rows: bySaleRows, total: sumRows(bySaleRows) },
        collection: { rows: byAreaRows, total: sumRows(byAreaRows) },
      },
    };

    cache.set(cacheKey, { ts: Date.now(), data: result });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
