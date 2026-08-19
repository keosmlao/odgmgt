/**
 * The one definition of "who covers which area, according to a year's sales",
 * shared by the writer and its reports so they can never drift.
 *
 * The seller lives only on the bill header (ic_trans.sale_code); odg_sale_detail
 * — the same bills (trans_flag 44 sale / 48 return) exploded to lines — has no
 * seller column, but is the only place the BU / province / district spellings
 * match what the grid's target and rollup LATERALs join on. Hence the doc_no
 * join between them.
 *
 * Both sides are kept index-friendly on purpose:
 *   · ic_trans is cut by doc_date to the year plus a month either side, so a
 *     bill whose reported month is pulled across the year boundary is still
 *     found, without scanning three whole years of every document type.
 *   · odg_sale_detail is cut by yeardoc so idx_osd_year_cover applies. The
 *     month then comes from app_sale_month_override, exactly as odg_sale_monthly
 *     does, so baht and assignment agree on which month a bill belongs to.
 *
 * Districts are only ever named for the capital (province 01); everywhere else
 * the row covers the whole province — what the Add form offers, and what the
 * hand-made rows do.
 */
import { CHANNEL_CODE_SQL } from "../lib/sale-monthly-sql.mjs";

/**
 * How much of each seller's year was rung up over a shop counter, by branch.
 *
 * Counter staff are not area sales: they serve whoever walks into the branch, so
 * the board — which is about who covers which province — has no row for them.
 * They are recognised by what they do rather than by a job title, because the
 * roster's titles are generic ("ພະນັກງານ") and its department codes do not line
 * up with the ERP's sale-channel departments.
 *
 * Params: $1 year · $2 branch code.
 */
export const SHOP_SHARE_BY_SELLER = `
  WITH line AS (
    SELECT btrim(t.sale_code) AS sale_id,
           btrim(t.branch_code) AS branch,
           ${CHANNEL_CODE_SQL} AS channel,
           d.sum_amount
    FROM public.odg_sale_detail d
    JOIN public.ic_trans t
      ON t.doc_no = d.doc_no
     AND t.trans_flag IN (44, 48)
     AND t.doc_date >= make_date($1::int, 1, 1) - INTERVAL '1 month'
     AND t.doc_date <  make_date($1::int + 1, 2, 1)
    WHERE d.yeardoc = $1::int AND COALESCE(btrim(t.sale_code), '') <> ''
  )
  SELECT sale_id,
         SUM(sum_amount)::float AS total,
         COALESCE(SUM(sum_amount) FILTER (
           WHERE branch = $2::text AND channel = '101'), 0)::float AS shop
  FROM line
  GROUP BY sale_id`;

/** One row per seller × BU × province × district × month. Params: $1 year. */
export const SALES_BY_SELLER_AREA_MONTH = `
  WITH seller AS (
    SELECT DISTINCT t.doc_no, btrim(t.sale_code) AS sale_code
    FROM public.ic_trans t
    WHERE t.trans_flag IN (44, 48)
      AND t.doc_date >= make_date($1::int, 1, 1) - INTERVAL '1 month'
      AND t.doc_date <  make_date($1::int + 1, 2, 1)
      AND COALESCE(btrim(t.sale_code), '') <> ''
  ),
  line AS (
    SELECT btrim(e.employee_code) AS sale_id,
           COALESCE(NULLIF(btrim(e.fullname_lo), ''),
                    NULLIF(btrim(e.fullname_en), ''),
                    NULLIF(btrim(e.nickname), ''),
                    btrim(e.employee_code)) AS sale_name,
           NULLIF(d.bu_code, '') AS bu_code,
           NULLIF(d.province, '') AS province_code,
           NULLIF(d.amper, '') AS amper,
           EXTRACT(YEAR  FROM COALESCE(mo.report_date, d.doc_date::date))::int AS year,
           EXTRACT(MONTH FROM COALESCE(mo.report_date, d.doc_date::date))::int AS month,
           d.sum_amount
    FROM public.odg_sale_detail d
    LEFT JOIN public.app_sale_month_override mo ON mo.doc_no = d.doc_no
    JOIN seller s ON s.doc_no = d.doc_no
    JOIN public.odg_employee e ON btrim(e.employee_code) = s.sale_code
    WHERE d.yeardoc = $1::int
      -- Someone who has left is not handed an area.
      AND UPPER(COALESCE(btrim(e.employment_status), 'ACTIVE')) = 'ACTIVE'
  )
  SELECT sale_id, MIN(sale_name) AS sale_name, bu_code, province_code,
         CASE WHEN province_code = '01' THEN COALESCE(amper, 'ALL') ELSE 'ALL' END AS district_code,
         month, SUM(sum_amount)::float AS amount
  FROM line
  WHERE bu_code IS NOT NULL AND province_code IS NOT NULL AND year = $1::int
  GROUP BY sale_id, bu_code, province_code, 5, month`;
