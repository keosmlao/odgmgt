/** Effective periods of the point rules. */
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
const d = (value) => (value ? new Date(value).toISOString().slice(0, 10) : "-");

console.log("== app_incentive_point_rule: distinct periods ==");
for (const row of await q(`
  SELECT effective_from, effective_to, COUNT(*)::int AS rules,
         COUNT(DISTINCT category_code)::int AS categories,
         MIN(points)::float AS min_points, MAX(points)::float AS max_points
  FROM public.app_incentive_point_rule
  GROUP BY 1, 2 ORDER BY 1, 2`)) {
  console.log(
    `  ${d(row.effective_from)} → ${d(row.effective_to)}   ${String(row.rules).padStart(3)} ກົດ · ${row.categories} ໝວດ · ຄະແນນ ${row.min_points}-${row.max_points}`,
  );
}

console.log("\n== in force per month of 2026 ==");
for (let month = 1; month <= 12; month += 1) {
  const date = `2026-${String(month).padStart(2, "0")}-15`;
  const [row] = await q(
    `SELECT COUNT(*)::int AS n FROM public.app_incentive_point_rule
     WHERE $1::date BETWEEN effective_from AND effective_to`,
    [date],
  );
  console.log(`  ${date.slice(0, 7)}  ${String(row.n).padStart(3)} ກົດ`);
}

console.log("\n== other time-scoped incentive tables ==");
for (const [table, from, to] of [
  ["app_incentive_unit_reward", "effective_from", "effective_to"],
  ["app_incentive_special_reward", "effective_from", "effective_to"],
  ["app_incentive_product_status", "effective_from", "effective_to"],
  ["app_incentive_product_status_rule", "effective_from", "effective_to"],
]) {
  const list = await q(
    `SELECT ${from} AS f, ${to} AS t, COUNT(*)::int AS n FROM public."${table}" GROUP BY 1,2 ORDER BY 1`,
  );
  console.log(`  ${table}`);
  for (const row of list) console.log(`     ${d(row.f)} → ${d(row.t)}  (${row.n})`);
}

const [map] = await q(
  `SELECT MIN(effect_month) AS f, MAX(effect_month) AS t, COUNT(*)::int AS n FROM public.app_incentive_point_map`,
);
console.log(`  app_incentive_point_map: effect_month ${d(map.f)} → ${d(map.t)} (${map.n}) — ບໍ່ມີວັນສິ້ນສຸດ`);

await pool.end();
