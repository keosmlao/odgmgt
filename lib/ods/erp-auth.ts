// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
import { scryptSync, timingSafeEqual } from "node:crypto";

/**
 * ກວດລະຫັດຜ່ານຂອງ odg_employee.password (ຖານ ERP).
 *
 * ພົບ 2 ຮູບແບບປົນກັນ:
 *   1. `scrypt$<salt>$<hash>` — salt 16 bytes, hash 64 bytes, encode ແບບ base64url
 *      (ຮູບແບບຂອງ hashlib.scrypt ຂອງ Python — ບໍ່ແມ່ນຂອງ Werkzeug)
 *   2. ຂໍ້ຄວາມທຳມະດາ (ບາງຄົນລະຫັດຜ່ານ = ລະຫັດພະນັກງານ)
 *
 * ບັນຫາ: ຮູບແບບນີ້ບໍ່ໄດ້ຝັງ parameter (N, r, p) ໄວ້ໃນ string ຄືຂອງ Werkzeug
 * ຈຶ່ງບໍ່ຮູ້ວ່າລະບົບ ERP ໃຊ້ຄ່າໃດ. ແທນທີ່ຈະເດົາອັນດຽວແລ້ວລັອກທຸກຄົນອອກ
 * ເຮົາລອງຊຸດຄ່າມາດຕະຖານທີ່ນິຍົມໃຊ້ — ອັນໃດຕົງກໍຜ່ານ.
 *
 * ຖ້າຮູ້ຄ່າແທ້ຈາກທີມ ERP ແລ້ວ ໃຫ້ຕັດ SCRYPT_PARAMS ເຫຼືອຊຸດດຽວ ຈະໄວຂຶ້ນ.
 */

/** ຊຸດ parameter ທີ່ຈະລອງ — ຮຽງຈາກທີ່ນິຍົມສຸດ */
const SCRYPT_PARAMS = [
  { N: 16384, r: 8, p: 1 }, // ຄ່າມາດຕະຖານທົ່ວໄປ
  { N: 32768, r: 8, p: 1 }, // ຄ່າ default ຂອງ Werkzeug
  { N: 65536, r: 8, p: 1 },
  { N: 8192, r: 8, p: 1 },
] as const;

function safeEqual(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyErpPassword(stored: string | null, password: string): boolean {
  if (!stored || !password) return false;

  if (stored.startsWith("scrypt$")) {
    const [, saltPart, hashPart] = stored.split("$");
    if (!saltPart || !hashPart) return false;

    let salt: Buffer;
    let expected: Buffer;
    try {
      salt = Buffer.from(saltPart, "base64url");
      expected = Buffer.from(hashPart, "base64url");
    } catch {
      return false;
    }
    if (!salt.length || !expected.length) return false;

    for (const { N, r, p } of SCRYPT_PARAMS) {
      try {
        const actual = scryptSync(password, salt, expected.length, {
          N,
          r,
          p,
          maxmem: 256 * N * r + 1024,
        });
        if (safeEqual(actual, expected)) return true;
      } catch {
        // ຄ່າ N ໃຫຍ່ເກີນ maxmem → ຂ້າມໄປລອງຊຸດຕໍ່ໄປ
      }
    }
    return false;
  }

  // ຂໍ້ຄວາມທຳມະດາ (ລະບົບ ERP ຍັງມີຢູ່) — ທຽບແບບ timing-safe
  return safeEqual(Buffer.from(stored), Buffer.from(password));
}

/**
 * ແປງ "ຕຳແໜ່ງ + ພະແນກ" ຂອງ ERP → role ຂອງລະບົບນີ້.
 *
 *   ຕຳແໜ່ງ (odg_position) ບອກ "ລະດັບສິດ":
 *     11 ຜູ້ຈັດການ      (is_manager) → manager       — ເຫັນທຸກວຽກ, ອະນຸມັດໄດ້
 *     12 ຫົວໜ້າໜວຍງານ                → ຫົວໜ້າສາຍງານນັ້ນ — ອະນຸມັດໄດ້
 *     13 ພະນັກງານ                    → ພະນັກງານສາຍງານນັ້ນ
 *
 *   ພະແນກ (odg_department) ບອກ "ສາຍງານ":
 *     401/402/403 ສ້ອມແປງ/ຕິດຕັ້ງ → ຊ່າງ · 501 ສາງ · 405 CS (ຮັບເຄື່ອງໜ້າເຄົາເຕີ)
 *
 * ຖ້າມື້ໃດຕື່ມຄ່າໃສ່ odg_employee.app_role ແລ້ວ ໃຫ້ຖືຄ່ານັ້ນເປັນຫຼັກ
 * (ຕອນນີ້ເປັນ NULL ທັງ 242 ຄົນ).
 */
/**
 * ຕົວຕົນ (= ຊື່ເຂົ້າລະບົບ) ຂອງພະນັກງານ ERP — ຊື່ຫຼິ້ນ, ຕົກໄປໃຊ້ຊື່ເຕັມຖ້າຊື່ຫຼິ້ນເປັນຕົວເລກ/ຫວ່າງ.
 * ຄ່ານີ້ຄືຄ່າດຽວກັບທີ່ເກັບໃນ tb_product.emp_code ແລະ session.username
 * ⇒ ທຸກບ່ອນຕ້ອງໃຊ້ສູດອັນນີ້ອັນດຽວ (login, ແຈ້ງເຕືອນ, ລາຍຊື່ຊ່າງ, ກຳນົດສິດ).
 * ຕ້ອງ alias odg_employee ເປັນ e.
 */
export const ERP_IDENTITY_SQL = `case when coalesce(nullif(e.nickname,''),'') ~ '^[0-9]*$'
  then e.fullname_lo else e.nickname end`;

/**
 * ສູດດຽວກັນກັບ roleFromErp() ແຕ່ຂຽນເປັນ SQL — ໃຊ້ຕອນຕ້ອງການ "ລາຍຊື່ຄົນທັງໝົດ
 * ໃນ role ນຶ່ງ" (ເຊັ່ນ ແຈ້ງເຕືອນຫາສາງທຸກຄົນ) ໂດຍບໍ່ຕ້ອງດຶງພະນັກງານ 242 ຄົນມາຄິດຢູ່ JS.
 * ຕ້ອງ alias odg_employee ເປັນ e.
 */
export const ERP_ROLE_CASE = `case
  when e.app_role is not null and e.app_role <> '' then e.app_role
  when e.position_code = '11' then 'manager'
  when e.department_code in ('401','402','403')
    then case when e.position_code = '12' then 'headtechnical' else 'technical' end
  when e.department_code = '501' then 'stock'
  when e.department_code = '405' then 'admin'
  else 'user' end`;

/**
 * ── ໃຜມີສິດ **ເຂົ້າລະບົບນີ້** (ນະໂຍບາຍຂອງຜູ້ຈັດການ 28-07-2026) ──
 *
 *   ໄດ້: ຝ່າຍບໍລິການ (400) **ຍົກເວັ້ນ ຕິດຕັ້ງໂຄງການ (403)** · ສາງ (501) · ໄອທີ (801)
 *   ບໍ່ໄດ້: ພະແນກອື່ນທັງໝົດ (ຂາຍ · ບັນຊີ · ຂົນສົ່ງ · ບຸກຄະລາກອນ …)
 *
 * ເປັນຫຍັງຕັດ 403: ຊ່າງໂຄງການບໍ່ຮັບງານສ້ອມ/ຕິດຕັ້ງຂອງສູນບໍລິການ — ຕົງກັບຂອບເຂດ
 * "ສູນບໍລິການ" ທີ່ໃຊ້ຢູ່ /manage/employees ແລະ dropdown ຈັດຊ່າງ (lib/technicians).
 * ໄອທີໃສ່ເຂົ້າມາເພື່ອແກ້ບັນຫາລະບົບໄດ້.
 *
 * ⚠️ ນີ້ຄື **ຕຳແໜ່ງບໍ່ກ່ຽວ** — ຜູ້ຈັດການພະແນກອື່ນ (ຕຳແໜ່ງ 11) ກໍ່ເຂົ້າບໍ່ໄດ້ ເຖິງແມ່ນ
 * roleFromErp() ຈະໃຫ້ role `manager` ກໍ່ຕາມ. ຖ້າຕ້ອງໃຫ້ໃຜຄົນນຶ່ງເຂົ້າໄດ້ເປັນກໍລະນີ
 * ຜູ້ຈັດການກຳນົດສິດໃຫ້ທີ່ /manage/employees — ສິດທີ່ກຳນົດເອງຊະນະດ່ານນີ້.
 */
const PROJECT_INSTALL_DEPT = "403";
const EXTRA_DEPTS = ["501", "801"]; // ສາງ · ໄອທີ

export function canEnterApp(divisionCode: string | null, departmentCode: string | null): boolean {
  const division = (divisionCode ?? "").trim();
  const department = (departmentCode ?? "").trim();
  if (division === "400") return department !== PROJECT_INSTALL_DEPT;
  return EXTRA_DEPTS.includes(department);
}

export function roleFromErp(
  appRole: string | null,
  positionCode: string | null,
  departmentCode: string | null,
): string {
  if (appRole) return appRole;

  // ຜູ້ຈັດການ — ບໍ່ວ່າພະແນກໃດ ກໍ່ເຫັນທຸກຢ່າງ
  if (positionCode === "11") return "manager";

  const head = positionCode === "12"; // ຫົວໜ້າໜວຍງານ

  switch (departmentCode) {
    case "401": // ພະແນກສ້ອມແປງ
    case "402": // ພະແນກຕິດຕັ້ງ
    case "403": // ພະແນກຕິດຕັ້ງໂຄງການ
      return head ? "headtechnical" : "technical";
    case "501": // ພະແນກສາງ
      return "stock";
    case "405": // ພະແນກ CS — ຮັບເຄື່ອງໜ້າເຄົາເຕີ
      return "admin";
    default:
      return "user";
  }
}
