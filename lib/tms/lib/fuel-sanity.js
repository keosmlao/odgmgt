// ກົດ "ຕົວເລກລິດນີ້ເປັນໄປໄດ້ບໍ່" — ບ່ອນດຽວ.
//
// ⚠️ ໄຟລ໌ນີ້ເປັນ CommonJS (.js) ດ້ວຍເຫດຜົນດຽວກັບ lao-date.js: src/queries/*.js
// ຮຽກມັນດ້ວຍ require() ໄດ້ ແລະ ຝັ່ງ TypeScript ຍັງ import ໄດ້ຄົບ type ຈາກ JSDoc.
//
// ບັນຫາທີ່ມັນແກ້: ການເຕີມ 62,940 ລິດ ບໍ່ແມ່ນການເຕີມ — ແມ່ນຄົນຂັບພິມ "ຈຳນວນເງິນ"
// ໃສ່ຊ່ອງລິດ. ໃນ odg_tms_fuel_log ມີເຕັມໄປໝົດ (ເດືອນ 2026-04 ເກືອບທັງໝົດ ບວກກັບ
// ອີກ 3 ແຖວ ໃນແຕ່ລະເດືອນ 05/06/07 — ວັດເມື່ອ 2026-08-12). ຄ່າຜິດໃຫຍ່ກວ່າຄວາມຈິງ
// ~1000 ເທົ່າ ຈຶ່ງເຮັດໃຫ້ km/L ທີ່ຄິດຈາກມັນ ອອກມາເປັນຕົວເລກທີ່ "ເບິ່ງຄືຖືກ".
"use strict";

/** ຕ່ຳກວ່ານີ້ບໍ່ແມ່ນການເຕີມຈິງ — ພິມຜິດ ຫຼື ແຖວທົດລອງ. */
const MIN_PLAUSIBLE_LITERS = 1;

/**
 * ຖັງໃຫຍ່ສຸດໃນກອງລົດປະມານ 400 ລິດ. ຈຳນວນເງິນເລີ່ມທີ່ຫຼັກແສນ
 * ຈຶ່ງບໍ່ມີທາງທີ່ຄ່າເກີນນີ້ຈະເປັນລິດ.
 */
const MAX_PLAUSIBLE_LITERS = 600;

/** ຊ່ວງລາຄາທີ່ຮັບໄດ້ — ໃຊ້ອະທິບາຍວ່າເປັນຫຍັງຈຶ່ງຖືກປະຕິເສດ. */
const MIN_KIP_PER_LITER = 5000;
const MAX_KIP_PER_LITER = 100000;

/**
 * ຕົວເລກລິດນີ້ເປັນລິດຈິງບໍ່?
 * @param {unknown} liters
 * @returns {boolean}
 */
function isPlausibleLiters(liters) {
  const n = Number(liters);
  return (
    Number.isFinite(n) && n >= MIN_PLAUSIBLE_LITERS && n <= MAX_PLAUSIBLE_LITERS
  );
}

/**
 * ບອກວ່າການເຕີມນີ້ຜິດຢູ່ໃສ ຫຼື null ຖ້າປົກກະຕິ. ສົ່ງໃຫ້ຄົນຂັບເຫັນຕອນບັນທຶກ
 * ຈຶ່ງຂຽນເປັນ "ໃຫ້ແກ້ແນວໃດ" ບໍ່ແມ່ນ "ກົດຂໍ້ໃດ".
 * @param {unknown} liters
 * @param {unknown} amount
 * @returns {string | null}
 */
function describeFuelEntryProblem(liters, amount) {
  const l = Number(liters);
  const a = Number(amount);

  if (Number.isFinite(l) && l > 0) {
    if (l > MAX_PLAUSIBLE_LITERS) {
      return `${l.toLocaleString()} ລິດ ຫຼາຍເກີນໄປ — ຖ້າແມ່ນຈຳນວນເງິນ ໃຫ້ໃສ່ຊ່ອງ "ຈຳນວນເງິນ" ແທນ`;
    }
    if (l < MIN_PLAUSIBLE_LITERS) {
      return `${l} ລິດ ໜ້ອຍເກີນໄປ`;
    }
  }

  // ໃສ່ມາທັງສອງຊ່ອງ: ລາຄາທີ່ຄິດອອກມາຈັບການສະຫຼັບຊ່ອງທີ່ຂອບເຂດຢ່າງດຽວຈັບບໍ່ໄດ້
  // (ເຊັ່ນ ໃສ່ 300 ທັງຊ່ອງລິດ ແລະ ຊ່ອງເງິນ).
  if (Number.isFinite(l) && l > 0 && Number.isFinite(a) && a > 0) {
    const kipPerLiter = a / l;
    if (kipPerLiter < MIN_KIP_PER_LITER || kipPerLiter > MAX_KIP_PER_LITER) {
      return `ລາຄາອອກມາ ${Math.round(kipPerLiter).toLocaleString()} ກີບ/ລິດ — ກວດເບິ່ງລິດ ແລະ ຈຳນວນເງິນຄືນ`;
    }
  }

  return null;
}

/**
 * ລະດັບນ້ຳມັນຈາກ GPS ເປັນເປີເຊັນ. ລົດທີ່ບໍ່ມີເຊັນເຊີ ຕົວ tracker ຈະສົ່ງຄ່າຂີ້ເຫຍື້ອ
 * (ຕິດລົບ ຫຼື ຄ່າ ADC ດິບຫຼັກພັນ) — ຖ້າເກັບໄວ້ ຄ່າສະເລ່ຍທັງໝົດຈະເສຍ
 * ຈຶ່ງໃຫ້ນອກຊ່ວງ 0..100 ເປັນ null.
 * @param {unknown} value
 * @returns {number | null}
 */
function clampFuelPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

module.exports = {
  clampFuelPercent,
  MIN_PLAUSIBLE_LITERS,
  MAX_PLAUSIBLE_LITERS,
  MIN_KIP_PER_LITER,
  MAX_KIP_PER_LITER,
  isPlausibleLiters,
  describeFuelEntryProblem,
};
