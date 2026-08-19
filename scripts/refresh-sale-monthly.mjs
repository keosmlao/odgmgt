/**
 * Builds/refreshes public.odg_sale_monthly — the pre-aggregated table the
 * dashboards read instead of scanning the 2.7 GB odg_sale_detail.
 *
 * Grain: year × month × BU × channel × province × district, bucketed on the
 * REPORTED month (app_sale_month_override wins over the ERP's own doc date).
 *
 * This file owns the DDL only; the aggregation itself lives in
 * lib/sale-rollup.js so the script and the API can never disagree.
 * Run manually:   node --env-file=.env.local scripts/refresh-sale-monthly.mjs
 * Or on a timer:  POST /api/admin/refresh-summary  (see route)
 */
import pg from "pg";
import { MONTHLY_TABLE, SELLER_TABLE_DDL } from "../lib/sale-monthly-sql.mjs";

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 10000,
});

const started = Date.now();

await pool.query(`
  CREATE TABLE IF NOT EXISTS ${MONTHLY_TABLE} (
    yeardoc      int  NOT NULL,
    monthdoc     int  NOT NULL,
    bu_code      text NOT NULL,
    channel_code text NOT NULL,
    province     text NOT NULL,
    province_name text NOT NULL DEFAULT '',
    amper        text NOT NULL,
    sum_amount   numeric NOT NULL DEFAULT 0,
    sum_cost     numeric NOT NULL DEFAULT 0,
    qty          numeric NOT NULL DEFAULT 0,
    cash_amount  numeric NOT NULL DEFAULT 0,
    credit_amount numeric NOT NULL DEFAULT 0,
    orders       int     NOT NULL DEFAULT 0,
    customers    int     NOT NULL DEFAULT 0,
    refreshed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (yeardoc, monthdoc, bu_code, channel_code, province, amper)
  )
`);
await pool.query(`ALTER TABLE ${MONTHLY_TABLE} ADD COLUMN IF NOT EXISTS province_name text NOT NULL DEFAULT ''`);
await pool.query(`ALTER TABLE ${MONTHLY_TABLE} ADD COLUMN IF NOT EXISTS cash_amount numeric NOT NULL DEFAULT 0`);
await pool.query(`ALTER TABLE ${MONTHLY_TABLE} ADD COLUMN IF NOT EXISTS credit_amount numeric NOT NULL DEFAULT 0`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_osm_year_month ON ${MONTHLY_TABLE} (yeardoc, monthdoc)`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_osm_bu_channel ON ${MONTHLY_TABLE} (yeardoc, bu_code, channel_code)`);

const years = process.argv.slice(2).filter((arg) => /^\d{4}$/.test(arg)).map(Number);

/* ── Seller × month rollup ────────────────────────────────────────────────
   Same grain as odg_sale_monthly plus the salesperson, who is only on the bill
   header (ic_trans.sale_code). Powers the Sales Assignment grid, where a row is
   one person's area and the seller-less rollup would hand every seller sharing
   a district that district's whole kip. */
for (const statement of SELLER_TABLE_DDL) await pool.query(statement);

/* ── Customer × month rollup ──────────────────────────────────────────────
   Powers the repeat/new/reactivated customer panels, which otherwise scan
   the whole detail table for every dashboard request. */
await pool.query(`
  CREATE TABLE IF NOT EXISTS public.odg_sale_customer_month (
    yeardoc       int  NOT NULL,
    monthdoc      int  NOT NULL,
    bu_code       text NOT NULL,
    customer_code text NOT NULL,
    sum_amount    numeric NOT NULL DEFAULT 0,
    orders        int     NOT NULL DEFAULT 0,
    PRIMARY KEY (yeardoc, monthdoc, bu_code, customer_code)
  )
`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_oscm_cust ON public.odg_sale_customer_month (customer_code, yeardoc, monthdoc)`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_oscm_year ON public.odg_sale_customer_month (yeardoc, monthdoc)`);

// One shared implementation for both rollups — the API refresh and this script
// must bucket sales the same way, month overrides included.
const { rebuildSaleRollup } = await import("../lib/sale-rollup.js");
await rebuildSaleRollup(years);

const stats = await pool.query(`
  SELECT COUNT(*)::int AS "rows", MIN(yeardoc) AS min_year, MAX(yeardoc) AS max_year,
         pg_size_pretty(pg_total_relation_size('${MONTHLY_TABLE}')) AS size
  FROM ${MONTHLY_TABLE}`);
console.log("summary table:", JSON.stringify(stats.rows[0]));
console.log(`took ${((Date.now() - started) / 1000).toFixed(1)}s`);

await pool.end();
