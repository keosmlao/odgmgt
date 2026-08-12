/** Computes incentive points the way app_incentive_point_rule intends. */
import pg from "pg";

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 8000,
  statement_timeout: 120000,
});
const q = (sql, params = []) => pool.query(sql, params).then((r) => r.rows);

console.log("rules with empty brand:", JSON.stringify(await q(
  `SELECT COUNT(*)::int AS n FROM public.app_incentive_point_rule WHERE COALESCE(brand_code,'') = ''`)));
console.log("distinct design tokens in rules:", JSON.stringify(await q(
  `SELECT DISTINCT design_token FROM public.app_incentive_point_rule ORDER BY 1 LIMIT 12`)));

const sql = `
WITH line AS (
  SELECT d.salename, d.item_code, d.item_brand, d.qty,
         c.pointmap_category AS category,
         COALESCE(dt.design_token, '') AS design_token,
         COALESCE(st.size_token, '')   AS size_token
  FROM public.odg_sale_detail d
  LEFT JOIN public.app_incentive_category c ON c.category_code = d.item_category
  LEFT JOIN public.app_incentive_design_token dt ON btrim(dt.design_name) = btrim(d.design_name)
  LEFT JOIN public.app_incentive_size_token st ON btrim(st.size_name) = btrim(d.size_name)
  WHERE d.yeardoc = $1 AND d.monthdoc = $2
    AND d.branch_code = '01' AND d.argroup_main = '101'
    AND COALESCE(d.bu_code,'') NOT IN ('14','17')
    AND d.qty > 0
),
scored AS (
  SELECT l.*,
         r.points AS rule_points,
         COALESCE(m.multiplier, 1) AS status_multiplier
  FROM line l
  LEFT JOIN LATERAL (
    SELECT r.points
    FROM public.app_incentive_point_rule r
    WHERE r.category_code = l.category
      AND upper(COALESCE(r.brand_code,'')) = upper(COALESCE(l.item_brand,''))
      AND (COALESCE(r.design_token,'') = '' OR r.design_token = l.design_token)
      AND (COALESCE(r.size_token,'')   = '' OR r.size_token   = l.size_token)
      AND $3::date BETWEEN r.effective_from AND r.effective_to
    ORDER BY (COALESCE(r.design_token,'') <> '') DESC, (COALESCE(r.size_token,'') <> '') DESC
    LIMIT 1
  ) r ON TRUE
  LEFT JOIN public.app_incentive_product_status ps
    ON ps.item_code = l.item_code AND $3::date BETWEEN ps.effective_from AND ps.effective_to
  LEFT JOIN public.app_incentive_status_multiplier m ON m.status_code = ps.status_code
)
SELECT salename,
       ROUND(SUM(COALESCE(rule_points,0) * qty * status_multiplier)::numeric, 2) AS points,
       SUM(qty) FILTER (WHERE rule_points IS NOT NULL)::int AS matched_units,
       SUM(qty) FILTER (WHERE rule_points IS NULL AND category IS NOT NULL)::int AS unmatched_units
FROM scored
GROUP BY salename
ORDER BY points DESC NULLS LAST
LIMIT 12`;

console.log("\n== incentive points, July 2026 (rule-based) ==");
for (const row of await q(sql, [2026, 7, "2026-07-15"])) {
  console.log(
    `  ${String(row.salename || "").padEnd(24)} points=${String(row.points).padStart(9)}  matched=${String(row.matched_units ?? 0).padStart(4)}  unmatched=${row.unmatched_units ?? 0}`,
  );
}

await pool.end();
