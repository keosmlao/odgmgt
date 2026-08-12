// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
/**
 * ກຳນົດເວລາ (SLA) ຂອງຂັ້ນຕອນກວດເຊັກ.
 *
 * ນັບແຍກ 2 ຂັ້ນ — ລໍຖ້າກວດເຊັກ ແລະ ກຳລັງກວດເຊັກ — ແຕ່ລະຂັ້ນມີເວລາຂອງຕົນເອງ.
 * ເວລາທີ່ອະນຸຍາດ ຂຶ້ນກັບ "ປະເພດບໍລິການ" (tb_product.service_type):
 *
 *   CI ລູກຄ້ານຳເຄື່ອງເຂົ້າ   →  2 ຊົ່ວໂມງ  (ລູກຄ້າລໍຢູ່)
 *   ST ສ້ອມເຄື່ອງໃນສາງ       →  2 ຊົ່ວໂມງ  (ເຄື່ອງຢູ່ໃນມືແລ້ວ)
 *   IH ສ້ອມບ້ານລູກຄ້າ        → 12 ຊົ່ວໂມງ
 *   PS ໄປຮັບເຄື່ອງທີ່ບ້ານລູກຄ້າມາສ້ອມຢູ່ສູນ → 12 ຊົ່ວໂມງ
 */

const HOUR = 3600;

/** ວິນາທີທີ່ອະນຸຍາດ ຕໍ່ປະເພດບໍລິການ — ບໍ່ມີໃນນີ້ = ບໍ່ນັບ SLA */
export const SLA_SECONDS: Record<string, number> = {
  CI: 2 * HOUR,
  ST: 2 * HOUR,
  IH: 12 * HOUR,
  PS: 12 * HOUR,
};

export const SERVICE_TYPE_LABEL: Record<string, string> = {
  CI: "ລູກຄ້ານຳເຄື່ອງເຂົ້າ",
  PS: "ໄປຮັບເຄື່ອງທີ່ບ້ານລູກຄ້າມາສ້ອມຢູ່ສູນ",
  IH: "ສ້ອມບ້ານລູກຄ້າ",
  ST: "ສ້ອມເຄື່ອງໃນສາງ",
};

/**
 * ປະເພດບໍລິການທີ່ຊ່າງ **ຕ້ອງອອກໜ້າງານ** ⇒ ຕ້ອງ check-in/out ເປັນຫຼັກຖານ.
 * ຂໍ້ມູນຈິງ (5,069 ໃບ): IH 3,669 + PS 123 = **3,792 ໃບ (75%)** · CI/ST ເຮັດຢູ່ສູນ.
 *
 * ⚠️ ຄ່າ 'in'/'out' **ບໍ່ມີຢູ່ໃນຖານເລີຍ** — lib/mobile-jobs ເຄີຍເດົາເອົາ
 * (`service_type <> 'in'`) ⇒ ເປັນຈິງສະເໝີ ⇒ ແອັບບັງຄັບ check-in ແມ່ນແຕ່ງານທີ່ເຮັດຢູ່ສູນ.
 * ນິຍາມຢູ່ບ່ອນນີ້ບ່ອນດຽວ (ຄູ່ກັບ SLA_SECONDS) ⇒ ບໍ່ໃຫ້ມີສອງແຫຼ່ງຄວາມຈິງອີກ.
 */
export const ONSITE_SERVICE_TYPES = ["IH", "PS"] as const;

/** SQL ຂອງ "ງານສ້ອມນອກສະຖານທີ່" — ຕ້ອງ alias ຕາຕະລາງ tb_product ເປັນ a */
export const REPAIR_ONSITE_SQL = `coalesce(a.service_type,'') in ('IH','PS')`;

/** SQL ຂອງ "ວິນາທີທີ່ອະນຸຍາດ" — ໃຊ້ນັບຈຳນວນເກີນກຳນົດຢູ່ຝັ່ງ DB */
export const SLA_SQL = `case a.service_type
  when 'CI' then ${2 * HOUR}
  when 'ST' then ${2 * HOUR}
  when 'IH' then ${12 * HOUR}
  when 'PS' then ${12 * HOUR}
  else null end`;

export type SlaState = "none" | "ok" | "warn" | "late";

/**
 * ສະຖານະ SLA ຂອງລາຍການນຶ່ງ.
 *   ok   ຍັງມີເວລາ
 *   warn ໃຊ້ໄປແລ້ວ ≥ 75% ຂອງເວລາ
 *   late ເກີນກຳນົດແລ້ວ
 *   none ປະເພດບໍລິການນີ້ບໍ່ໄດ້ກຳນົດເວລາ
 */
export function slaState(seconds: number | null, serviceType: string | null): SlaState {
  const limit = serviceType ? SLA_SECONDS[serviceType] : undefined;
  if (!limit || seconds == null) return "none";
  if (seconds > limit) return "late";
  if (seconds >= limit * 0.75) return "warn";
  return "ok";
}

/** ສີຂອງປ້າຍເວລາ ຕາມສະຖານະ SLA */
export function slaTone(state: SlaState) {
  switch (state) {
    case "late":
      return { chip: "bg-brand-orange-700 text-white", bar: "bg-brand-orange-700" };
    case "warn":
      return { chip: "bg-brand-orange-300 text-brand-900", bar: "bg-brand-orange-300" };
    case "ok":
      return { chip: "bg-brand-50 text-brand-800", bar: "bg-brand-400" };
    default:
      return { chip: "bg-slate-100 text-slate-600", bar: "bg-slate-200" };
  }
}

/** ຂໍ້ຄວາມບອກກຳນົດເວລາ ເຊັ່ນ "ກຳນົດ 2 ຊມ" */
export function slaLabel(serviceType: string | null): string | null {
  const limit = serviceType ? SLA_SECONDS[serviceType] : undefined;
  if (!limit) return null;
  return `ກຳນົດ ${limit / HOUR} ຊມ`;
}
