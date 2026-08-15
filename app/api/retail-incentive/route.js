import { NextResponse } from "next/server";
import { rows, one } from "@/lib/db";
import { parseIntSafe, safeDiv } from "@/lib/helpers";
import { swrCache } from "@/lib/cache";
import { ensurePayoutTables } from "@/lib/migrations";
import { OVERRIDE_JOIN, REPORT_MONTH_FILTER } from "@/lib/sale-month-override";
import { POINTS_SQL } from "@/lib/incentive-points-sql";
import { ensurePriceBands } from "@/lib/migrations";

/**
 * Retail (ຂາຍໜ້າຮ້ານ) staff rewards for one month.
 *
 * Sources — the incentive scheme owns the rules, this only reports them:
 *   odg_sale_detail            → bills, sales (THB) and units sold per seller
 *   app_incentive_point_rule   → points per unit by category / brand / design / size
 *   app_incentive_*_token      → maps the sale row's design & size names to rule tokens
 *   app_incentive_product_status + _status_multiplier → per-item point multiplier
 *   odg_retail_target_employee → that month's target per employee
 *   app_incentive_config       → value of one point and the achievement bands
 *
 * NOTE: report_sale_retail_get_point_26.get_point is the CUSTOMER loyalty point
 * (1 per 50,000 kip) — not the staff incentive point — so it is not used here.
 *
 * Reward = points × base_amount × band multiplier, where the band follows
 * achievement against target (low / standard / high in app_incentive_config).
 * Unit and special rewards are returned separately and are NOT added into the
 * per-person totals.
 */


/**
 * Scope of this report: the ຂົວຫຼວງ storefront only (branch_code 01, the same
 * branch the ERP's own front-store index uses), retail AR group, and without
 * the spare-parts and online business units.
 */
const RETAIL_BRANCH = process.env.ODG_RETAIL_BRANCH || "01";
const RETAIL_AR_GROUP = "101";
const EXCLUDED_BU = ["14", "17"]; // ອາໄຫຼ່, ອອນລາຍ

/** BU → the group_code the incentive rules are written against. */
const BU_GROUP = { 11: "CE_SDA", 15: "CE_SDA", 12: "AIR", 13: "PIPE", 16: "SERVICE", 17: "ONLINE" };

const DEFAULT_COMMISSION_RULE = { minPct: 0.8, step: 0.05, pivotPct: 1 };

/** Drill-down bucket for sales whose category carries no point group. */
const OUT_OF_SCHEME = "ນອກເງື່ອນໄຂ";

/** Trim a numeric so "18.0000" reads as 18 and "0.5000" as 0.5. */
const ruleNum = (value) => String(Number(value ?? 0) || 0);

/** The dimensions a point rule is looked up by, as one label. */
const dimensionsOf = (row) => [
  String(row.pcat || OUT_OF_SCHEME),
  String(row.brand || "").trim() || "ບໍ່ມີຍີ່ຫໍ້",
  String(row.design_token || "").trim() || "—",
  String(row.size_token || "").trim() || "—",
].join(" / ");

/**
 * How a line arrived at its points — null when it scored nothing (see
 * noPointReason below).
 *
 * The rule that matched is not derivable from the report: 9 points a unit can
 * be a 9-point rule or an 18-point rule halved by a product status. Spelling
 * the arithmetic out is what lets a seller check their own bonus.
 */
function pointBasis(row, points) {
  if (points === 0) return null;
  const base = Number(row.configured_points ?? 0);
  const multiplier = row.raw_multiplier == null ? 1 : Number(row.raw_multiplier);
  const dimensions = dimensionsOf(row);
  if (multiplier === 1) return `${dimensions} · ${ruleNum(base)} ຄະແນນ/ໜ່ວຍ`;
  const note = String(row.status_note || "").trim();
  return `${dimensions} · ${ruleNum(base)} × ຕົວຄູນ ${ruleNum(multiplier)}`
    + `${note ? ` (${note})` : ""} = ${ruleNum(row.unit_points)}/ໜ່ວຍ`;
}

/**
 * Why a sold line earned nothing — null when it did earn.
 *
 * A zero is data, not an error: without the reason a manager cannot tell a
 * mis-configured point map from a product the scheme deliberately excludes.
 * Kept word-for-word in step with the sales application's bill audit
 * (web_sale_order api/reports/incentives/breakdown) so the same line reads the
 * same in both.
 */
function noPointReason(row, points, qty) {
  if (points !== 0) return null;
  // No point group = the category is not part of the scheme at all. Said first
  // because none of the finer reasons below apply, and "no matching rule"
  // would read as a gap in the point map rather than a deliberate exclusion.
  if (!row.pcat) return `ໝວດ "${String(row.category_name || "-")}" ບໍ່ຢູ່ໃນເງື່ອນໄຂການໃຫ້ຄະແນນ`;
  if (String(row.pcat) === "Air" && Number(row.point_qty || 0) === 0 && /\[H\]\s*$/.test(String(row.item_name || ""))) {
    return "ສ່ວນ [H] ຂອງຊຸດ AIR — ຄະແນນຖືກນັບຢູ່ສ່ວນ [C]";
  }
  if (row.raw_multiplier != null && Number(row.raw_multiplier) === 0) {
    const note = String(row.status_note || "").trim();
    return note ? `ຕັ້ງຄ່າບໍ່ໃຫ້ໂບນັດ: ${note}` : `ສະຖານະ ${row.status_code ?? "no-bonus"} ບໍ່ໃຫ້ຄະແນນ`;
  }
  if (row.configured_points == null) return `ບໍ່ມີກົດຄະແນນທີ່ກົງ: ${dimensionsOf(row)}`;
  if (Number(row.configured_points) === 0) return "ກົດ Incentive ຂອງເດືອນນີ້ກຳນົດເປັນ 0 ຄະແນນ";
  if (qty === 0) return "ຈຳນວນໃນລາຍການເປັນ 0";
  return "ຜົນຄຳນວນຄະແນນເປັນ 0";
}

/**
 * Bills that sold something the scheme covers and still scored nothing.
 *
 * The drill-down already carries the reason on every line, but finding these
 * meant opening each seller, each group and each brand in turn — so a rule that
 * was never written down stayed invisible until someone went looking. Collected
 * here they are a work list: which bill, which item, and why it paid nothing.
 *
 * Two kinds of zero are deliberately kept apart from the rest. A category with
 * no point group is outside the scheme by decision, not by mistake, and the
 * [H] half of a split air conditioner scores on its [C] partner — neither is
 * an unpaid sale, and listing them would bury the ones that are.
 */
function zeroPointBills(points, people) {
  const nameByCode = new Map(people.map((row) => [String(row.employee_code ?? ""), row.name]));

  /** Why this line pays nothing when it should have paid, or null if it is fine. */
  const unpaidKind = (row) => {
    if (!row.pcat) return null;
    if (Number(row.points || 0) !== 0) return null;
    if (Number(row.point_qty || 0) === 0 && /\[H\]\s*$/.test(String(row.item_name || ""))) return null;
    // Same precedence as noPointReason, so the tag and the sentence agree.
    if (row.raw_multiplier != null && Number(row.raw_multiplier) === 0) return "no_bonus";
    if (row.configured_points == null) return "no_rule";
    if (Number(row.configured_points) === 0) return "zero_rule";
    return "other";
  };

  // Which bills are worth listing, decided before any line is collected — a
  // bill qualifies on one unpaid line but is then shown whole.
  const flagged = new Map();
  let lineCount = 0;
  for (const row of points) {
    const kind = unpaidKind(row);
    if (!kind) continue;
    lineCount += 1;
    const docNo = String(row.doc_no || "—");
    const kinds = flagged.get(docNo) ?? [];
    if (!kinds.includes(kind)) kinds.push(kind);
    flagged.set(docNo, kinds);
  }

  const bills = new Map();
  for (const row of points) {
    const docNo = String(row.doc_no || "—");
    if (!flagged.has(docNo)) continue;

    const code = String(row.employee_code ?? "").trim();
    const bill = bills.get(docNo) || {
      doc_no: docNo,
      doc_date: row.doc_date,
      employee_code: code || null,
      seller: nameByCode.get(code) || "—",
      // Unpaid portion — what the card is counting.
      qty: 0,
      amount: 0,
      // The whole bill, so an expanded row can be read as a bill and not as a
      // list of complaints: what else was on it, and what it did earn.
      total_qty: 0,
      total_amount: 0,
      total_points: 0,
      flagged_lines: 0,
      kinds: flagged.get(docNo),
      lines: [],
    };
    const qty = Number(row.qty || 0);
    const amount = Number(row.amount || 0);
    const earned = Number(row.points || 0);
    const kind = unpaidKind(row);

    bill.total_qty += qty;
    bill.total_amount += amount;
    bill.total_points += earned;
    if (kind) {
      bill.qty += qty;
      bill.amount += amount;
      bill.flagged_lines += 1;
    }
    bill.lines.push({
      item_code: String(row.item_code || ""),
      item_name: String(row.item_name || ""),
      category_name: String(row.category_name || "-"),
      // The ERP wording behind the tokens, so a line that matched nothing can
      // be read without opening the product master to find out what it said.
      size_name: String(row.size_name || ""),
      design_name: String(row.design_name || ""),
      qty,
      amount,
      price: Number(row.price || 0),
      points: earned,
      kind,
      reason: noPointReason(row, earned, qty),
      basis: pointBasis(row, earned),
      in_scheme: Boolean(row.pcat),
      rule: {
        category_code: row.pcat ?? null,
        brand_code: String(row.brand || "").trim() || null,
        design_token: row.design_token ?? "",
        size_token: row.size_token ?? "",
      },
    });
    bills.set(docNo, bill);
  }

  // Unpaid lines first inside each bill: the reason the bill is here leads.
  for (const bill of bills.values()) {
    bill.lines.sort((left, right) =>
      (right.kind ? 1 : 0) - (left.kind ? 1 : 0) || right.amount - left.amount);
  }

  const all = [...bills.values()].sort((left, right) => right.amount - left.amount);
  // Counted in bills, not in lines: the list below is a list of bills, and a
  // tab whose number counts something else is a tab that cannot be checked.
  const kinds = { no_rule: 0, no_bonus: 0, zero_rule: 0, other: 0 };
  for (const bill of all) for (const kind of bill.kinds) kinds[kind] += 1;

  return {
    total: all.length,
    lines: lineCount,
    qty: all.reduce((sum, bill) => sum + bill.qty, 0),
    amount: all.reduce((sum, bill) => sum + bill.amount, 0),
    kinds,
    // A month with hundreds of these is a configuration problem, not a list to
    // read to the end; the counts above still describe every one of them.
    bills: all.slice(0, 200),
  };
}

/** Biggest earner first at every level of the point drill-down. */
const byPointsThenAmount = (left, right) => right.points - left.points || right.amount - left.amount;

function roundToStep(value, step, up) {
  const safeStep = step > 0 ? step : 0.05;
  const units = Math.round((value / safeStep) * 1e6) / 1e6;
  return (up ? Math.ceil(units) : Math.floor(units)) * safeStep;
}

function commissionRateFor(achievement, tiers, fallback) {
  if (tiers?.length) {
    let active = null;
    for (const tier of tiers) {
      if (achievement >= tier.fromPct) active = tier;
      else break;
    }
    if (!active || active.mode === "zero") return 0;
    if (active.mode === "exact") return achievement;
    return roundToStep(achievement, active.roundStep, active.mode === "round_up");
  }
  if (achievement < fallback.minPct) return 0;
  return roundToStep(achievement, fallback.step, achievement >= fallback.pivotPct);
}

async function loadMonth(year, month) {
  const monthVariants = [String(month), String(month).padStart(2, "0")];

  const [
    config,
    sales,
    points,
    targets,
    specialRewards,
    employees,
    brandSales,
    brandTargets,
    unitRules,
    roleCommission,
    commissionTiers,
    managerEmployees,
  ] = await Promise.all([
    one(`SELECT * FROM public.app_incentive_config ORDER BY id LIMIT 1`).catch(() => null),
    // Same sales basis as the sales application's incentive report: Khua
    // Luang walk-in sales, excluding service/fee pseudo-items (97xxxx).
    rows(
      // The alias table wins over the roster name: an alias is an explicit
      // decision about who a spelling belongs to, a fullname_lo match is a
      // guess. The point query below resolves the same way, so a seller's
      // sales and their points can never land on different people.
      `SELECT COALESCE(a.employee_code, e.employee_code) AS employee_code,
              d.salename,
              COALESCE(SUM(d.qty), 0)::float AS bills,
              COALESCE(SUM(d.sum_amount), 0)::float AS amount
       FROM public.odg_sale_detail d
       ${OVERRIDE_JOIN}
       LEFT JOIN public.odg_employee e ON btrim(e.fullname_lo) = btrim(d.salename)
       LEFT JOIN public.app_incentive_sale_alias a ON btrim(a.salename) = btrim(d.salename)
       LEFT JOIN public.app_incentive_category c ON c.category_code = d.item_category
       WHERE ${REPORT_MONTH_FILTER}
         AND d.branch_code = %s AND d.argroup_main = %s
         AND d.item_code NOT LIKE '97%%'
         AND COALESCE(c.is_active, true)
       GROUP BY 1, 2`,
      [Number(year), Number(month), Number(year), Number(month), RETAIL_BRANCH, RETAIL_AR_GROUP],
    ),
    // Ported from the sales application's incentive report. The dimensions in
    // the workbook are derived differently per point-map category.
    rows(
      POINTS_SQL,
      [
        Number(year), Number(month), Number(year), Number(month), RETAIL_BRANCH, RETAIL_AR_GROUP,
      ],
    ),
    rows(
      // Spare-part and online targets are out of scope for this report.
      `SELECT DISTINCT ON (t.emp_code)
              t.emp_code,
              CASE WHEN t.product_group = 'AC' THEN 'AIR' ELSE 'CE_SDA' END AS product_group,
              t.target::float AS target
       FROM public.odg_retail_target_employee t
       JOIN public.odg_employee e ON e.employee_code = t.emp_code AND e.department_code = '205'
       WHERE t.year::text = %s AND t.month::text = ANY(%s)
       ORDER BY t.emp_code, t.roworder DESC`,
      [String(year), monthVariants],
    ),
    rows(
      `SELECT reward_code, description, group_code, target_amount, reward_amount, split_by_share
       FROM public.app_incentive_special_reward
       WHERE is_active AND %s::date BETWEEN effective_from AND effective_to`,
      [`${year}-${String(month).padStart(2, "0")}-15`],
    ).catch(() => []),
    rows(`SELECT employee_code, fullname_lo, fullname_en, position_code FROM public.odg_employee`).catch(() => []),
    // Brand-level sales (qty drives the unit rewards, amount the brand targets)
    rows(
      `SELECT COALESCE(a.employee_code, e.employee_code) AS employee_code,
              COALESCE(NULLIF(d.item_brand, ''), '-') AS brand,
              d.bu_code,
              COALESCE(SUM(d.qty), 0)::float AS qty,
              COALESCE(SUM(d.sum_amount), 0)::float AS amount
       FROM public.odg_sale_detail d
       ${OVERRIDE_JOIN}
       LEFT JOIN public.odg_employee e ON btrim(e.fullname_lo) = btrim(d.salename)
       LEFT JOIN public.app_incentive_sale_alias a ON btrim(a.salename) = btrim(d.salename)
       WHERE ${REPORT_MONTH_FILTER}
         AND d.branch_code = %s AND d.argroup_main = %s
         AND COALESCE(d.bu_code, '') <> ALL (%s)
       GROUP BY 1, 2, 3`,
      [Number(year), Number(month), Number(year), Number(month), RETAIL_BRANCH, RETAIL_AR_GROUP, EXCLUDED_BU],
    ),
    rows(
      `SELECT emp_code, item_brand, product_group, COALESCE(SUM(target::numeric), 0)::float AS target
       FROM public.odg_retail_target_employee_brand
       WHERE year::text = %s AND month::text = ANY(%s)
       GROUP BY 1, 2, 3`,
      [String(year), monthVariants],
    ),
    // Unit rewards, counted per rule per roster member.
    //
    // A rule either names an item (item_match, matched on code or name) or
    // covers a brand's air conditioners; it pays only to the roster group it
    // is written for. A split AC is an indoor "… [C]" plus an outdoor "… [H]"
    // line, so [H] is dropped to count each SET once — counting both lines
    // paid every air-conditioner spiff twice.
    rows(
      `WITH roster AS (
         SELECT DISTINCT ON (t.emp_code)
                t.emp_code,
                CASE WHEN t.product_group = 'AC' THEN 'AIR' ELSE 'CE_SDA' END AS group_code
         FROM public.odg_retail_target_employee t
         JOIN public.odg_employee re ON re.employee_code = t.emp_code AND re.department_code = '205'
         WHERE t.year::text = %s AND t.month::text = ANY(%s)
         ORDER BY t.emp_code, t.roworder DESC
       ),
       names AS (
         SELECT r.emp_code, btrim(e.fullname_lo) AS salename
         FROM roster r
         JOIN public.odg_employee e ON e.employee_code = r.emp_code
         WHERE COALESCE(e.fullname_lo, '') <> ''
         UNION
         SELECT r.emp_code, btrim(a.salename)
         FROM roster r
         JOIN public.app_incentive_sale_alias a ON a.employee_code = r.emp_code
       )
       SELECT ur.reward_code, ur.description, ur.group_code, ur.brand_code, ur.item_match,
              ur.low_min_qty, ur.low_reward, ur.high_min_qty, ur.high_reward,
              r.emp_code,
              COALESCE(s.units, 0)::float AS units
       FROM public.app_incentive_unit_reward ur
       JOIN roster r ON r.group_code = ur.group_code
       LEFT JOIN LATERAL (
         SELECT SUM(d.qty) AS units
         FROM public.odg_sale_detail d
         ${OVERRIDE_JOIN}
         JOIN names n ON n.salename = btrim(d.salename)
         LEFT JOIN public.app_incentive_category c ON c.category_code = d.item_category
         WHERE n.emp_code = r.emp_code
           AND ${REPORT_MONTH_FILTER}
           AND d.branch_code = %s AND d.argroup_main = %s
           AND d.item_code NOT LIKE '97%%'
           AND d.item_name !~ '\\[H\\]\\s*$'
           AND (
             CASE
               WHEN COALESCE(ur.item_match, '') <> '' THEN
                 d.item_code = ur.item_match OR d.item_name ILIKE '%%' || ur.item_match || '%%'
               ELSE
                 COALESCE(c.pointmap_category, '') = 'Air'
                 AND UPPER(COALESCE(d.item_brand, '')) = UPPER(COALESCE(ur.brand_code, ''))
             END
           )
       ) s ON TRUE
       WHERE ur.is_active
         AND ur.effective_from < make_date(%s, %s, 1) + INTERVAL '1 month'
         AND ur.effective_to >= make_date(%s, %s, 1)`,
      [
        String(year), monthVariants,
        Number(year), Number(month), Number(year), Number(month),
        RETAIL_BRANCH, RETAIL_AR_GROUP,
        Number(year), Number(month), Number(year), Number(month),
      ],
    ).catch(() => []),
    rows(
      `SELECT position_code, group_code, base_amount
       FROM public.app_incentive_role_commission`,
    ).catch(() => []),
    rows(
      `SELECT position_code, from_pct, mode, round_step
       FROM public.app_incentive_commission_tier
       ORDER BY position_code, from_pct`,
    ).catch(() => []),
    rows(
      `SELECT employee_code, fullname_lo, fullname_en, position_code
       FROM public.odg_employee
       WHERE position_code IN ('11', '12')
         AND department_code = '205'
         AND COALESCE(employment_status, 'ACTIVE') = 'ACTIVE'
       ORDER BY position_code DESC`,
    ).catch(() => []),
  ]);

  const nameByCode = new Map(
    employees.map((row) => [String(row.employee_code), row.fullname_lo || row.fullname_en || ""]),
  );
  const positionByCode = new Map(
    employees.map((row) => [String(row.employee_code), String(row.position_code ?? "")]),
  );

  const pointValue = Number(config?.base_amount || 0);
  const lowMax = Number(config?.low_max_pct || 0.5);
  const standardMax = Number(config?.standard_max_pct || 1);
  const lowMul = Number(config?.low_multiplier || 0.8);
  const standardMul = Number(config?.standard_multiplier || 1);
  const highMul = Number(config?.high_multiplier || 1.1);
  const commissionFallback = {
    minPct: Number(config?.commission_min_pct ?? DEFAULT_COMMISSION_RULE.minPct),
    step: Number(config?.commission_round_step ?? DEFAULT_COMMISSION_RULE.step),
    pivotPct: Number(config?.commission_pivot_pct ?? DEFAULT_COMMISSION_RULE.pivotPct),
  };
  const tiersByPosition = new Map();
  for (const row of commissionTiers) {
    const position = String(row.position_code);
    if (!tiersByPosition.has(position)) tiersByPosition.set(position, []);
    tiersByPosition.get(position).push({
      fromPct: Number(row.from_pct || 0),
      mode: String(row.mode || "zero"),
      roundStep: Number(row.round_step || commissionFallback.step),
    });
  }
  const sellerTiers = tiersByPosition.get("13") || [];
  const commissionBaseByGroup = new Map(
    roleCommission
      .filter((row) => String(row.position_code) === "13")
      .map((row) => [String(row.group_code), Number(row.base_amount || 0)]),
  );

  const pointsByCode = new Map();
  const categoryPoints = new Map();
  const treeByCode = new Map();
  const unmatchedByCode = new Map();
  for (const row of points) {
    const code = String(row.employee_code ?? "").trim();
    if (!code) continue;
    const value = Number(row.points || 0);
    pointsByCode.set(code, (pointsByCode.get(code) || 0) + value);
    if (value) {
      if (!categoryPoints.has(code)) categoryPoints.set(code, new Map());
      const categories = categoryPoints.get(code);
      categories.set(row.category_name, (categories.get(row.category_name) || 0) + value);
    }
    // point-map group → brand → the sold lines behind the points.
    //
    // Both levels are dimensions the point rule is written against: the group
    // (AV / REF / Air / Washer / SDA) and the brand. The band the group is
    // scored by is a property of the line, not a level — it is spelled out in
    // each line's point condition, so grouping by it only added a click.
    if (!treeByCode.has(code)) treeByCode.set(code, new Map());
    const pcat = String(row.pcat || "").trim() || OUT_OF_SCHEME;
    const brandName = String(row.brand || "").trim() || "—";
    const qty = Number(row.qty || 0);
    const amount = Number(row.amount || 0);

    const groupNode = treeByCode.get(code).get(pcat) || {
      pcat, qty: 0, amount: 0, points: 0, brands: new Map(),
    };
    const brandNode = groupNode.brands.get(brandName) || {
      brand: brandName, pcat, qty: 0, amount: 0, points: 0, lines: [],
    };
    brandNode.lines.push({
      doc_no: String(row.doc_no || "—"),
      doc_date: row.doc_date,
      item_code: String(row.item_code || ""),
      item_name: String(row.item_name || ""),
      qty,
      amount,
      price: Number(row.price || 0),
      unit_points: Number(row.unit_points || 0),
      points: value,
      unmatched_qty: Number(row.unmatched_qty || 0),
      no_point_reason: noPointReason(row, value, qty),
      point_basis: pointBasis(row, value),
      // The four dimensions the rule is looked up by, kept apart from the
      // sentence above so the screen can link straight to that rule in the
      // configuration instead of making someone search for it.
      rule: {
        category_code: row.pcat ?? null,
        brand_code: String(row.brand || "").trim() || null,
        design_token: row.design_token ?? "",
        size_token: row.size_token ?? "",
      },
    });
    brandNode.qty += qty;
    brandNode.amount += amount;
    brandNode.points += value;
    groupNode.brands.set(brandName, brandNode);
    groupNode.qty += qty;
    groupNode.amount += amount;
    groupNode.points += value;
    treeByCode.get(code).set(pcat, groupNode);
    const miss = unmatchedByCode.get(code) || { qty: 0, matched: 0 };
    miss.qty += Number(row.unmatched_qty || 0);
    miss.matched += Number(row.matched_qty || 0);
    unmatchedByCode.set(code, miss);
  }

  const targetByCode = new Map();
  const groupsByCode = new Map();
  for (const row of targets) {
    const code = String(row.emp_code);
    targetByCode.set(code, (targetByCode.get(code) || 0) + Number(row.target || 0));
    if (!groupsByCode.has(code)) groupsByCode.set(code, []);
    groupsByCode.get(code).push({ group: row.product_group, target: Number(row.target || 0) });
  }

  // One row per seller; sellers whose name could not be matched keep their raw
  // name so nothing disappears from the totals.
  const byKey = new Map();
  for (const row of sales) {
    const code = row.employee_code ? String(row.employee_code) : "";
    const key = code || `name:${String(row.salename || "").trim()}`;
    const entry = byKey.get(key) || {
      employee_code: code || null,
      name: String(row.salename || "").trim() || "—",
      bills: 0,
      amount: 0,
    };
    entry.bills += Number(row.bills || 0);
    entry.amount += Number(row.amount || 0);
    byKey.set(key, entry);
  }
  // Every employee with a target for the month gets a line, even if they sold
  // nothing — the report is about target holders, not about who happened to sell.
  for (const code of targetByCode.keys()) {
    if (!byKey.has(code)) {
      byKey.set(code, { employee_code: code, name: nameByCode.get(code) || code, bills: 0, amount: 0 });
    }
  }

  // Brand rollups per seller: qty feeds the unit rewards, amount the brand targets.
  const brandByCode = new Map();
  for (const row of brandSales) {
    const code = row.employee_code ? String(row.employee_code) : "";
    if (!code) continue;
    const group = BU_GROUP[Number(row.bu_code)] || "-";
    const brand = String(row.brand || "-");
    if (!brandByCode.has(code)) brandByCode.set(code, new Map());
    const key = `${group}|${brand}`;
    const entry = brandByCode.get(code).get(key) || { group, brand, qty: 0, amount: 0, target: 0 };
    entry.qty += Number(row.qty || 0);
    entry.amount += Number(row.amount || 0);
    brandByCode.get(code).set(key, entry);
  }
  for (const row of brandTargets) {
    const code = String(row.emp_code);
    const brand = String(row.item_brand || "-");
    if (!brandByCode.has(code)) brandByCode.set(code, new Map());
    const bucket = brandByCode.get(code);
    const existing = [...bucket.values()].find((item) => item.brand === brand);
    if (existing) existing.target += Number(row.target || 0);
    else bucket.set(`?|${brand}`, { group: row.product_group || "-", brand, qty: 0, amount: 0, target: Number(row.target || 0) });
  }

  /**
   * Unit rewards per seller. The qualifying set count comes from the query
   * above (one row per rule per roster member); reaching high_min_qty pays
   * high_reward on EVERY set, else low_min_qty pays low_reward on every set,
   * else the rule pays nothing.
   */
  const unitRewardByCode = new Map();
  for (const rule of unitRules) {
    const code = String(rule.emp_code ?? "").trim();
    const qty = Number(rule.units || 0);
    if (!code || qty <= 0) continue;
    const highMin = Number(rule.high_min_qty || 0);
    const lowMin = Number(rule.low_min_qty || 0);
    const rate =
      highMin && qty >= highMin
        ? Number(rule.high_reward || 0)
        : lowMin && qty >= lowMin
          ? Number(rule.low_reward || 0)
          : 0;
    if (!rate) continue;
    const entry = unitRewardByCode.get(code) || { total: 0, lines: [] };
    entry.lines.push({
      code: rule.reward_code,
      description: rule.description,
      group: rule.group_code,
      brand: rule.brand_code,
      qty,
      min_qty: highMin && qty >= highMin ? highMin : lowMin,
      rate,
      amount: qty * rate,
    });
    entry.total += qty * rate;
    unitRewardByCode.set(code, entry);
  }
  const unitRewardFor = (code) => unitRewardByCode.get(code) || { total: 0, lines: [] };

  const people = [...byKey.values()]
    .map((entry) => {
      const code = entry.employee_code;
      const earned = code ? Number(pointsByCode.get(code) || 0) : 0;
      const target = code ? Number(targetByCode.get(code) || 0) : 0;
      const ratio = target ? entry.amount / target : 0;

      // Two separate payouts, two separate rules:
      //   points     × app_incentive_config band multiplier (0.8 / 1.0 / 1.1)
      //   commission × app_incentive_commission_tier ladder (below, and zero
      //               under 80% achievement)
      const position = code ? positionByCode.get(code) || "" : "";
      let band = target ? "standard" : "no_target";
      let multiplier = standardMul;
      if (target && ratio <= lowMax) {
        band = "low";
        multiplier = lowMul;
      } else if (target && ratio > standardMax) {
        band = "high";
        multiplier = highMul;
      }

      const pointReward = Math.max(0, earned) * pointValue * multiplier;
      const unit = code ? unitRewardFor(code) : { total: 0, lines: [] };
      const brands = code ? [...(brandByCode.get(code)?.values() || [])] : [];
      const group = (code ? groupsByCode.get(code)?.[0]?.group : null) || "CE_SDA";
      const commissionBase = commissionBaseByGroup.get(group) ?? Number(config?.commission_base || 0);
      const commissionRate = commissionRateFor(ratio, sellerTiers, commissionFallback);
      const commission = commissionBase * commissionRate;

      return {
        employee_code: code,
        name: entry.name,
        group,
        bills: entry.bills,
        amount: entry.amount,
        target,
        ach_pct: target ? safeDiv(entry.amount, target) * 100 : 0,
        points: earned,
        band,
        multiplier,
        position_code: position || null,
        point_reward: pointReward,
        unit_reward: unit.total,
        commission_base: commissionBase,
        commission_rate: commissionRate,
        commission,
        unit_reward_lines: unit.lines,
        reward: pointReward + unit.total + commission,
        target_groups: (code ? groupsByCode.get(code) || [] : []).map((item) => ({
          ...item,
          actual: 0,
        })),
        brands: brands
          .filter((item) => item.qty || item.amount || item.target)
          .sort((left, right) => right.amount - left.amount),
        point_categories: (code ? [...(categoryPoints.get(code)?.entries() || [])].map(([category, points]) => ({ category, points })) : []).sort(
          (left, right) => right.points - left.points,
        ),
        point_tree: (code ? [...(treeByCode.get(code)?.values() || [])] : [])
          .map((group) => ({
            ...group,
            brands: [...group.brands.values()]
              .map((brand) => ({
                ...brand,
                lines: brand.lines.sort(
                  (left, right) =>
                    String(left.doc_date || "").localeCompare(String(right.doc_date || "")) ||
                    left.doc_no.localeCompare(right.doc_no),
                ),
              }))
              .sort(byPointsThenAmount),
          }))
          .sort(byPointsThenAmount),
        // Units sold that no point rule covers (rules only exist for CE/SDA lines).
        no_point: code
          ? { amount: 0, lines: (unmatchedByCode.get(code) || { qty: 0 }).qty }
          : { amount: 0, lines: 0 },
        unmatched: !code,
      };
    })
    .filter((row) => row.target > 0)
    .sort((left, right) =>
      left.group.localeCompare(right.group) || right.reward - left.reward || right.amount - left.amount,
    );

  const totals = people.reduce(
    (acc, row) => ({
      bills: acc.bills + row.bills,
      amount: acc.amount + row.amount,
      target: acc.target + row.target,
      points: acc.points + row.points,
      point_reward: acc.point_reward + row.point_reward,
      unit_reward: acc.unit_reward + row.unit_reward,
      commission: acc.commission + row.commission,
      reward: acc.reward + row.reward,
    }),
    { bills: 0, amount: 0, target: 0, points: 0, point_reward: 0, unit_reward: 0, commission: 0, reward: 0 },
  );

  const groupStats = (group) => {
    const members = group === "ALL"
      ? people
      : people.filter((person) => person.target_groups.some((item) => item.group === group));
    const amount = members.reduce((sum, person) => sum + person.amount, 0);
    const target = members.reduce((sum, person) => sum + person.target, 0);
    return { amount, target, ratio: target ? amount / target : 0 };
  };
  const managers = managerEmployees.map((employee) => {
    const position = String(employee.position_code);
    const lines = roleCommission
      .filter((row) => String(row.position_code) === position)
      .map((row) => {
        const group = ["AIR", "CE_SDA"].includes(String(row.group_code)) ? String(row.group_code) : "ALL";
        const stats = groupStats(group);
        const rate = commissionRateFor(stats.ratio, tiersByPosition.get(position) || [], commissionFallback);
        const base = Number(row.base_amount || 0);
        return {
          group,
          base,
          amount: stats.amount,
          target: stats.target,
          ach_pct: stats.ratio * 100,
          rate,
          commission: base * rate,
        };
      })
      .sort((left, right) => Number(left.group === "ALL") - Number(right.group === "ALL"));
    return {
      employee_code: String(employee.employee_code),
      name: employee.fullname_lo || employee.fullname_en || String(employee.employee_code),
      position,
      commission: lines.reduce((sum, line) => sum + line.commission, 0),
      lines,
    };
  }).filter((manager) => manager.lines.length > 0);

  const managerCommission = managers.reduce((sum, manager) => sum + manager.commission, 0);
  totals.commission += managerCommission;
  totals.reward += managerCommission;

  // Department-level rewards: achieved when the whole store passes the target.
  // split_by_share divides the pot by each seller's share of sales.
  const specials = specialRewards.map((row) => {
    const targetAmount = Number(row.target_amount || 0);
    const rewardAmount = Number(row.reward_amount || 0);
    const achieved = targetAmount > 0 && totals.amount >= targetAmount;
    return {
      code: row.reward_code,
      description: row.description,
      group: row.group_code,
      target_amount: targetAmount,
      reward_amount: rewardAmount,
      split_by_share: row.split_by_share,
      achieved,
      actual_amount: totals.amount,
      ach_pct: targetAmount ? safeDiv(totals.amount, targetAmount) * 100 : 0,
      shares:
        achieved && row.split_by_share && totals.amount > 0
          ? people.map((person) => ({
              employee_code: person.employee_code,
              name: person.name,
              share_pct: safeDiv(person.amount, totals.amount) * 100,
              amount: rewardAmount * safeDiv(person.amount, totals.amount),
            }))
          : [],
    };
  });
  const specialTotal = specials.reduce(
    (sum, row) => sum + (row.achieved ? Number(row.reward_amount || 0) : 0),
    0,
  );

  const zeroBills = zeroPointBills(points, people);

  return {
    meta: {
      year: Number(year),
      month: Number(month),
      currency: config?.currency_code || "THB",
      point_value: pointValue,
      bands: {
        low: { max_ratio: lowMax, multiplier: lowMul },
        standard: { max_ratio: standardMax, multiplier: standardMul },
        high: { multiplier: highMul },
      },
      // What actually drives the multiplier now.
      tier_ladder: [...tiersByPosition.entries()].map(([position, ladder]) => ({
        position_code: position,
        tiers: [...ladder].sort((left, right) => left.fromPct - right.fromPct),
      })),
      branch: RETAIL_BRANCH,
      excluded_bu: EXCLUDED_BU,
      people_count: people.length,
      unmatched_count: people.filter((row) => row.unmatched).length,
    },
    totals: {
      ...totals,
      ach_pct: totals.target ? safeDiv(totals.amount, totals.target) * 100 : 0,
      special_reward: specialTotal,
      grand_total: totals.reward + specialTotal,
    },
    people,
    managers,
    zero_bills: zeroBills,
    // One row per rule — the query returns it once per roster member, so the
    // reference table below has to collapse them back.
    unit_rules: [...new Map(unitRules.map((row) => [row.reward_code, {
      code: row.reward_code,
      description: row.description,
      group: row.group_code,
      brand: row.brand_code,
      item_match: row.item_match || null,
      low_min_qty: Number(row.low_min_qty || 0),
      low_reward: Number(row.low_reward || 0),
      high_min_qty: Number(row.high_min_qty || 0),
      high_reward: Number(row.high_reward || 0),
    }])).values()],
    special_rewards: specials,
  };
}

/** The frozen payout for a month, or null when the month is still open. */
async function loadPayout(year, month) {
  await ensurePayoutTables();
  const head = await one(
    `SELECT id, status, people, point_reward, unit_reward, commission, total_amount,
            currency, note, paid_by, paid_at
     FROM public.odg_incentive_payout
     WHERE target_year = %s AND target_month = %s AND branch_code = %s`,
    [year, month, RETAIL_BRANCH],
  );
  if (!head) return null;

  const lines = await rows(
    `SELECT employee_code, employee_name, sales, target, ach_pct, points,
            multiplier, point_reward, unit_reward, commission, total
     FROM public.odg_incentive_payout_line
     WHERE payout_id = %s
     ORDER BY total DESC`,
    [head.id],
  );

  return { head, lines };
}

export async function GET(request) {
  try {
    const sp = request.nextUrl.searchParams;
    const now = new Date();
    const year = parseIntSafe(sp.get("year"), now.getFullYear());
    const month = Math.min(12, Math.max(1, parseIntSafe(sp.get("month"), now.getMonth() + 1)));

    const payout = await loadPayout(year, month);

    // A paid month is history: serve exactly what was paid, never a fresh calc.
    if (payout) {
      const people = payout.lines.map((line) => ({
        employee_code: line.employee_code,
        name: line.employee_name || line.employee_code,
        bills: 0,
        amount: Number(line.sales || 0),
        target: Number(line.target || 0),
        ach_pct: Number(line.ach_pct || 0),
        points: Number(line.points || 0),
        multiplier: Number(line.multiplier || 0),
        band: "paid",
        point_reward: Number(line.point_reward || 0),
        unit_reward: Number(line.unit_reward || 0),
        unit_reward_lines: [],
        commission: Number(line.commission || 0),
        commission_rate: 0,
        commission_base: 0,
        reward: Number(line.total || 0),
        target_groups: [],
        brands: [],
        point_categories: [],
        point_tree: [],
        no_point: { qty: 0, matched: 0 },
      }));

      return NextResponse.json({
        success: true,
        data: {
          meta: {
            year,
            month,
            currency: payout.head.currency || "THB",
            point_value: 0,
            branch: RETAIL_BRANCH,
            excluded_bu: EXCLUDED_BU,
            people_count: people.length,
            unmatched_count: 0,
            frozen: true,
          },
          payout: {
            status: payout.head.status,
            paid_by: payout.head.paid_by,
            paid_at: payout.head.paid_at,
            note: payout.head.note,
          },
          totals: {
            bills: 0,
            amount: people.reduce((sum, row) => sum + row.amount, 0),
            target: people.reduce((sum, row) => sum + row.target, 0),
            ach_pct: 0,
            points: people.reduce((sum, row) => sum + row.points, 0),
            point_reward: Number(payout.head.point_reward || 0),
            unit_reward: Number(payout.head.unit_reward || 0),
            commission: Number(payout.head.commission || 0),
            reward: Number(payout.head.total_amount || 0),
            special_reward: 0,
            grand_total: Number(payout.head.total_amount || 0),
          },
          people,
          unit_rules: [],
          special_rewards: [],
        },
      });
    }

    // The scoring query reads the bracket table; make sure it exists first.
    await ensurePriceBands();

    const data = await swrCache(
      `retail-incentive:v23:${year}|${month}`,
      { ttl: 300_000, staleTtl: 24 * 3_600_000, bypass: sp.get("nocache") === "1" },
      () => loadMonth(year, month),
    );

    return NextResponse.json({ success: true, data: { ...data, payout: null } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
