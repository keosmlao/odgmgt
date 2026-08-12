import { NextResponse } from "next/server";
import { rows, one } from "@/lib/db";
import { parseIntSafe, safeDiv } from "@/lib/helpers";
import { swrCache } from "@/lib/cache";
import { ensurePayoutTables } from "@/lib/migrations";

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
      `SELECT COALESCE(e.employee_code, a.employee_code) AS employee_code,
              d.salename,
              COALESCE(SUM(d.qty), 0)::float AS bills,
              COALESCE(SUM(d.sum_amount), 0)::float AS amount
       FROM public.odg_sale_detail d
       LEFT JOIN public.odg_employee e ON btrim(e.fullname_lo) = btrim(d.salename)
       LEFT JOIN public.app_incentive_sale_alias a ON btrim(a.salename) = btrim(d.salename)
       LEFT JOIN public.app_incentive_category c ON c.category_code = d.item_category
       WHERE d.doc_date >= make_date(%s, %s, 1)
         AND d.doc_date < make_date(%s, %s, 1) + INTERVAL '1 month'
         AND d.branch_code = %s AND d.argroup_main = %s
         AND d.item_code NOT LIKE '97%%'
         AND COALESCE(c.is_active, true)
       GROUP BY 1, 2`,
      [Number(year), Number(month), Number(year), Number(month), RETAIL_BRANCH, RETAIL_AR_GROUP],
    ),
    // Ported from the sales application's incentive report. The dimensions in
    // the workbook are derived differently per point-map category.
    rows(
      `
      WITH line AS (
        SELECT s.employee_code, s.category_name, s.item_code, s.doc_date, s.doc_no,
               s.brand, s.qty, s.sales_amount,
               CASE WHEN s.pcat = 'Air' AND s.item_name ~ '\\[H\\]\\s*$' THEN 0 ELSE s.qty END AS point_qty,
               CASE s.pcat
                 WHEN 'SDA' THEN s.sda_subtype
                 WHEN 'Air' THEN CASE WHEN s.item_name ~* 'invert' THEN 'Inverter' ELSE 'On-Off' END
                 WHEN 'AV' THEN ''
                 ELSE COALESCE(dt.design_token, '')
               END AS design_token,
               CASE
                 WHEN s.pcat IN ('REF', 'Washer') THEN COALESCE(st.size_token, '')
                 WHEN s.pcat = 'AV' AND s.item_category = '008' THEN COALESCE(st.size_token, '')
                 WHEN s.pcat IN ('AV', 'Air') THEN
                   CASE WHEN s.combo_price <= 10000 THEN '<=10000'
                        WHEN s.combo_price <= 20000 THEN '10001-20000'
                        ELSE '>20000' END
                 WHEN s.pcat = 'SDA' THEN
                   CASE WHEN s.price <= 500 THEN '<=500'
                        WHEN s.price <= 1000 THEN '<=1000'
                        WHEN s.price <= 2000 THEN '<=2000'
                        WHEN s.price <= 5000 THEN '<=5000'
                        ELSE '>5000' END
                 ELSE ''
               END AS size_token,
               s.pcat
        FROM (
          SELECT COALESCE(a.employee_code, e.employee_code) AS employee_code,
                 d.doc_date, d.doc_no, d.item_code, d.item_name, d.item_category,
                 d.design_name, d.size_name, d.qty, d.price,
                 d.sum_amount AS sales_amount,
                 COALESCE(NULLIF(d.item_category_name, ''), '-') AS category_name,
                 UPPER(COALESCE(d.item_brand, '')) AS brand,
                 COALESCE(c.pointmap_category, 'SDA') AS pcat,
                 COALESCE(c.sda_subtype, 'OTH') AS sda_subtype,
                 CASE WHEN COALESCE(c.pointmap_category, 'SDA') = 'Air'
                   THEN SUM(d.price) OVER (
                     PARTITION BY d.doc_no, d.salename, UPPER(COALESCE(d.item_brand, '')), d.qty, d.price
                   )
                   ELSE d.price END AS combo_price
          FROM public.odg_sale_detail d
          LEFT JOIN public.app_incentive_category c ON c.category_code = d.item_category
          LEFT JOIN public.app_incentive_sale_alias a ON a.salename = d.salename
          LEFT JOIN public.odg_employee e ON e.fullname_lo = d.salename
          WHERE d.doc_date >= make_date(%s, %s, 1)
            AND d.doc_date < make_date(%s, %s, 1) + INTERVAL '1 month'
            AND d.branch_code = %s AND d.argroup_main = %s
            AND d.item_code NOT LIKE '97%%'
            AND COALESCE(c.is_active, true)
        ) s
        LEFT JOIN public.app_incentive_design_token dt ON dt.design_name = s.design_name
        LEFT JOIN public.app_incentive_size_token st ON st.size_name = s.size_name
      ),
      scored AS (
        SELECT l.employee_code, l.category_name, l.doc_no, l.doc_date,
               l.qty, l.point_qty, l.sales_amount,
               r.points AS rule_points,
               COALESCE(m.multiplier, 1) AS status_multiplier
        FROM line l
        LEFT JOIN LATERAL (
          SELECT r.points
          FROM public.app_incentive_point_rule r
          WHERE r.category_code = l.pcat
            AND r.brand_code = l.brand
            AND r.design_token = l.design_token
            AND r.size_token = l.size_token
            AND l.doc_date::date BETWEEN r.effective_from AND r.effective_to
          ORDER BY r.is_special DESC,
                   (r.effective_to - r.effective_from) ASC,
                   r.updated_at DESC, r.id DESC
          LIMIT 1
        ) r ON TRUE
        LEFT JOIN LATERAL (
          SELECT ps.status_code
          FROM public.app_incentive_product_status_rule ps
          WHERE ps.item_code = l.item_code
            AND l.doc_date::date BETWEEN ps.effective_from AND ps.effective_to
          ORDER BY (ps.effective_to - ps.effective_from) ASC, ps.updated_at DESC
          LIMIT 1
        ) ps ON TRUE
        LEFT JOIN public.app_incentive_status_multiplier m ON m.status_code = ps.status_code
      )
      SELECT employee_code, category_name, doc_no, doc_date,
             COALESCE(SUM(qty), 0)::float AS qty,
             COALESCE(SUM(sales_amount), 0)::float AS amount,
             COALESCE(SUM(rule_points * point_qty * status_multiplier), 0)::float AS points,
             COALESCE(SUM(point_qty) FILTER (WHERE rule_points IS NOT NULL), 0)::float AS matched_qty,
             COALESCE(SUM(point_qty) FILTER (WHERE rule_points IS NULL), 0)::float AS unmatched_qty
      FROM scored
      GROUP BY employee_code, category_name, doc_no, doc_date
      `,
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
      `SELECT COALESCE(e.employee_code, a.employee_code) AS employee_code,
              COALESCE(NULLIF(d.item_brand, ''), '-') AS brand,
              d.bu_code,
              COALESCE(SUM(d.qty), 0)::float AS qty,
              COALESCE(SUM(d.sum_amount), 0)::float AS amount
       FROM public.odg_sale_detail d
       LEFT JOIN public.odg_employee e ON btrim(e.fullname_lo) = btrim(d.salename)
       LEFT JOIN public.app_incentive_sale_alias a ON btrim(a.salename) = btrim(d.salename)
       WHERE d.yeardoc = %s AND d.monthdoc = %s
         AND d.branch_code = %s AND d.argroup_main = %s
         AND COALESCE(d.bu_code, '') <> ALL (%s)
       GROUP BY 1, 2, 3`,
      [Number(year), Number(month), RETAIL_BRANCH, RETAIL_AR_GROUP, EXCLUDED_BU],
    ),
    rows(
      `SELECT emp_code, item_brand, product_group, COALESCE(SUM(target::numeric), 0)::float AS target
       FROM public.odg_retail_target_employee_brand
       WHERE year::text = %s AND month::text = ANY(%s)
       GROUP BY 1, 2, 3`,
      [String(year), monthVariants],
    ),
    rows(
      `SELECT reward_code, description, group_code, brand_code, item_match,
              low_min_qty, low_reward, high_min_qty, high_reward
       FROM public.app_incentive_unit_reward
       WHERE is_active AND %s::date BETWEEN effective_from AND effective_to`,
      [`${year}-${String(month).padStart(2, "0")}-15`],
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
  const invoicesByCode = new Map();
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
    if (!invoicesByCode.has(code)) invoicesByCode.set(code, new Map());
    const invoiceKey = String(row.doc_no || "—");
    const invoice = invoicesByCode.get(code).get(invoiceKey) || {
      doc_no: invoiceKey,
      doc_date: row.doc_date,
      qty: 0,
      amount: 0,
      points: 0,
      unmatched_qty: 0,
      categories: new Map(),
    };
    invoice.qty += Number(row.qty || 0);
    invoice.amount += Number(row.amount || 0);
    invoice.points += value;
    invoice.unmatched_qty += Number(row.unmatched_qty || 0);
    const invoiceCategory = invoice.categories.get(row.category_name) || { category: row.category_name, qty: 0, amount: 0, points: 0, unmatched_qty: 0 };
    invoiceCategory.qty += Number(row.qty || 0);
    invoiceCategory.amount += Number(row.amount || 0);
    invoiceCategory.points += value;
    invoiceCategory.unmatched_qty += Number(row.unmatched_qty || 0);
    invoice.categories.set(row.category_name, invoiceCategory);
    invoicesByCode.get(code).set(invoiceKey, invoice);
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

  /** Unit rewards: qty of a brand within a group, matched to the rule tiers. */
  const unitRewardFor = (code) => {
    const bucket = brandByCode.get(code);
    if (!bucket) return { total: 0, lines: [] };
    const lines = [];
    for (const rule of unitRules) {
      const ruleGroup = String(rule.group_code || "").toUpperCase();
      const ruleBrand = rule.brand_code ? String(rule.brand_code).toUpperCase() : null;
      let qty = 0;
      for (const entry of bucket.values()) {
        if (ruleGroup && ruleGroup !== "ALL" && entry.group.toUpperCase() !== ruleGroup) continue;
        if (ruleBrand && entry.brand.toUpperCase() !== ruleBrand) continue;
        qty += entry.qty;
      }
      if (qty <= 0) continue;
      const highMin = Number(rule.high_min_qty || 0);
      const lowMin = Number(rule.low_min_qty || 0);
      const rate =
        highMin && qty >= highMin
          ? Number(rule.high_reward || 0)
          : lowMin && qty >= lowMin
            ? Number(rule.low_reward || 0)
            : 0;
      if (!rate) continue;
      lines.push({
        code: rule.reward_code,
        description: rule.description,
        group: rule.group_code,
        brand: rule.brand_code,
        qty,
        rate,
        amount: qty * rate,
      });
    }
    return { total: lines.reduce((sum, line) => sum + line.amount, 0), lines };
  };

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
        invoices: (code ? [...(invoicesByCode.get(code)?.values() || [])].map((invoice) => ({
          ...invoice,
          categories: [...invoice.categories.values()].sort((left, right) => right.points - left.points),
        })) : [])
          .sort((left, right) => String(right.doc_date || "").localeCompare(String(left.doc_date || "")) || left.doc_no.localeCompare(right.doc_no)),
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
    unit_rules: unitRules.map((row) => ({
      code: row.reward_code,
      description: row.description,
      group: row.group_code,
      brand: row.brand_code,
      low_min_qty: Number(row.low_min_qty || 0),
      low_reward: Number(row.low_reward || 0),
      high_min_qty: Number(row.high_min_qty || 0),
      high_reward: Number(row.high_reward || 0),
    })),
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

    const data = await swrCache(
      `retail-incentive:v6:${year}|${month}`,
      { ttl: 300_000, staleTtl: 24 * 3_600_000, bypass: sp.get("nocache") === "1" },
      () => loadMonth(year, month),
    );

    return NextResponse.json({ success: true, data: { ...data, payout: null } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
