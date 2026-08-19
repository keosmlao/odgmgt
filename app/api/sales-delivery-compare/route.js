import { NextResponse } from "next/server";
import { rows } from "@/lib/db";
import { getCurrentUser } from "@/lib/route-auth";
import { buildFilters } from "@/lib/filters";
import { parseIntSafe, safeDiv, monthName, formatDate, monthRange, CHANNEL_EXPR } from "@/lib/helpers";
import { ensureSalesAssignmentTable } from "@/lib/migrations";
import { SALE_DETAIL_REPORTED, ensureReportedView } from "@/lib/sale-detail-view";
import { CHANNEL_CODE_SQL } from "@/lib/sale-monthly-sql.mjs";
import { sellerTargetSql } from "@/lib/sale-seller-target.mjs";
import { ensureFreshRollup } from "@/lib/sale-rollup";
import {
  PROJECT_BU_CODE, PROJECT_BU_NAME, PROJECT_DETAIL_CHANNEL, PROJECT_TARGET_CHANNELS,
  SERVICE_BU_CODE, isProjectBu, projectBuSplitApplies,
} from "@/lib/project-bu.mjs";

/**
 * ເປົ້າ · ຍອດຂາຍ · ຈັດສົ່ງສຳເລັດ, ຄຽງກັນຢູ່ຕາຕະລາງດຽວ.
 *
 * The sales reports stop at "was the bill written". This one carries each bill
 * one step further and asks whether the goods actually reached the buyer, so a
 * month that hit its plan on paper but is still sitting in the warehouse reads
 * differently from one that is finished.
 *
 * The two figures are counted on DIFFERENT DATES, which is the whole point:
 *
 *   actual     ຍອດຂາຍ — bills whose reported month is this month, i.e. counted
 *              on the day the bill was written.
 *   delivered  ຈັດສົ່ງສຳເລັດ — counted on the day the goods reached the buyer.
 *              A bill sold in June and delivered in July counts in JULY; a bill
 *              sold in July and delivered in August does NOT count in July, it
 *              counts in August. Whichever month it was sold in is irrelevant.
 *
 * So the two are not subsets of one another and delivered can exceed actual in
 * a month that cleared a backlog. Both are measured against the same ເປົ້າ.
 *
 * pending is carried alongside as the counterpart the delivery figure cannot
 * show: of the bills sold THIS month, how much has not reached anyone yet.
 *
 * Everything comes back at one shared grain (BU × channel × province ×
 * district × salesperson) and the four breakdowns are folded out of it here
 * rather than asked for one query each. odg_sale_detail has no index that
 * covers transport_name, so every one of these reads is a table scan —
 * 500-odd grain rows fold in microseconds, and one scan per figure beats four.
 */

/**
 * A bill counts as handed over when either is true:
 *
 *   1. TMS recorded a delivery leg that finished (odg_tms_detail.status = 1 on
 *      an approved trip). Bills that go out in stages are complete at the LAST
 *      successful leg, matching /transport/delivery-performance.
 *   2. The customer collected it themselves — those never enter TMS at all, so
 *      keying only on (1) would leave 12.6M of July 2026 counter sales looking
 *      undelivered forever.
 *
 * ຊ່າງໂອດ່ຽນມາເອົາເອງ is deliberately NOT in the list: that is our own fitter
 * drawing stock, not goods reaching the buyer. Add it here if that changes.
 */
const SELF_PICKUP_TRANSPORT = ["ລູກຄ້າຮັບເອງ"];

const sqlStringList = (values) =>
  values.map((value) => `'${String(value).replace(/'/g, "''")}'`).join(", ");

const SELF_PICKUP_SQL = `s.transport_name IN (${sqlStringList(SELF_PICKUP_TRANSPORT)})`;

/** Bills with a finished delivery leg, and when the last one finished. */
const DONE_CTE = `
  done AS (
    SELECT dt.bill_no,
           MAX(dt.sent_end) FILTER (WHERE dt.status = 1) AS done_at
    FROM public.odg_tms_detail dt
    JOIN public.odg_tms j ON j.doc_no = dt.doc_no
    WHERE COALESCE(j.approve_status, 0) = 1
    GROUP BY dt.bill_no
  )`;

/**
 * The day the goods reached the buyer. A self-collected bill has no delivery
 * leg to date, so the bill's own date stands in — that IS the day it was
 * carried out of the shop. NULL means it has not reached the buyer at all.
 */
const HANDOVER_DATE = `COALESCE(
  done.done_at::date,
  CASE WHEN ${SELF_PICKUP_SQL} THEN s.doc_date END
)`;

/** Handed over inside [from, to). Drives both delivery figures. */
const handedInMonth = (from, to) =>
  `${HANDOVER_DATE} >= DATE '${from}' AND ${HANDOVER_DATE} < DATE '${to}'`;

/**
 * The grain both figures are measured at. The salesperson is on the bill
 * header (ic_trans.sale_code), never on odg_sale_detail, so it is joined back
 * on doc_no the way lib/sale-rollup.js does it; a bill with no seller on it
 * still counts towards every other breakdown. ic_trans holds at most one
 * 44/48 row per doc_no, so the join cannot multiply a bill's kip.
 *
 * channel is the display name the sales screens use, channel_code the
 * normalized ar_group code the assignment rules match on — they part company
 * for the service BU, and both are needed.
 *
 * The sale side is filtered in its own subquery before ic_trans is joined:
 * both tables carry doc_no and doc_date, and buildFilters writes unqualified
 * column names, so filtering after the join would be ambiguous.
 */
const grainSql = ({ where, measures, window = "" }) => `
  WITH ${DONE_CTE},
  sale AS (
    SELECT doc_no, doc_date, sum_amount, transport_name,
           COALESCE(NULLIF(bu_code, ''), '-') AS bu_code,
           COALESCE(NULLIF(province, ''), '-') AS province,
           COALESCE(NULLIF(province_name, ''), NULLIF(province, ''), '-') AS province_name,
           COALESCE(NULLIF(amper, ''), '-') AS amper,
           ${CHANNEL_EXPR} AS channel,
           ${CHANNEL_CODE_SQL} AS channel_code
    FROM ${SALE_DETAIL_REPORTED}
    WHERE ${where}
  )
  SELECT s.bu_code, s.channel, s.channel_code, s.province, s.province_name, s.amper,
         btrim(t.sale_code) AS sale_id,
         ${measures}
  FROM sale s
  LEFT JOIN done ON done.bill_no = s.doc_no
  LEFT JOIN public.ic_trans t
    ON t.doc_no = s.doc_no AND t.trans_flag IN (44, 48)
  ${window}
  GROUP BY 1, 2, 3, 4, 5, 6, 7`;

const cache = new Map();
const TTL = 180_000;

/**
 * Predicates that pick project rows out of each side. Definitions and the
 * reasoning behind the split live in lib/project-bu.mjs.
 *
 * The sale side matches on the DISPLAY channel, which is what makes the
 * ສູນບໍລິການ exclusion fall out on its own: that BU normalizes to ບໍລິການ, not
 * ຂາຍໂຄງການ. COALESCE guards keep `NOT (…)` from dropping rows on a NULL.
 */
const DETAIL_IS_PROJECT = `(
  (${CHANNEL_EXPR}) = '${PROJECT_DETAIL_CHANNEL}'
  AND COALESCE(NULLIF(bu_code, ''), '-') <> '${SERVICE_BU_CODE}'
)`;

const TARGET_IS_PROJECT = `(
  COALESCE(sale_channel, '') IN (${PROJECT_TARGET_CHANNELS.map((c) => `'${c}'`).join(", ")})
  AND COALESCE(NULLIF(bu_code, ''), '-') <> '${SERVICE_BU_CODE}'
)`;

/** ALL is how the plan spells "not split by this"; give it a readable name. */
const ALL_CHANNEL_LABEL = "ລວມທຸກຊ່ອງທາງ";
const ALL_PROVINCE_LABEL = "ທົ່ວປະເທດ (ບໍ່ແຍກແຂວງ)";

export async function GET(request) {
  await ensureReportedView();
  try {
    const sp = request.nextUrl.searchParams;
    let bu = sp.get("bu") || "ALL";
    let channel = sp.get("channel") || "ALL";
    const province = sp.get("province") || "ALL";

    // Same scoping the other sales screens apply: a BU manager only ever sees
    // their own BU and channels, whatever the query string asks for.
    const user = getCurrentUser(request) || {};
    if (user.role === "sale_bu_manager") {
      if (user.bu_code) bu = user.bu_code;
      if (Array.isArray(user.channel_codes) && user.channel_codes.length) {
        channel = user.channel_codes.map(String).join(",");
      }
    }

    const now = new Date();
    const yearVal = parseIntSafe(sp.get("year"), now.getFullYear());
    const monthVal = Math.min(12, Math.max(1, parseIntSafe(sp.get("month"), now.getMonth() + 1)));

    const cacheKey = `${yearVal}|${monthVal}|${bu}|${channel}|${province}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < TTL) return NextResponse.json(cached.data);

    /**
     * ໂຄງການ is offered in the BU picker, not the channel picker, so `bu` can
     * name a unit that does not exist in odg_bu. Selecting it means "project
     * rows, whichever BU recorded them"; selecting a real BU now means that BU
     * WITHOUT its project rows, because those are reported as their own unit.
     * Both are expressed as extra predicates — buildFilters only knows real
     * bu_code values.
     */
    const projectSplit = projectBuSplitApplies(yearVal);
    const projectOnly = projectSplit && isProjectBu(bu);
    const excludeProject = projectSplit && !projectOnly && bu && bu !== "ALL";
    const buFilter = projectOnly ? "ALL" : bu;

    const detailExtra = projectOnly
      ? ` AND ${DETAIL_IS_PROJECT}`
      : excludeProject ? ` AND NOT ${DETAIL_IS_PROJECT}` : "";
    const targetExtra = projectOnly
      ? ` AND ${TARGET_IS_PROJECT}`
      : excludeProject ? ` AND NOT ${TARGET_IS_PROJECT}` : "";

    const base = buildFilters(yearVal, buFilter, channel, province, monthVal);
    const detailWhere = base.detailWhere + detailExtra;
    const detailParams = base.detailParams;
    const targetWhere = base.targetWhere + targetExtra;
    const targetParams = base.targetParams;

    /**
     * Scope for ສົ່ງອອກໃນເດືອນນີ້: the same BU / channel / province cut, but no
     * month on the SALE side — a bill sold in June and handed over in July has
     * to be found from July. The previous year comes along for the same reason
     * at the January boundary.
     */
    const { detailWhere: yearWhere, detailParams: yearParams } = buildFilters(
      yearVal, buFilter, channel, province, null,
    );
    const spanWhere = yearWhere.replace("yeardoc = %s", "yeardoc = ANY(%s::int[])") + detailExtra;
    const spanParams = [[yearVal, yearVal - 1], ...yearParams.slice(1)];

    const { start: startDate, end: endDate } = monthRange(yearVal, monthVal);
    const pad = (n) => String(n).padStart(2, "0");
    const monthStart = `${yearVal}-${pad(monthVal)}-01`;
    const nextMonthStart = monthVal === 12 ? `${yearVal + 1}-01-01` : `${yearVal}-${pad(monthVal + 1)}-01`;

    const inMonth = handedInMonth(monthStart, nextMonthStart);

    // Bills booked this month: what was sold, and how much of it has not
    // reached anyone yet (no delivery leg, not collected). The rest of this
    // month's sales may still be sitting in a later month's delivery figure.
    const soldSql = grainSql({
      where: detailWhere,
      measures: `COALESCE(SUM(s.sum_amount), 0)::float AS actual,
         COALESCE(SUM(s.sum_amount) FILTER (WHERE ${HANDOVER_DATE} IS NULL), 0)::float AS pending`,
    });

    // Everything handed over this month, whichever month it was sold in.
    const deliveredSql = grainSql({
      where: spanWhere,
      measures: `COALESCE(SUM(s.sum_amount), 0)::float AS delivered`,
      window: `WHERE ${inMonth}`,
    });

    // Assignment scope for the per-salesperson section, mirroring
    // app/api/sales-summary so the two pages bucket the same people.
    const assignFilters = [];
    const assignParams = [];
    // ໂຄງການ is not an assignment's bu_code; the plan side is narrowed by
    // channel below instead, and the sale side by detailExtra above.
    if (buFilter && buFilter !== "ALL") { assignFilters.push("a.bu_code = %s"); assignParams.push(buFilter); }
    if (province && province !== "ALL") {
      const vals = typeof province === "string" ? province.split(",").filter(Boolean) : [...province];
      assignFilters.push("a.province_code = ANY(%s)"); assignParams.push(vals);
    }
    assignFilters.push("a.month = %s"); assignParams.push(monthVal);
    const assignWhere = `WHERE ${assignFilters.join(" AND ")}`;

    // The plan table keeps whichever spelling was typed into it, code or name,
    // so a channel filter has to offer both.
    const channelLookup = await rows(
      `SELECT code, name_1 FROM public.ar_group WHERE code NOT IN ('10','9','104','105')`,
    );
    const c2n = {}, n2c = {};
    for (const r of channelLookup) {
      if (r.code == null) continue;
      const code = String(r.code);
      const name = r.name_1 == null ? code : String(r.name_1);
      c2n[code] = name;
      n2c[name] = code;
    }
    let chClauseT = "", chParamsT = [];
    if (channel && channel !== "ALL") {
      const vals = typeof channel === "string" ? channel.split(",").filter(Boolean) : [channel];
      const names = [], codes = [];
      for (const v of vals) { names.push(c2n[String(v)] || String(v)); codes.push(n2c[String(v)] || String(v)); }
      chClauseT = " AND (st.sale_channel = ANY(%s) OR st.sale_channel = ANY(%s))";
      chParamsT = [codes.length ? codes : names, names.length ? names : codes];
    }
    // Each seller's ເປົ້າ has to be cut the same way their ຍອດຂາຍ was, or the
    // by-salesperson Ach% compares a project number against a whole-BU plan.
    if (projectOnly) chClauseT += " AND st.sale_channel = ANY(%s)";
    else if (excludeProject) chClauseT += " AND NOT (st.sale_channel = ANY(%s))";
    if (projectOnly || excludeProject) chParamsT = [...chParamsT, PROJECT_TARGET_CHANNELS];

    const chLabel = (raw) => {
      if (raw == null) return "-";
      const v = String(raw);
      if (v === "ALL") return ALL_CHANNEL_LABEL;
      const mapped = c2n[v] || (n2c[v] ? c2n[n2c[v]] : v) || v;
      if (["PROJECT", "103", "ຂາຍໂຄງການ", "ໂຄງການ"].includes(String(mapped))) return "ໂຄງການ";
      return mapped;
    };

    const [
      , // ensureSalesAssignmentTable
      , // ensureFreshRollup — the seller plan split reads the seller rollup
      soldGrain, deliveredGrain,
      channelTarget, buTarget, areaTarget, sellerTarget,
      assignments, buLookup,
    ] = await Promise.all([
      ensureSalesAssignmentTable(),
      ensureFreshRollup([yearVal, yearVal - 1]),

      rows(soldSql, detailParams),
      rows(deliveredSql, spanParams),

      rows(`SELECT sale_channel, COALESCE(SUM(target_amount),0)::float AS target
            FROM public.odg_sales_target WHERE ${targetWhere} GROUP BY sale_channel`, targetParams),
      rows(`SELECT bu_code, sale_channel, COALESCE(SUM(target_amount),0)::float AS target
            FROM public.odg_sales_target WHERE ${targetWhere} GROUP BY bu_code, sale_channel`, targetParams),
      rows(`SELECT province_code, COALESCE(SUM(target_amount),0)::float AS target
            FROM public.odg_sales_target WHERE ${targetWhere} GROUP BY province_code`, targetParams),
      rows(sellerTargetSql({ channelClause: chClauseT, scope: assignWhere, bySegment: true }),
           [yearVal, yearVal, ...chParamsT, ...assignParams]),

      rows(`SELECT a.sale_id, COALESCE(NULLIF(a.sale_name,''), a.sale_id) AS sale_name,
                   a.bu_code, a.province_code, a.district_code, a.channel_codes
            FROM public.odg_sales_assignment a ${assignWhere}`, assignParams),

      rows(`SELECT code, name_1 FROM public.odg_bu ORDER BY code`),
    ]);

    const buName = {};
    for (const r of buLookup) buName[String(r.code)] = r.name_1 || String(r.code);
    buName[PROJECT_BU_CODE] = PROJECT_BU_NAME;

    /**
     * The BU a row is REPORTED under, which from 2026 is not always the BU it
     * was recorded under. Only the display grouping goes through this; the
     * assignment match below still uses the real bu_code, because that is what
     * the assignment rows name.
     */
    const reportedBu = (buCode, channelRaw) => {
      const code = String(buCode ?? "-");
      if (projectSplit && code !== SERVICE_BU_CODE && chLabel(channelRaw) === PROJECT_BU_NAME) {
        return PROJECT_BU_CODE;
      }
      return code;
    };

    /**
     * Which salesperson a grain row belongs to. Same rule as the plan split:
     * 'ALL' is a wildcard on the assignment side, an empty channel list means
     * every channel. A row is only ever credited once, however many of that
     * person's overlapping assignment rows would also cover it.
     */
    const assignmentsBySeller = new Map();
    for (const a of assignments) {
      const id = String(a.sale_id);
      if (!assignmentsBySeller.has(id)) assignmentsBySeller.set(id, []);
      assignmentsBySeller.get(id).push(a);
    }
    const sellerName = {};
    for (const a of assignments) sellerName[String(a.sale_id)] = a.sale_name || String(a.sale_id);
    for (const r of sellerTarget) sellerName[String(r.sale_id)] = r.sale_name || String(r.sale_id);

    const coveredSeller = (row) => {
      const id = row.sale_id ? String(row.sale_id) : "";
      if (!id) return null;
      const mine = assignmentsBySeller.get(id);
      if (!mine) return null;
      const covers = mine.some((a) =>
        String(a.bu_code) === String(row.bu_code)
        && (a.province_code === "ALL" || String(a.province_code) === String(row.province))
        && (a.district_code === "ALL" || String(a.district_code) === String(row.amper))
        && (!a.channel_codes?.length || a.channel_codes.map(String).includes(String(row.channel_code))),
      );
      return covers ? id : null;
    };

    /**
     * Rows are folded from three independent sources, so an area that only has
     * a plan (nothing sold yet) still gets a row instead of quietly vanishing —
     * showing that gap is the point of the page.
     */
    const makeSection = () => new Map();
    const at = (section, key, label, extra) => {
      let row = section.get(key);
      if (!row) {
        row = { key, label: label ?? key, target: 0, actual: 0, delivered: 0, pending: 0, ...extra };
        section.set(key, row);
      } else if (label && row.label === row.key) {
        row.label = label;
      }
      return row;
    };

    const byChannel = makeSection();
    const byArea = makeSection();

    /**
     * BU → ຊ່ອງທາງ → ພະນັກງານຂາຍ, held as three flat maps keyed by the path and
     * assembled into a tree at the end. Every level is accumulated from the SAME
     * grain rows rather than one level being derived from another, so a level can
     * never quietly disagree with the one above it.
     */
    const LEVEL_SEP = "\u0000";
    const byBu = makeSection();
    const byBuChannel = makeSection();
    const byBuChannelSale = makeSection();

    /**
     * Sales nobody's assignment covers, and plan nobody claims, still belong to
     * the channel that produced them. Without a row of their own the seller
     * level would silently add up to less than the channel above it, which
     * reads as an arithmetic error rather than as unassigned work.
     */
    const UNASSIGNED = "__unassigned";
    const UNASSIGNED_LABEL = "(ບໍ່ໄດ້ມອບໝາຍ)";

    const areaLabel = (code, name) => (String(code) === "ALL" ? ALL_PROVINCE_LABEL : name || String(code));
    const buLabelOf = (code) => buName[String(code ?? "")] || String(code ?? "-");

    /** Adds one grain row's figures into every level it belongs to. */
    const fold = (row, fields) => {
      const bu = reportedBu(row.bu_code, row.channel);
      const ch = chLabel(row.channel);
      const seller = coveredSeller(row) || UNASSIGNED;
      const buckets = [
        at(byChannel, ch),
        at(byArea, String(row.province), areaLabel(row.province, row.province_name)),
        at(byBu, bu, buLabelOf(bu)),
        at(byBuChannel, `${bu}${LEVEL_SEP}${ch}`, ch),
        at(byBuChannelSale, `${bu}${LEVEL_SEP}${ch}${LEVEL_SEP}${seller}`,
           seller === UNASSIGNED ? UNASSIGNED_LABEL : sellerName[seller] || seller),
      ];
      for (const bucket of buckets) {
        for (const field of fields) bucket[field] += Number(row[field] || 0);
      }
    };

    for (const row of soldGrain) fold(row, ["actual", "pending"]);
    for (const row of deliveredGrain) fold(row, ["delivered"]);

    for (const r of channelTarget) {
      at(byChannel, chLabel(r.sale_channel)).target += Number(r.target || 0);
    }
    // Only ຂາຍສົ່ງ is planned province by province; the counter, project and
    // online plans are entered once as province_code 'ALL'. Keeping that as its
    // own row is what makes the column add up to the company plan.
    for (const r of areaTarget) {
      const code = String(r.province_code ?? "-");
      at(byArea, code, areaLabel(code, null)).target += Number(r.target || 0);
    }
    // The BU and channel levels take the plan as odg_sales_target states it...
    for (const r of buTarget) {
      const amount = Number(r.target || 0);
      const bu = reportedBu(r.bu_code, r.sale_channel);
      const ch = chLabel(r.sale_channel);
      at(byBu, bu, buLabelOf(bu)).target += amount;
      at(byBuChannel, `${bu}${LEVEL_SEP}${ch}`, ch).target += amount;
    }
    // ...and the seller level takes each person's claimed share of it, which is
    // a smaller number: managers own no plan row and some areas are unassigned.
    for (const r of sellerTarget) {
      // A seller with no claimed plan row comes back once with a NULL segment;
      // there is nothing to place it under, and their sales make their own rows.
      if (r.target_bu == null) continue;
      const bu = reportedBu(r.target_bu, r.target_channel);
      const ch = chLabel(r.target_channel);
      const id = String(r.sale_id);
      at(byBuChannelSale, `${bu}${LEVEL_SEP}${ch}${LEVEL_SEP}${id}`, sellerName[id] || id)
        .target += Number(r.target || 0);
    }

    /**
     * Whatever the seller level does not account for is booked to the unassigned
     * row, so the tree adds up exactly at every level instead of leaving the
     * reader to wonder where the difference went.
     */
    const MEASURES = ["target", "actual", "delivered", "pending"];
    for (const [key, parent] of byBuChannel) {
      const prefix = `${key}${LEVEL_SEP}`;
      const residual = { target: 0, actual: 0, delivered: 0, pending: 0 };
      for (const m of MEASURES) residual[m] = parent[m];
      for (const [childKey, child] of byBuChannelSale) {
        if (!childKey.startsWith(prefix)) continue;
        for (const m of MEASURES) residual[m] -= child[m];
      }
      if (MEASURES.some((m) => Math.abs(residual[m]) > 0.5)) {
        const row = at(byBuChannelSale, `${prefix}${UNASSIGNED}`, UNASSIGNED_LABEL);
        for (const m of MEASURES) row[m] += residual[m];
      }
    }

    const withRatios = (row) => ({
      ...row,
      ach_pct: safeDiv(row.actual, row.target) * 100,
      delivered_pct: safeDiv(row.delivered, row.target) * 100,
      /** Of this month's sales, the share still waiting on a handover. */
      pending_share_pct: safeDiv(row.pending, row.actual) * 100,
    });

    const finish = (section, compare) => {
      const list = [...section.values()]
        // A bucket with no plan, no sale and nothing delivered is an empty ERP
        // code, not a line of business — it only adds a row of zeros to read past.
        .filter((r) => r.target || r.actual || r.delivered || r.pending)
        .map(withRatios)
        .sort(compare ?? ((a, b) => b.actual - a.actual || b.target - a.target));
      const total = list.reduce(
        (acc, r) => ({
          target: acc.target + r.target,
          actual: acc.actual + r.actual,
          delivered: acc.delivered + r.delivered,
          pending: acc.pending + r.pending,
        }),
        { target: 0, actual: 0, delivered: 0, pending: 0 },
      );
      return { rows: list, total: withRatios({ key: "TOTAL", label: "TOTAL", ...total }) };
    };

    /**
     * Flat maps → nested rows. Children are ordered the way the parents are,
     * biggest actual first, with the unassigned remainder always last so it
     * reads as a footnote rather than as a competitor to the real names.
     */
    const order = (a, b) => {
      if (a.key.endsWith(UNASSIGNED) !== b.key.endsWith(UNASSIGNED)) {
        return a.key.endsWith(UNASSIGNED) ? 1 : -1;
      }
      return b.actual - a.actual || b.target - a.target;
    };
    const childrenOf = (section, prefix, depth) =>
      [...section.entries()]
        .filter(([key]) => key.startsWith(prefix) && key.split(LEVEL_SEP).length === depth)
        .map(([, row]) => row);

    const buTree = [...byBu.entries()]
      .map(([buKey, buRow]) => ({
        ...withRatios(buRow),
        children: childrenOf(byBuChannel, `${buKey}${LEVEL_SEP}`, 2)
          .map((chRow) => ({
            ...withRatios(chRow),
            children: childrenOf(byBuChannelSale, `${chRow.key}${LEVEL_SEP}`, 3)
              .map(withRatios)
              .filter((r) => MEASURES.some((m) => Math.abs(r[m]) > 0.5))
              .sort(order),
          }))
          .filter((r) => MEASURES.some((m) => Math.abs(r[m]) > 0.5))
          .sort(order),
      }))
      .filter((r) => MEASURES.some((m) => Math.abs(r[m]) > 0.5))
      .sort(order);

    const result = {
      success: true,
      data: {
        meta: {
          year: yearVal,
          month: monthVal,
          month_label: monthName(monthVal),
          date_range: `${formatDate(startDate)} - ${formatDate(endDate)}`,
          self_pickup_transport: SELF_PICKUP_TRANSPORT,
          project_bu_split: projectSplit,
          project_bu_name: PROJECT_BU_NAME,
          generated_at: new Date().toISOString(),
        },
        by_channel: finish(byChannel),
        /** BU → ຊ່ອງທາງ → ພະນັກງານຂາຍ, nested. */
        by_bu: { rows: buTree, total: finish(byBu).total },
        by_area: finish(byArea),
      },
    };

    if (cache.size > 60) cache.clear();
    cache.set(cacheKey, { ts: Date.now(), data: result });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
