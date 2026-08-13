/**
 * Gives a system user (odg_mgmt_user) a starting password equal to their
 * employee code, stored as a scrypt hash.
 *
 * This used to do the opposite: it overwrote hashes with plain text, because
 * the app could not verify a hash and those accounts could not log in. The
 * verifier in lib/employee-auth.js now handles every format the shared column
 * holds, so that workaround is gone — hashed rows are left alone and only
 * accounts with no password at all are given one.
 *
 * The password it sets is guessable by design (it is the employee code), so it
 * is a first login, not a credential. Anyone it is applied to should change it.
 *
 * Dry run:  node --env-file=.env.local scripts/reset-mgmt-passwords.mjs
 * Apply:    node --env-file=.env.local scripts/reset-mgmt-passwords.mjs --apply
 */
import crypto from "crypto";
import pg from "pg";

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 8000,
});

/** Same format as lib/auth.js generatePasswordHash: scrypt:N:r:p$salt$hex. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const [N, r, p] = [32768, 8, 1];
  const digest = crypto
    .scryptSync(String(password), salt, 64, { N, r, p, maxmem: 128 * 1024 * 1024 })
    .toString("hex");
  return `scrypt:${N}:${r}:${p}$${salt}$${digest}`;
}

const apply = process.argv.includes("--apply");

const targets = await pool.query(`
  SELECT e.employee_code, e.fullname_lo, u.app_role
  FROM public.odg_mgmt_user u
  JOIN public.odg_employee e ON e.employee_code = u.employee_code
  WHERE e.password IS NULL OR e.password = ''
  ORDER BY e.employee_code`);

console.log(`${apply ? "updating" : "would update"} ${targets.rowCount} account(s) with no password:`);
for (const row of targets.rows) {
  console.log(`  ${row.employee_code}  ${(row.fullname_lo || "?").padEnd(24)} ${row.app_role} → password = ${row.employee_code} (hashed)`);
}

if (apply && targets.rowCount) {
  let updated = 0;
  for (const row of targets.rows) {
    const result = await pool.query(
      `UPDATE public.odg_employee
       SET password = $2
       WHERE employee_code = $1 AND (password IS NULL OR password = '')`,
      [row.employee_code, hashPassword(row.employee_code)],
    );
    updated += result.rowCount;
  }
  console.log(`\nupdated ${updated} row(s)`);
} else if (!apply) {
  console.log("\n(dry run — pass --apply to write)");
}

await pool.end();
