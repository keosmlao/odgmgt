/** Finds where the names of position codes 11 / 12 / 13 live. */
import pg from "pg";

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  statement_timeout: 25000,
});
const q = (sql, params = []) => pool.query(sql, params).then((r) => r.rows);

for (const table of ["odg_position", "odg_position_list_biotime"]) {
  const cols = await q(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table],
  );
  if (!cols.length) continue;
  console.log(`\n== ${table}: ${cols.map((c) => c.column_name).join(", ")}`);
  console.log(JSON.stringify(await q(`SELECT * FROM public."${table}" LIMIT 6`)).slice(0, 700));
}

console.log("\n== any table with a column named position_code that also has a name column ==");
const candidates = await q(`
  SELECT table_name, string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
  FROM information_schema.columns
  WHERE table_schema='public'
    AND table_name IN (
      SELECT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name IN ('position_code','position_id')
    )
  GROUP BY table_name
  HAVING string_agg(column_name, ',') ILIKE '%name%'
  ORDER BY 1 LIMIT 8`);
for (const row of candidates) console.log(`  ${row.table_name}: ${row.cols.slice(0, 160)}`);

console.log("\n== employees at each commission position (sample names) ==");
for (const code of ["11", "12", "13"]) {
  const list = await q(
    `SELECT employee_code, fullname_lo, position_code FROM public.odg_employee WHERE position_code = $1 LIMIT 3`,
    [code],
  );
  console.log(`  ${code}: ${list.map((row) => row.fullname_lo).join(" · ")}`);
}

await pool.end();
