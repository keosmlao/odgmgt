/**
 * Explain, line by line, how one bill earned its incentive points.
 *
 * Reproduces the retail-incentive report's scoring exactly — the point-map
 * category, the design and size tokens it is looked up by, the air-conditioner
 * price band, the product status multiplier and the matched rule — so a
 * "the points are wrong" report can be traced to the step that produced it
 * instead of being argued about.
 *
 * It also prints the OLD air price band (SUM over every equal-priced line of
 * the bill) next to the current one. A bill selling two identical sets used to
 * band on four component prices; where the two columns differ, that bill's
 * points changed with the fix.
 *
 * Read-only. Usage:
 *   node scripts/explain-bill-points.mjs CAK26008257
 */
import { loadEnv } from "./_env.mjs";

const docNo = (process.argv[2] ?? "").trim();
if (!docNo) {
  console.error("Usage: node scripts/explain-bill-points.mjs <doc_no>");
  process.exit(1);
}

// Read .env.local before lib/db.js builds its pool from those variables, so the
// script talks to exactly the database the app talks to.
loadEnv();
const { query, pool } = await import("../lib/db.js");

const num = (value) => Number(value ?? 0) || 0;
const fmt = (value) => num(value).toLocaleString("en-US", { maximumFractionDigits: 2 });

const SQL = `
WITH s AS (
  SELECT d.doc_no, d.salename, d.branch_code, d.argroup_main,
         d.doc_date, COALESCE(mo.report_date, d.doc_date::date) AS report_date,
         d.item_code, d.item_name, d.item_category, d.design_name, d.size_name,
         d.qty, d.price, d.sum_amount,
         COALESCE(NULLIF(d.item_category_name, ''), '-') AS category_name,
         UPPER(COALESCE(d.item_brand, '')) AS brand,
         COALESCE(c.pointmap_category, 'SDA') AS pcat,
         COALESCE(c.sda_subtype, 'OTH') AS sda_subtype,
         COALESCE(c.is_active, true) AS category_active,
         -- current rule: two component prices per set, however many sets
         CASE
           WHEN COALESCE(c.pointmap_category, 'SDA') = 'Air'
             AND d.item_name ~ '\\[[CH]\\]\\s*$'
             AND EXISTS (
               SELECT 1 FROM public.odg_sale_detail pair
               WHERE pair.doc_no = d.doc_no
                 AND pair.branch_code IS NOT DISTINCT FROM d.branch_code
                 AND pair.salename IS NOT DISTINCT FROM d.salename
                 AND UPPER(COALESCE(pair.item_brand, '')) = UPPER(COALESCE(d.item_brand, ''))
                 AND pair.qty IS NOT DISTINCT FROM d.qty
                 AND pair.price IS NOT DISTINCT FROM d.price
                 AND ((d.item_name ~ '\\[C\\]\\s*$' AND pair.item_name ~ '\\[H\\]\\s*$')
                   OR (d.item_name ~ '\\[H\\]\\s*$' AND pair.item_name ~ '\\[C\\]\\s*$'))
             )
             THEN d.price * 2
           ELSE d.price
         END AS combo_price,
         -- previous rule, kept only to show what changed
         CASE WHEN COALESCE(c.pointmap_category, 'SDA') = 'Air'
           THEN SUM(d.price) OVER (
             PARTITION BY d.doc_no, d.salename, UPPER(COALESCE(d.item_brand, '')), d.qty, d.price)
           ELSE d.price END AS old_combo_price
  FROM public.odg_sale_detail d
  LEFT JOIN public.app_sale_month_override mo ON mo.doc_no = d.doc_no
  LEFT JOIN public.app_incentive_category c ON c.category_code = d.item_category
  WHERE d.doc_no = $1
),
line AS (
  SELECT s.*,
         CASE WHEN s.pcat = 'Air' AND s.item_name ~ '\\[H\\]\\s*$' THEN 0 ELSE s.qty END AS point_qty,
         CASE s.pcat
           WHEN 'SDA' THEN s.sda_subtype
           WHEN 'Air' THEN CASE WHEN s.item_name ~* 'invert' THEN 'Inverter' ELSE 'On-Off' END
           WHEN 'AV' THEN ''
           ELSE COALESCE(dt.design_token, '')
         END AS design_token,
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
         -- the band the OLD air price would have chosen
         CASE WHEN s.pcat IN ('AV', 'Air')
           THEN CASE WHEN s.old_combo_price <= 10000 THEN '<=10000'
                     WHEN s.old_combo_price <= 20000 THEN '10001-20000'
                     ELSE '>20000' END
           ELSE '' END AS old_size_token
  FROM s
  LEFT JOIN public.app_incentive_design_token dt ON dt.design_name = s.design_name
  LEFT JOIN public.app_incentive_size_token st ON st.size_name = s.size_name
)
SELECT l.*,
       r.points AS rule_points, r.effective_from, r.effective_to, r.is_special,
       ps.status_code, ps.note AS status_note,
       m.multiplier AS raw_multiplier,
       COALESCE(r.points, 0) * COALESCE(m.multiplier, 1) * l.point_qty AS line_points,
       old_r.points AS old_rule_points
FROM line l
LEFT JOIN LATERAL (
  SELECT r.points, r.effective_from, r.effective_to, r.is_special
  FROM public.app_incentive_point_rule r
  WHERE r.category_code = l.pcat AND r.brand_code = l.brand
    AND r.design_token = l.design_token AND r.size_token = l.size_token
    AND l.report_date BETWEEN r.effective_from AND r.effective_to
  ORDER BY r.is_special DESC, (r.effective_to - r.effective_from) ASC, r.updated_at DESC, r.id DESC
  LIMIT 1
) r ON TRUE
LEFT JOIN LATERAL (
  SELECT r2.points
  FROM public.app_incentive_point_rule r2
  WHERE r2.category_code = l.pcat AND r2.brand_code = l.brand
    AND r2.design_token = l.design_token AND r2.size_token = l.old_size_token
    AND l.report_date BETWEEN r2.effective_from AND r2.effective_to
  ORDER BY r2.is_special DESC, (r2.effective_to - r2.effective_from) ASC, r2.updated_at DESC, r2.id DESC
  LIMIT 1
) old_r ON TRUE
LEFT JOIN LATERAL (
  SELECT ps.status_code, ps.note
  FROM public.app_incentive_product_status_rule ps
  WHERE ps.item_code = l.item_code
    AND l.report_date BETWEEN ps.effective_from AND ps.effective_to
  ORDER BY (ps.effective_to - ps.effective_from) ASC, ps.updated_at DESC
  LIMIT 1
) ps ON TRUE
LEFT JOIN public.app_incentive_status_multiplier m ON m.status_code = ps.status_code
ORDER BY l.item_name`;

function reason(row) {
  if (num(row.line_points) !== 0) return null;
  if (row.pcat === "Air" && num(row.point_qty) === 0 && /\[H\]\s*$/.test(String(row.item_name || ""))) {
    return "ສ່ວນ [H] ຂອງຊຸດ AIR — ຄະແນນຖືກນັບຢູ່ສ່ວນ [C]";
  }
  if (row.raw_multiplier != null && num(row.raw_multiplier) === 0) {
    const note = String(row.status_note || "").trim();
    return note ? `ຕັ້ງຄ່າບໍ່ໃຫ້ໂບນັດ: ${note}` : `ສະຖານະ ${row.status_code ?? "no-bonus"} ບໍ່ໃຫ້ຄະແນນ`;
  }
  if (row.rule_points == null) {
    return `ບໍ່ມີກົດຄະແນນທີ່ກົງ: ${[row.pcat, row.brand || "ບໍ່ມີຍີ່ຫໍ້", row.design_token || "—", row.size_token || "—"].join(" / ")}`;
  }
  if (num(row.rule_points) === 0) return "ກົດ Incentive ຂອງເດືອນນີ້ກຳນົດເປັນ 0 ຄະແນນ";
  if (num(row.qty) === 0) return "ຈຳນວນໃນລາຍການເປັນ 0";
  return "ຜົນຄຳນວນຄະແນນເປັນ 0";
}

try {
  const { rows } = await query(SQL, [docNo]);
  if (rows.length === 0) {
    console.log(`\nບໍ່ພົບບິນ ${docNo} ໃນ odg_sale_detail.`);
  } else {
    const head = rows[0];
    console.log(`\n=== ${docNo} ===`);
    console.log(`ຜູ້ຂາຍ: "${head.salename}"   branch=${head.branch_code} argroup=${head.argroup_main}`);
    console.log(`doc_date=${String(head.doc_date).slice(0, 10)}  report_date=${String(head.report_date).slice(0, 10)}`
      + (String(head.doc_date).slice(0, 10) !== String(head.report_date).slice(0, 10) ? "   << ຍ້າຍເດືອນໂດຍ app_sale_month_override" : ""));
    if (head.branch_code !== "01" || head.argroup_main !== "101") {
      console.log("!! ບິນນີ້ຢູ່ນອກຂອບເຂດລາຍງານ (ຕ້ອງ branch 01 + argroup 101) — ຈະບໍ່ມີຄະແນນເລີຍ");
    }

    let total = 0;
    for (const row of rows) {
      total += num(row.line_points);
      console.log(`\n  ${row.item_code}  ${row.item_name}`);
      console.log(`    ໝວດ=${row.pcat}  ຍີ່ຫໍ້=${row.brand || "—"}  design=${row.design_token || "—"}  size=${row.size_token || "—"}`);
      console.log(`    qty=${fmt(row.qty)}  point_qty=${fmt(row.point_qty)}  price=${fmt(row.price)}  ຍອດ=${fmt(row.sum_amount)}`);
      if (row.pcat === "Air") {
        const changed = num(row.combo_price) !== num(row.old_combo_price);
        console.log(`    ລາຄາ band=${fmt(row.combo_price)}${changed ? `   (ສູດເກົ່າ=${fmt(row.old_combo_price)} → band ${row.old_size_token}, ຄະແນນ ${row.old_rule_points ?? "ບໍ່ມີກົດ"})` : ""}`);
      }
      if (!row.category_active) console.log("    !! ໝວດນີ້ຖືກປິດ (app_incentive_category.is_active = false) — ຖືກຕັດອອກຈາກລາຍງານ");
      if (String(row.item_code).startsWith("97")) console.log("    !! ລາຍການບໍລິການ 97xxxx — ຖືກຕັດອອກຈາກລາຍງານ");
      console.log(`    ກົດ: ${row.rule_points == null ? "ບໍ່ພົບ" : `${fmt(row.rule_points)} ຄະແນນ/ໜ່ວຍ (${String(row.effective_from).slice(0, 10)}..${String(row.effective_to).slice(0, 10)}${row.is_special ? ", special" : ""})`}`);
      console.log(`    ສະຖານະ: ${row.status_code ?? "—"}  ຕົວຄູນ=${row.raw_multiplier ?? "1 (ບໍ່ມີກົດ)"}`);
      console.log(`    => ຄະແນນ ${fmt(row.line_points)}`);
      const why = reason(row);
      if (why) console.log(`    => ${why}`);
    }
    console.log(`\n  ລວມຄະແນນຂອງບິນນີ້: ${fmt(total)}`);
  }
} finally {
  await pool.end();
}
