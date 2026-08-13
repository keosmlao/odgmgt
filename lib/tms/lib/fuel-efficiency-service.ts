// ແກ່ນການຄິດ km/L — ບໍ່ແມ່ນ Server Action ໂດຍເຈດຕະນາ.
//
// ⚠️ ຢ່າຍ້າຍໄຟລ໌ນີ້ໄປໃສ່ໃນໄຟລ໌ "use server". ຟັງຊັນນີ້ຮັບ session ເປັນ argument
// ແລະ ທຸກ export ຂອງໄຟລ໌ "use server" ກາຍເປັນ endpoint ສາທາລະນະ — ຜູ້ໃຊ້ພາຍນອກ
// ຈະສົ່ງ session ປອມເຂົ້າມາ ແລ້ວຂ້າມການຈຳກັດສາຂາໄດ້.
//
// ແຍກອອກມາເພື່ອໃຫ້ action ລວມ (getGpsMonthlyOverview) ເອີ້ນໄດ້ໂດຍກວດ session
// ພຽງເທື່ອດຽວ: Next.js ແລ່ນ Server Action ເທື່ອລະອັນ (ບໍ່ຂະໜານ) ແລະ
// requireSession() ຍິງ query ຫາ DB ທຸກຄັ້ງ ຈຶ່ງເສຍເວລາເປັນຜົນບວກ.
import type { Session } from "@/lib/tms/lib/auth";
import { getFuelByCar as svcGetFuelByCar } from "@/lib/tms/queries/fuel.js";
import { getDistanceByCar as svcGetDistanceByCar } from "@/lib/tms/queries/gps-daily-rollup.js";
import {
  getHourlyFuelSeries as svcGetHourlyFuelSeries,
  getRefillsByCarDay as svcGetRefillsByCarDay,
  getFuelSensorCoverage as svcGetFuelSensorCoverage,
} from "@/lib/tms/queries/fuel-sensor.js";
import { addDays } from "@/lib/tms/lib/lao-date";
import { fuelStatsForCar, indexFuelByCar } from "@/lib/tms/lib/fuel-efficiency";
import {
  calibrateLitersPerPercent,
  pairRefillsWithSensor,
  sensorKmPerLiter,
  splitFuelMovements,
} from "@/lib/tms/lib/fuel-sensor";
import type { FuelByCarRow, FuelEfficiencyResult, FuelEfficiencyRow } from "./fuel-types";

/**
 * ແກ່ນຂອງ getFuelEfficiency ທີ່ຮັບ session ມາເລີຍ.
 *
 * ⚠️ Next.js ແລ່ນ Server Action ເທື່ອລະອັນ (ບໍ່ຂະໜານ) ແລະ requireSession()
 * ຍິງ query ຫາ DB ທຸກຄັ້ງ — ໜ້າທີ່ເອີ້ນ 3 action ຈຶ່ງເສຍເວລາເປັນຜົນບວກ.
 * ແຍກແກ່ນອອກມາ ເພື່ອໃຫ້ action ລວມ (getGpsMonthlyOverview) ເອີ້ນໄດ້ໂດຍ
 * ກວດ session ພຽງເທື່ອດຽວ.
 */
export async function buildFuelEfficiency(
  session: Session,
  endDate: string,
  days = 30
) {
  const window = Math.max(1, Math.min(365, Math.floor(days)));
  const fromDate = addDays(endDate, -(window - 1));

  const [distance, fuel, series, refillDays, sensorCoverage] = await Promise.all([
    svcGetDistanceByCar(fromDate, endDate) as Promise<
      Array<{ imei: string; car_code: string; car_name: string; distance_km: number }>
    >,
    svcGetFuelByCar({ fromDate, toDate: endDate, session }) as Promise<
      FuelByCarRow[]
    >,
    svcGetHourlyFuelSeries(fromDate, endDate) as Promise<
      Array<{ imei: string; car_code: string; car_name: string; at: string; pct: number }>
    >,
    svcGetRefillsByCarDay(fromDate, endDate, session) as Promise<
      Array<{ car_code: string; fuel_date: string; liters: number }>
    >,
    svcGetFuelSensorCoverage() as Promise<FuelEfficiencyResult["sensorCoverage"]>,
  ]);

  // ເສັ້ນ % ຂອງແຕ່ລະຄັນ (SQL ຮຽງມາໃຫ້ແລ້ວ) → ໃຊ້ໄປເທົ່າໃດ / ເຕີມເຂົ້າເທົ່າໃດ
  const seriesByImei = new Map<string, Array<{ at: string; pct: number }>>();
  for (const p of series) {
    const list = seriesByImei.get(p.imei);
    if (list) list.push({ at: p.at, pct: p.pct });
    else seriesByImei.set(p.imei, [{ at: p.at, pct: p.pct }]);
  }
  const movementByImei = new Map(
    [...seriesByImei].map(([imei, points]) => [imei, splitFuelMovements(points)])
  );

  // ໃບບິນ ຈັດເປັນ ຄັນ → (ວັນ → ລິດ)
  const receiptsByCar = new Map<string, Map<string, number>>();
  for (const r of refillDays) {
    const key = String(r.car_code ?? "").trim().toUpperCase();
    if (!key) continue;
    const byDay = receiptsByCar.get(key) ?? new Map<string, number>();
    byDay.set(r.fuel_date, (byDay.get(r.fuel_date) ?? 0) + Number(r.liters || 0));
    receiptsByCar.set(key, byDay);
  }

  // ປັບທຽບຂະໜາດຖັງຕໍ່ຄັນ ຈາກໃບບິນຂອງຄັນນັ້ນເອງ
  const litersPerPctByImei = new Map<string, number>();
  for (const car of distance) {
    const movement = movementByImei.get(car.imei);
    if (!movement) continue;
    const byDay =
      receiptsByCar.get(String(car.car_code ?? "").trim().toUpperCase()) ??
      receiptsByCar.get(String(car.car_name ?? "").trim().toUpperCase());
    if (!byDay) continue;
    const calibrated = calibrateLitersPerPercent(
      pairRefillsWithSensor(byDay, movement.refills)
    );
    if (calibrated) litersPerPctByImei.set(car.imei, calibrated);
  }

  // ຄັນທີ່ຍັງບໍ່ມີໃບບິນໃຫ້ປັບທຽບ ໃຊ້ຄ່າກາງຂອງກອງລົດໄປກ່ອນ ແລ້ວໝາຍໄວ້ວ່າເປັນຄ່າປະມານ
  const fleetLitersPerPercent = calibrateLitersPerPercent(
    [...litersPerPctByImei.values()].map((r) => ({ liters: r, risePct: 1 }))
  );

  const index = indexFuelByCar(fuel);
  const rows: FuelEfficiencyRow[] = distance.map((car) => {
    const receipts = fuelStatsForCar(car, index);
    const movement = movementByImei.get(car.imei);
    const consumedPct = movement?.consumedPct ?? 0;
    const own = litersPerPctByImei.get(car.imei) ?? null;
    const litersPerPercent = own ?? fleetLitersPerPercent;
    const distanceKm = Number(car.distance_km || 0);
    const liters = litersPerPercent ? consumedPct * litersPerPercent : 0;
    const kmPerLiter = sensorKmPerLiter(distanceKm, consumedPct, litersPerPercent);

    return {
      car_code: car.car_code,
      car_name: car.car_name,
      distance_km: distanceKm,
      liters,
      consumed_pct: consumedPct,
      liters_per_percent: litersPerPercent,
      capacity_estimated: own === null,
      receipt_liters: receipts.liters,
      receipt_refills: receipts.refills,
      sensor_refills: movement?.refills.length ?? 0,
      amount: receipts.fuel_amount,
      km_per_liter: kmPerLiter,
      receipt_km_per_liter: receipts.km_per_liter,
      cost_per_km:
        receipts.fuel_amount > 0 && distanceKm > 0
          ? receipts.fuel_amount / distanceKm
          : null,
    };
  });

  return {
    fromDate,
    toDate: endDate,
    days: window,
    rows,
    ignoredRefills: fuel.reduce(
      (sum, f) => sum + Number(f.ignored_refills || 0),
      0
    ),
    fleetLitersPerPercent,
    sensorCoverage,
  } satisfies FuelEfficiencyResult;
}
