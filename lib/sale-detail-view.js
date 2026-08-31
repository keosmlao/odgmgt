import { pool, query, rows } from "./db.js";

/**
 * odg_sale_detail as the business reports it — two things the raw table is not:
 *
 *   odg_sale_detail_live      the copy PLUS the bills the copy has not caught
 *                             up with yet, read off the ERP.
 *   odg_sale_detail_reported  the same rows, with yeardoc/monthdoc carrying the
 *                             month the sale is CREDITED to rather than the
 *                             month its bill was printed in.
 *
 * ── ຮອດປະຈຸບັນ ──────────────────────────────────────────────────────────────
 *
 * odg_sale_detail is not the ERP: it is a copy of public.sale_detail_2022 that
 * an ERP-side job reloads for the last 31 days, seven times on a working day —
 * 07:30, 12:00, 14:00, 16:30, 17:00, 18:00, 19:30, each run logged to
 * odg_trigger_update_data. Between two runs the reports stand still, and the
 * morning gap is four and a half hours wide: at 10:00 the screens showed
 * yesterday, because the 07:30 run had found nothing yet to copy.
 *
 * So the bills newer than the copy are read from the same view the job copies
 * from — but into a small table of our own, refreshed at most once a minute,
 * NOT straight into the reports. sale_detail_2022 joins some twenty-five ERP
 * tables; asked for today's rows on its own it answers in 300 ms, but inside a
 * report's two-year scan it cost three seconds every time. Held in a table the
 * union costs 0.4 s in total, and no report pays the ERP join at all.
 *
 * Nothing here writes to odg_sale_detail. The top-up table is ours, disposable,
 * and rebuilt whole; two guards keep it from ever double-counting a bill:
 *
 *   · only bills DATED AFTER the copy's last day are taken, so a day the job
 *     has already loaded is never read twice; and
 *   · a doc_no that is in the copy is skipped whatever its date, which covers
 *     a job run landing between two refreshes.
 *
 * The source is the job's own source, so a day read live and the same day read
 * after the job has run give the same kip — verified over 26-30/08/2026, row
 * for row and kip for kip.
 *
 * ── ເດືອນທີ່ບິນຖືກນັບ ───────────────────────────────────────────────────────
 *
 * A bill closed on 30/7 but issued on 1/8 is approved into July in
 * app_sale_month_override. The incentive queries have always honoured that by
 * joining the override themselves; the sales reports never did, so the same
 * bill paid July points while its kip landed in August.
 *
 * Doing it as a view rather than editing every report's WHERE clause keeps
 * `yeardoc = %s` meaning one thing everywhere — there is no second spelling of
 * "which month is this in" for a new report to pick the wrong one of.
 *
 * doc_date stays the date on the bill; only the month buckets move. Reports
 * asking "what sold today" still mean the day the bill was printed.
 *
 * The column list is read from the catalog instead of being written out here
 * because the ERP adds columns without warning (lib/sale-detail-schema.js
 * exists for the same reason). A hardcoded list would silently stop passing
 * through anything added later.
 */
export const SALE_DETAIL_LIVE = "public.odg_sale_detail_live";
export const SALE_DETAIL_REPORTED = "public.odg_sale_detail_reported";

/** ບິນທີ່ຍັງບໍ່ທັນ copy — ours, rebuilt whole, never more than a minute old. */
const LIVE_TABLE = "public.app_sale_detail_live";

/** The ERP-side view the copy job selects from — the copy's own source. */
const LIVE_SOURCE = "public.sale_detail_2022";

/** Columns the reported view redefines; everything else passes through. */
const REPLACED = new Set(["yeardoc", "monthdoc", "report_date"]);

/** How stale the top-up is allowed to get before a page pays to rebuild it. */
const MAX_AGE_MS = 60_000;

/**
 * ສະແຕມບິນສົດ — what the top-up holds. Reports key their cache on it, so an
 * answer computed before a bill arrived cannot be served after it, and the
 * stamp and the rows behind it always come from the same refresh.
 */
export const LIVE_BILL_STAMP_SQL = `(SELECT COUNT(*)::text || '@' || COALESCE(MAX(doc_date)::text, '-')
       FROM ${LIVE_TABLE})`;

/** ວັນທີບິນລ່າສຸດ that is not in the copy — what "ຂໍ້ມູນຮອດ" has to account for. */
export const LIVE_MAX_DOC_DATE_SQL = `(SELECT MAX(doc_date) FROM ${LIVE_TABLE})`;

let ready = null;
let refreshedAt = 0;
let refreshing = null;

const quoted = (name) => `"${name.replace(/"/g, '""')}"`;

async function columnsOf(relation) {
  return rows(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
     FROM pg_attribute a
     WHERE a.attrelid = '${relation}'::regclass
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
  );
}

async function build() {
  const columns = await columnsOf("public.odg_sale_detail");
  if (!columns.length) throw new Error("odg_sale_detail not found");
  const names = columns.map(({ name }) => name);

  // The top-up table carries the copy's own shape. Rebuilt from scratch when
  // the ERP adds a column, which it does without warning.
  const existing = await columnsOf(LIVE_TABLE).catch(() => []);
  const sameShape =
    existing.length === columns.length &&
    existing.every((column, index) => column.name === columns[index].name);
  if (!sameShape) {
    await query(`DROP VIEW IF EXISTS ${SALE_DETAIL_REPORTED}`);
    await query(`DROP VIEW IF EXISTS ${SALE_DETAIL_LIVE}`);
    await query(`DROP TABLE IF EXISTS ${LIVE_TABLE}`);
    await query(`CREATE TABLE ${LIVE_TABLE} (LIKE public.odg_sale_detail)`);
    refreshedAt = 0;
  }

  // LIKE copies NOT NULL but not the defaults behind it — roworder is the
  // copy's own sequence, and a top-up row has nothing to put there. Idempotent,
  // so it also repairs a table created before this ran.
  const required = await rows(
    `SELECT a.attname AS name
     FROM pg_attribute a
     WHERE a.attrelid = '${LIVE_TABLE}'::regclass
       AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull`,
  );
  for (const column of required) {
    await query(`ALTER TABLE ${LIVE_TABLE} ALTER COLUMN ${quoted(column.name)} DROP NOT NULL`);
  }

  const liveSql = `
    CREATE OR REPLACE VIEW ${SALE_DETAIL_LIVE} AS
      SELECT ${names.map((name) => `c.${quoted(name)}`).join(", ")}
      FROM public.odg_sale_detail c
    UNION ALL
      SELECT ${names.map((name) => `t.${quoted(name)}`).join(", ")}
      FROM ${LIVE_TABLE} t`;

  const passthrough = names
    .filter((name) => !REPLACED.has(name))
    .map((name) => `d.${quoted(name)}`)
    .join(",\n           ");

  // Split rather than LEFT JOIN + COALESCE. Wrapping yeardoc in an expression
  // hides it from idx_osd_year_cover, and a report that took 40 ms went to
  // 700 ms — every dashboard pays that, to relocate a handful of bills a year.
  // Written as two branches, `WHERE yeardoc = %s` pushes down into the first
  // one unchanged and still uses the index; the second is only ever as big as
  // the override table.
  const reportedSql = `
    CREATE OR REPLACE VIEW ${SALE_DETAIL_REPORTED} AS
      SELECT d.yeardoc,
             d.monthdoc,
             d.doc_date::date AS report_date,
             ${passthrough}
      FROM ${SALE_DETAIL_LIVE} d
      WHERE NOT EXISTS (
        SELECT 1 FROM public.app_sale_month_override mo WHERE mo.doc_no = d.doc_no
      )
    UNION ALL
      SELECT EXTRACT(YEAR FROM mo.report_date)::smallint,
             EXTRACT(MONTH FROM mo.report_date)::smallint,
             mo.report_date,
             ${passthrough}
      FROM ${SALE_DETAIL_LIVE} d
      JOIN public.app_sale_month_override mo ON mo.doc_no = d.doc_no`;

  for (const sql of [liveSql, reportedSql]) {
    try {
      await query(sql);
    } catch {
      // CREATE OR REPLACE refuses to change the column list or their order.
      // The reported view is built on the live one, so it goes first.
      await query(`DROP VIEW IF EXISTS ${SALE_DETAIL_REPORTED}`);
      if (sql === liveSql) await query(`DROP VIEW IF EXISTS ${SALE_DETAIL_LIVE}`);
      await query(sql);
    }
  }

  // The union reads it on every report query; a table this small with no plan
  // to speak of is still worth an analyze after each rebuild.
  await query(`ANALYZE ${LIVE_TABLE}`);
}

/**
 * Rebuilds the top-up: everything the ERP has that the copy has not. Whole
 * table at a time inside one transaction, so a report never sees it half
 * written, and behind an advisory lock so two page loads land one rebuild.
 */
async function refresh() {
  const columns = await columnsOf("public.odg_sale_detail");
  const source = new Set((await columnsOf(LIVE_SOURCE)).map((column) => column.name));
  const names = columns.map(({ name }) => name);

  // roworder is the copy's own sequence and has no counterpart in the ERP view;
  // a live row carries none rather than an invented one.
  const select = columns
    .map(({ name, type }) =>
      source.has(name) ? `v.${quoted(name)}::${type}` : `NULL::${type}`,
    )
    .join(", ");

  // One connection for the whole rebuild: query() hands out whichever pool
  // member is free, and a BEGIN on one of them is not a transaction.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('app_sale_detail_live'))");
    await client.query(`DELETE FROM ${LIVE_TABLE}`);
    await client.query(
      `INSERT INTO ${LIVE_TABLE} (${names.map(quoted).join(", ")})
       SELECT ${select}
       FROM ${LIVE_SOURCE} v
       WHERE v.doc_date > (SELECT MAX(doc_date) FROM public.odg_sale_detail)
         AND NOT EXISTS (
           SELECT 1 FROM public.odg_sale_detail c WHERE c.doc_no = v.doc_no
         )`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await query(`ANALYZE ${LIVE_TABLE}`);
  refreshedAt = Date.now();
}

/** Creates the table and both views once per process; safe to await anywhere. */
export function ensureReportedView() {
  if (!ready) {
    ready = build().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

/**
 * What a report calls before it reads: the views exist, and the top-up is at
 * most a minute old. A refresh that fails leaves the last one standing — a
 * page a minute behind beats a page with an error on it.
 */
export async function ensureLiveView() {
  await ensureReportedView();
  if (Date.now() - refreshedAt < MAX_AGE_MS) return;
  if (!refreshing) {
    refreshing = refresh()
      .catch((error) => {
        // Keep serving what is there; the next request tries again. Said out
        // loud: a top-up that stops filling is a page quietly going stale.
        console.error("[sale-detail] live top-up failed:", error.message);
        refreshedAt = Date.now() - MAX_AGE_MS / 2;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  await refreshing;
}
