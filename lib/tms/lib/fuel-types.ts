// Type ຮ່ວມ ລະຫວ່າງ action ("use server") ກັບ service ທຳມະດາ.
// ໄຟລ໌ "use server" export ໄດ້ແຕ່ async function ຈຶ່ງວາງ interface ໄວ້ຢູ່ນີ້.

export interface FuelByCarRow {
  car_code: string;
  liters: number;
  amount: number;
  refills: number;
  ignored_refills: number;
}

export interface FuelEfficiencyRow {
  car_code: string;
  car_name: string;
  distance_km: number;
  /** ລິດທີ່ໃຊ້ໄປ ຄິດຈາກເຂັມວັດແທກ */
  liters: number;
  /** % ທີ່ເຂັມລົງລວມ */
  consumed_pct: number;
  /** ລິດຕໍ່ 1% ຂອງຄັນນີ້ */
  liters_per_percent: number | null;
  /** true = ໃຊ້ຄ່າກາງຂອງກອງລົດແທນ ເພາະຄັນນີ້ຍັງບໍ່ມີໃບບິນໃຫ້ປັບທຽບ */
  capacity_estimated: boolean;
  /** ລິດຕາມໃບບິນ ໃນຊ່ວງດຽວກັນ — ໄວ້ທຽບກັບເຂັມ */
  receipt_liters: number;
  receipt_refills: number;
  /** ຈຳນວນຄັ້ງທີ່ເຂັມກະໂດດຂຶ້ນ — ຫຼາຍກວ່າ receipt_refills = ເຕີມແຕ່ບໍ່ໄດ້ບັນທຶກ */
  sensor_refills: number;
  amount: number;
  /** km/L ຈາກເຂັມວັດແທກ */
  km_per_liter: number | null;
  /** km/L ຈາກໃບບິນ — ໄວ້ທຽບ, ສອງຄ່ານີ້ບໍ່ຈຳເປັນຕ້ອງກົງກັນ */
  receipt_km_per_liter: number | null;
  cost_per_km: number | null;
}

export interface FuelEfficiencyResult {
  fromDate: string;
  toDate: string;
  days: number;
  rows: FuelEfficiencyRow[];
  ignoredRefills: number;
  /** ລິດຕໍ່ 1% ຄ່າກາງຂອງກອງລົດ — ໃຊ້ກັບຄັນທີ່ຍັງບໍ່ມີໃບບິນ */
  fleetLitersPerPercent: number | null;
  /** ຊ່ວງທີ່ມີຂໍ້ມູນເຂັມວັດແທກແທ້ */
  sensorCoverage: {
    from_date: string | null;
    to_date: string | null;
    points: number;
    cars: number;
  };
}

