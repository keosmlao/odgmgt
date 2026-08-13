// Pickup variance (ຈຳນວນເບີກບໍ່ກົງກັບຖ້ຽວ)
//
// When the driver taps "ເບີກເຄື່ອງ" the app may send the quantity actually
// handed over at the warehouse. Whatever differs from what the dispatcher put
// on the trip (odg_tms_detail_item.selected_qty) is a variance: the trip is
// corrected down to the real figure and the dispatcher is notified.
//
// ⚠️ CommonJS (.js) ໂດຍເຈດຕະນາ — src/queries/mobile.js require ໄຟລ໌ນີ້ ແລະ
// require() ໂຫຼດ .ts ໄດ້ສະເພາະໃນ bundler ຂອງ Next. type ຢູ່ .d.ts ຄູ່ກັນ.
//
// Pure so it can be unit-tested; the DB writes live in mobileJobAction
// ("pickup_bill") in src/queries/mobile.js.

"use strict";

/**
 * @param {unknown} value
 * @returns {number}
 */
function toQty(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  // Warehouse quantities are counted in whole/decimal units; guard against a
  // stray float like 3.0000000004 coming off the wire.
  return Math.round(n * 1000) / 1000;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toText(value) {
  return String(value ?? "").trim();
}

/**
 * Compare what the driver says they received against what the trip planned.
 *
 * Items the app does not mention are left untouched (an app that sends nothing
 * behaves exactly as before this feature existed). Reported quantities are
 * clamped to [0, planned]: a short pickup corrects the trip, a surplus is
 * flagged for the dispatcher but never silently grabs stock held elsewhere.
 */
/**
 * @param {import("./pickup-variance").PlannedPickupItem[]} planned
 * @param {import("./pickup-variance").ReportedPickupItem[]} reported
 * @returns {import("./pickup-variance").PickupVarianceResult}
 */
function computePickupVariance(planned, reported) {
  /** @type {Map<string, number>} */
  const reportedByCode = new Map();
  for (const item of reported ?? []) {
    const code = toText(item?.item_code);
    if (!code) continue;
    // Duplicate lines for the same item (multi-scan) add up.
    reportedByCode.set(code, (reportedByCode.get(code) ?? 0) + toQty(item?.qty));
  }

  /** @type {import("./pickup-variance").PickupVarianceLine[]} */
  const lines = [];
  let plannedTotal = 0;
  let actualTotal = 0;

  for (const item of planned ?? []) {
    const code = toText(item?.item_code);
    if (!code) continue;
    const plannedQty = toQty(item?.selected_qty);
    plannedTotal += plannedQty;

    if (!reportedByCode.has(code)) {
      // Not mentioned by the app → keep the trip as planned.
      actualTotal += plannedQty;
      continue;
    }

    const reportedQty = reportedByCode.get(code) ?? 0;
    const actualQty = Math.min(reportedQty, plannedQty);
    actualTotal += actualQty;
    if (reportedQty === plannedQty) continue;

    lines.push({
      item_code: code,
      item_name: toText(item?.item_name) || code,
      unit_code: toText(item?.unit_code),
      planned_qty: plannedQty,
      reported_qty: reportedQty,
      actual_qty: actualQty,
      diff_qty: Math.round((actualQty - plannedQty) * 1000) / 1000,
      over_reported: reportedQty > plannedQty,
    });
  }

  return {
    lines,
    plannedTotal,
    actualTotal,
    hasVariance: lines.length > 0,
    emptyPickup: plannedTotal > 0 && actualTotal === 0,
  };
}

/** One-line Lao summary used in the notification body. */
/**
 * @param {import("./pickup-variance").PickupVarianceResult} result
 * @returns {string}
 */
function describePickupVariance(result) {
  const short = result.lines.filter((l) => l.diff_qty < 0);
  const over = result.lines.filter((l) => l.over_reported);
  /** @type {string[]} */
  const parts = [];
  if (short.length > 0) {
    const missing = short.reduce((sum, l) => sum + Math.abs(l.diff_qty), 0);
    parts.push(`ຂາດ ${missing} ໜ່ວຍ (${short.length} ລາຍການ)`);
  }
  if (over.length > 0) {
    parts.push(`ເກີນ ${over.length} ລາຍການ (ຍັງບໍ່ໄດ້ປັບ)`);
  }
  return parts.join(" · ");
}

module.exports = { computePickupVariance, describePickupVariance };
