// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
import { installStageIs } from "@/lib/ods/install-stage";
import { heldSql } from "@/lib/ods/job-hold";
import { inTransferSql } from "@/lib/ods/repair-center";
import { IS_CLAIM, NOT_CLAIM, STAGE_SQL } from "@/lib/ods/stage";

/**
 * ຂັ້ນຂອງວຽກ ສຳລັບໜ້າລວມ ແລະ ໜ້າລາຍລະອຽດ /work/<workflow>/<slug>.
 *
 * ທັງສອງໜ້າອ່ານຈາກໄຟລ໌ນີ້ບ່ອນດຽວ ⇒ ຕົວເລກຢູ່ໜ້າລວມ ກັບ ຈຳນວນແຖວຢູ່ໜ້າລາຍລະອຽດ
 * ບໍ່ມີທາງບໍ່ຕົງກັນ.
 */

/**
 * ເງື່ອນໄຂ "ຢູ່ຂັ້ນນີ້" ຂອງ tb_product (alias a).
 * ⚠️ `stageIs` = **ງານສ້ອມປົກກະຕິ** (ຕັດເຄມອອກ) · `claimStageIs` = ງານເຄມ
 * ⇒ ຄິວສອງຝັ່ງບໍ່ປົນກັນ ແລະ ຍອດບໍ່ນັບຊ້ຳ (ເບິ່ງ NOT_CLAIM ຢູ່ lib/stage).
 */
const stageIs = (stage: number) => `(${STAGE_SQL}) = ${stage} and ${NOT_CLAIM}`;
const claimStageIs = (stage: number) => `(${STAGE_SQL}) = ${stage} and ${IS_CLAIM}`;

export type StatusDef = {
  label: string;
  condition: string;
  /**
   * ຂັ້ນຂອງຂັ້ນໄດ — ຂັ້ນລ້ວນໆຈະ "ບໍ່ຫຼົ້ນກັນ" ແລະ ລວມກັນໄດ້ຍອດທັງໝົດພໍດີ
   * ຈຶ່ງເອົາມາເຮັດແຖບ pipeline ໄດ້. ບໍ່ມີ stage = ຄິວທີ່ **ຕັດຂວາງຂັ້ນ** (overlay)
   * — ນັບຊ້ຳກັບຂັ້ນອື່ນ ຈຶ່ງຫ້າມເອົາໄປລວມຍອດ.
   */
  stage?: number;
  /** ລຳດັບສະແດງ; ໃຊ້ໃຫ້ສາຂາເຄມຢູ່ຕໍ່ຈາກຂັ້ນກວດເຊັກ. */
  order?: number;
};

export const repairStatuses: Record<string, StatusDef> = {
  /**
   * PS: ໄປຮັບເຄື່ອງບ້ານລູກຄ້າມາສ້ອມຢູ່ສູນ — ສອງ**ຂັ້ນຍ່ອຍ**ຂອງ STAGE 0 (ຍັງບໍ່ຮັບເຂົ້າສູນ).
   * ແບ່ງດ້ວຍ pickup_start (ເວລາ "ອອກໄປຮັບ") — ບໍ່ຫຼົ້ນກັນ ແລະ ລວມກັນ = ຂັ້ນ 0 ທັງໝົດ
   * ⇒ ຍັງໃສ່ stage:0 ໄດ້ທັງຄູ່ໂດຍບໍ່ທຳລາຍຍອດ pipeline (countsSql ນັບແຕ່ລະ condition ແຍກ).
   *   ລໍໄປຮັບເຄື່ອງ = ຄິວ, ຍັງບໍ່ອອກ · ກຳລັງໄປຮັບ = ຂົນສົ່ງເດີນທາງແລ້ວ. CS ກົດ "ຮັບເຂົ້າສູນ".
   */
  "wait-pickup": {
    label: "ລໍໄປຮັບເຄື່ອງ (PS)",
    condition: `${stageIs(0)} and coalesce(a.service_type,'') = 'PS' and a.pickup_start is null`,
    stage: 0,
  },
  "picking-up": {
    label: "ກຳລັງໄປຮັບ (PS)",
    condition: `${stageIs(0)} and coalesce(a.service_type,'') = 'PS' and a.pickup_start is not null`,
    stage: 0,
  },
  /**
   * IH: ໄປສ້ອມບ້ານລູກຄ້າ — ຂັ້ນ 0 "ລໍນັດໝາຍ/ຈັດຊ່າງໄປສ້ອມ" (ຍັງບໍ່ຕັ້ງວັນນັດ).
   * CS/ຝ່າຍບໍລິການ ກົດ "ນັດ+ຈັດຊ່າງ" (ຕັ້ງ appoint_date + ຊ່າງ) ⇒ ວຽກຂຶ້ນຂັ້ນ 1.
   * ຂັ້ນ 0 ແບ່ງຕາມ service_type: PS (2 ຄິວເທິງ) + IH (ອັນນີ້) ບໍ່ຫຼົ້ນກັນ, ລວມ = ຂັ້ນ 0.
   */
  "wait-schedule": {
    label: "ລໍນັດໝາຍ/ຈັດຊ່າງໄປສ້ອມ (IH)",
    condition: `${stageIs(0)} and coalesce(a.service_type,'') = 'IH'`,
    stage: 0,
  },
  "wait-check": { label: "ຮັບງານ / ລໍຖ້າກວດເຊັກ", condition: stageIs(1), stage: 1 },
  checking: { label: "ກຳລັງກວດເຊັກ", condition: stageIs(2), stage: 2 },
  "wait-quote": { label: "ລໍຖ້າສະເໜີລາຄາ", condition: stageIs(3), stage: 3 },
  quoting: { label: "ກຳລັງສະເໜີລາຄາ", condition: stageIs(4), stage: 4 },
  "wait-withdraw": { label: "ກວດ Stock / ຊື້ ຫຼື ຂໍເບີກ", condition: stageIs(5), stage: 5 },
  withdrawing: { label: "ກຳລັງເບີກອາໄຫຼ່", condition: stageIs(6), stage: 6 },
  purchasing: { label: "ກຳລັງສັ່ງຊື້", condition: stageIs(7), stage: 7 },
  "wait-repair": { label: "ລໍຖ້າສ້ອມ", condition: stageIs(8), stage: 8 },
  repairing: { label: "ກຳລັງສ້ອມ", condition: stageIs(9), stage: 9 },
  // ດ່ານກວດຮັບຄຸນນະພາບ — ຂັ້ນໃໝ່ (ສ້ອມສຳເລັດແລ້ວ ແຕ່ຍັງບໍ່ຜ່ານ QC)
  "wait-qc": { label: "ລໍກວດຮັບຄຸນນະພາບ", condition: stageIs(10), stage: 10 },
  "wait-return": { label: "ລໍຖ້າສົ່ງຄືນ / ປິດງານ (IH)", condition: stageIs(11), stage: 11 },

  /**
   * ⚠️ ຄິວ **ຕັດຂວາງຂັ້ນ** — ຊ່າງຖືກຈັດແລ້ວ ແຕ່ຍັງບໍ່ກົດຮັບງານ (repair_confirm ຫວ່າງ).
   * ນັບຊ້ຳກັບຂັ້ນ 1+ (ວຽກຍັງນອນຢູ່ຂັ້ນຂອງມັນ) ຈຶ່ງ **ບໍ່ມີ `stage`** ຫ້າມລວມຍອດ pipeline
   * — ຄືກັບ wait-accept ຝັ່ງຕິດຕັ້ງ. ເງື່ອນໄຂຄືກັນກັບ notAccepted ຂອງ /repair/assign.
   */
  "wait-accept": {
    label: "ລໍຖ້າຊ່າງຮັບ",
    condition: `${stageIs(1)} and coalesce(a.emp_code,'') <> '' and a.repair_confirm is null`,
  },
  /**
   * ພັກຊົ່ວຄາວ — ງານທີ່ຖືກໝາຍ "ວຽກມີບັນຫາ" (ods_job_hold, ມີເຫດຜົນ+ປະເພດ) ⇒ ຄາຢູ່
   * ຂັ້ນຈິງແຕ່ຢຸດນາລິກາ. **ຕັດຂວາງຂັ້ນ (ບໍ່ມີ stage)** ⇒ ນັບຊ້ຳກັບຂັ້ນຂອງມັນ ຈຶ່ງ
   * ຫ້າມລວມຍອດ pipeline. ເປີດ/ປິດຄວາມສາມາດທີ່ ການຕັ້ງຄ່າ (SETTING.JOB_HOLD).
   */
  paused: { label: "ພັກຊົ່ວຄາວ", condition: heldSql("repair") },
  /**
   * ໂອນໄປສ້ອມສູນອື່ນ — ເຄື່ອງກຳລັງສົ່ງໄປ/ຢູ່ສູນອື່ນ (ods_job_transfer received_at null).
   * ຕັດຂວາງຂັ້ນ (ບໍ່ມີ stage) ⇒ ບໍ່ລວມຍອດ pipeline. ສູນປາຍທາງກົດ "ຮັບເຂົ້າ" ຈຶ່ງປິດ.
   */
  transferring: { label: "ໂອນໄປສ້ອມສູນອື່ນ (ລໍຮັບ)", condition: inTransferSql },
  /**
   * **ລໍຖ້າອະນຸມັດປ່ຽນປະກັນ** (07-08-2026) — ຊ່າງກວດແລ້ວຂໍປ່ຽນເປັນ "ໝົດຮັບປະກັນ"
   * (= ລູກຄ້າຕ້ອງຈ່າຍ) ⇒ ຕ້ອງໃຫ້ຜູ້ຈັດການຕັດສິນກ່ອນ (ເບິ່ງ lib/warranty-request).
   *
   * ເມື່ອກ່ອນລະຫວ່າງລໍ ໃບ**ຄາຢູ່ຂັ້ນເດີມແບບງຽບໆ** — ຮູ້ກໍ່ຕໍ່ເມື່ອມີຄົນໄປກົດອອກໃບ
   * ສະເໜີລາຄາ/ສົ່ງຄືນ ແລ້ວຖືກ `warrantyBlock` ປະຕິເສດ ⇒ ບໍ່ມີໃຜທວງຜູ້ອະນຸມັດ.
   * ດຽວນີ້ມີຄິວຂອງຕົນເອງ. **ຕັດຂວາງຂັ້ນ (ບໍ່ມີ `stage`)** ⇒ ບໍ່ລວມຍອດ pipeline
   * ຄືກັບ paused/transferring — ໃບຍັງນອນຢູ່ຂັ້ນຈິງຂອງມັນ (ສ່ວນຫຼາຍຂັ້ນ 2 ກຳລັງກວດ).
   * ອະນຸມັດແລ້ວ ⇒ `warrunty` ຖືກຂຽນ ⇒ ໃບໄຫຼໄປຕາມເງື່ອນໄຂປະກັນເອງ (STAGE_SQL).
   */
  "warranty-approval": {
    label: "ລໍຖ້າອະນຸມັດປ່ຽນປະກັນ",
    condition: `exists (select 1 from ods_warranty_request w
                         where w.job_code = a.code and w.state = 'pending')`,
  },
  // ບໍ່ມີ "ຂໍ້ມູນຜິດປົກກະຕິ" ອີກຕໍ່ໄປ — STAGE_SQL ໃຫ້ຂັ້ນທຸກໃບສະເໝີ ຈຶ່ງຕົກຫຼົ່ນບໍ່ໄດ້
};

/**
 * ── ຄິວຂອງ **ງານເຄມ** (ແຍກອອກຈາກສ້ອມ 31-07-2026) ──
 *
 * ເຄມເດີນ: ຮັບຈາກຮ້ານ → ຊ່າງກວດ → **ຕັດສິນ** (ສ້ອມ ຫຼື ປ່ຽນ: stock/ສັ່ງຊື້/supplier)
 * → ຄືນຮ້ານ. ຂັ້ນ 13-16 ຂອງ STAGE_SQL ຄືສາຂາເຄມທີ່ບໍ່ໄຫຼເຂົ້າ "ລໍສ້ອມ" ຂອງງານທົ່ວໄປ.
 *
 * ⚠️ ຂັ້ນ 1/2/11 ໃຊ້ເລກດຽວກັບສ້ອມ ແຕ່ **ກອງດ້ວຍ IS_CLAIM** ⇒ ໃບດຽວກັນຈະຢູ່ຝັ່ງດຽວ
 * ບໍ່ມີທາງນັບຊ້ຳ. ໜ້າ /work/repair/<slug> ໃຊ້ໄດ້ຄືເກົ່າ (ຄີຢູ່ຊຸດດຽວກັນ)
 * ພຽງແຕ່ **ເມນູ** ຢູ່ຄົນລະກຸ່ມ (lib/navigation).
 */
export const claimStatuses: Record<string, StatusDef> = {
  "claim-wait-check": { label: "ຮັບຈາກຮ້ານ / ລໍຖ້າກວດ", condition: claimStageIs(1), stage: 1 },
  "claim-checking": { label: "ກຳລັງກວດເຄມ", condition: claimStageIs(2), stage: 2 },
  "claim-decision": { label: "ລໍຕັດສິນຜົນເຄມ", condition: claimStageIs(13), stage: 13 },
  "claim-stock": { label: "ລໍປ່ຽນຈາກ Stock", condition: claimStageIs(14), stage: 14 },
  "claim-purchase": { label: "ລໍຂອງຈາກການສັ່ງຊື້", condition: claimStageIs(15), stage: 15 },
  "claim-supplier": { label: "ລໍຜົນ/ຂອງຈາກ Supplier", condition: claimStageIs(16), stage: 16 },
  "claim-return": { label: "ລໍສົ່ງຄືນຮ້ານ", condition: claimStageIs(11), stage: 11 },
};

/**
 * ຂັ້ນຂອງງານຕິດຕັ້ງ — ດຽວນີ້ອີງ **INSTALL_STAGE_SQL** (lib/install-stage) ບ່ອນດຽວ.
 *
 * ແຕ່ກ່ອນໄຟລ໌ນີ້ຂຽນເງື່ອນໄຂເອງດ້ວຍມື (a.tech_code is null, a.reg_start is null …)
 * ⇒ ເປັນການ "ຄິດຂັ້ນສອງບ່ອນ" ເຊິ່ງຂັ້ນໄດຈິງເຕືອນໄວ້ວ່າຢ່າເຮັດ: ເງື່ອນໄຂເກົ່າເຊື່ອທຸງ
 * used_spare ຢ່າງດຽວ ໃນຂະນະທີ່ຂັ້ນໄດຈິງບໍ່ເຊື່ອທຸງນັ້ນຖ້າມີຮ່ອງຮອຍການເບີກຢູ່ໃນແຖວແລ້ວ
 * (ມີງານຈິງທີ່ used_spare=0 ແຕ່ມີໃບຂໍເບີກ/ໃບເບີກ) ⇒ ຕົວເລກໜ້າລວມ ກັບ ໜ້າ /installations
 * ຫຼົ້ນກັນໄດ້. ດຽວນີ້ໃຊ້ນິຍາມອັນດຽວກັນທັງລະບົບ.
 */
export const installStatuses: Record<string, StatusDef> = {
  "wait-assign": { label: "ເປີດງານ / ລໍຖ້າຈັດຊ່າງ", condition: installStageIs(0), stage: 0 },
  "wait-accept": { label: "ລໍຖ້າຊ່າງຮັບ", condition: installStageIs(1), stage: 1 },
  "wait-register": { label: "ລໍຖ້າເບີກອາໄຫຼ່", condition: installStageIs(2), stage: 2 },
  "wait-pick": { label: "ລໍຖ້າຮັບອາໄຫຼ່ຈາກການເບີກ", condition: installStageIs(3), stage: 3 },
  "wait-install": { label: "ລໍຖ້າຕິດຕັ້ງ", condition: installStageIs(4), stage: 4 },
  installing: { label: "ກຳລັງຕິດຕັ້ງ", condition: installStageIs(5), stage: 5 },
  "wait-qc": { label: "ລໍຖ້າກວດ QC", condition: installStageIs(6), stage: 6 },
  "wait-feedback": { label: "ລໍຖ້າລູກຄ້າປະເມີນ", condition: installStageIs(7), stage: 7 },
  "wait-close": { label: "ລໍຖ້າປິດງານ", condition: installStageIs(8), stage: 8 },

  // URL ເກົ່າຍັງເປີດໄດ້ ແຕ່ບໍ່ສະແດງເປັນຄິວເພີ່ມໃນ pipeline.
  "wait-dispatch": { label: "ລໍຖ້າຮັບອາໄຫຼ່ຈາກການເບີກ", condition: installStageIs(3) },
};

/** ສະເພາະຂັ້ນລ້ວນໆ (ບໍ່ຫຼົ້ນກັນ) — ໃຊ້ເຮັດແຖບ pipeline ແລະ ລວມຍອດ */
export const pipelineOf = (statuses: Record<string, StatusDef>) =>
  Object.entries(statuses)
    .filter(([, def]) => def.stage != null)
    .sort((a, b) => (a[1].order ?? a[1].stage ?? 0) - (b[1].order ?? b[1].stage ?? 0));
