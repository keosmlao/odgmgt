// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
import type { Session } from "@/lib/ods/auth";

/**
 * ວຽກຂອງໃຜ — ກົດເກນກາງອັນດຽວຂອງລະບົບ.
 *
 * ຊ່າງ (technical) ເຫັນສະເພາະວຽກຂອງຕົນເອງ.
 * ຄົນອື່ນທັງໝົດ (ຜູ້ຈັດການ, admin, CS, ສາງ, ພະນັກງານທົ່ວໄປ) ເຫັນທຸກວຽກ.
 *
 * ຄືນ username ຖ້າຕ້ອງກອງ, ຫຼື null ຖ້າເຫັນໝົດ.
 *
 * ໝາຍເຫດ: ໜ້າກວດເຊັກເຄີຍໃຊ້ `role !== "manager"` ຕາມ ods —
 * ແຕ່ role ດຽວນີ້ມາຈາກພະແນກໃນ odg_employee ຈຶ່ງບໍ່ມີໃຜເປັນ "manager"
 * ຜົນຄື ທຸກຄົນຖືກກອງແລ້ວເຫັນ 0 ວຽກ.
 */
export function ownJobsOnly(session: Session | null): string | null {
  return session?.role === "technical" ? session.username : null;
}

/** ກວດໜ້າ detail: ຊ່າງເປີດໄດ້ສະເພາະ record ທີ່ assigned ໃຫ້ຕົນ. */
export function canViewAssignedJob(session: Session | null, assignedTo: string | null | undefined): boolean {
  const owner = ownJobsOnly(session);
  return owner === null || (assignedTo ?? "").trim().toLowerCase() === owner.trim().toLowerCase();
}
