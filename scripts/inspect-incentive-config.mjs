/** Lists every incentive configuration table with its size and columns. */
import pg from "pg";

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 8000,
  statement_timeout: 30000,
});
const q = (sql, params = []) => pool.query(sql, params).then((r) => r.rows);

const tables = await q(`
  SELECT c.relname AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND (c.relname LIKE 'app_incentive%' OR c.relname LIKE 'app_commission%')
  ORDER BY 1`);

for (const row of tables) {
  const count = await q(`SELECT COUNT(*)::int AS n FROM public."${row.name}"`);
  const cols = await q(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [row.name],
  );
  console.log(`${row.name.padEnd(36)} ${String(count[0].n).padStart(4)} rows   ${cols.map((c) => c.column_name).join(", ")}`);
}

await pool.end();
