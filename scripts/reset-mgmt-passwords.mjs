/**
 * Gives a system user (odg_mgmt_user) a starting password equal to their
 * employee code. Stored as plain text, which is how this project keeps them.
 *
 * It no longer overwrites rows that already hold a hash. That was a workaround
 * for the app being unable to verify one, and lib/employee-auth.js now handles
 * every format the shared column holds — so those accounts can log in as they
 * are, and rewriting them would only replace a password their owner knows with
 * their employee code.
 *
 * The password it sets is guessable by design (it is the employee code), so it
 * is a first login, not a credential. Anyone it is applied to should change it.
 *
 * Dry run:  node --env-file=.env.local scripts/reset-mgmt-passwords.mjs
 * Apply:    node --env-file=.env.local scripts/reset-mgmt-passwords.mjs --apply
 */
import pg from "pg";

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 8000,
});

const apply = process.argv.includes("--apply");

const targets = await pool.query(`
  SELECT e.employee_code, e.fullname_lo, u.app_role
  FROM public.odg_mgmt_user u
  JOIN public.odg_employee e ON e.employee_code = u.employee_code
  WHERE e.password IS NULL OR e.password = ''
  ORDER BY e.employee_code`);

console.log(`${apply ? "updating" : "would update"} ${targets.rowCount} account(s) with no password:`);
for (const row of targets.rows) {
  console.log(`  ${row.employee_code}  ${(row.fullname_lo || "?").padEnd(24)} ${row.app_role} → password = ${row.employee_code}`);
}

if (apply && targets.rowCount) {
  const result = await pool.query(
    `UPDATE public.odg_employee e
     SET password = e.employee_code
     FROM public.odg_mgmt_user u
     WHERE u.employee_code = e.employee_code
       AND (e.password IS NULL OR e.password = '')`,
  );
  console.log(`\nupdated ${result.rowCount} row(s)`);
} else if (!apply) {
  console.log("\n(dry run — pass --apply to write)");
}

await pool.end();
