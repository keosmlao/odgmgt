/**
 * ພາກ ແລະ ແຂວງ ຂອງ ສປປ ລາວ — ແກນການເບິ່ງຕົວເລກຂອງໜ້າພາບລວມການຂາຍ.
 *
 * ລະຫັດແຂວງມາຈາກ public.erp_province (01–18) ບວກ 19–20 ທີ່ ERP ໃຊ້ເກັບການຂາຍ
 * ຕ່າງປະເທດ. ການແບ່ງພາກຖືຕາມ salewole ບ່ອນດຽວກັນ ເພື່ອສອງລະບົບບໍ່ໃຫ້ຕົວເລກ
 * ຄົນລະຢ່າງ ເມື່ອຜູ້ບໍລິຫານເປີດທຽບກັນ:
 *
 *   ⚠️ ນະຄອນຫຼວງ ແຍກອອກຈາກພາກກາງເປັນກຸ່ມຂອງມັນເອງ — ຄົນດຽວກວມເກືອບ 2/3 ຂອງ
 *      ຍອດທັງປະເທດ, ລວມຢູ່ພາກກາງແລ້ວແຂວງອື່ນຈະຖືກກົບຈົນເບິ່ງບໍ່ເຫັນ.
 *   ⚠️ ສະຫວັນນະເຂດ ຢູ່ **ພາກກາງ** ຕາມການແບ່ງທາງການ. ໜ້າ ສະຫຼຸບເດືອນ · ພາກໃຕ້
 *      ນັບສະຫວັນນະເຂດລວມນຳ ຕາມທີ່ຝ່າຍຂາຍຂໍ ຈຶ່ງເປັນຄົນລະຂອບເຂດກັບ 'S' ບ່ອນນີ້
 *      ແລະ ຊື່ເມນູຂອງມັນເວົ້າໄວ້ຊັດເຈນວ່າ "ພາກໃຕ້ + ສະຫວັນນະເຂດ".
 */

export const REGIONS = [
  { key: "V", label: "ນະຄອນຫຼວງ", provinces: ["01"] },
  { key: "N", label: "ພາກເໜືອ", provinces: ["02", "03", "04", "05", "06", "07", "08"] },
  { key: "C", label: "ພາກກາງ", provinces: ["09", "10", "11", "12", "13", "14"] },
  { key: "S", label: "ພາກໃຕ້", provinces: ["15", "16", "17", "18"] },
  { key: "X", label: "ຕ່າງປະເທດ", provinces: ["19", "20"] },
];

/** ແຂວງທີ່ບໍ່ຢູ່ໃນຕາຕະລາງ (ວ່າງ / '-' / ລະຫັດແປກ) — ບໍ່ຖິ້ມ ຍອດຈຶ່ງຍັງຄົບ. */
export const UNKNOWN_REGION = { key: "U", label: "ບໍ່ລະບຸພື້ນທີ່" };

/** ຊື່ແຂວງແບບສັ້ນ — ຕັດຄຳວ່າ "ແຂວງ" ອອກ ບໍ່ດັ່ງນັ້ນ chip ຈະຍາວເກີນ. */
export const PROVINCE_SHORT = {
  "01": "ນະຄອນຫຼວງ",
  "02": "ຜົ້ງສາລີ",
  "03": "ຫຼວງນ້ຳທາ",
  "04": "ບໍ່ແກ້ວ",
  "05": "ອຸດົມໄຊ",
  "06": "ຫຼວງພະບາງ",
  "07": "ໄຊຍະບູລີ",
  "08": "ຫົວພັນ",
  "09": "ຊຽງຂວາງ",
  "10": "ວຽງຈັນ",
  "11": "ໄຊສົມບູນ",
  "12": "ບໍລິຄຳໄຊ",
  "13": "ຄຳມ່ວນ",
  "14": "ສະຫວັນນະເຂດ",
  "15": "ສາລະວັນ",
  "16": "ຈຳປາສັກ",
  "17": "ເຊກອງ",
  "18": "ອັດຕະປື",
  "19": "ຫວຽດນາມ",
  "20": "ໄທ",
};

const PROVINCE_TO_REGION = new Map(
  REGIONS.flatMap((region) => region.provinces.map((province) => [province, region.key])),
);

export const isRegionKey = (value) => REGIONS.some((region) => region.key === value);

/** ພາກຂອງແຂວງ — 'U' ເມື່ອບໍ່ຮູ້ຈັກ. */
export const regionOf = (province) =>
  PROVINCE_TO_REGION.get(String(province ?? "").trim()) ?? UNKNOWN_REGION.key;

export const regionLabel = (key) =>
  REGIONS.find((region) => region.key === key)?.label ?? UNKNOWN_REGION.label;

export const provinceLabel = (code) => {
  const value = String(code ?? "").trim();
  return PROVINCE_SHORT[value] || (value && value !== "-" ? value : UNKNOWN_REGION.label);
};

/** ລະຫັດແຂວງທັງໝົດຂອງພາກ — ໃຊ້ເປັນຕົວກັ່ນຕອງ. */
export const provincesOf = (key) => [
  ...(REGIONS.find((region) => region.key === key)?.provinces ?? []),
];
