// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
/**
 * ສູນບໍລິການສ້ອມ — ລະຫັດ ↔ ຊື່. **client-safe** (ບໍ່ import db) ⇒ ໃຊ້ໄດ້ທັງ modal ແລະ server.
 * ລະຫັດຕົງກັບ REPAIR_WAREHOUSES (lib/stock-constants) · ຊື່ຕົງກັບ repair-stock-cache.
 */
export const REPAIR_CENTER_LABEL: Record<string, string> = {
  "1104": "ຂົວຫຼວງ",
  "1206": "ດອນຕີ້ວ",
};

export const REPAIR_CENTERS = Object.keys(REPAIR_CENTER_LABEL);

export const centerLabel = (code: string | null | undefined): string =>
  code ? REPAIR_CENTER_LABEL[code] ?? code : "-";

/** ເງື່ອນໄຂ SQL "ງານນີ້ກຳລັງໂອນ (ຍັງບໍ່ຮັບ)" — alias tb_product ເປັນ a */
export const inTransferSql =
  "exists (select 1 from ods_job_transfer jt where jt.job_code = a.code and jt.received_at is null)";
