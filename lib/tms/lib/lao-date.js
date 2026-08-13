// ວັນ/ເວລາລາວ — ບ່ອນດຽວທີ່ຕອບວ່າ "ມື້ນີ້" ຄືວັນໃດ.
//
// ⚠️ ໄຟລ໌ນີ້ເປັນ CommonJS (.js) ດ້ວຍເຫດຜົນດຽວກັບ fixed-year.js: src/queries/*.js
// ຮຽກມັນດ້ວຍ require() ໄດ້ ແລະ ຝັ່ງ TypeScript ຍັງ import ໄດ້ຄົບ type ຈາກ JSDoc.
//
// ບັນຫາທີ່ມັນແກ້ — ສອງແບບທີ່ຂຽນກັນມາກ່ອນ ຜິດທັງສອງ:
//
//   new Date().toISOString().slice(0, 10)
//     → ວັນທີ UTC ສະເໝີ. ລະຫວ່າງ 00:00–07:00 ຢູ່ລາວ ມັນຄືນວັນວານ.
//
//   new Date(`${ymd}T00:00:00`) ... .toISOString().slice(0, 10)
//     → ອ່ານເປັນເວລາເຄື່ອງ ແຕ່ພິມເປັນ UTC. ຢູ່ເຄື່ອງ +07 ວັນທີຫຼຸດໄປ 1 ມື້ທັນທີ
//       (ວັດແລ້ວ: "2026-08-05T00:00:00" → "2026-08-04").
//
// ຢູ່ນີ້ຈຶ່ງແຍກສອງເລື່ອງອອກຈາກກັນ:
//   getLaoToday()  ອ່ານໂມງຝາຢູ່ລາວດ້ວຍ Intl — ບໍ່ຂຶ້ນກັບ TZ ຂອງ server/browser
//   addDays()      ບວກມື້ດ້ວຍ Date.UTC ລ້ວນໆ — ບໍ່ມີໂອກາດເລື່ອນວັນ
"use strict";

// UTC+07 ບໍ່ມີ DST. ຖານຂໍ້ມູນຕັ້ງ TimeZone = Asia/Bangkok ເຊິ່ງຊົດເຊີຍເທົ່າກັນ
// ຈຶ່ງກົງກັບ LOCALTIMESTAMP ຂອງ Postgres.
const LAO_TIME_ZONE = "Asia/Vientiane";

const LAO_PARTS_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: LAO_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** @param {number} value */
function pad(value) {
  return String(value).padStart(2, "0");
}

/**
 * ໂມງຝາຢູ່ລາວ ຂອງເວລາຈິງທີ່ໃຫ້ມາ.
 * @param {Date} [now]
 * @returns {{year:string, month:string, day:string, hour:string, minute:string, second:string}}
 */
function getLaoParts(now = new Date()) {
  /** @type {Record<string, string>} */
  const parts = {};
  for (const part of LAO_PARTS_FORMAT.formatToParts(now)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  // hour12:false ບາງ runtime ຄືນ "24" ແທນ "00" ຕອນທ່ຽງຄືນ
  if (parts.hour === "24") parts.hour = "00";
  return /** @type {any} */ (parts);
}

/**
 * "ມື້ນີ້" ຢູ່ລາວ ເປັນ YYYY-MM-DD — ບໍ່ຂຶ້ນກັບ TZ ຂອງເຄື່ອງທີ່ແລ່ນ.
 * @param {Date} [now]
 * @returns {string}
 */
function getLaoToday(now = new Date()) {
  const p = getLaoParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * ເດືອນປັດຈຸບັນຢູ່ລາວ ເປັນ YYYY-MM.
 * @param {Date} [now]
 * @returns {string}
 */
function getLaoTodayMonth(now = new Date()) {
  return getLaoToday(now).slice(0, 7);
}

/**
 * ວັນ+ເວລາລາວ ເປັນ "YYYY-MM-DD HH:MM:SS" — ຮູບແບບດຽວກັບ LOCALTIMESTAMP(0).
 * @param {Date} [now]
 * @returns {string}
 */
function getLaoNowStamp(now = new Date()) {
  const p = getLaoParts(now);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/**
 * ບວກ/ລົບມື້ໃສ່ YYYY-MM-DD. ຄິດດ້ວຍ Date.UTC ລ້ວນໆ ຈຶ່ງໃຫ້ຜົນດຽວກັນທຸກ TZ.
 * ຄ່າທີ່ອ່ານບໍ່ໄດ້ຄືນຄືເກົ່າ ເພື່ອບໍ່ໃຫ້ໜ້າຈໍພັງຍ້ອນ input ວ່າງ.
 * @param {string | null | undefined} date
 * @param {number} days
 * @returns {string}
 */
function addDays(date, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date ?? ""));
  if (!match) return String(date ?? "");
  const shifted = new Date(
    Date.UTC(
      Number.parseInt(match[1], 10),
      Number.parseInt(match[2], 10) - 1,
      Number.parseInt(match[3], 10) + (Number(days) || 0)
    )
  );
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * ບວກ/ລົບເດືອນໃສ່ YYYY-MM-DD. ມື້ທີ່ເກີນຄວາມຍາວເດືອນປາຍທາງຖືກຕັດລົງ
 * (31-01 + 1 ເດືອນ = 28/29-02) ແທນທີ່ຈະລົ້ນໄປເດືອນຖັດໄປແບບ setMonth().
 * @param {string | null | undefined} date
 * @param {number} months
 * @returns {string}
 */
function addMonths(date, months) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date ?? ""));
  if (!match) return String(date ?? "");
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10) - 1 + (Number(months) || 0);
  const day = Number.parseInt(match[3], 10);
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const daysInMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${targetYear}-${pad(targetMonth + 1)}-${pad(Math.min(day, daysInMonth))}`;
}

/**
 * ວັນທຳອິດຂອງເດືອນ ຂອງ YYYY-MM-DD (ຫຼື YYYY-MM).
 * @param {string | null | undefined} date
 * @returns {string}
 */
function startOfMonth(date) {
  const match = /^(\d{4})-(\d{2})/.exec(String(date ?? ""));
  if (!match) return String(date ?? "");
  return `${match[1]}-${match[2]}-01`;
}

module.exports = {
  LAO_TIME_ZONE,
  getLaoParts,
  getLaoToday,
  getLaoTodayMonth,
  getLaoNowStamp,
  addDays,
  addMonths,
  startOfMonth,
};
