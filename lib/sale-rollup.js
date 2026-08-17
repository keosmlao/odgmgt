import { one, query } from "./db";
import { CHANNEL_CODE_SQL, MONTHLY_TABLE } from "./sale-monthly-sql.mjs";

/**
 * Keeps the pre-aggregated rollups the dashboards read in step with
 * odg_sale_detail, which an overnight job tops up.
 *
 * The reports never read odg_sale_detail directly (2.7 GB, too slow), so the
 * rollup going stale is invisible: the page renders a confident-looking number
 * that is simply days old. `ensureFreshRollup` closes that gap — it compares a
 * cheap watermark (row count + latest sale date) against what the rollup was
 * last built from and rebuilds only when the source actually moved.
 */
const CUSTOMER_TABLE = "public.odg_sale_customer_month";
const WATERMARK_TABLE = "public.odg_rollup_watermark";

let watermarkTable = null;
function ensureWatermarkTable() {
  if (!watermarkTable) {
    watermarkTable = query(`
      CREATE TABLE IF NOT EXISTS ${WATERMARK_TABLE} (
        scope           text PRIMARY KEY,
        source_rows     bigint      NOT NULL,
        source_max_date date,
        refreshed_at    timestamptz NOT NULL DEFAULT now()
      )
    `).catch((error) => {
      watermarkTable = null;
      throw error;
    });
  }
  return watermarkTable;
}

const scopeKey = (years) => (years.length ? [...new Set(years)].sort().join(",") : "all");

/** Cheap stand-in for "has the source changed?" — a count and the latest sale date. */
async function readSource(years) {
  const row = await one(
    `SELECT COUNT(*)::bigint AS source_rows,
            to_char(MAX(doc_date), 'YYYY-MM-DD') AS source_max_date
     FROM public.odg_sale_detail
     ${years.length ? "WHERE yeardoc = ANY(%s::int[])" : ""}`,
    years.length ? [years] : [],
  );
  return { source_rows: String(row?.source_rows ?? "0"), source_max_date: row?.source_max_date ?? null };
}

async function readWatermark(scope) {
  await ensureWatermarkTable();
  const row = await one(
    `SELECT source_rows::text AS source_rows, source_max_date::text AS source_max_date,
            refreshed_at
     FROM ${WATERMARK_TABLE} WHERE scope = %s`,
    [scope],
  );
  return row || null;
}

/**
 * Rebuilds both rollups for the given years (all years when empty).
 * Scoped rebuilds delete only those years, leaving history untouched.
 */
export async function rebuildSaleRollup(years = []) {
  const scoped = years.length > 0;
  const yearParam = scoped ? [years] : [];

  if (scoped) {
    await query(`DELETE FROM ${MONTHLY_TABLE} WHERE yeardoc = ANY(%s::int[])`, yearParam);
  } else {
    await query(`TRUNCATE ${MONTHLY_TABLE}`);
  }
  await query(
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
    ${scoped ? "WHERE yeardoc = ANY(%s::int[])" : ""}
    GROUP BY 1, 2, 3, 4, 5, 7
    `,
    yearParam,
  );

  if (scoped) {
    await query(`DELETE FROM ${CUSTOMER_TABLE} WHERE yeardoc = ANY(%s::int[])`, yearParam);
  } else {
    await query(`TRUNCATE ${CUSTOMER_TABLE}`);
  }
  await query(
    `
    INSERT INTO ${CUSTOMER_TABLE}
      (yeardoc, monthdoc, bu_code, customer_code, sum_amount, orders)
    SELECT yeardoc, CAST(monthdoc AS int), COALESCE(NULLIF(bu_code, ''), '-'), customer_code,
           COALESCE(SUM(sum_amount), 0), COUNT(DISTINCT doc_no)
    FROM public.odg_sale_detail
    WHERE COALESCE(customer_code, '') <> ''
    ${scoped ? "AND yeardoc = ANY(%s::int[])" : ""}
    GROUP BY 1, 2, 3, 4
    `,
    yearParam,
  );
}

/** Concurrent page loads share one rebuild instead of racing the same TRUNCATE. */
const inFlight = new Map();

/**
 * Rebuilds the rollup when the source has moved since the last build (or when
 * `force`, which is what the Refresh button sends). Returns the freshness the
 * caller should report and key its own cache on.
 */
export async function ensureFreshRollup(years = [], { force = false } = {}) {
  const scope = scopeKey(years);
  const pending = inFlight.get(scope);
  if (pending) {
    const result = await pending;
    // A forced press that merely joined a no-op check still deserves a rebuild.
    if (!force || result.refreshed) return result;
  }

  const task = (async () => {
    const source = await readSource(years);
    const mark = await readWatermark(scope);
    const stale =
      !mark ||
      String(mark.source_rows) !== source.source_rows ||
      (mark.source_max_date || null) !== source.source_max_date;

    if (!force && !stale) {
      return {
        refreshed: false,
        refreshed_at: new Date(mark.refreshed_at).toISOString(),
        data_through: source.source_max_date,
      };
    }

    await rebuildSaleRollup(years);
    const saved = await one(
      `INSERT INTO ${WATERMARK_TABLE} (scope, source_rows, source_max_date, refreshed_at)
       VALUES (%s, %s, %s, now())
       ON CONFLICT (scope) DO UPDATE
         SET source_rows = EXCLUDED.source_rows,
             source_max_date = EXCLUDED.source_max_date,
             refreshed_at = EXCLUDED.refreshed_at
       RETURNING refreshed_at`,
      [scope, source.source_rows, source.source_max_date],
    );
    return {
      refreshed: true,
      refreshed_at: new Date(saved.refreshed_at).toISOString(),
      data_through: source.source_max_date,
    };
  })();

  inFlight.set(scope, task);
  try {
    return await task;
  } finally {
    inFlight.delete(scope);
  }
}
