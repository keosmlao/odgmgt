/**
 * ໂຄງການ as a business unit of its own, from 2026.
 *
 * The company used to run project sales as a CHANNEL inside each product BU
 * (ໄຟຟ້າ, ແອ, ປະປາ, ອາໄຫຼ່). From 2026 it is run as its own unit, so the Sales
 * vs Delivery report lifts it out and gives it a BU row — plan and actual
 * together, or the Ach% of both sides would be measured against the wrong
 * denominator.
 *
 * This is a REPORTING split, scoped to /sales-delivery: odg_bu is untouched,
 * nothing is written back, and /month-summary, /sales-summary, the target
 * screens and the incentive rules all still see the original bu_code.
 *
 * Shared between the route and the page so the filter dropdown and the query
 * cannot disagree about what "ໂຄງການ" selects.
 */

/** Deliberately non-numeric so it can never collide with a real odg_bu code. */
export const PROJECT_BU_CODE = "PJ";
export const PROJECT_BU_NAME = "ໂຄງການ";

/** Earlier years keep reading the way they were reported at the time. */
export const PROJECT_BU_FROM_YEAR = 2026;

/**
 * ສູນບໍລິການ keeps its own project work — excluded by decision. It falls out
 * anyway (that BU records every sale as ບໍລິການ, never ຂາຍໂຄງການ), but the
 * guard is written out so the intent survives a relabelling of that BU.
 */
export const SERVICE_BU_CODE = "16";

/** How odg_sales_target spells the project channel — code or either name. */
export const PROJECT_TARGET_CHANNELS = ["103", "ຂາຍໂຄງການ", "ໂຄງການ"];

/** What CHANNEL_EXPR normalizes a project sale line to. */
export const PROJECT_DETAIL_CHANNEL = "ຂາຍໂຄງການ";

export const isProjectBu = (value) => String(value ?? "") === PROJECT_BU_CODE;

/** Whether the split is in force for a reporting year. */
export const projectBuSplitApplies = (year) => Number(year) >= PROJECT_BU_FROM_YEAR;
