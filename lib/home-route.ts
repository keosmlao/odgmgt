/**
 * ໜ້າແລກຫຼັງ login ຂຶ້ນກັບວ່າຜູ້ນັ້ນເປັນໃຜ.
 *
 * ຜູ້ບໍລິຫານເປີດມາຄວນເຫັນ ພາບລວມການຂາຍ ທັນທີ — ຄຳຖາມທຳອິດຂອງເຂົາເຈົ້າຄື
 * "ເດືອນນີ້ຈະຮອດເປົ້າບໍ" ບໍ່ແມ່ນລາຍການວຽກ. ຄົນອື່ນຍັງລົງທີ່ dashboard ຄືເກົ່າ
 * ເພາະບໍ່ມີສິດເປີດໜ້ານັ້ນຢູ່ແລ້ວ.
 *
 * ລາຍຊື່ role ຢູ່ບ່ອນດຽວນີ້ ແລະ ຖືກໃຊ້ຄືນທັງເມນູຂ້າງ ແລະ ໜ້າ /sales-overview
 * ເອງ — ຝັ່ງ API ກໍ່ກວດຊຸດດຽວກັນ (ALLOWED_ROLES ໃນ app/api/sales-overview).
 */
export const EXECUTIVE_ROLES = ["ceo", "gm", "sale_bu_manager", "sale_supervisor"];

export const isExecutive = (user: { role?: string | null } | null | undefined) =>
  EXECUTIVE_ROLES.includes(String(user?.role || "").toLowerCase());

/** ໜ້າທີ່ຄວນເປີດໃຫ້ຜູ້ນີ້ ຫຼັງ login ຫຼື ເມື່ອເປີດ "/" ຂຶ້ນມາ. */
export const homeFor = (user: { role?: string | null } | null | undefined) =>
  isExecutive(user) ? "/sales-overview" : "/dashboard";
