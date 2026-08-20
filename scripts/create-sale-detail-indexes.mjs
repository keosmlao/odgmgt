/**
 * Creates the covering indexes that keep dashboard/analytics aggregates off the
 * 2GB odg_sale_detail heap, plus the ic_trans lookup the online-channel rule
 * depends on. Safe to re-run: every step is IF NOT EXISTS and uses
 * CONCURRENTLY so live traffic is never blocked.
 *
 *   node scripts/create-sale-detail-indexes.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  const env = { ...process.env };
  try {
    for (const line of readFileSync(join(root, ".env.local"), "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !env[match[1]]) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // fall back to the ambient environment
  }
  return env;
}

const env = loadEnv();
const pool = new pg.Pool({
  host: env.PGHOST,
  port: Number(env.PGPORT || 5432),
  database: env.PGDATABASE,
  user: env.PGUSER,
  password: env.PGPASSWORD,
  max: 2,
  statement_timeout: 0,
});

const INDEXES = [
  // Filters + money/customer aggregates: KPI, monthly rollups, BU/province/channel splits.
  ["idx_osd_year_cover", `
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_osd_year_cover
    ON public.odg_sale_detail (yeardoc, monthdoc)
    INCLUDE (bu_code, province, province_name, channel_name, argroup, argroup_main,
             argroupsub, saletype, customer_code, customername, doc_no, doc_date,
             sum_amount, sum_of_cost, sum_cost_thb_vte, discount_amount, discount_amount_2)`],
  // Date-range scans such as the 90-day revenue window behind DSO.
  ["idx_osd_doc_date", `
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_osd_doc_date
    ON public.odg_sale_detail (doc_date)
    INCLUDE (sum_amount, bu_code, customer_code, doc_no)`],
  // doc_no -> BU lookup used to attribute AR aging rows to a business unit.
  ["idx_osd_docno_bu", `
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_osd_docno_bu
    ON public.odg_sale_detail (doc_no)
    INCLUDE (bu_code, bu_name)`],
  // Item-level analytics: brand profitability, product groups, top/dropping items.
  ["idx_osd_item_cover", `
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_osd_item_cover
    ON public.odg_sale_detail (yeardoc, monthdoc)
    INCLUDE (item_code, item_name, item_brand, itemmaingroup, itemsubgroup,
             bu_code, province, province_name, channel_name, argroup, argroup_main,
             argroupsub, customer_code, qty, sum_amount, sum_of_cost, sum_cost_thb_vte)`],
  // Resolving ຂາຍອອນລາຍ means asking "which bills did the online department
  // sell", and the salesperson only exists on the bill header. Without this the
  // lookup seq-scans 322k ic_trans rows (222 ms) on every report that splits by
  // channel; with it, 19 ms. See lib/online-channel.mjs.
  ["idx_ic_trans_sale_code_btrim", `
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ic_trans_sale_code_btrim
    ON public.ic_trans (btrim(sale_code))
    WHERE trans_flag IN (44, 48)`],
];

for (const [name, sql] of INDEXES) {
  const started = Date.now();
  process.stdout.write(`creating ${name} ... `);
  try {
    await pool.query(sql);
    const size = await pool.query("SELECT pg_size_pretty(pg_relation_size($1::regclass)) AS sz", [name]);
    console.log(`ok in ${((Date.now() - started) / 1000).toFixed(1)}s, size ${size.rows[0].sz}`);
  } catch (error) {
    console.log(`FAILED: ${error.message}`);
  }
}

// A cancelled CREATE INDEX CONCURRENTLY leaves an unusable index behind.
const invalid = await pool.query(`
  SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
  WHERE NOT i.indisvalid AND c.relname LIKE 'idx_osd%'`);
console.log("invalid indexes:", invalid.rows.map((row) => row.relname).join(", ") || "none");

// Index-only scans need an up-to-date visibility map and statistics.
process.stdout.write("VACUUM ANALYZE ... ");
const vacuumStarted = Date.now();
await pool.query("VACUUM (ANALYZE) public.odg_sale_detail");
console.log(`done in ${((Date.now() - vacuumStarted) / 1000).toFixed(1)}s`);

const total = await pool.query(
  `SELECT pg_size_pretty(pg_indexes_size($1::regclass)) AS idx,
          pg_size_pretty(pg_total_relation_size($1::regclass)) AS tot`,
  ["public.odg_sale_detail"],
);
console.log(`indexes ${total.rows[0].idx} | table total ${total.rows[0].tot}`);

await pool.end();
