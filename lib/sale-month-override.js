/**
 * Bills the branch approved to count in a month other than the one they were
 * issued in — a sale closed at month end but billed on the 1st, for example.
 *
 * public.app_sale_month_override holds one row per approved bill:
 *   doc_no · report_date (the month it counts in) · original_date · reason ·
 *   approved_by · created_at
 *
 * Monthly figures bucket on report_date so an approved bill lands in the month
 * it was credited to; everything else keeps its own doc_date. The sale row
 * alias must be `d` and the override alias `mo`.
 */
export const OVERRIDE_JOIN = "LEFT JOIN public.app_sale_month_override mo ON mo.doc_no = d.doc_no";

/** The date a sale row is reported on: the approved date, else its own. */
export const REPORT_DATE = "COALESCE(mo.report_date, d.doc_date::date)";

/** Rows reported in one month; takes year, month, year, month as %s params. */
export const REPORT_MONTH_FILTER =
  `${REPORT_DATE} >= make_date(%s, %s, 1)
     AND ${REPORT_DATE} < make_date(%s, %s, 1) + INTERVAL '1 month'`;
