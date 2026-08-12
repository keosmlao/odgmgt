/**
 * Drops persisted report cache rows so the next request recomputes.
 * Usage: node --env-file=.env.local scripts/clear-report-cache.mjs [key-prefix]
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

const prefix = process.argv[2] || "";
const result = await pool.query(
  prefix
    ? `DELETE FROM public.app_report_cache WHERE cache_key LIKE $1`
    : `DELETE FROM public.app_report_cache`,
  prefix ? [`${prefix}%`] : [],
);
console.log(`cleared ${result.rowCount} cached report(s)${prefix ? ` matching "${prefix}"` : ""}`);
await pool.end();
