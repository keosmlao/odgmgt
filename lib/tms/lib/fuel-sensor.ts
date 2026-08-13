// ປ່ຽນເສັ້ນລະດັບນ້ຳມັນ (%) ຈາກ GPS ໃຫ້ເປັນ "ໃຊ້ໄປເທົ່າໃດ" ແລະ "ເຕີມເຂົ້າເທົ່າໃດ".
//
// ⚠️ ຫ້າມບວກສ່ວນຕ່າງຂອງທຸກ ping ດິບ. ເອກະສານ provider ວັດໃຫ້ເຫັນວ່າ ວິທີນັ້ນ
// ໄດ້ 53.95 L ທຽບກັບຄ່າຈິງ 3.90 L (ເກີນ 13.8 ເທົ່າ) ເພາະນ້ຳມັນກະເພື່ອມໃນຖັງ
// ຕອນລົດແລ່ນ ເຮັດໃຫ້ຄ່າຂຶ້ນລົງຕະຫຼອດເວລາ.
//
// ວິທີຢູ່ນີ້ຈຶ່ງຫຍໍ້ເສັ້ນເປັນ "ຄ່າກາງລາຍຊົ່ວໂມງ" ກ່ອນ (ຝັ່ງ SQL) ແລ້ວຈຶ່ງເດີນເສັ້ນນັ້ນ.
// ວັດຈາກຂໍ້ມູນຈິງ 2026-08-08..10: ຄ່າລາຍຊົ່ວໂມງລົງເປັນລຳດັບຕອນແລ່ນ ແລະ ຄົງທີ່
// ຕອນຈອດ — ສັນຍານສະອາດພໍທີ່ຈະນັບໄດ້.

/** ຈຸດໜຶ່ງໃນເສັ້ນ — ຄ່າກາງຂອງຊົ່ວໂມງນັ້ນ. */
export interface FuelPoint {
  /** ຮຽງລຳດັບໄດ້ ເຊັ່ນ "2026-08-10 14" */
  at: string;
  pct: number;
}

export interface FuelMovement {
  /** % ທີ່ໃຊ້ໄປລວມ (ຜົນບວກຂອງຂາລົງ) */
  consumedPct: number;
  /** % ທີ່ເຕີມເຂົ້າລວມ (ຜົນບວກຂອງຂາຂຶ້ນທີ່ຖືວ່າເປັນການເຕີມ) */
  refilledPct: number;
  refills: Array<{ at: string; risePct: number }>;
  /** ຈຳນວນຊົ່ວໂມງທີ່ມີຂໍ້ມູນ — ໃຊ້ບອກວ່າເສັ້ນຂາດຫຼາຍບໍ່ */
  samples: number;
}

/**
 * ຂາຂຶ້ນທີ່ນ້ອຍກວ່ານີ້ຖືວ່າເປັນສັນຍານແກວ່ງ ບໍ່ແມ່ນການເຕີມ. ຖັງ 200 L →
 * 3% ≈ 6 L ເຊິ່ງນ້ອຍກວ່າການເຕີມຈິງທຸກຄັ້ງທີ່ພົບໃນ odg_tms_fuel_log.
 */
export const REFILL_RISE_PCT = 3;

/**
 * ຂາລົງທີ່ໃຫຍ່ກວ່ານີ້ພາຍໃນ 1 ຊົ່ວໂມງ ບໍ່ແມ່ນການເຜົາໄໝ້ປົກກະຕິ — ອາດເປັນການ
 * ດູດນ້ຳມັນ ຫຼື ເຊັນເຊີກະໂດດ. ຍັງນັບເປັນການໃຊ້ ແຕ່ໝາຍໄວ້ໃຫ້ກວດ.
 */
export const SUSPICIOUS_DROP_PCT = 15;

/**
 * ເດີນເສັ້ນແລ້ວແຍກຂາລົງ (ໃຊ້) ອອກຈາກຂາຂຶ້ນ (ເຕີມ).
 * ຈຸດຕ້ອງຮຽງຕາມເວລາມາແລ້ວ.
 *
 * ⚠️ ບໍ່ໄດ້ບວກທຸກຂາລົງ. ຫຼັກຄື: ລະຫວ່າງການເຕີມສອງຄັ້ງ ນ້ຳມັນຫຼຸດຢ່າງດຽວ
 * (ຖັງບໍ່ເຕີມຕົວເອງ) ຈຶ່ງເອົາ "ລະດັບຕົ້ນຊ່ວງ − ລະດັບທ້າຍຊ່ວງ" ພຽງເທົ່ານັ້ນ.
 *
 * ວັດເມື່ອ 2026-08-12 ວ່າເປັນຫຍັງ: ການບວກທຸກຂາລົງ ໃຫ້ຄ່າ 228% ທີ່ຄວາມລະອຽດ
 * 1 ຊົ່ວໂມງ ແຕ່ 100% ທີ່ 1 ວັນ ສຳລັບລົດຄັນດຽວກັນຊ່ວງດຽວກັນ — ຄື້ນທຸກໜ່ວຍຖືກນັບ
 * ເປັນການໃຊ້ນ້ຳມັນ. ວິທີແບບຊ່ວງລຸດເຫຼືອ 212% → 193% (1 ຊມ → 6 ຊມ) ໝັ້ນຄົງກວ່າ
 * ຫຼາຍ ເພາະຄື້ນລະຫວ່າງທາງບໍ່ມີຜົນ ມີແຕ່ຫົວ-ທ້າຍຂອງຊ່ວງ.
 */
export function splitFuelMovements(
  points: FuelPoint[],
  refillRisePct = REFILL_RISE_PCT
): FuelMovement {
  if (points.length === 0) {
    return { consumedPct: 0, refilledPct: 0, refills: [], samples: 0 };
  }

  let consumedPct = 0;
  let refilledPct = 0;
  const refills: Array<{ at: string; risePct: number }> = [];

  let segmentStart = points[0].pct;
  let prev = points[0].pct;

  for (let i = 1; i < points.length; i++) {
    const cur = points[i].pct;
    if (cur - prev >= refillRisePct) {
      // ປິດຊ່ວງກ່ອນໜ້າ: ໃຊ້ໄປ = ຫົວຊ່ວງ − ລະດັບກ່ອນເຕີມ
      consumedPct += Math.max(0, segmentStart - prev);
      refilledPct += cur - prev;
      refills.push({ at: points[i].at, risePct: cur - prev });
      segmentStart = cur;
    }
    prev = cur;
  }
  consumedPct += Math.max(0, segmentStart - prev);

  return { consumedPct, refilledPct, refills, samples: points.length };
}

/**
 * ຂະໜາດຖັງ (ລິດຕໍ່ 1%) ຈາກໃບບິນຈິງ: ເຕີມ N ລິດ ແລ້ວເຂັມຂຶ້ນ P% → N/P ລິດ/%.
 *
 * ໃຊ້ຄ່າມັດທະຍົມ ບໍ່ແມ່ນຄ່າສະເລ່ຍ — ໃບບິນໜຶ່ງທີ່ຈັບຄູ່ຜິດວັນ ຈະດຶງຄ່າສະເລ່ຍໄປໄກ
 * ແຕ່ຂະຫຍັບຄ່າມັດທະຍົມບໍ່ໄດ້.
 *
 * @param pairs ຄູ່ (ລິດຕາມໃບບິນ, % ທີ່ເຂັມຂຶ້ນ)
 * @returns ລິດຕໍ່ 1% ຫຼື null ຖ້າບໍ່ມີຄູ່ທີ່ໃຊ້ໄດ້
 */
export function calibrateLitersPerPercent(
  pairs: Array<{ liters: number; risePct: number }>
): number | null {
  const ratios = pairs
    .filter((p) => p.liters > 0 && p.risePct >= REFILL_RISE_PCT)
    .map((p) => p.liters / p.risePct)
    // ຖັງລົດບັນທຸກ 50–1000 L → 0.5–10 L ຕໍ່ 1%. ນອກຊ່ວງນີ້ຄືຈັບຄູ່ຜິດ.
    .filter((r) => r >= 0.5 && r <= 10)
    .sort((a, b) => a - b);

  if (ratios.length === 0) return null;
  const mid = Math.floor(ratios.length / 2);
  return ratios.length % 2 === 1
    ? ratios[mid]
    : (ratios[mid - 1] + ratios[mid]) / 2;
}

/**
 * km/L ຈາກເຂັມວັດແທກ.
 * @returns null ເມື່ອຍັງບອກບໍ່ໄດ້ (ບໍ່ມີການປັບທຽບ ຫຼື ບໍ່ມີການໃຊ້ນ້ຳມັນ)
 */
/**
 * ຈັບຄູ່ໃບບິນກັບຂາຂຶ້ນຂອງເຂັມ ໃນວັນດຽວກັນ ແລ້ວຄິດລິດຕໍ່ 1%.
 *
 * ຈັບຄູ່ດ້ວຍ "ວັນ" ບໍ່ແມ່ນ "ເວລາ" ໂດຍເຈດຕະນາ: ຄົນຂັບບັນທຶກໃບບິນຫຼັງເຕີມ
 * ດົນເທົ່າໃດກໍ່ໄດ້ ແລະ odg_tms_fuel_log.fuel_date ເປັນວັນທີລ້ວນໆ ບໍ່ມີເວລາ.
 *
 * @param refillsByDay ໃບບິນ: ວັນ → ລິດລວມ
 * @param sensorRefills ຂາຂຶ້ນທີ່ກວດພົບ (at ຂຶ້ນຕົ້ນດ້ວຍ "YYYY-MM-DD")
 */
export function pairRefillsWithSensor(
  refillsByDay: Map<string, number>,
  sensorRefills: Array<{ at: string; risePct: number }>
): Array<{ liters: number; risePct: number }> {
  const riseByDay = new Map<string, number>();
  for (const r of sensorRefills) {
    const day = r.at.slice(0, 10);
    riseByDay.set(day, (riseByDay.get(day) ?? 0) + r.risePct);
  }
  const pairs: Array<{ liters: number; risePct: number }> = [];
  for (const [day, liters] of refillsByDay) {
    const risePct = riseByDay.get(day);
    if (risePct && risePct > 0) pairs.push({ liters, risePct });
  }
  return pairs;
}

export function sensorKmPerLiter(
  distanceKm: number,
  consumedPct: number,
  litersPerPercent: number | null
): number | null {
  if (!litersPerPercent || consumedPct <= 0) return null;
  const liters = consumedPct * litersPerPercent;
  if (liters <= 0) return null;
  return distanceKm / liters;
}
