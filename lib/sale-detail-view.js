import { query, rows } from "./db.js";

/**
 * odg_sale_detail as the business reports it: the same 113 columns the ERP
 * syncs, except yeardoc/monthdoc carry the month the sale is CREDITED to
 * rather than the month its bill was printed in.
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
 * The column list is read from information_schema instead of being written out
 * here because the ERP adds columns without warning (lib/sale-detail-schema.js
 * exists for the same reason). A hardcoded list would silently stop passing
 * through anything added later.
 */
export const SALE_DETAIL_REPORTED = "public.odg_sale_detail_reported";

/** Columns the view redefines; everything else passes through untouched. */
const REPLACED = new Set(["yeardoc", "monthdoc", "report_date"]);

let ready = null;

async function build() {
  const columns = await rows(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'odg_sale_detail'
     ORDER BY ordinal_position`,
  );
  if (!columns.length) throw new Error("odg_sale_detail not found");

  const passthrough = columns
    .map((row) => row.column_name)
    .filter((name) => !REPLACED.has(name))
    .map((name) => `d."${name.replace(/"/g, '""')}"`)
    .join(",\n           ");

  // Split rather than LEFT JOIN + COALESCE. Wrapping yeardoc in an expression
  // hides it from idx_osd_year_cover, and a report that took 40 ms went to
  // 700 ms — every dashboard pays that, to relocate a handful of bills a year.
  // Written as two branches, `WHERE yeardoc = %s` pushes down into the first
  // one unchanged and still uses the index; the second is only ever as big as
  // the override table.
  const sql = `
    CREATE OR REPLACE VIEW ${SALE_DETAIL_REPORTED} AS
      SELECT d.yeardoc,
             d.monthdoc,
             d.doc_date::date AS report_date,
             ${passthrough}
      FROM public.odg_sale_detail d
      WHERE NOT EXISTS (
        SELECT 1 FROM public.app_sale_month_override mo WHERE mo.doc_no = d.doc_no
      )
    UNION ALL
      SELECT EXTRACT(YEAR FROM mo.report_date)::smallint,
             EXTRACT(MONTH FROM mo.report_date)::smallint,
             mo.report_date,
             ${passthrough}
      FROM public.odg_sale_detail d
      JOIN public.app_sale_month_override mo ON mo.doc_no = d.doc_no`;

  try {
    await query(sql);
  } catch {
    // CREATE OR REPLACE refuses to change the column list or their order, which
    // is exactly what happens the first time the ERP adds a column.
    await query(`DROP VIEW IF EXISTS ${SALE_DETAIL_REPORTED}`);
    await query(sql);
  }
}

/** Creates the view once per process; safe to await on every request. */
export function ensureReportedView() {
  if (!ready) {
    ready = build().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}
