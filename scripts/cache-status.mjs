/** Shows what the persistent report cache is holding. */
import pg from "pg";

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 8000,
});

const res = await pool
  .query(`
    SELECT cache_key,
           pg_size_pretty(pg_column_size(payload)::bigint) AS size,
           to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at,
           round(EXTRACT(EPOCH FROM (now() - updated_at)))::int AS age_s
    FROM public.app_report_cache ORDER BY updated_at DESC LIMIT 20`)
  .catch((error) => ({ rows: [], error }));

if (res.error) console.log("cache table not ready:", res.error.message);
console.log(`cached reports: ${res.rows.length}`);
for (const row of res.rows) {
  console.log(`  ${row.cache_key.padEnd(42)} ${row.size.padStart(9)}  age ${row.age_s}s`);
}

await pool.end();
