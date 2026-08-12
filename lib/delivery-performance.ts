// ຊະນິດຂໍ້ມູນ + ການຄິດເປີເຊັນ ຂອງລາຍງານປະສິດທິພາບການຈັດສົ່ງ.
//
// ແຍກອອກຈາກໜ້າຈໍເພື່ອໃຫ້ໜ້າ Dashboard ແລະ ໜ້າລາຍງານໃຊ້ສູດດຽວກັນ (ຖ້າຕ່າງກັນ
// ຜູ້ບໍລິຫານຈະເຫັນ 2 ຕົວເລກທີ່ບໍ່ກົງກັນຢູ່ 2 ໜ້າ) ແລະ ເພື່ອໃຫ້ທົດສອບໄດ້ໂດຍບໍ່
// ຕ້ອງຕໍ່ຖານຂໍ້ມູນ. ຂໍ້ມູນດິບມາຈາກ getDeliveryPerformance() ໃນ src/queries/reports.js.

export type LeadTimeBuckets = {
  le_24h: number;
  h24_48: number;
  gt_48h: number;
};

export type ScheduleBuckets = LeadTimeBuckets & {
  /** ບິນທີ່ບໍ່ເຄີຍມີວັນນັດ — ວັດຈາກວັນນັດບໍ່ໄດ້ ຈຶ່ງແຍກໄວ້ ບໍ່ຖິ້ມ */
  no_schedule: number;
};

/** ເກນ N ວັນ ຂອງການລັດຄິວ — d1 = 1 ວັນ, d3 = 3 ວັນ, d7 = 7 ວັນ */
export type JumpWindow = "d1" | "d3" | "d7";

export type JumpBuckets = Record<JumpWindow, number>;

export const JUMP_WINDOW_LABEL: Record<JumpWindow, string> = {
  d1: "1 ວັນ",
  d3: "3 ວັນ",
  d7: "7 ວັນ",
};

export type DeliveryPerfBucket = {
  /** ບິນທີ່ເປີດກ່ອນເດືອນນີ້ ແລະ ຍັງບໍ່ທັນສົ່ງສຳເລັດຕອນຕົ້ນເດືອນ */
  carry_in: number;
  /** ບິນທີ່ເປີດພາຍໃນເດືອນ */
  opened: number;
  /** ບິນທີ່ສົ່ງສຳເລັດພາຍໃນເດືອນ (ຈາກທັງ 2 ກຸ່ມຂ້າງເທິງ) */
  delivered: number;
  /**
   * ບິນທີ່ອອກຈາກຍອດຄ້າງໂດຍບໍ່ໄດ້ສົ່ງ — ຄືນສິນຄ້າຜ່ານໃບຫຼຸດໜີ້ ຫຼື ຖືກປິດຢູ່
   * ERP. ຕ້ອງແຍກໄວ້ ບໍ່ດັ່ງນັ້ນສົມຜົນຍອດຈະບໍ່ສົມດຸນ.
   */
  closed_other: number;
  /** ບິນທີ່ຍັງບໍ່ເຖິງລູກຄ້າຕອນສິ້ນເດືອນ = carry_in + opened − delivered − closed_other */
  carry_out: number;
  /** ບິນທີ່ຢູ່ໃນມືເດືອນນີ້ = carry_in + opened (ໂຕຫານຂອງອັດຕາລຸ່ມນີ້) */
  handled: number;
  /** ເວລານຳສົ່ງ ນັບແຕ່ເປີດບິນ → ສົ່ງສຳເລັດ */
  from_open: LeadTimeBuckets;
  /** ເວລານຳສົ່ງ ນັບແຕ່ວັນນັດຈັດສົ່ງ → ສົ່ງສຳເລັດ */
  from_schedule: ScheduleBuckets;
  /** ບິນທີ່ຖືກປ່ຽນວັນນັດຈັດສົ່ງຫຼາຍກວ່າ 2 ຄັ້ງ */
  rescheduled_over_2: number;
  /**
   * ບິນທີ່ຖືກລັດຄິວ — ມີບິນທີ່ເປີດຫຼັງ (ສາຂາດຽວກັນ) ຖືກສົ່ງໄປກ່ອນເກີນ N ວັນ.
   * ເກັບ 3 ເກນໄວ້ພ້ອມກັນ ເພື່ອໃຫ້ໜ້າຈໍສະຫຼັບເບິ່ງໄດ້ໂດຍບໍ່ຕ້ອງຖາມຖານຂໍ້ມູນຄືນ.
   */
  jumped: JumpBuckets;
  /** ຍ່ອຍລົງມາ: ສະເພາະບິນທີ່ຜູ້ຈັດໝາຍວ່າ "ຕິດຕໍ່ແລ້ວ/ພ້ອມສົ່ງ" ແຕ່ຍັງຖືກຂ້າມ */
  jumped_ready: JumpBuckets;
  /** ບິນທີ່ທະຍອຍສົ່ງ — ສົ່ງສຳເລັດຫຼາຍກວ່າ 1 ຖ້ຽວ */
  multi_leg_bills: number;
  /** ບິນທີ່ປິດງານແລ້ວແຕ່ຈຳນວນສົ່ງຍັງບໍ່ຄົບຕາມທີ່ເບີກ */
  short_bills: number;
  /** ບິນທີ່ມີການຍົກເລີກການສົ່ງພາຍໃນເດືອນ */
  cancelled_bills: number;
  /** ຈຳນວນຄັ້ງທີ່ຖືກຍົກເລີກ (1 ບິນ ອາດຖືກຍົກເລີກຫຼາຍຄັ້ງ) */
  cancelled_legs: number;
  avg_lead_open_h: number | null;
  median_lead_open_h: number | null;
};

export type DeliveryPerfBranch = DeliveryPerfBucket & {
  branch_code: string;
  branch_name: string;
};

export type DeliveryPerfDepartment = DeliveryPerfBucket & {
  department_code: string;
  department_name: string;
};

export type DeliveryPerfReport = {
  month: string;
  overall: DeliveryPerfBucket;
  branches: DeliveryPerfBranch[];
  /** ແຍກຕາມພະແນກຂອງພະນັກງານຂາຍທີ່ເປີດບິນ */
  departments: DeliveryPerfDepartment[];
};

export const EMPTY_PERF_BUCKET: DeliveryPerfBucket = {
  carry_in: 0,
  opened: 0,
  delivered: 0,
  closed_other: 0,
  carry_out: 0,
  handled: 0,
  from_open: { le_24h: 0, h24_48: 0, gt_48h: 0 },
  from_schedule: { le_24h: 0, h24_48: 0, gt_48h: 0, no_schedule: 0 },
  rescheduled_over_2: 0,
  jumped: { d1: 0, d3: 0, d7: 0 },
  jumped_ready: { d1: 0, d3: 0, d7: 0 },
  multi_leg_bills: 0,
  short_bills: 0,
  cancelled_bills: 0,
  cancelled_legs: 0,
  avg_lead_open_h: null,
  median_lead_open_h: null,
};

export const EMPTY_PERF_REPORT: DeliveryPerfReport = {
  month: "",
  overall: EMPTY_PERF_BUCKET,
  branches: [],
  departments: [],
};

/** ເປີເຊັນທີ່ບໍ່ລະເບີດເມື່ອໂຕຫານເປັນ 0 */
export function perfPercent(part: number, total: number) {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return (part / total) * 100;
}

export type DeliveryPerfRates = {
  deliveredRate: number;
  closedOtherRate: number;
  carryOutRate: number;
  openOnTimeRate: number;
  open24to48Rate: number;
  openOver48Rate: number;
  schedOnTimeRate: number;
  sched24to48Rate: number;
  schedOver48Rate: number;
  schedUnknownRate: number;
  rescheduledRate: number;
  multiLegRate: number;
  shortRate: number;
  cancelledRate: number;
};

/**
 * ອັດຕາທັງໝົດຂອງໜຶ່ງ bucket.
 *
 * ໂຕຫານ:
 *  • ຊັ້ນເວລານຳສົ່ງ (from_open / from_schedule) → `delivered`
 *    ທັງ 3 ຊັ້ນຂອງ from_open ບວກກັນໄດ້ 100%, ແລະ from_schedule ບວກ
 *    no_schedule ນຳ ຈຶ່ງໄດ້ 100% (ບໍ່ຖິ້ມບິນທີ່ບໍ່ມີວັນນັດອອກຈາກໂຕຫານ
 *    ເພາະນັ້ນຈະດັນເປີເຊັນ "ທັນເວລາ" ໃຫ້ສູງກວ່າຄວາມຈິງ)
 *  • ອັດຕາອື່ນ → `handled` (ບິນທີ່ຢູ່ໃນມືເດືອນນີ້)
 */
export function deliveryPerfRates(bucket: DeliveryPerfBucket): DeliveryPerfRates {
  const { delivered, handled } = bucket;
  return {
    deliveredRate: perfPercent(delivered, handled),
    closedOtherRate: perfPercent(bucket.closed_other, handled),
    carryOutRate: perfPercent(bucket.carry_out, handled),
    openOnTimeRate: perfPercent(bucket.from_open.le_24h, delivered),
    open24to48Rate: perfPercent(bucket.from_open.h24_48, delivered),
    openOver48Rate: perfPercent(bucket.from_open.gt_48h, delivered),
    schedOnTimeRate: perfPercent(bucket.from_schedule.le_24h, delivered),
    sched24to48Rate: perfPercent(bucket.from_schedule.h24_48, delivered),
    schedOver48Rate: perfPercent(bucket.from_schedule.gt_48h, delivered),
    schedUnknownRate: perfPercent(bucket.from_schedule.no_schedule, delivered),
    rescheduledRate: perfPercent(bucket.rescheduled_over_2, handled),
    multiLegRate: perfPercent(bucket.multi_leg_bills, handled),
    shortRate: perfPercent(bucket.short_bills, handled),
    cancelledRate: perfPercent(bucket.cancelled_bills, handled),
  };
}

/**
 * ອັດຕາບິນທີ່ຖືກລັດຄິວ ຕາມເກນ N ວັນ — ໂຕຫານແມ່ນບິນທີ່ຢູ່ໃນມືເດືອນນີ້
 * ຄືກັນກັບອັດຕາຄຸນນະພາບອື່ນ ຈຶ່ງທຽບກັນໄດ້ໂດຍກົງ.
 */
export function jumpedRate(bucket: DeliveryPerfBucket, win: JumpWindow) {
  return perfPercent(bucket.jumped[win], bucket.handled);
}

/** ອັດຕາສະເພາະບິນທີ່ໝາຍວ່າ "ພ້ອມສົ່ງ" ແລ້ວແຕ່ຍັງຖືກຂ້າມ */
export function jumpedReadyRate(bucket: DeliveryPerfBucket, win: JumpWindow) {
  return perfPercent(bucket.jumped_ready[win], bucket.handled);
}

/**
 * ສົມຜົນບັນຊີຂອງເດືອນ: ຍົກມາ + ເປີດໃໝ່ − ສົ່ງສຳເລັດ − ຫຼຸດອອກ = ຍົກໄປ.
 * ບິນອອກຈາກຍອດຄ້າງໄດ້ 2 ທາງເທົ່ານັ້ນ ແລະ ບໍ່ຊ້ອນກັນ ຈຶ່ງຕ້ອງລົງຕົວສະເໝີ.
 * ໃຊ້ໃນ test ແລະ ໃນໜ້າຈໍ ເພື່ອເຕືອນທັນທີຖ້າ SQL ຄືນຄ່າທີ່ບໍ່ສົມດຸນ.
 */
export function perfBalanceIsSound(bucket: DeliveryPerfBucket) {
  return (
    bucket.carry_in + bucket.opened - bucket.delivered - bucket.closed_other ===
    bucket.carry_out
  );
}

/** 13.86 → "13.9 ຊມ", 31.05 → "1.3 ມື້" */
export function formatLeadHours(hours: number | null | undefined) {
  if (hours == null || !Number.isFinite(hours)) return "—";
  if (Math.abs(hours) >= 48) return `${(hours / 24).toFixed(1)} ມື້`;
  return `${hours.toFixed(1)} ຊມ`;
}
