// ປີທີ່ລະບົບຖືກ "ຕຶງ" ໄວ້ — ທຸກ query ກັ່ນຕອງດ້ວຍປີນີ້ ບໍ່ແມ່ນປີປັດຈຸບັນ.
//
// ⚠️ ໄຟລ໌ນີ້ເປັນ CommonJS (.js) ໂດຍເຈດຕະນາ ບໍ່ແມ່ນ .ts:
// src/queries/*.js ຮຽກມັນດ້ວຍ require() ແລະ CommonJS require() ໂຫຼດໄຟລ໌
// .ts ໄດ້ສະເພາະຢູ່ໃນ bundler ຂອງ Next ເທົ່ານັ້ນ. ຕອນເປັນ .ts ຜົນຄື 20
// ໂມດູນໃນ src/queries ແລ່ນນອກ Next ບໍ່ໄດ້ ຈຶ່ງຂຽນ vitest ຫຼື script ກວດ
// ຂໍ້ມູນໃສ່ມັນບໍ່ໄດ້ເລີຍ. ຝັ່ງ TypeScript ຍັງ import ໄດ້ຄືເກົ່າ (allowJs)
// ແລະ ຍັງໄດ້ type ຄົບຈາກ JSDoc ຂ້າງລຸ່ມ.
"use strict";

const { getLaoToday } = require("./lao-date");

const FIXED_YEAR = 2026;
const FIXED_YEAR_START = `${FIXED_YEAR}-01-01`;
const FIXED_YEAR_END = `${FIXED_YEAR}-12-31`;
const FIXED_YEAR_NEXT_START = `${FIXED_YEAR + 1}-01-01`;
const FIXED_MONTH_MIN = `${FIXED_YEAR}-01`;
const FIXED_MONTH_MAX = `${FIXED_YEAR}-12`;

/** @param {number} value */
function pad(value) {
  return String(value).padStart(2, "0");
}

/**
 * @param {number} year
 * @param {number} month
 */
function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * @param {Date} [now]
 * @returns {string}
 */
function getFixedTodayDate(now = new Date()) {
  // ໂມງຝາຢູ່ລາວ ບໍ່ແມ່ນ now.getMonth()/getDate() ຂອງເຄື່ອງທີ່ແລ່ນ — ຖ້າ server
  // ຕັ້ງເປັນ UTC ທຸກໜ້າຈະຖືວ່າ "ມື້ນີ້" ເປັນວັນວານ ຕະຫຼອດ 00:00–07:00 ຢູ່ລາວ.
  const [, laoMonth, laoDay] = getLaoToday(now).split("-");
  const month = Math.min(Math.max(Number.parseInt(laoMonth, 10), 1), 12);
  const day = Math.min(
    Math.max(Number.parseInt(laoDay, 10), 1),
    getDaysInMonth(FIXED_YEAR, month)
  );

  return `${FIXED_YEAR}-${pad(month)}-${pad(day)}`;
}

/**
 * @param {Date} [now]
 * @returns {string}
 */
function getFixedTodayMonth(now = new Date()) {
  return getFixedTodayDate(now).slice(0, 7);
}

/**
 * @param {string | null | undefined} [value]
 * @param {string} [fallback]
 * @returns {string}
 */
function coerceDateToFixedYear(value, fallback = FIXED_YEAR_START) {
  if (!value) return fallback;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return fallback;
  const month = Math.min(Math.max(Number.parseInt(match[2], 10), 1), 12);
  const day = Math.min(
    Math.max(Number.parseInt(match[3], 10), 1),
    getDaysInMonth(FIXED_YEAR, month)
  );
  return `${FIXED_YEAR}-${pad(month)}-${pad(day)}`;
}

/**
 * @param {string | null | undefined} [from]
 * @param {string | null | undefined} [to]
 * @returns {{ fromDate: string, toDate: string }}
 */
function getFixedYearDateRange(from, to) {
  const fromDate = coerceDateToFixedYear(from, FIXED_YEAR_START);
  const toDate = coerceDateToFixedYear(to, FIXED_YEAR_END);
  if (fromDate <= toDate) return { fromDate, toDate };
  return { fromDate: toDate, toDate: fromDate };
}

/**
 * @param {string | null | undefined} [value]
 * @param {string} [fallback]
 * @returns {string}
 */
function coerceMonthToFixedYear(value, fallback = getFixedTodayMonth()) {
  const match = /^(\d{4})-(\d{2})$/.exec(value ?? "");
  if (!match) return fallback;
  const month = Math.min(Math.max(Number.parseInt(match[2], 10), 1), 12);
  return `${FIXED_YEAR}-${pad(month)}`;
}

/**
 * @param {string} column
 * @returns {string}
 */
function getFixedYearSqlFilter(column) {
  return `${column} >= DATE '${FIXED_YEAR_START}' AND ${column} < DATE '${FIXED_YEAR_NEXT_START}'`;
}

module.exports = {
  FIXED_YEAR,
  FIXED_YEAR_START,
  FIXED_YEAR_END,
  FIXED_YEAR_NEXT_START,
  FIXED_MONTH_MIN,
  FIXED_MONTH_MAX,
  getFixedTodayDate,
  getFixedTodayMonth,
  coerceDateToFixedYear,
  getFixedYearDateRange,
  coerceMonthToFixedYear,
  getFixedYearSqlFilter,
};
