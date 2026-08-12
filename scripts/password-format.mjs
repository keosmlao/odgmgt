/** Shows the stored password format for the system's users. */
import pg from "pg";

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 8000,
});

const rows = await pool.query(`
  SELECT u.employee_code, u.app_role, u.is_active, e.fullname_lo,
         CASE
           WHEN e.password IS NULL OR e.password = '' THEN 'empty'
           WHEN e.password ~* '^(scrypt|pbkdf2|argon2)[$:]' THEN 'hashed'
           WHEN e.password = e.employee_code THEN 'plain (= employee code)'
           ELSE 'plain'
         END AS password_format,
         u.is_active,
         e.employment_status
  FROM public.odg_mgmt_user u
  LEFT JOIN public.odg_employee e ON e.employee_code = u.employee_code
  ORDER BY u.employee_code`);

console.log("system users:");
for (const row of rows.rows) {
  console.log(
    `  ${row.employee_code}  ${(row.fullname_lo || "?").padEnd(22)} ${String(row.app_role).padEnd(16)} ${String(row.password_format).padEnd(24)} active=${row.is_active}  hr=${row.employment_status}`,
  );
}

const summary = await pool.query(`
  SELECT COUNT(*) FILTER (WHERE password ~* '^(scrypt|pbkdf2|argon2)[$:]')::int AS hashed,
         COUNT(*) FILTER (WHERE password = employee_code)::int AS plain_code,
         COUNT(*)::int AS total
  FROM public.odg_employee`);
console.log("\nall employees:", JSON.stringify(summary.rows[0]));

await pool.end();
