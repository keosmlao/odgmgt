/**
 * Give every point rule the numeric ceiling it was always describing.
 *
 * A band written as a name ("12-14", "<=34", ">5000") can only be matched by a
 * query that already produced the same name, which is why a kilogram spelling
 * nobody had mapped scored nothing, and why two brands could never split a band
 * differently — the name belonged to the category, not to the row. Replacing
 * the name with a number removes both limits at once.
 *
 * The mapping below is not a guess: each ceiling is read off the behaviour the
 * scoring query has today, so a line lands in the same band it already lands
 * in. The one deliberate change is that the ladder now ends open, so a size
 * nobody mapped falls into the nearest band above instead of scoring zero.
 *
 * Read-only by default; --apply writes the two columns. Either way it ends by
 * comparing, line by line, the rule the NAMES pick against the rule the NUMBERS
 * pick over recent months — which is the only evidence worth having before the
 * scoring query is switched over.
 *
 *   node scripts/migrate-rule-bounds.mjs
 *   node scripts/migrate-rule-bounds.mjs --apply
 */
import { loadEnv } from "./_env.mjs";

const APPLY = process.argv.includes("--apply");
/** Months to prove the change against. */
const PERIODS = [[2026, 6], [2026, 7], [2026, 8]];

/**
 * band name → [kind, ceiling] per category, where the ceiling is INCLUSIVE and
 * null is the open top.
 *
 * Washer's `<5` is 5.9999 rather than 5, because the query's own fallback puts
 * everything under SIX kilograms in that band; REF's `<5` is 4.9, because a
 * fridge's size arrives as the band's own wording ("ນ້ອຍກວ່າ 5.0ຄິວ") whose
 * lower edge is zero. Copying today's behaviour is the whole point — the two
 * `<5` tokens never did mean the same thing.
 */
const BOUNDS = {
  "AV|<=34": ["size", 34],
  "AV|40-44": ["size", 44],
  "AV|55-64": ["size", 64],
  "AV|65-74": ["size", 74],
  "AV|>=75": ["size", null],
  "AV|<=10000": ["price", 10000],
  "AV|10001-20000": ["price", 20000],
  "AV|>20000": ["price", null],
  "Air|<=10000": ["price", 10000],
  "Air|10001-20000": ["price", 20000],
  "Air|>20000": ["price", null],
  "SDA|<=500": ["price", 500],
  "SDA|<=1000": ["price", 1000],
  "SDA|<=2000": ["price", 2000],
  "SDA|<=5000": ["price", 5000],
  "SDA|>5000": ["price", null],
  "REF|<5": ["size", 4.9],
  "REF|5.0-9.9": ["size", 9.9],
  "REF|10.0-14.9": ["size", 14.9],
  "REF|15.0-19.9": ["size", 19.9],
  "REF|>=20": ["size", null],
  "Washer|<5": ["size", 5.9999],
  "Washer|6-11": ["size", 11],
  "Washer|12-14": ["size", 14],
  "Washer|15-19": ["size", 19],
  "Washer|>20": ["size", null],
};

loadEnv();
const { rows, query, pool } = await import("../lib/db.js");
const { OVERRIDE_JOIN, REPORT_MONTH_FILTER, REPORT_DATE } = await import("../lib/sale-month-override.js");

const BRANCH = process.env.ODG_RETAIL_BRANCH || "01";
const fmt = (value) => Number(value || 0).toFixed(2);
const label = ([year, month]) => `${year}-${String(month).padStart(2, "0")}`;

/**
 * Every sold line of a month with BOTH answers beside it: the points the band
 * NAME resolves to, and the points the numeric ceiling resolves to.
 *
 * The line half is a trimmed copy of the report's scoring query — the same
 * category join, the same air-conditioner pairing, the same token derivation —
 * because a comparison run against a different definition of "a line" would
 * prove nothing about the report.
 */
const COMPARE_SQL = `
WITH base AS (
  SELECT COALESCE(a.employee_code, e.employee_code) AS employee_code,
         ${REPORT_DATE} AS report_date, d.doc_no, d.item_code, d.item_name,
         d.item_category, d.design_name, d.size_name, d.qty, d.price,
         UPPER(COALESCE(d.item_brand, '')) AS brand,
         c.pointmap_category AS pcat,
         COALESCE(c.sda_subtype, 'OTH') AS sda_subtype,
         CASE WHEN c.pointmap_category = 'Air' AND d.item_name ~ '\\[[CH]\\]\\s*$'
              THEN d.price + COALESCE(mate.price, 0) ELSE d.price END AS combo_price,
         (c.pointmap_category = 'Air' AND d.item_name ~ '\\[[CH]\\]\\s*$' AND mate.price IS NOT NULL) AS has_mate
  FROM public.odg_sale_detail d
  ${OVERRIDE_JOIN}
  LEFT JOIN LATERAL (
    SELECT mate.price FROM public.odg_sale_detail mate
    WHERE mate.doc_no = d.doc_no
      AND mate.branch_code IS NOT DISTINCT FROM d.branch_code
      AND mate.salename IS NOT DISTINCT FROM d.salename
      AND UPPER(COALESCE(mate.item_brand, '')) = UPPER(COALESCE(d.item_brand, ''))
      AND mate.qty IS NOT DISTINCT FROM d.qty
      AND ((d.item_name ~ '\\[C\\]\\s*$' AND mate.item_name ~ '\\[H\\]\\s*$')
        OR (d.item_name ~ '\\[H\\]\\s*$' AND mate.item_name ~ '\\[C\\]\\s*$'))
    ORDER BY abs(COALESCE(NULLIF(regexp_replace(mate.item_code, '\\D', '', 'g'), ''), '0')::bigint
                 - COALESCE(NULLIF(regexp_replace(d.item_code, '\\D', '', 'g'), ''), '0')::bigint) ASC
    LIMIT 1) mate ON TRUE
  LEFT JOIN public.app_incentive_category c ON c.category_code = d.item_category
  LEFT JOIN public.app_incentive_sale_alias a ON btrim(a.salename) = btrim(d.salename)
  LEFT JOIN public.odg_employee e ON btrim(e.fullname_lo) = btrim(d.salename)
  WHERE ${REPORT_MONTH_FILTER}
    AND d.branch_code = %s AND d.argroup_main = %s
    AND d.item_code NOT LIKE '97%%'
    AND COALESCE(c.is_active, true)
),
line AS (
  SELECT s.*,
         CASE WHEN s.pcat = 'Air' AND s.item_name ~ '\\[H\\]\\s*$' AND s.has_mate THEN 0 ELSE s.qty END AS point_qty,
         CASE s.pcat
           WHEN 'SDA' THEN s.sda_subtype
           WHEN 'Air' THEN CASE WHEN s.item_name ~* 'invert' THEN 'Inverter' ELSE 'On-Off' END
           WHEN 'AV' THEN ''
           ELSE COALESCE(dt.design_token, '') END AS design_token,
         CASE
           WHEN s.pcat = 'REF' THEN COALESCE(st.size_token, '')
           WHEN s.pcat = 'Washer' THEN COALESCE(st.size_token, CASE
             WHEN (substring(replace(s.size_name, ',', '.') from '([0-9]+([.][0-9]+)?)'))::numeric < 6 THEN '<5'
             WHEN (substring(replace(s.size_name, ',', '.') from '([0-9]+([.][0-9]+)?)'))::numeric <= 11 THEN '6-11'
             WHEN (substring(replace(s.size_name, ',', '.') from '([0-9]+([.][0-9]+)?)'))::numeric <= 14 THEN '12-14'
             WHEN (substring(replace(s.size_name, ',', '.') from '([0-9]+([.][0-9]+)?)'))::numeric <= 19 THEN '15-19'
             WHEN (substring(replace(s.size_name, ',', '.') from '([0-9]+([.][0-9]+)?)'))::numeric IS NOT NULL THEN '>20'
             ELSE '' END)
           WHEN s.pcat = 'AV' AND s.item_category = '008' THEN COALESCE(st.size_token, '')
           WHEN s.pcat IN ('AV', 'Air', 'SDA') THEN COALESCE(pb.size_token, '')
           ELSE '' END AS size_token,
         -- The number the band was always describing: a price for the bracket
         -- categories, otherwise the measurement in the size wording. A band's
         -- own wording ("ນ້ອຍກວ່າ 5.0ຄິວ") is a range, so its LOWER edge is what
         -- the line carries — zero for an open bottom.
         CASE
           WHEN s.pcat IN ('Air') THEN s.combo_price
           WHEN s.pcat = 'AV' AND s.item_category <> '008' THEN s.combo_price
           WHEN s.pcat = 'SDA' THEN s.price
           WHEN s.size_name ~ 'ນ້ອຍກວ່າ' THEN 0
           ELSE (substring(replace(s.size_name, ',', '.') from '([0-9]+([.][0-9]+)?)'))::numeric
         END AS measure,
         CASE
           WHEN s.pcat = 'SDA' OR s.pcat = 'Air' OR (s.pcat = 'AV' AND s.item_category <> '008')
             THEN 'price' ELSE 'size' END AS measure_kind
  FROM base s
  LEFT JOIN public.app_incentive_design_token dt ON dt.design_name = s.design_name
  LEFT JOIN public.app_incentive_size_token st ON st.size_name = s.size_name
  LEFT JOIN LATERAL (
    SELECT b.size_token FROM public.app_incentive_price_band b
    WHERE b.category_code = s.pcat
      AND (b.max_price IS NULL
        OR (CASE WHEN s.pcat IN ('AV', 'Air') THEN s.combo_price ELSE s.price END) <= b.max_price)
    ORDER BY b.max_price ASC NULLS LAST LIMIT 1) pb ON TRUE
)
SELECT l.pcat, l.brand, l.design_token, l.size_token, l.measure, l.measure_kind,
       l.item_name, l.size_name, l.doc_no,
       COALESCE(SUM(l.point_qty), 0)::float AS qty,
       COALESCE(MAX(old.points), 0)::float AS old_points,
       COALESCE(MAX(new.points), 0)::float AS new_points,
       (MAX(old.points) IS NULL) AS old_missing,
       (MAX(new.points) IS NULL) AS new_missing
FROM line l
LEFT JOIN LATERAL (
  SELECT r.points FROM public.app_incentive_point_rule r
  WHERE r.category_code = l.pcat AND r.brand_code = l.brand AND r.design_token = l.design_token
    AND l.report_date BETWEEN r.effective_from AND r.effective_to
    AND (r.size_token = l.size_token
      OR (l.size_token ~ '^<=' AND r.size_token ~ '^<='
          AND (substring(r.size_token from '([0-9.]+)'))::numeric
              >= (substring(l.size_token from '([0-9.]+)'))::numeric))
  ORDER BY (r.size_token = l.size_token) DESC,
           CASE WHEN r.size_token ~ '^<=' THEN (substring(r.size_token from '([0-9.]+)'))::numeric ELSE 1e18 END ASC,
           r.is_special DESC, (r.effective_to - r.effective_from) ASC, r.updated_at DESC, r.id DESC
  LIMIT 1) old ON TRUE
LEFT JOIN LATERAL (
  SELECT r.points FROM public.app_incentive_point_rule r
  WHERE r.category_code = l.pcat AND r.brand_code = l.brand AND r.design_token = l.design_token
    AND l.report_date BETWEEN r.effective_from AND r.effective_to
    AND r.band_kind = l.measure_kind
    AND l.measure IS NOT NULL
    AND (r.max_value IS NULL OR l.measure <= r.max_value)
  ORDER BY r.max_value ASC NULLS LAST,
           r.is_special DESC, (r.effective_to - r.effective_from) ASC, r.updated_at DESC, r.id DESC
  LIMIT 1) new ON TRUE
GROUP BY l.pcat, l.brand, l.design_token, l.size_token, l.measure, l.measure_kind,
         l.item_name, l.size_name, l.doc_no
`;

try {
  // The same DDL as lib/migrations.js ensureRuleBounds(), inline because that
  // module resolves its imports the way Next does, not the way node does.
  await query(`
    ALTER TABLE public.app_incentive_point_rule
      ADD COLUMN IF NOT EXISTS max_value numeric,
      ADD COLUMN IF NOT EXISTS band_kind text;
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_incentive_point_rule_bounds
      ON public.app_incentive_point_rule (category_code, brand_code, design_token, band_kind, max_value);
  `);

  const rules = await rows(
    `SELECT id, category_code, size_token FROM public.app_incentive_point_rule ORDER BY category_code, size_token, id`,
  );
  const unknown = new Set();
  const plan = [];
  for (const rule of rules) {
    const key = `${rule.category_code}|${rule.size_token}`;
    const bound = BOUNDS[key];
    if (!bound) { unknown.add(key); continue; }
    plan.push({ id: rule.id, kind: bound[0], max: bound[1] });
  }

  console.log(`\n===== ແປງຂັ້ນເປັນຕົວເລກ · ກົດ ${rules.length} ແຖວ =====`);
  const byKey = new Map();
  for (const rule of rules) {
    const key = `${rule.category_code}|${rule.size_token}`;
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }
  for (const [key, count] of [...byKey].sort()) {
    const bound = BOUNDS[key];
    const shown = bound ? `${bound[0].padEnd(5)} ≤ ${bound[1] === null ? "ບໍ່ຈຳກັດ" : bound[1]}` : "!! ບໍ່ຮູ້ຈັກ";
    console.log(`   ${key.padEnd(24)} ${String(count).padStart(3)} ແຖວ  →  ${shown}`);
  }
  if (unknown.size) {
    console.error(`\nຢຸດ: ມີຂັ້ນທີ່ບໍ່ຮູ້ຈັກ — ${[...unknown].join(", ")}`);
    process.exit(1);
  }

  // The bounds are written either way: a comparison run against empty columns
  // would only prove that empty columns match nothing. A dry run rolls the
  // write back once it has been measured.
  await query("BEGIN");
  for (const row of plan) {
    await query(
      `UPDATE public.app_incentive_point_rule SET band_kind = %s, max_value = %s WHERE id = %s`,
      [row.kind, row.max, row.id],
    );
  }
  console.log(`\nຂຽນຂອບເຂດຕົວເລກ ${plan.length} ແຖວ`);

  /**
   * Phase two: write down the zeros the old shape only implied.
   *
   * Reading names, a band with no rule of its own scored nothing (outside the
   * price ladders, where a `<=` rule above it took over). Reading numbers there
   * is no such thing as a band with no rule: every measurement takes the
   * SMALLEST CEILING ABOVE IT, so a hole in the middle of a row would quietly
   * start paying the rate of the band above — a raise nobody decided on.
   *
   * So every hole that would change its answer is written down as an explicit
   * zero. Two holes are deliberately left alone, because they are the bug this
   * change exists to fix rather than a rate anyone chose:
   *
   *   - a measurement no band ever covered (a 50-inch television, whose size
   *     was never mapped) — it now lands in the band above instead of nowhere
   *   - a `<=` hole a higher ceiling already covered — numbers resolve it the
   *     same way names did, so there is nothing to preserve
   */
  const ladders = new Map();
  for (const [key, [kind, max]] of Object.entries(BOUNDS)) {
    const [category, token] = key.split("|");
    if (!ladders.has(category)) ladders.set(category, []);
    ladders.get(category).push({ token, kind, max });
  }
  for (const list of ladders.values()) {
    list.sort((left, right) => (left.max ?? Infinity) - (right.max ?? Infinity));
  }

  // Every rule, not only the ones in force today: a band a row picked up LAST
  // month was still a hole the month before, and the months before this one
  // have to keep scoring the way they were paid. A band counts as held only if
  // the row has carried it since before the scheme's first month — anything
  // adopted later leaves a hole behind it that still needs its zero.
  //
  // Writing that zero over a period a real rule also covers is harmless: the
  // real rule's window is the narrower one, and a narrower window already wins.
  const live = await rows(
    `SELECT category_code, brand_code, design_token, size_token, points::float AS points,
            max_value::float AS max_value, (effective_from <= '2026-01-01'::date) AS held_throughout
     FROM public.app_incentive_point_rule`,
  );
  const byRow = new Map();
  for (const rule of live) {
    const key = `${rule.category_code}|${rule.brand_code}|${rule.design_token}`;
    if (!byRow.has(key)) byRow.set(key, []);
    byRow.get(key).push(rule);
  }

  const zeros = [];
  for (const [key, own] of byRow) {
    const [category, brand, design] = key.split("|");
    const ladder = ladders.get(category) ?? [];
    const held = new Set(own.filter((rule) => rule.held_throughout).map((rule) => rule.size_token));
    for (const band of ladder) {
      if (held.has(band.token)) continue;
      // The open top has nothing above it to fall into, so a hole there scores
      // nothing under either shape.
      if (band.max === null) continue;
      // A `<=` hole the names already resolved upwards: same answer either way.
      if (band.token.startsWith("<=")) {
        const covering = own
          .filter((rule) => rule.held_throughout && rule.size_token.startsWith("<=") && (rule.max_value ?? Infinity) >= band.max)
          .sort((left, right) => (left.max_value ?? Infinity) - (right.max_value ?? Infinity))[0];
        if (covering) continue;
      }
      const wouldPay = own
        .filter((rule) => rule.max_value === null || rule.max_value >= band.max)
        .sort((left, right) => (left.max_value ?? Infinity) - (right.max_value ?? Infinity))[0];
      if (!wouldPay || !(wouldPay.points > 0)) continue;
      zeros.push({ category, brand, design, band, from: wouldPay.size_token, was: wouldPay.points });
    }
  }

  console.log(`\n===== ຂຽນ 0 ໃສ່ຊ່ອງທີ່ມື້ນີ້ໄດ້ 0 ຢູ່ແລ້ວ: ${zeros.length} ແຖວ =====`);
  const sample = zeros.slice(0, 14);
  for (const zero of sample) {
    console.log(`   ${zero.category.padEnd(7)} ${zero.brand.padEnd(12)} ${(zero.design || "—").padEnd(11)} ${zero.band.token.padEnd(12)}`
      + ` (ຖ້າບໍ່ຂຽນ ຈະຕົກໄປ ${zero.from} = ${zero.was})`);
  }
  if (zeros.length > sample.length) console.log(`   … ອີກ ${zeros.length - sample.length} ແຖວ`);

  for (const zero of zeros) {
    await query(
      `INSERT INTO public.app_incentive_point_rule
              (category_code, brand_code, design_token, size_token, effective_from, effective_to, points, max_value, band_kind)
       VALUES (%s, %s, %s, %s, '2020-01-01'::date, '2099-12-31'::date, 0, %s, %s)
       ON CONFLICT (category_code, brand_code, design_token, size_token, effective_from, effective_to, is_special)
       DO NOTHING`,
      [zero.category, zero.brand, zero.design, zero.band.token, zero.band.max, zero.band.kind],
    );
  }

  // The proof. Anything printed here is a line whose points would move the day
  // the scoring query starts reading numbers instead of names.
  console.log("\n===== ທຽບ ຊື່ຂັ້ນ ກັບ ຕົວເລກ =====");
  for (const period of PERIODS) {
    const [year, month] = period;
    const lines = await rows(COMPARE_SQL, [year, month, year, month, BRANCH, "101"]);
    const moved = lines.filter((row) => Number(row.old_points) !== Number(row.new_points));
    const gained = moved.filter((row) => row.old_missing && !row.new_missing);
    const changed = moved.filter((row) => !row.old_missing);
    const oldTotal = lines.reduce((sum, row) => sum + row.old_points * row.qty, 0);
    const newTotal = lines.reduce((sum, row) => sum + row.new_points * row.qty, 0);
    console.log(`\n${label(period)}  ແຖວ=${lines.length}  ຄະແນນເກົ່າ=${fmt(oldTotal)}  ໃໝ່=${fmt(newTotal)}  ຕ່າງ=${fmt(newTotal - oldTotal)}`);
    console.log(`   ເຄີຍໄດ້ 0 ດຽວນີ້ໄດ້ຄະແນນ: ${gained.length} ແຖວ · ອັດຕາປ່ຽນ: ${changed.length} ແຖວ`);
    for (const row of changed.slice(0, 12)) {
      console.log(`   ⚠ ${row.pcat}·${row.brand}·${row.design_token}·${row.size_token} (${row.size_name ?? "—"} → ${row.measure})`
        + `  ${fmt(row.old_points)} → ${fmt(row.new_points)}  ${row.item_name?.slice(0, 34)}`);
    }
    for (const row of gained.slice(0, 8)) {
      console.log(`   + ${row.pcat}·${row.brand}·${row.design_token}·${row.size_token || "(ບໍ່ມີຂັ້ນ)"} (${row.size_name ?? "—"} → ${row.measure})`
        + `  0 → ${fmt(row.new_points)}  ${row.item_name?.slice(0, 34)}`);
    }
  }
  if (APPLY) {
    await query("COMMIT");
    console.log("\nບັນທຶກແລ້ວ.\n");
  } else {
    await query("ROLLBACK");
    console.log("\n(dry run — ຄືນຄ່າເກົ່າແລ້ວ, ບໍ່ໄດ້ຂຽນຫຍັງ. ໃສ່ --apply ເພື່ອບັນທຶກ)\n");
  }
} catch (error) {
  await query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await pool.end();
}
