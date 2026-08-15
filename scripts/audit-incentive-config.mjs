/**
 * Health check on the incentive configuration for one month.
 *
 * The report only applies the rules it is given, so a wrong bonus is almost
 * always a gap in the configuration rather than in the code. Each section
 * below is a way a sale can silently score nothing (or score twice), ordered
 * by the sales value at stake.
 *
 * Read-only. Usage:
 *   node scripts/audit-incentive-config.mjs 2026 7
 */
import { loadEnv } from "./_env.mjs";

const [, , yearArg, monthArg] = process.argv;
const year = Number(yearArg);
const month = Number(monthArg);
if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
  console.error("Usage: node scripts/audit-incentive-config.mjs <year> <month>");
  process.exit(1);
}

loadEnv();
const { rows: q, pool } = await import("../lib/db.js");

const BRANCH = process.env.ODG_RETAIL_BRANCH || "01";
const AR_GROUP = "101";
const money = (value) => Math.round(Number(value ?? 0)).toLocaleString("en-US");
const mid = `${year}-${String(month).padStart(2, "0")}-15`;

/** Front-store sale lines of the month, the basis every section starts from. */
const SALE_SCOPE = `
  FROM public.odg_sale_detail d
  LEFT JOIN public.app_sale_month_override mo ON mo.doc_no = d.doc_no
  LEFT JOIN public.app_incentive_category c ON c.category_code = d.item_category
  WHERE COALESCE(mo.report_date, d.doc_date::date) >= make_date($1, $2, 1)
    AND COALESCE(mo.report_date, d.doc_date::date) < make_date($1, $2, 1) + INTERVAL '1 month'
    AND d.branch_code = $3 AND d.argroup_main = $4
    AND d.item_code NOT LIKE '97%'`;
const P = [year, month, BRANCH, AR_GROUP];

let findings = 0;
function section(title, list, render) {
  console.log(`\n-- ${title} --`);
  if (list.length === 0) {
    console.log("   ok");
    return;
  }
  findings += list.length;
  for (const row of list) console.log("   " + render(row));
}

try {
  console.log(`\n===== incentive config audit · ${year}-${String(month).padStart(2, "0")} =====`);

  section(
    "ໝວດທີ່ຂາຍແຕ່ບໍ່ມີກຸ່ມຄະແນນ (pointmap_category ວ່າງ → ຕົກໄປ SDA)",
    await q(`SELECT d.item_category, COALESCE(NULLIF(MAX(c.category_name), ''), MAX(d.item_category_name)) AS name,
                    SUM(d.qty)::float AS qty, SUM(d.sum_amount) AS amount
             ${SALE_SCOPE} AND c.category_code IS NOT NULL AND c.pointmap_category IS NULL
             GROUP BY 1 ORDER BY 4 DESC`, P),
    (r) => `${r.item_category}  ${String(r.name || "").padEnd(24)} ${String(r.qty).padStart(7)} ໜ່ວຍ ${money(r.amount).padStart(12)}`,
  );

  section(
    "ໝວດທີ່ຂາຍແຕ່ບໍ່ມີແຖວໃນ app_incentive_category ເລີຍ",
    await q(`SELECT d.item_category, MAX(d.item_category_name) AS name,
                    SUM(d.qty)::float AS qty, SUM(d.sum_amount) AS amount
             ${SALE_SCOPE} AND c.category_code IS NULL
             GROUP BY 1 ORDER BY 4 DESC`, P),
    (r) => `${r.item_category}  ${String(r.name || "").padEnd(24)} ${String(r.qty).padStart(7)} ໜ່ວຍ ${money(r.amount).padStart(12)}`,
  );

  section(
    "ໝວດທີ່ຖືກປິດ (is_active=false) ແຕ່ຍັງມີການຂາຍ — ຍອດຖືກຕັດອອກທັງໝົດ",
    await q(`SELECT d.item_category, MAX(c.category_name) AS name,
                    SUM(d.qty)::float AS qty, SUM(d.sum_amount) AS amount
             ${SALE_SCOPE} AND c.is_active = false
             GROUP BY 1 ORDER BY 4 DESC`, P),
    (r) => `${r.item_category}  ${String(r.name || "").padEnd(24)} ${String(r.qty).padStart(7)} ໜ່ວຍ ${money(r.amount).padStart(12)}`,
  );

  section(
    "ຍີ່ຫໍ້ທີ່ຂາຍແຕ່ບໍ່ມີກົດຄະແນນຈັກແຖວໃນກຸ່ມນັ້ນ",
    await q(`SELECT COALESCE(c.pointmap_category, 'SDA') AS pcat, UPPER(COALESCE(d.item_brand, '')) AS brand,
                    SUM(d.qty)::float AS qty, SUM(d.sum_amount) AS amount
             ${SALE_SCOPE} AND COALESCE(c.is_active, true)
               AND NOT EXISTS (SELECT 1 FROM public.app_incentive_point_rule r
                               WHERE r.category_code = COALESCE(c.pointmap_category, 'SDA')
                                 AND r.brand_code = UPPER(COALESCE(d.item_brand, '')))
             GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 15`, P),
    (r) => `${String(r.pcat).padEnd(8)}${String(r.brand || "(ບໍ່ມີ)").padEnd(16)}${String(r.qty).padStart(7)} ໜ່ວຍ ${money(r.amount).padStart(12)}`,
  );

  section(
    "design_name ທີ່ຂາຍແຕ່ບໍ່ມີ token (ໝວດທີ່ໃຊ້ design)",
    await q(`SELECT COALESCE(c.pointmap_category, 'SDA') AS pcat, d.design_name,
                    SUM(d.qty)::float AS qty, SUM(d.sum_amount) AS amount
             ${SALE_SCOPE} AND COALESCE(c.is_active, true)
               AND c.pointmap_category IN ('REF', 'Washer')
               AND NOT EXISTS (SELECT 1 FROM public.app_incentive_design_token t WHERE t.design_name = d.design_name)
             GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 10`, P),
    (r) => `${String(r.pcat).padEnd(8)}"${r.design_name ?? ""}"  ${String(r.qty).padStart(6)} ໜ່ວຍ ${money(r.amount).padStart(12)}`,
  );

  section(
    "size_name ທີ່ຂາຍແຕ່ບໍ່ມີ token (ໝວດທີ່ໃຊ້ size)",
    await q(`SELECT COALESCE(c.pointmap_category, 'SDA') AS pcat, d.size_name,
                    SUM(d.qty)::float AS qty, SUM(d.sum_amount) AS amount
             ${SALE_SCOPE} AND COALESCE(c.is_active, true)
               AND (c.pointmap_category IN ('REF', 'Washer')
                    OR (c.pointmap_category = 'AV' AND d.item_category = '008'))
               AND NOT EXISTS (SELECT 1 FROM public.app_incentive_size_token t WHERE t.size_name = d.size_name)
             GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 10`, P),
    (r) => `${String(r.pcat).padEnd(8)}"${r.size_name ?? ""}"  ${String(r.qty).padStart(6)} ໜ່ວຍ ${money(r.amount).padStart(12)}`,
  );

  // Overlapping rules are normal — a month-specific rule is meant to sit on top
  // of a year-long baseline, and the narrower window wins. What matters is
  // which one actually wins and by how much the loser differs, so the winner is
  // resolved here with the report's own tie-break instead of being guessed at.
  // No LIMIT: truncating this list once hid a rule that resolves to 0 points.
  const duplicates = await q(
    `WITH active AS (
       SELECT * FROM public.app_incentive_point_rule
       WHERE $1::date BETWEEN effective_from AND effective_to
     ),
     dup AS (
       SELECT category_code, brand_code, design_token, size_token,
              COUNT(*)::int AS n, MIN(points) AS min_points, MAX(points) AS max_points
       FROM active GROUP BY 1, 2, 3, 4 HAVING COUNT(*) > 1
     )
     SELECT dup.*, w.points AS winning_points, w.effective_from::text AS wf, w.effective_to::text AS wt
     FROM dup
     JOIN LATERAL (
       SELECT r.points, r.effective_from, r.effective_to
       FROM active r
       WHERE r.category_code = dup.category_code AND r.brand_code = dup.brand_code
         AND r.design_token = dup.design_token AND r.size_token = dup.size_token
       ORDER BY r.is_special DESC, (r.effective_to - r.effective_from) ASC,
                r.updated_at DESC, r.id DESC
       LIMIT 1
     ) w ON TRUE
     ORDER BY (dup.max_points - dup.min_points) DESC, 1, 2, 3, 4`,
    [mid],
  );
  section(
    `ກົດຄະແນນທັບກັນ (${duplicates.length} ຄູ່) — ຮຽງຕາມສ່ວນຕ່າງ, ອັນທີ່ຕ່າງຫຼາຍຢູ່ເທິງ`,
    duplicates,
    (r) => `${String(r.category_code).padEnd(8)}${String(r.brand_code).padEnd(12)}${String(r.design_token).padEnd(12)}${String(r.size_token).padEnd(12)}`
      + ` ×${r.n} [${Number(r.min_points)}..${Number(r.max_points)}]`
      + ` → ໃຊ້ ${Number(r.winning_points)} (${r.wf}..${r.wt})`
      + (Number(r.winning_points) === 0 && Number(r.max_points) > 0 ? "   << ຊະນະດ້ວຍ 0 ຄະແນນ" : ""),
  );

  section(
    "ສະຖານະສິນຄ້າທີ່ບໍ່ມີຕົວຄູນ (ຖືເປັນ 1 ໂດຍປະລິຍາຍ)",
    await q(`SELECT DISTINCT s.status_code
             FROM public.app_incentive_product_status_rule s
             LEFT JOIN public.app_incentive_status_multiplier m ON m.status_code = s.status_code
             WHERE m.status_code IS NULL AND $1::date BETWEEN s.effective_from AND s.effective_to`, [mid]),
    (r) => String(r.status_code),
  );

  section(
    "ຊື່ຜູ້ຂາຍທີ່ຫາເຈົ້າຂອງບໍ່ໄດ້ — ຍອດ ແລະ ຄະແນນຕົກຫາຍ",
    await q(`SELECT btrim(d.salename) AS salename, SUM(d.qty)::float AS qty, SUM(d.sum_amount) AS amount
             ${SALE_SCOPE}
               AND NOT EXISTS (SELECT 1 FROM public.app_incentive_sale_alias a WHERE btrim(a.salename) = btrim(d.salename))
               AND NOT EXISTS (SELECT 1 FROM public.odg_employee e WHERE btrim(e.fullname_lo) = btrim(d.salename))
             GROUP BY 1 ORDER BY 3 DESC LIMIT 10`, P),
    (r) => `"${r.salename}"  ${String(r.qty).padStart(6)} ໜ່ວຍ ${money(r.amount).padStart(12)}`,
  );

  section(
    "alias ທີ່ຊີ້ໄປພະນັກງານທີ່ບໍ່ມີໃນທະບຽນ",
    await q(`SELECT a.salename, a.employee_code
             FROM public.app_incentive_sale_alias a
             LEFT JOIN public.odg_employee e ON e.employee_code = a.employee_code
             WHERE e.employee_code IS NULL`),
    (r) => `"${r.salename}" → ${r.employee_code}`,
  );

  section(
    "ພະນັກງານທີ່ມີເປົ້າ ແຕ່ເປົ້າເປັນ 0 — ລາຍງານ odgmgt ຈະຕັດອອກ",
    await q(`SELECT DISTINCT ON (t.emp_code) t.emp_code, e.fullname_lo, t.target
             FROM public.odg_retail_target_employee t
             JOIN public.odg_employee e ON e.employee_code = t.emp_code AND e.department_code = '205'
             WHERE t.year::text = $1 AND t.month::text = ANY($2)
             ORDER BY t.emp_code, t.roworder DESC`,
    [String(year), [String(month), String(month).padStart(2, "0")]])
      .then((list) => list.filter((r) => Number(r.target || 0) <= 0)),
    (r) => `${r.emp_code}  ${r.fullname_lo ?? ""}  target=${r.target}`,
  );

  section(
    "app_incentive_config ຫຼາຍກວ່າ 1 ແຖວ — ລາຍງານໃຊ້ແຖວ id ນ້ອຍສຸດເທົ່ານັ້ນ",
    await q(`SELECT id, base_amount, currency_code FROM public.app_incentive_config ORDER BY id OFFSET 1`),
    (r) => `id=${r.id} base_amount=${r.base_amount} ${r.currency_code ?? ""}`,
  );

  console.log(`\n===== ${findings} ຈຸດທີ່ຄວນເບິ່ງ =====`);
} finally {
  await pool.end();
}
