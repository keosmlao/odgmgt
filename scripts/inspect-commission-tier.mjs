/** Where the "department commission tiers" on the page come from. */
import pg from "pg";

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  statement_timeout: 30000,
});
const q = (sql, params = []) => pool.query(sql, params).then((r) => r.rows);

console.log("== public.app_commission_tier — every row ==");
console.log(JSON.stringify(await q(`SELECT * FROM public.app_commission_tier ORDER BY min_pct`), null, 1));

console.log("\n== is it referenced by anything? ==");
console.log(
  "views mentioning it:",
  JSON.stringify(await q(`SELECT viewname FROM pg_views WHERE schemaname='public' AND definition ILIKE '%app_commission_tier%'`)),
);
console.log(
  "functions mentioning it:",
  JSON.stringify(await q(`SELECT proname FROM pg_proc WHERE prosrc ILIKE '%app_commission_tier%' LIMIT 5`)),
);

console.log("\n== the tables it would feed ==");
for (const table of ["app_commission_round", "app_commission_line"]) {
  const [count] = await q(`SELECT COUNT(*)::int AS n FROM public."${table}"`);
  console.log(`  ${table}: ${count.n} rows`);
}

console.log("\n== the other tier table (used by the incentive engine) ==");
console.log(JSON.stringify(await q(`SELECT position_code, from_pct, mode, round_step FROM public.app_incentive_commission_tier ORDER BY position_code, from_pct LIMIT 6`)));

await pool.end();
