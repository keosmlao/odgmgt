/** Reads how the points view defines "front store" so the report matches it. */
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

const def = await q(`SELECT pg_get_viewdef('public.report_sale_retail_get_point_26'::regclass, true) AS def`);
console.log(def[0].def.slice(0, 2600));

console.log("\n== Jul 2026, branch 01 + argroup_main 101, by BU ==");
for (const row of await q(`
  SELECT d.bu_code, b.name_1 AS bu_name, d.department_name,
         COUNT(DISTINCT d.doc_no)::int AS bills,
         ROUND(SUM(d.sum_amount)::numeric, 0) AS amount
  FROM public.odg_sale_detail d
  LEFT JOIN public.odg_bu b ON b.code = d.bu_code
  WHERE d.yeardoc = 2026 AND d.monthdoc = 7
    AND d.branch_code = '01' AND d.argroup_main = '101'
  GROUP BY 1,2,3 ORDER BY 5 DESC`)) {
  console.log(`   bu=${String(row.bu_code).padEnd(4)} ${String(row.bu_name || "").padEnd(12)} ${String(row.department_name || "").padEnd(28)} ${Number(row.amount).toLocaleString()}`);
}

await pool.end();
