/**
 * ຂາຍອອນລາຍ — recovered from the salesperson, because the ERP never tags it.
 *
 * public.ar_group has carried code 107 = ອອນລາຍ for years and the plan is
 * entered against it (10,900,000 for 2026, spread over BU 11 / 12 / 15), but
 * NOT ONE sale row in 2023-2026 ever carries 107 in argroup, argroup_main,
 * argroupsub or channel_name, and BU 17 holds only a couple of credit notes.
 * The online column on every report was therefore permanently 0 — a plan with
 * no actual to measure it against.
 *
 * The sales are real; they were being rung up as ຂາຍໜ້າຮ້ານ. What identifies
 * them is who sold them: ພະແນກຂາຍ ອອນລາຍ (odg_department 207). So the channel
 * is resolved from the bill's salesperson, which lives on the bill header
 * (ic_trans.sale_code) rather than on odg_sale_detail — hence a bill-number
 * lookup rather than a plain CASE over the row's own columns.
 *
 * Defined once here and consumed by every classifier so the rollups, the
 * detail reports and the incentive queries cannot disagree about what "online"
 * means. If the ERP ever starts tagging 107 properly, delete this and the
 * plain channel columns take over on their own.
 */

/** ພະແນກຂາຍ ອອນລາຍ in public.odg_department. */
export const ONLINE_DEPARTMENT_CODE = "207";

/** public.ar_group code / display name this resolves to. */
export const ONLINE_CHANNEL_CODE = "107";

/**
 * The name this resolves to. It must be ar_group's own spelling of 107:
 * the reports label the PLAN by looking 107 up in ar_group, and label the
 * ACTUAL with this string. Any other spelling — "ຂາຍອອນລາຍ", say — leaves the
 * two on separate rows, one with a plan and no sales and one with sales and
 * no plan, which is exactly the bug this file exists to fix.
 */
export const ONLINE_CHANNEL_NAME = "ອອນລາຍ";

/**
 * Bill numbers sold by the online department. Small — a few hundred a year —
 * so callers use it as an IN-list the planner hashes once, rather than as a
 * correlated EXISTS evaluated per detail row.
 *
 * trans_flag 44/48 = sale / sale return, the same pair lib/sale-rollup.js uses
 * when it resolves a seller.
 */
export const ONLINE_BILLS_SQL = `
  SELECT btrim(ot.doc_no)
  FROM public.ic_trans ot
  JOIN public.odg_employee oe ON btrim(oe.employee_code) = btrim(ot.sale_code)
  WHERE ot.trans_flag IN (44, 48)
    AND oe.department_code = '${ONLINE_DEPARTMENT_CODE}'`;

/**
 * Is this bill an online sale?
 * @param {string} docNo SQL expression for the bill number. Pass a QUALIFIED
 *   column wherever more than one table in scope has a doc_no — the rollup
 *   joins app_sale_month_override, which has one, and an unqualified name
 *   there is ambiguous rather than merely wrong.
 */
export const isOnlineBillSql = (docNo = "doc_no") => `btrim(${docNo}) IN (${ONLINE_BILLS_SQL})`;
