// km/L ຈາກເຂັມວັດແທກນ້ຳມັນຂອງ GPS (ບໍ່ແມ່ນຈາກໃບບິນ).
//
// ສາມຂັ້ນຕອນ:
//   1. ຫຍໍ້ເສັ້ນ % ດິບ (ທຸກ ~20 ວິ) ໃຫ້ເປັນຄ່າກາງລາຍຊົ່ວໂມງ — ຝັ່ງ SQL
//   2. ເດີນເສັ້ນ ແຍກຂາລົງ (ໃຊ້) ອອກຈາກຂາຂຶ້ນ (ເຕີມ) — lib/fuel-sensor.ts
//   3. ປ່ຽນ % ເປັນລິດ ໂດຍປັບທຽບກັບໃບບິນຈິງ (ເຕີມ N ລິດ → ເຂັມຂຶ້ນ P%)
//
// ຂັ້ນທີ 3 ຄືຫົວໃຈ: ບໍ່ມີໃຜບອກຂະໜາດຖັງຂອງແຕ່ລະຄັນໄວ້ໃນລະບົບ ຈຶ່ງຄິດເອົາຈາກ
// ໃບບິນທີ່ມີຢູ່ແລ້ວ. ຜົນພ່ວງ: ຖ້າໃບບິນກັບເຂັມບໍ່ກົງກັນ ນັ້ນຄືສັນຍານທີ່ຕ້ອງເບິ່ງ.
"use strict";

const { query } = require("../lib/db");
const { getBranchScope } = require("./helpers");
const {
  MIN_PLAUSIBLE_LITERS,
  MAX_PLAUSIBLE_LITERS,
} = require("../lib/fuel-sanity");

/**
 * ຄ່າກາງລາຍຊົ່ວໂມງຂອງທຸກຄັນ. ຄ່າກາງ (median) ບໍ່ແມ່ນຄ່າສະເລ່ຍ ເພາະຄ່າສະເລ່ຍ
 * ຍັງຖືກດຶງໄປໂດຍຈຸດກະໂດດຕອນນ້ຳມັນກະເພື່ອມ.
 */
async function getHourlyFuelSeries(fromDate, toDate) {
  // ອ່ານຈາກ odg_tms_gps_fuel_hourly ທີ່ worker ຄິດໄວ້ໃຫ້ແລ້ວ. ການຄິດ
  // percentile_cont ສົດເທິງຈຸດດິບ ໃຊ້ 8.8 ວິນາທີ ຕໍ່ການເປີດໜ້າ 1 ຄັ້ງ.
  return query(
    `SELECT
       h.imei,
       COALESCE(c.code, '')   AS car_code,
       COALESCE(c.name_1, '') AS car_name,
       to_char(h.hour_at, 'YYYY-MM-DD HH24') AS at,
       h.fuel_pct::float AS pct
     FROM public.odg_tms_gps_fuel_hourly h
     LEFT JOIN LATERAL (
       SELECT c2.code, c2.name_1 FROM public.odg_tms_car c2
       WHERE c2.imei = h.imei ORDER BY c2.code LIMIT 1
     ) c ON TRUE
     WHERE h.hour_at >= $1::date
       AND h.hour_at <  ($2::date + INTERVAL '1 day')
     ORDER BY h.imei, h.hour_at`,
    [fromDate, toDate]
  );
}

/**
 * ໃບບິນທີ່ບັນທຶກໄວ້ ຈັດເປັນ (ຄັນ, ວັນ) — ໃຊ້ປັບທຽບຂະໜາດຖັງ.
 * ກັ່ນຕອງແຖວທີ່ຊ່ອງລິດເປັນຈຳນວນເງິນອອກ (ເບິ່ງ lib/fuel-sanity.js).
 */
async function getRefillsByCarDay(fromDate, toDate, session) {
  const params = [fromDate, toDate, MIN_PLAUSIBLE_LITERS, MAX_PLAUSIBLE_LITERS];
  const where = [
    `f.car IS NOT NULL`,
    `btrim(f.car::text) <> ''`,
    `f.fuel_date >= $1::date`,
    `f.fuel_date <= $2::date`,
    `f.liters BETWEEN $3 AND $4`,
  ];
  const scope = getBranchScope(session);
  if (scope.scoped) {
    params.push(scope.branches);
    where.push(
      `(f.transport_code = ANY($${params.length}) OR f.transport_code IS NULL)`
    );
  }
  return query(
    `SELECT
       COALESCE(m.code::text, btrim(f.car::text)) AS car_code,
       to_char(f.fuel_date, 'YYYY-MM-DD') AS fuel_date,
       SUM(f.liters)::float AS liters,
       COUNT(*)::int AS refills
     FROM public.odg_tms_fuel_log f
     LEFT JOIN LATERAL (
       SELECT c.code FROM public.odg_tms_car c
       WHERE btrim(c.code::text) = btrim(f.car::text)
          OR upper(btrim(c.name_1::text)) = upper(btrim(f.car::text))
       ORDER BY (btrim(c.code::text) = btrim(f.car::text)) DESC
       LIMIT 1
     ) m ON TRUE
     WHERE ${where.join(" AND ")}
     GROUP BY 1, 2`,
    params
  );
}

/** ວັນທີເກົ່າສຸດ/ໃໝ່ສຸດທີ່ມີຄ່າ % — ໃຊ້ບອກຜູ້ໃຊ້ວ່າຂໍ້ມູນເຊັນເຊີກວມເຖິງໃສ. */
async function getFuelSensorCoverage() {
  // ນັບຈາກຕາຕະລາງສະຫຼຸບ (ພັນແຖວ) ບໍ່ແມ່ນຈຸດດິບ (ຫຼາຍແສນແຖວ) — ອັນຫຼັງໃຊ້ 1.2 ວິນາທີ
  const rows = await query(
    `SELECT to_char(MIN(hour_at), 'YYYY-MM-DD') AS from_date,
            to_char(MAX(hour_at), 'YYYY-MM-DD') AS to_date,
            COUNT(*)::int AS points,
            COUNT(DISTINCT imei)::int AS cars
     FROM public.odg_tms_gps_fuel_hourly`
  );
  return rows[0] ?? { from_date: null, to_date: null, points: 0, cars: 0 };
}

module.exports = {
  getHourlyFuelSeries,
  getRefillsByCarDay,
  getFuelSensorCoverage,
};
