/**
 * Builds/refreshes public.odg_sale_monthly — the pre-aggregated table the
 * dashboards read instead of scanning the 2.7 GB odg_sale_detail.
 *
 * Grain: year × month × BU × channel × province × district.
 * Run manually:   node --env-file=.env.local scripts/refresh-sale-monthly.mjs
 * Or on a timer:  POST /api/admin/refresh-summary  (see route)
 */
import pg from "pg";
import { CHANNEL_CODE_SQL, MONTHLY_TABLE } from "../lib/sale-monthly-sql.mjs";

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

const years = process.argv.slice(2).filter((arg) => /^\d{4}$/.test(arg));
const yearFilter = years.length ? `WHERE yeardoc = ANY($1::int[])` : "";
const params = years.length ? [years.map(Number)] : [];

const client = await pool.connect();
try {
  await client.query("BEGIN");
  if (years.length) {
    await client.query(`DELETE FROM ${MONTHLY_TABLE} WHERE yeardoc = ANY($1::int[])`, params);
  } else {
    await client.query(`TRUNCATE ${MONTHLY_TABLE}`);
  }

  const inserted = await client.query(
    `
    INSERT INTO ${MONTHLY_TABLE}
      (yeardoc, monthdoc, bu_code, channel_code, province, province_name, amper,
       sum_amount, sum_cost, qty, cash_amount, credit_amount, orders, customers, refreshed_at)
    SELECT
      yeardoc,
      CAST(monthdoc AS int),
      COALESCE(NULLIF(bu_code, ''), '-'),
      ${CHANNEL_CODE_SQL},
      COALESCE(NULLIF(province, ''), '-'),
      COALESCE(NULLIF(MIN(province_name), ''), ''),
      COALESCE(NULLIF(amper, ''), '-'),
      COALESCE(SUM(sum_amount), 0),
      COALESCE(SUM(sum_of_cost), 0),
      COALESCE(SUM(qty), 0),
      COALESCE(SUM(CASE WHEN lower(COALESCE(saletype, '')) LIKE '%สด%' OR lower(COALESCE(saletype, '')) LIKE '%cash%'
                        OR lower(COALESCE(saletype, '')) LIKE '%cod%' THEN sum_amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN lower(COALESCE(saletype, '')) LIKE '%เชื่อ%' OR lower(COALESCE(saletype, '')) LIKE '%credit%'
                        OR lower(COALESCE(saletype, '')) LIKE '%ติดหนี้%' THEN sum_amount ELSE 0 END), 0),
      COUNT(DISTINCT doc_no),
      COUNT(DISTINCT customer_code),
      now()
    FROM public.odg_sale_detail
    ${yearFilter}
    GROUP BY 1, 2, 3, 4, 5, 7
    `,
    params,
  );
  await client.query("COMMIT");
  console.log(`rows written: ${inserted.rowCount}`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}

const stats = await pool.query(`
  SELECT COUNT(*)::int AS "rows", MIN(yeardoc) AS min_year, MAX(yeardoc) AS max_year,
         pg_size_pretty(pg_total_relation_size('${MONTHLY_TABLE}')) AS size
  FROM ${MONTHLY_TABLE}`);
console.log("summary table:", JSON.stringify(stats.rows[0]));
console.log(`took ${((Date.now() - started) / 1000).toFixed(1)}s`);

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

{
  const client2 = await pool.connect();
  try {
    await client2.query("BEGIN");
    if (years.length) {
      await client2.query(`DELETE FROM public.odg_sale_customer_month WHERE yeardoc = ANY($1::int[])`, params);
    } else {
      await client2.query(`TRUNCATE public.odg_sale_customer_month`);
    }
    const res = await client2.query(
      `INSERT INTO public.odg_sale_customer_month
         (yeardoc, monthdoc, bu_code, customer_code, sum_amount, orders)
       SELECT yeardoc, CAST(monthdoc AS int), COALESCE(NULLIF(bu_code, ''), '-'), customer_code,
              COALESCE(SUM(sum_amount), 0), COUNT(DISTINCT doc_no)
       FROM public.odg_sale_detail
       WHERE COALESCE(customer_code, '') <> ''
       ${years.length ? "AND yeardoc = ANY($1::int[])" : ""}
       GROUP BY 1, 2, 3, 4`,
      params,
    );
    await client2.query("COMMIT");
    console.log(`customer rollup rows: ${res.rowCount}`);
  } catch (error) {
    await client2.query("ROLLBACK");
    throw error;
  } finally {
    client2.release();
  }
}

await pool.end();
