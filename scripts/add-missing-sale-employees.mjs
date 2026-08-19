/**
 * Adds people who are already selling to the HR roster.
 *
 * A bill carries ic_trans.sale_code, and every report that scores a person —
 * the Sales Assignment board, the incentive runs — joins that to
 * odg_employee.employee_code. A new hire the ERP knows about but HR has not
 * entered yet therefore sells into a void: their baht is attributed to nobody
 * and simply never appears.
 *
 * Names are read from public.erp_user, the ERP's own user master, rather than
 * typed in here — this writes to the HR roster, so it must not invent anyone.
 * A code the ERP cannot name either is reported and skipped.
 *
 * Usage:
 *   node scripts/add-missing-sale-employees.mjs [year] [--apply]
 */
import { loadEnv } from "./_env.mjs";
import pg from "pg";

loadEnv();

const argv = process.argv.slice(2);
const YEAR = Number(argv.find((a) => /^\d{4}$/.test(a)) || new Date().getFullYear());
const APPLY = argv.includes("--apply");

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: 1,
  statement_timeout: 600000,
});
const q = (sql, params = []) => pool.query(sql, params).then((r) => r.rows);
const money = (n) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

/** Sale codes that billed in the year but are not on the roster. */
const MISSING = `
  WITH sold AS (
    SELECT btrim(t.sale_code) AS sale_code,
           COUNT(DISTINCT d.doc_no)::int AS bills,
           SUM(d.sum_amount)::float AS baht,
           MIN(d.doc_date)::text AS first_bill,
           MAX(d.doc_date)::text AS last_bill
    FROM public.odg_sale_detail d
    JOIN public.ic_trans t
      ON t.doc_no = d.doc_no
     AND t.trans_flag IN (44, 48)
     AND t.doc_date >= make_date($1::int, 1, 1) - INTERVAL '1 month'
     AND t.doc_date <  make_date($1::int + 1, 2, 1)
    WHERE d.yeardoc = $1::int AND COALESCE(btrim(t.sale_code), '') <> ''
    GROUP BY 1
  )
  SELECT s.*,
         NULLIF(btrim(u.name_1), '') AS erp_name,
         NULLIF(btrim(u.dept_code), '') AS dept_code,
         NULLIF(btrim(u.bu_code), '') AS bu_code
  FROM sold s
  LEFT JOIN public.erp_user u ON btrim(u.code) = s.sale_code
  WHERE NOT EXISTS (
    SELECT 1 FROM public.odg_employee e WHERE btrim(e.employee_code) = s.sale_code
  )
  ORDER BY s.baht DESC`;

const missing = await q(MISSING, [YEAR]);
const named = missing.filter((r) => r.erp_name);
const unnamed = missing.filter((r) => !r.erp_name);

console.log(`year ${YEAR} · ${APPLY ? "APPLY" : "dry run"}`);
console.log(`\n${missing.length} sale codes billed but are not on the roster`);
console.log(`  ${named.length} the ERP can name · ${unnamed.length} it cannot\n`);

for (const r of named) {
  console.log(
    `  + ${r.sale_code.padEnd(8)} ${String(r.erp_name).padEnd(26)}` +
      ` dept ${String(r.dept_code || "-").padEnd(5)} bu ${String(r.bu_code || "-").padEnd(3)}` +
      ` ${String(r.bills).padStart(4)} bills ${money(r.baht).padStart(12)} baht` +
      ` (${r.first_bill} → ${r.last_bill})`,
  );
}
if (unnamed.length) {
  console.log("\n  skipped — no name in erp_user either, so nothing can be entered:");
  for (const r of unnamed) {
    console.log(
      `  ? ${r.sale_code.padEnd(8)} ${String(r.bills).padStart(4)} bills` +
        ` ${money(r.baht).padStart(12)} baht (${r.first_bill} → ${r.last_bill})`,
    );
  }
}

if (!APPLY) {
  console.log("\ndry run — nothing written. Pass --apply to insert.");
} else if (named.length) {
  // hire_date is left NULL rather than guessed from the ERP's record-created
  // stamp: most of the roster has it NULL too, and a wrong date is worse than
  // none. position_code likewise — the ERP does not carry one for these rows.
  const inserted = await q(
    `INSERT INTO public.odg_employee
       (employee_code, fullname_lo, department_code, employment_status)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
     ON CONFLICT DO NOTHING
     RETURNING employee_code`,
    [
      named.map((r) => r.sale_code),
      named.map((r) => r.erp_name),
      named.map((r) => r.dept_code),
      named.map(() => "ACTIVE"),
    ],
  );
  console.log(`\ninserted ${inserted.length} employees: ${inserted.map((r) => r.employee_code).join(", ")}`);
  const [now] = await q(
    `SELECT COUNT(*)::int AS active FROM public.odg_employee
     WHERE UPPER(COALESCE(btrim(employment_status), 'ACTIVE')) = 'ACTIVE'`,
  );
  console.log(`odg_employee now has ${now.active} active people`);
}

await pool.end();
