// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
/**
 * ຄ່າຄົງທີ່ຂອງສາງ/ອາໄຫຼ່ — ຖອດແບບຈາກ ods/stock.py, ods/spare_part.py, ods/newspare.py.
 * ໃນ ods ຄ່າພວກນີ້ຖືກຂຽນຝັງໄວ້ຫຼາຍບ່ອນ (hardcode) — ຢູ່ນີ້ລວມໄວ້ບ່ອນດຽວ.
 */

/** trans_flag ຂອງ ic_trans / ic_trans_detail */
export const TRANS = {
  /** ໃບຂໍເບີກ (ຊ່າງຂໍ) */
  REQUEST: 122,
  /** ໃບເບີກອາໄຫຼ່ (ສາງຈ່າຍ) */
  DISPATCH: 56,
  /** ຮັບຄືນເຂົ້າສາງ */
  RECEIVE_BACK: 58,
  /** ໃບຂໍສົ່ງຄືນ */
  RETURN_REQUEST: 59,
  /** ໂອນຍ້າຍສາງ */
  TRANSFER: 124,
  /** ແຖວຮ່າງໃນ ic_trans_detail_draft */
  DRAFT: 33,
} as const;

/** status ຂອງແຖວ ic_trans_detail */
export const LINE_STATUS = {
  /** ລໍຖ້າ */
  PENDING: 0,
  /** ເບີກແລ້ວ */
  ISSUED: 1,
  /** ຂໍສົ່ງຄືນ */
  RETURN_REQUESTED: 3,
  /** ກຳລັງສັ່ງຊື້ */
  ON_PURCHASE_ORDER: 5,
} as const;

/** ສາງທີ່ຊ່າງເລືອກໄດ້ຕອນຂໍເບີກ (ods: show_req → ic_warehouse where code in (...)) */
export const REQUEST_WAREHOUSES = ["1103", "1204", "1206", "1104"] as const;

/** ສາງທີ່ໜ້າ "ເບີກອາໄຫຼ່" ເບິ່ງເຫັນ ຖ້າຜູ້ໃຊ້ບໍ່ໄດ້ຜູກສາງໄວ້ (ods: spdispatch) */
export const DISPATCH_WAREHOUSES = ["1103", "1204", "1206", "1203"] as const;

/**
 * ສາງສ້ອມແປງ **ສູນບໍລິການ** ສອງສາງ — ປາຍທາງຂອງ "ຂໍໂອນອາໄຫຼ່ມາຫ້ອງສ້ອມ".
 *   1104 = ສາງສ້ອມແປງ (ສູນບໍລິການ ຂົວຫຼວງ) · 1206 = ສາງສ້ອມແປງສູນບໍລິການ (ດອນຕີ້ວ)
 */
export const REPAIR_WAREHOUSES = ["1104", "1206"] as const;

/** ທີ່ເກັບທີ່ອະນຸຍາດ (ods: fetch_data_shelfx) */
export const ALLOWED_SHELVES = [
  "110301",
  "120401",
  "120601",
  "120602",
  "120603",
  "120604",
  "120605",
  "120606",
  "120301",
  "110413",
  "110411",
] as const;

/** ຄ່າຕັ້ງຕົ້ນເມື່ອໃບຂໍເບີກບໍ່ໄດ້ລະບຸສາງ (ods: save_dispatch) */
export const DEFAULT_WH = "1103";
export const DEFAULT_SHELF = "110301";

/** ສາງທີ່ຕັດ wh_qty ນຳ (ods: save_dispatch — ສາງອື່ນຕັດແຕ່ balance_qty) */
export const MAIN_WH = "1103";

/** ສາງ/ທີ່ເກັບຂອງໃບຮັບຄືນ (ods: save_com_return — ຝັງໄວ້ຕາຍຕົວ) */
export const RETURN_WH = "1103";
export const RETURN_SHELF = "110301";

/** ສາຂາ ERP: ດອນຕີ້ວ(1204) = '00', ນອກນັ້ນ = '01' (ods: save_dispatch) */
export function branchOf(whCode: string) {
  return whCode === "1204" ? "00" : "01";
}

/**
 * ຕ່ອງໂສ້ການສັ່ງຊື້ຝັ່ງ **ERP** — ຜູກກັນຜ່ານ `ic_trans_detail.ref_doc_no` (ບໍ່ແມ່ນ doc_ref ຂອງຫົວໃບ).
 *
 *   ໃບຂໍຊື້ (SPR)  →  ອະນຸມັດ (WPRA)  →  ໃບສັ່ງຊື້ (POT/POH)  →  ຮັບເຂົ້າສາງ (PUIT/PUIH)
 *      PR_REQUEST        PR_APPROVE           ORDER                  RECEIPT
 *
 * ຢືນຢັນກັບຂໍ້ມູນຈິງແລ້ວ (16-07-2026): SPR ຂອງວຽກສ້ອມ 549 ໃບ — ປີ 2024 ມີ 268 ໃບ
 * ຕໍ່ຕ່ອງໂສ້ໄດ້ຄົບເຖິງ "ຮັບເຂົ້າສາງ" 244 ໃບ ⇒ ຕິດຕາມຜ່ານຕ່ອງໂສ້ນີ້ໄດ້ຈິງ.
 */
export const ERP_PURCHASE = {
  /** ໃບຂໍຊື້ (SPR ຂອງວຽກສ້ອມ · PRHN/PRTM… ຂອງຝ່າຍອື່ນ) */
  /** ອະນຸມັດໃບສັ່ງຊື້ (WPOA) — ref_doc_no ຊີ້ໃສ່ໃບສັ່ງຊື້ */
  ORDER_APPROVE: 8,
  PR_REQUEST: 2,
  /** ອະນຸມັດໃບຂໍຊື້ (WPRA) — ref_doc_no ຊີ້ໃສ່ໃບຂໍຊື້ໄຟຢົຢໄ  ຟຢຟຢຢ */
  PR_APPROVE: 4,
  /** ໃບສັ່ງຊື້ (POT/POH) — ref_doc_no ຊີ້ໃສ່ໃບອະນຸມັດ */
  ORDER: 6,
  /** ຮັບເຂົ້າສາງ (PUIT/PUIH) — ref_doc_no ຊີ້ໃສ່ໃບສັ່ງຊື້ */
  RECEIPT: 12,
} as const;

/**
 * **ສົດ ຫຼື ຕິດໜີ້ — ເປັນຄຳເວົ້າ.** ນິຍາມບ່ອນດຽວ ໃຊ້ທັງຟອມ · ໜ້າເອກະສານ · ໃບພິມ.
 *
 * ERP ບໍ່ມີຖັນ "ສົດ/ຕິດໜີ້" ແຍກ — ມັນບອກດ້ວຍ `ic_trans.credit_day` ດຽວ
 * (0 = ສົດ · >0 = ຕິດໜີ້ N ວັນ). ເບິ່ງ `PoTerms` ໃນ erp-po.ts ສຳລັບຂໍ້ມູນຢືນຢັນ.
 */
export const payTermLabel = (creditDay: number | null | undefined) =>
  creditDay && creditDay > 0 ? `ຕິດໜີ້ ${creditDay} ວັນ` : "ຈ່າຍສົດ";

/** ຄ່າຄົງທີ່ຂອງເອກະສານຝັ່ງ ERP (odg) */
export const ERP = {
  TRANS_TYPE: 3,
  SIDE_CODE: "400",
  DEPARTMENT_CODE: "4001",
  /**
   * ສາຂາຂອງໃບ**ຂໍ**ເບີກ/ຂໍສົ່ງຄືນ — **ສາຂາຂົວຫຼວງ (01) ສະເໝີ** ບໍ່ອີງສາງ.
   * branchOf() ຈັບຄູ່ 1204→00 (ສຳນັກງານໃຫ່ຍ) ຕາມ ods ເກົ່າ ⇒ ໃບຂອງສາງດອນຕີ້ວ
   * ອອກເປັນສາຂາຜິດ (SION2026072399) — ສູນບໍລິການສັງກັດສາຂາຂົວຫຼວງ.
   */
  BRANCH_REQUEST: "01",
  /** doc_format_code ຂອງໃບເບີກ */
  FORMAT_DISPATCH: "SWC",
  /** doc_format_code ຂອງໃບ **ຂໍ**ເບີກ (122) — ໃບຂອງເຮົາໃຊ້ເລກ SIO… ⇒ ຮູບແບບ SIO */
  FORMAT_REQUEST: "SIO",
  /** doc_format_code ຂອງໃບຮັບຄືນ */
  FORMAT_RECEIVE: "RIM",
  /** doc_format_code ຂອງໃບ **ຂໍ**ສົ່ງຄືນ (59) */
  FORMAT_RETURN: "SRI",
} as const;

/**
 * **ໃບຂອງຝ່າຍບໍລິການ** — ERP ໝາຍຝ່າຍເຈົ້າຂອງໃບດ້ວຍ `ic_trans.side_code`
 * (400 = ບໍລິການ · 200 = ຝ່າຍອື່ນ · ຫວ່າງ/null = ໃບທີ່ບໍ່ໄດ້ຕິດປ້າຍ).
 *
 * ຂໍ້ມູນຈິງ (12-08-2026 · PO ຍ້ອນຫຼັງ 1 ປີ): 273 ໃບຕິດ 400 · 1,962 ໃບບໍ່ໄດ້ຕິດ
 * ⇒ ຖັນນີ້ຢ່າງດຽວຍັງບໍ່ພໍ ຕ້ອງນັບໃບຕ່ອງໂສ້ SPR ແລະ ໃບຂອງພະນັກງານສູນນຳ
 * (ເບິ່ງ `serviceStaffCodes` ໃນ erp-employee.ts).
 */
export const SERVICE_SIDE_SQL = (alias = "t") => `coalesce(${alias}.side_code,'') = '${ERP.SIDE_CODE}'`;

/** calc_flag: -1 = ຕັດອອກຈາກສາງ, 1 = ບວກເຂົ້າສາງ */
export const CALC_OUT = -1;
export const CALC_IN = 1;
/** 0 = ບໍ່ແຕະສະຕັອກ — ໃບ**ຂໍ**ເບີກເປັນພຽງຄຳຂໍ (ໃບເບີກ 56 ຂອງສາງເປັນຄົນຕັດສະຕັອກ) */
export const CALC_NONE = 0;
