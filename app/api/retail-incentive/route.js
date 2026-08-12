import { NextResponse } from "next/server";
import { rows, one } from "@/lib/db";
import { parseIntSafe, safeDiv } from "@/lib/helpers";
import { swrCache } from "@/lib/cache";

/**
 * Retail (ຂາຍໜ້າຮ້ານ) staff rewards for one month.
 *
 * Sources — the incentive scheme owns the rules, this only reports them:
 *   odg_sale_detail (channel ຂາຍໜ້າຮ້ານ) → bills and sales per seller, in THB
 *   report_sale_retail_get_point_26      → points earned per seller
 *   odg_retail_target_employee           → that month's target per employee
 *   app_incentive_config                 → point value and achievement bands
 *
 * Reward = points × base_amount × band multiplier, where the band follows
 * achievement against target (low / standard / high in app_incentive_config).
 * Unit and special rewards are returned separately and are NOT added into the
 * per-person totals.
 */
const POINT_VIEW = "public.report_sale_retail_get_point_26";

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
    pointDetail,
  ] = await Promise.all([
    one(`SELECT * FROM public.app_incentive_config ORDER BY id LIMIT 1`).catch(() => null),
    // Sales in THB, resolved to an employee code by name (alias table covers
    // sellers whose display name differs from the HR record).
    rows(
      `SELECT COALESCE(e.employee_code, a.employee_code) AS employee_code,
              d.salename,
              COUNT(DISTINCT d.doc_no)::int AS bills,
              COALESCE(SUM(d.sum_amount), 0)::float AS amount
       FROM public.odg_sale_detail d
       LEFT JOIN public.odg_employee e ON btrim(e.fullname_lo) = btrim(d.salename)
       LEFT JOIN public.app_incentive_sale_alias a ON btrim(a.salename) = btrim(d.salename)
       WHERE d.yeardoc = %s AND d.monthdoc = %s
         AND d.branch_code = %s
         AND d.argroup_main = %s
         AND COALESCE(d.bu_code, '') <> ALL (%s)
       GROUP BY 1, 2`,
      [Number(year), Number(month), RETAIL_BRANCH, RETAIL_AR_GROUP, EXCLUDED_BU],
    ),
    rows(
      `SELECT sale_code, MAX(sale_name) AS sale_name, COALESCE(SUM(get_point), 0)::float AS points
       FROM ${POINT_VIEW}
       WHERE yeardoc::text = %s AND monthdoc::text = ANY(%s)
       GROUP BY sale_code`,
      [String(year), monthVariants],
    ),
    rows(
      // Spare-part and online targets are out of scope for this report.
      `SELECT emp_code, product_group, COALESCE(SUM(target::numeric), 0)::float AS target
       FROM public.odg_retail_target_employee
       WHERE year::text = %s AND month::text = ANY(%s)
         AND upper(COALESCE(product_group, '')) <> ALL (ARRAY['SP', 'SPARE', 'PART', 'ONLINE', 'OD'])
       GROUP BY emp_code, product_group`,
      [String(year), monthVariants],
    ),
    rows(
      `SELECT reward_code, description, group_code, target_amount, reward_amount, split_by_share
       FROM public.app_incentive_special_reward
       WHERE is_active AND %s::date BETWEEN effective_from AND effective_to`,
      [`${year}-${String(month).padStart(2, "0")}-15`],
    ).catch(() => []),
    rows(`SELECT employee_code, fullname_lo, fullname_en FROM public.odg_employee`).catch(() => []),
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
    // Points per seller broken down by product category, plus the lines that
    // earned nothing (discount over 3% or flagged as no-point).
    rows(
      `SELECT v.sale_code,
              COALESCE(NULLIF(i.item_category_name, ''), NULLIF(i.itemmaingroup, ''), '-') AS category,
              COALESCE(SUM(v.get_point), 0)::float AS points,
              COALESCE(SUM(CASE WHEN v.get_point = 0 THEN v.sum_amount_2 ELSE 0 END), 0)::float AS no_point_amount,
              COUNT(*) FILTER (WHERE v.get_point = 0)::int AS no_point_lines
       FROM ${POINT_VIEW} v
       LEFT JOIN (
         SELECT DISTINCT ON (item_code) item_code, item_category_name, itemmaingroup
         FROM public.odg_sale_detail
         WHERE yeardoc = %s AND monthdoc = %s
       ) i ON i.item_code = v.item_code
       WHERE v.yeardoc::text = %s AND v.monthdoc::text = ANY(%s)
       GROUP BY 1, 2`,
      [Number(year), Number(month), String(year), monthVariants],
    ).catch(() => []),
  ]);

  const nameByCode = new Map(
    employees.map((row) => [String(row.employee_code), row.fullname_lo || row.fullname_en || ""]),
  );

  const pointValue = Number(config?.base_amount || 0);
  const lowMax = Number(config?.low_max_pct || 0.5);
  const standardMax = Number(config?.standard_max_pct || 1);
  const lowMul = Number(config?.low_multiplier || 0.8);
  const standardMul = Number(config?.standard_multiplier || 1);
  const highMul = Number(config?.high_multiplier || 1.1);

  const pointsByCode = new Map();
  for (const row of points) {
    const code = String(row.sale_code ?? "").trim();
    if (!code) continue;
    pointsByCode.set(code, (pointsByCode.get(code) || 0) + Number(row.points || 0));
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

  // Points and no-point lines by product category.
  const categoryByCode = new Map();
  const noPointByCode = new Map();
  for (const row of pointDetail) {
    const code = String(row.sale_code ?? "").trim();
    if (!code) continue;
    if (!categoryByCode.has(code)) categoryByCode.set(code, []);
    const points = Number(row.points || 0);
    if (points) categoryByCode.get(code).push({ category: row.category, points });
    const miss = noPointByCode.get(code) || { amount: 0, lines: 0 };
    miss.amount += Number(row.no_point_amount || 0);
    miss.lines += Number(row.no_point_lines || 0);
    noPointByCode.set(code, miss);
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

      return {
        employee_code: code,
        name: entry.name,
        bills: entry.bills,
        amount: entry.amount,
        target,
        ach_pct: target ? safeDiv(entry.amount, target) * 100 : 0,
        points: earned,
        band,
        multiplier,
        point_reward: pointReward,
        unit_reward: unit.total,
        unit_reward_lines: unit.lines,
        reward: pointReward + unit.total,
        target_groups: (code ? groupsByCode.get(code) || [] : []).map((item) => ({
          ...item,
          actual: 0,
        })),
        brands: brands
          .filter((item) => item.qty || item.amount || item.target)
          .sort((left, right) => right.amount - left.amount),
        point_categories: (code ? categoryByCode.get(code) || [] : []).sort(
          (left, right) => right.points - left.points,
        ),
        no_point: code ? noPointByCode.get(code) || { amount: 0, lines: 0 } : { amount: 0, lines: 0 },
        unmatched: !code,
      };
    })
    .filter((row) => row.target > 0)
    .sort((left, right) => right.reward - left.reward || right.amount - left.amount);

  const totals = people.reduce(
    (acc, row) => ({
      bills: acc.bills + row.bills,
      amount: acc.amount + row.amount,
      target: acc.target + row.target,
      points: acc.points + row.points,
      point_reward: acc.point_reward + row.point_reward,
      unit_reward: acc.unit_reward + row.unit_reward,
      reward: acc.reward + row.reward,
    }),
    { bills: 0, amount: 0, target: 0, points: 0, point_reward: 0, unit_reward: 0, reward: 0 },
  );

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

export async function GET(request) {
  try {
    const sp = request.nextUrl.searchParams;
    const now = new Date();
    const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const year = parseIntSafe(sp.get("year"), previous.getFullYear());
    const month = Math.min(12, Math.max(1, parseIntSafe(sp.get("month"), previous.getMonth() + 1)));

    const data = await swrCache(
      `retail-incentive:${year}|${month}`,
      { ttl: 300_000, staleTtl: 24 * 3_600_000, bypass: sp.get("nocache") === "1" },
      () => loadMonth(year, month),
    );

    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
