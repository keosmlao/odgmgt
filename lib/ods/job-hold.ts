// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
/**
 * **ທຸງ "ວຽກມີບັນຫາ"** — ນິຍາມບ່ອນດຽວ ໃຊ້ທັງຄິວ · ນາລິກາ · ປຸ່ມ.
 *
 * ── ທຸງ ບໍ່ແມ່ນ ຂັ້ນ ──
 * ວຽກທີ່ຖືກໝາຍ **ຍັງຢູ່ຂັ້ນຈິງຂອງມັນ** (STAGE_SQL ບໍ່ຮູ້ຈັກທຸງນີ້ເລີຍ ແລະ ບໍ່ຄວນຮູ້).
 * ທຸງພຽງແຕ່ບອກວ່າ "ຄາຢູ່ນີ້ດ້ວຍເຫດຜົນທີ່ຄິວແກ້ບໍ່ໄດ້" ⇒ ໜ້າຈໍແຍກແທັບໃຫ້ ແລະ
 * ນາລິກາຂັ້ນຢຸດນັບ. ເຫດຜົນທີ່ບໍ່ເຮັດເປັນຂັ້ນ 13 ຢູ່ໃນ migrations/2026-07-17-job-hold.sql
 * (ສັ້ນໆ: ຕອນ "ຍົກເລີກ" ເປັນຂັ້ນ ວຽກ 570 ໜ່ວຍຫາຍອອກຈາກທຸກຄິວ — ຢ່າພາດຊ້ຳ).
 *
 * ── ໃຊ້ແນວໃດໃນ SQL ──
 * ທຸກ fragment ຢູ່ນີ້ຖືວ່າຕາຕະລາງງານ alias ເປັນ `a` (ຄືກັບ STAGE_SQL) ແລະ
 * ຮັບ workflow ເປັນ argument ເພາະ repair (tb_product) ກັບ install (ods_tb_install)
 * ໃຊ້ຕາຕະລາງຄົນລະອັນ ແຕ່ໃຊ້ທຸງອັນດຽວກັນ.
 */

/** ສາຍງານທີ່ໃຊ້ທຸງໄດ້ — ຄືກັບ ods_job_reject */
export type HoldWorkflow = "repair" | "install";

/** ປະເພດບັນຫາ — ຄ່າໃນຖານ ↔ ຄຳທີ່ຄົນອ່ານ */
export const HOLD_KIND_LABEL: Record<string, string> = {
  spare_wait: "ລໍອາໄຫຼ່ນອກ",
  customer_wait: "ລໍລູກຄ້າຕອບ",
  no_stock: "ອາໄຫຼ່ບໍ່ມີຂາຍ",
  other: "ອື່ນໆ",
};

export const HOLD_KINDS = Object.keys(HOLD_KIND_LABEL);

/**
 * ເງື່ອນໄຂ "ງານນີ້ມີທຸງເປີດຢູ່" — ໃສ່ໃນ where ຂອງຄິວໄດ້ໂດຍກົງ.
 * ໃຊ້ exists ບໍ່ແມ່ນ join ⇒ ບໍ່ຄູນແຖວ ແລະ ບໍ່ຕ້ອງແກ້ select ຂອງຄິວທີ່ມີຢູ່.
 */
export const heldSql = (workflow: HoldWorkflow) =>
  `exists (select 1 from ods_job_hold h
            where h.workflow = '${workflow}' and h.job_code = a.code and h.resolved_at is null)`;

export const notHeldSql = (workflow: HoldWorkflow) => `not ${heldSql(workflow)}`;

/**
 * ເວລາທີ່ **ທຸງເລີ່ມ** — null ຖ້າບໍ່ມີທຸງເປີດ. ນາລິກາຂັ້ນເອົາອັນນີ້ໄປ coalesce
 * ກັບ localtimestamp ⇒ ໝາຍທຸງແລ້ວເວລາຢຸດເດີນ ຢູ່ຈຸດທີ່ໝາຍ.
 */
export const holdSinceSql = (workflow: HoldWorkflow) =>
  `(select h.created_at from ods_job_hold h
     where h.workflow = '${workflow}' and h.job_code = a.code and h.resolved_at is null limit 1)`;

/** ຂໍ້ມູນທຸງເປີດຂອງງານ — ໃຫ້ໜ້າຈໍສະແດງເຫດຜົນ/ໃຜໝາຍ */
export type JobHold = {
  id: number;
  kind: string;
  reason: string;
  created_by: string;
  created_at: string;
  /** ຄ້າງມາຈັກມື້ນັບແຕ່ຖືກໝາຍ */
  held_days: number;
};

/**
 * SQL ດຶງທຸງເປີດເປັນ json ຕໍ່ແຖວ — ໃຊ້ໃນຄິວທີ່ຢາກສະແດງເຫດຜົນຢູ່ໃນຕາຕະລາງ.
 *
 * ⚠️ ຕັ້ງຊື່ຖັນມາໃຫ້ເລີຍ (`as hold`) — **`hold` ເປັນຄຳສະຫງວນຂອງ Postgres**
 * ⇒ `${holdJsonSql(w)} hold` (ບໍ່ມີ as) ຈະລົ້ມດ້ວຍ `syntax error at or near "hold"`
 * ຕອນ runtime ເທົ່ານັ້ນ (build/typecheck ຈັບບໍ່ໄດ້ ເພາະ SQL ເປັນ string).
 */
export const holdJsonSql = (workflow: HoldWorkflow) =>
  `(select json_build_object(
        'id', h.id, 'kind', h.kind, 'reason', h.reason,
        'created_by', h.created_by,
        'created_at', to_char(h.created_at,'DD-MM-YYYY HH24:MI'),
        'held_days', (current_date - h.created_at::date))
      from ods_job_hold h
     where h.workflow = '${workflow}' and h.job_code = a.code and h.resolved_at is null limit 1) as hold`;
