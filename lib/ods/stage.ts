// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
import { holdSinceSql } from "@/lib/ods/job-hold";
// ຄ່າຄົງທີ່ລ້ວນ (ບໍ່ມີ import ຈັກອັນ) ⇒ ບໍ່ດຶງ pg ເຂົ້າ client bundle — ເບິ່ງໝາຍເຫດຂ້າງລຸ່ມ
import { LINE_STATUS, TRANS } from "@/lib/ods/stock-constants";

/**
 * ສະວິດ "ໝາຍວຽກມີບັນຫາ" ເປີດຢູ່ບໍ່ — **ຖາມໃນ SQL** ບໍ່ແມ່ນ await ຢູ່ TypeScript.
 *
 * ເປັນຫຍັງ: `STAGE_ELAPSED_SQL` ເປັນ string ຄົງທີ່ ທີ່ 7 ໄຟລ໌ເອົາໄປແປະໃນ query ຂອງໃຜລາວ
 * ⇒ ຖ້າໃຫ້ມັນຮັບ argument ຕ້ອງແກ້ 7 ບ່ອນ ແລະ ມີບ່ອນລືມແນ່ນອນ. ຖາມໃນ SQL ແທນ
 * ⇒ ນິຍາມຢູ່ບ່ອນດຽວ ແລະ **ທຸກບ່ອນຖືກຕ້ອງພ້ອມກັນສະເໝີ**. ຕາຕະລາງ 1 ແຖວ ຫາດ້ວຍ PK.
 *
 * ⚠️ ຝັງ key/ຄ່າຕັ້ງຕົ້ນເປັນ literal ບໍ່ import ຈາກ lib/settings — ໄຟລ໌ນີ້ຖືກ import
 * ໂດຍ client component (STAGE_LABEL) ⇒ import settings (→ pg) ຈະພັງ build.
 * key ຕ້ອງຕົງກັບ `SETTING.JOB_HOLD` · ຄ່າຕັ້ງຕົ້ນ 'on' ຕົງກັບ `fallback:true` ໃນ lib/settings.
 */
const HOLD_ENABLED_SQL = `coalesce((select s.value from ods_setting s where s.key = 'job_hold_enabled'), 'on') <> 'off'`;

/**
 * ຂັ້ນຕອນຂອງໃບຮັບເຄື່ອງສ້ອມ (tb_product) — ຄິດຈາກຖັນເວລາໂດຍກົງ.
 *
 * ── ເປັນຫຍັງບໍ່ໃຊ້ view tracking_tb_product ──
 * view ນັ້ນຜູກ warrunty ເຂົ້າກັບ qt_* ແລະ used_spare ເຂົ້າກັບ spare_* ຢ່າງແໜ້ນ:
 * ຖ້າຂ້າມຂັ້ນໃດຂັ້ນນຶ່ງ (ກົດ "ຈົບ" ໂດຍບໍ່ໄດ້ກົດ "ເລີ່ມ"), ຫຼື ອອກໃບສະເໜີລາຄາ
 * ໃຫ້ວຽກທີ່ຍັງຮັບປະກັນ → ບໍ່ເຂົ້າກິ່ງໃດເລີຍ ໄດ້ status_real = 0
 * ແລ້ວວຽກນັ້ນ "ຫາຍ" ອອກຈາກທຸກໜ້າ. ປັດຈຸບັນມີ 5 ໃບຕິດຢູ່ແບບນັ້ນ
 * (668, 1303, 1580, 3953, 4619 — ສົ່ງຄືນລູກຄ້າໄປແລ້ວ ແຕ່ບໍ່ມີໃນລາຍງານໃດເລີຍ).
 *
 * ຕົວນີ້ເປັນ case ແບບ "ອັນທຳອິດທີ່ຖືກ ຊະນະ" ຈຶ່ງ **ບໍ່ມີທາງຕົກຫຼົ່ນ**:
 * ທຸກໃບຕ້ອງໄດ້ຂັ້ນນຶ່ງສະເໝີ (-1 ຫຼື 1..11).
 *
 * ── ທາງອອກຂອງຂັ້ນ 7 (ກຳລັງສັ່ງຊື້ອາໄຫຼ່) ──
 * ເດີມຂັ້ນ 7 ອອກໄດ້ດ້ວຍ spare_order_finish ເທົ່ານັ້ນ ແຕ່ຖັນນັ້ນເປັນ `time` (ບໍ່ມີວັນທີ)
 * ແລະ **ບໍ່ມີ code ບ່ອນໃດຂຽນມັນເລີຍ** (505 ໃບມີ spare_order, ມີແຕ່ 2 ໃບທີ່ມີ spare_order_finish)
 * ⇒ ວຽກຄ້າງຢູ່ຂັ້ນ 7 ຕະຫຼອດ (27 ໃບ, ເກົ່າສຸດ 225 ມື້) ຈົນກວ່າສາງຈະເບີກອາໄຫຼ່ໃຫ້.
 * ດຽວນີ້ ERP ຮັບເຂົ້າ → ຂຽນ spare_arrive (timestamp) → ກັບຂັ້ນ 5 ເພື່ອສ້າງ SIO
 * ແລ້ວຈຶ່ງໄປຂັ້ນ 6 (ສາງຈ່າຍ). ບໍ່ມີ SIO ກ່ອນສັ່ງຊື້ອີກ.
 * ຍັງນັບ spare_order_finish ຄືເກົ່າ ຈຶ່ງບໍ່ມີໃບເກົ່າໃບໃດປ່ຽນຂັ້ນ.
 */

/** ໃຊ້ໃນ SQL — ຕ້ອງ alias ຕາຕະລາງ tb_product ເປັນ a */
/**
 * ── ດ່ານກວດຮັບຄຸນນະພາບ (QC) — ຂັ້ນ 10 ໃໝ່ ──
 * ກຳລັງສ້ອມ → **ລໍກວດ QC** → ລໍສົ່ງຄືນ → ສົ່ງຄືນສຳເລັດ
 * ຂັ້ນ 10/11 ເກົ່າ ເລື່ອນເປັນ 11/12. ງານທີ່ QC ຍັງບໍ່ຜ່ານ ອອກໃບຮັບເງິນ/ສົ່ງຄືນບໍ່ໄດ້.
 */
export const STAGE_SQL = `case
  -- ── ຍົກເລີກ = **ທຸງ ບໍ່ແມ່ນຂັ້ນ** (17-07-2026) ─────────────────────────────
  -- ເມື່ອກ່ອນ status=6 ຢູ່ບັນທັດທຳອິດ ⇒ ງານທີ່ຍົກເລີກ **ຫຼົບອອກຈາກທຸກຄິວທັນທີ**
  -- ທັງທີ່ **ເຄື່ອງຂອງລູກຄ້າຍັງນອນຢູ່ຮ້ານ** ແລະ ຍັງຕ້ອງອອກໃບຄືນເຄື່ອງ + ເກັບຄ່າກວດ.
  -- ຂໍ້ມູນຈິງ: **570 ໜ່ວຍ** ຍົກເລີກແລ້ວແຕ່ບໍ່ເຄີຍສົ່ງຄືນ (ເກົ່າສຸດ 925 ມື້) ແລະ
  -- ງານຍົກເລີກ **ຈັກໜ່ວຍກໍ່ບໍ່ເຄີຍ**ຖືກໝາຍວ່າສົ່ງຄືນ (0 ໃບ) — ບໍ່ມີຄິວໃດເຝົ້າມັນເລີຍ.
  -- ດຽວນີ້: **ອະນຸມັດຍົກເລີກແລ້ວ + ເຄື່ອງຍັງຢູ່** ⇒ ເຂົ້າຄິວ **ລໍຖ້າສົ່ງຄືນ (11)**
  -- ຄືກັບງານທີ່ສ້ອມສຳເລັດ — ບ່ອນອອກໃບຄືນເຄື່ອງ ແລະ ເກັບຄ່າກວດ (261 ໜ່ວຍ).
  -- ⚠️ ຍັງ**ບໍ່ທັນອະນຸມັດ**ການຍົກເລີກ (cancel_finish ຫວ່າງ · 309 ໜ່ວຍ) ຍັງເປັນ -1 ຄືເກົ່າ —
  -- ມັນຢູ່ຄິວ /approvals/cancellations ຍັງບໍ່ຕົກລົງວ່າຈະຍົກເລີກ ຈຶ່ງຍັງບໍ່ຄືນເຄື່ອງ.
  -- ຄວາມເປັນ "ຍົກເລີກ" ຍັງອ່ານໄດ້ຈາກ status=6 (CANCELLED_JOBS) ⇒ ໜ້າຈໍຕິດປ້າຍໄດ້ ບໍ່ຕ້ອງເບິ່ງຂັ້ນ.
  when a.status = 6 and a.cancel_finish is not null
       and a.return_complete is null                           then 11
  when a.status = 6                                            then -1
  when a.return_complete is not null                           then 12
  when a.time_finish_repair is not null
   and a.qc_finish is not null                                 then 11
  when a.time_finish_repair is not null                        then 10
  when a.time_repair is not null                               then 9
  when coalesce(a.service_type,'') = 'PS' and a.pickup_at is null
   and a.time_check is null and a.time_finish_check is null    then 0
  -- IH ໄປສ້ອມບ້ານລູກຄ້າ: ຍັງບໍ່ນັດ/ຈັດຊ່າງ (appoint_date null) ⇒ ຂັ້ນ 0 "ລໍນັດໝາຍ/ຈັດຊ່າງໄປສ້ອມ".
  -- ໝາຍວັນນັດ (assignRepairTech) ແລ້ວ ⇒ ຕົກໄປຂັ້ນ 1 ຄືວຽກທົ່ວໄປ. ຄຸມດ້ວຍ time_check null
  -- ⇒ ໃບທີ່ເລີ່ມກວດແລ້ວບໍ່ຖືກດຶງກັບ (ຂໍ້ມູນເກົ່າ appoint_date ຫວ່າງ ຢູ່ຂັ້ນກາງບໍ່ຂະຍັບ).
  when coalesce(a.service_type,'') = 'IH' and a.appoint_date is null
   and a.time_check is null and a.time_finish_check is null    then 0
  when a.time_check is null and a.time_finish_check is null    then 1
  when a.time_finish_check is null                             then 2
  -- ງານເຄມຕ້ອງຢຸດລໍຕັດສິນຫຼັງກວດ; ບໍ່ໄຫຼເຂົ້າ "ລໍສ້ອມ" ເອງ.
  when coalesce(a.job_kind,'repair')='claim' and a.claim_decision is null then 13
  when coalesce(a.job_kind,'repair')='claim' and a.claim_decision='stock' then 14
  when coalesce(a.job_kind,'repair')='claim' and a.claim_decision='purchase' then 15
  when coalesce(a.job_kind,'repair')='claim' and a.claim_decision='supplier' then 16
  when a.warrunty = 'ໝົດຮັບປະກັນ' and a.qt_start is null
       and a.qt_finish is null                                 then 3
  when a.warrunty = 'ໝົດຮັບປະກັນ' and a.qt_finish is null      then 4
  -- ── ຄວາມຈິງຢູ່ **ແຖວເອກະສານ** ບໍ່ແມ່ນຢູ່ທຸງຂອງ tb_product (28-07-2026) ──
  -- ໃບ 5477 (ຄ້າງ 343 ມື້ — ດົນສຸດຂອງທັງລະບົບ) ສະແດງເປັນ "ກຳລັງເບີກອາໄຫຼ່" (6)
  -- ທັງທີ່ 2 ແຖວຂອງໃບຂໍເບີກຍັງເປັນ status=5 (ກຳລັງສັ່ງຊື້) ແລະ ໃບຂໍຊື້ RQ2026060619
  -- ຍັງບໍ່ມີ PO ຈັກໃບ. ເຫດຜົນ: ສາຂາຂັ້ນ 7 ຂ້າງລຸ່ມບັງຄັບ spare_arrive is null ແຕ່ໃບນີ້
  -- ມີ spare_arrive ແລ້ວ ⇒ ຫຼົ່ນລົງມາເປັນ 6. ສາງເປີດຄິວມາກໍ່ເບີກໃຫ້ບໍ່ໄດ້ (ຂອງຍັງບໍ່ມາ)
  -- ⇒ ງານຄ້າງງຽບໆ ໂດຍບໍ່ມີໃຜຮູ້ວ່າແທ້ຈິງແລ້ວມັນລໍການສັ່ງຊື້ຢູ່.
  --
  -- ⇒ ຖ້າ **ຍັງມີແຖວໃດຄ້າງຢູ່ໃບສັ່ງຊື້** ⇒ ຍັງເປັນ "ກຳລັງສັ່ງຊື້ອາໄຫຼ່" ບໍ່ວ່າທຸງຈະເປັນແນວໃດ.
  -- ວາງໄວ້ໃນສ່ວນອາໄຫຼ່ (ຫຼັງ 9/10/11/12) ⇒ ງານທີ່ລົງມືສ້ອມ/ຜ່ານ QC ແລ້ວ **ບໍ່ຖືກດຶງກັບ**
  -- ເຖິງຈະມີແຖວຄ້າງຫຼົງເຫຼືອ. ວັດແລ້ວ: ຍ້າຍ 11 ໃບ (6→7 ຫົກ · 5→7 ສີ່ · 8→7 ນຶ່ງ) ໃຊ້ 42ms.
  --
  -- ⚠️ ຄວາມຈິງຢູ່ **ແຖວເອກະສານ** ລະດັບແຖວ (03-08-2026): ວຽກສັ່ງຊື້/ເບີກຫຼາຍຮອບ
  -- (ຂໍ້ມູນຈິງ: 711 ວຽກມີ SIO ຫຼາຍຮອບ · 81 ວຽກມີ RQ ຫຼາຍຮອບ) ແຕ່ tb_product ມີ
  -- ທຸງ spare_arrive ຄືນດຽວ ⇒ ຮອບໃໝ່ຖືກທຸງຮອບເກົ່າບັງ. ດ່ານຈຶ່ງຍ້າຍມາຢູ່ແຖວ:
  -- **ຍັງມີແຖວ SIO status=5 ທີ່ arrive_at ຫວ່າງ** (ຍັງບໍ່ຮັບເຂົ້າສາງ) ⇒ ຂັ້ນ 7.
  -- syncErpPurchase ສະແຕມ arrive_at ໃຫ້ແຕ່ລະແຖວຈາກໃບຮັບເຂົ້າ PUIT ຂອງ ERP
  -- (ທຽບ item_code ຄົບທຸກລາຍການ, ບໍ່ມີປຸ່ມກົດມືອີກ). ຖືກສະແຕມໝົດແລ້ວວຽກປ່ອຍມື:
  -- ມີໃບຂໍເບີກ ⇒ ຂັ້ນ 6 (ກຳລັງເບີກອາໄຫຼ່ — ສາງເບີກ ແລ້ວຊ່າງກົດຮັບ) · ບໍ່ມີ ⇒ ຂັ້ນ 5.
  when coalesce(a.used_spare,0) = 1
   and exists (select 1 from ic_trans_detail d
                where d.product_code = a.code
                  and d.trans_flag = ${TRANS.REQUEST}
                  and d.status = ${LINE_STATUS.ON_PURCHASE_ORDER}
                  and d.arrive_at is null)                         then 7
  -- ຖ້າ stock ບໍ່ພໍ: ສັ່ງຊື້/ຮັບເຂົ້າກ່ອນ SIO. ກວດ stage 7 ກ່ອນ stage 5
  -- ເພາະໃນ workflow ໃໝ່ spare_reg ຍັງເປັນ null ຕະຫຼອດຊ່ວງສັ່ງຊື້.
  when coalesce(a.used_spare,0) = 1 and a.spare_order is not null
       and a.spare_order_finish is null
       and a.spare_arrive is null                              then 7
  -- ຂັ້ນ 5 = ຍັງບໍ່ມີໃບຂໍເບີກ. ໃບເກົ່າບາງໃບມີແຖວ SIO ແລ້ວແຕ່ spare_reg ຫວ່າງ
  -- (ໂຄ້ດເກົ່າບໍ່ໄດ້ຕັ້ງ) ⇒ ຖືວ່າມີໃບຂໍເບີກແລ້ວ ໃຫ້ຕົກໄປຂັ້ນ 6 ຄືກັນ.
  when coalesce(a.used_spare,0) = 1 and a.spare_reg is null
   and not exists (select 1 from ic_trans_detail d
                    where d.product_code = a.code
                      and d.trans_flag = ${TRANS.REQUEST}
                      and coalesce(d.status,0) in (${LINE_STATUS.PENDING}, ${LINE_STATUS.ON_PURCHASE_ORDER})) then 5
  when coalesce(a.used_spare,0) = 1 and a.spare_finish is null then 6
  else 8
end`;

export const STAGE_LABEL: Record<number, string> = {
  [-1]: "ຍົກເລີກ",
  0: "ລໍໄປຮັບເຄື່ອງ",
  1: "ລໍຖ້າກວດເຊັກ",
  2: "ກຳລັງກວດເຊັກ",
  3: "ລໍຖ້າສະເໜີລາຄາ",
  4: "ກຳລັງສະເໜີລາຄາ",
  5: "ກວດ Stock / ດຳເນີນອາໄຫຼ່",
  6: "ກຳລັງເບີກອາໄຫຼ່",
  7: "ກຳລັງສັ່ງຊື້ອາໄຫຼ່",
  8: "ລໍຖ້າສ້ອມແປງ",
  9: "ກຳລັງສ້ອມແປງ",
  10: "ລໍກວດຮັບຄຸນນະພາບ",
  11: "ລໍຖ້າສົ່ງຄືນ",  // ລວມງານທີ່ຍົກເລີກແຕ່ເຄື່ອງຍັງຢູ່ຮ້ານ — ເບິ່ງໝາຍເຫດຢູ່ STAGE_SQL
  12: "ສົ່ງຄືນສຳເລັດ",
  13: "ລໍຕັດສິນຜົນເຄມ",
  14: "ລໍປ່ຽນຈາກ Stock",
  15: "ລໍສິນຄ້າ/ອາໄຫຼ່ຈາກການສັ່ງຊື້",
  16: "ລໍຜົນ/ສິນຄ້າຈາກ Supplier",
};

/**
 * ຊື່ຂັ້ນ ໃນຮູບ SQL — **ສ້າງຈາກ STAGE_LABEL ບ່ອນດຽວ**.
 * ແຕ່ກ່ອນ 3 ໄຟລ໌ຂຽນ `case … when 10 then 'ລໍຖ້າສົ່ງຄືນ' …` ຊ້ຳກັນເອງ
 * ⇒ ພໍເພີ່ມຂັ້ນ QC ເລກເລື່ອນໝົດ ແລະ ລາຍງານຈະສະແດງຊື່ຂັ້ນຜິດຢ່າງງຽບໆ.
 */
/**
 * ຂັ້ນທີ່ **IH (ໄປສ້ອມບ້ານລູກຄ້າ)** ມີຄຳຕ່າງຈາກທົ່ວໄປ — ເຄື່ອງຢູ່ບ້ານລູກຄ້າ ບໍ່ໄດ້ຢູ່ສູນ:
 *   0  ລໍນັດໝາຍ/ຈັດຊ່າງໄປສ້ອມ (ບໍ່ແມ່ນ "ລໍໄປຮັບເຄື່ອງ" ຂອງ PS)
 *   11 ລໍປິດງານ · 12 ຈົບງານ (ບໍ່ແມ່ນ "ສົ່ງຄືນ" — ບໍ່ມີເຄື່ອງໃຫ້ສົ່ງຄືນ)
 * **ບ່ອນດຽວ** ໃຊ້ທັງ SQL (STAGE_LABEL_SQL) ແລະ JS (stageLabel) ⇒ ບໍ່ຫຼົງກັນ.
 */
export const IH_STAGE_LABEL: Record<number, string> = {
  0: "ລໍນັດໝາຍ/ຈັດຊ່າງໄປສ້ອມ",
  11: "ລໍປິດງານ",
  12: "ຈົບງານ (ໜ້າງານ)",
};

/**
 * ຊື່ຂັ້ນ **ຮັບຮູ້ປະເພດບໍລິການ** — IH ຕ່າງຢູ່ຂັ້ນ 0/11/12. ໃຊ້ບ່ອນທີ່ມີ service_type
 * (ໜ້າລາຍລະອຽດ, ລາຍການ). ບ່ອນທີ່ບໍ່ມີ (ຫົວຄໍລຳ board, ຫົວລາຍງານລວມທຸກປະເພດ) ໃຊ້ STAGE_LABEL ຊື່ໆ.
 */
export function stageLabel(stage: number | null | undefined, serviceType?: string | null): string {
  if (stage == null) return "-";
  if (serviceType === "IH" && stage in IH_STAGE_LABEL) return IH_STAGE_LABEL[stage];
  return STAGE_LABEL[stage] ?? "-";
}

// ປ້າຍ SQL ແຍກຕາມ service_type (ບ່ອນອື່ນ — ເມນູ/ຫົວໜ້າຄິວ — ເອົາຈາກ repairStatuses).
export const STAGE_LABEL_SQL = `case
${Object.entries(IH_STAGE_LABEL)
  .map(([stage, label]) => `  when (${STAGE_SQL}) = ${stage} and coalesce(a.service_type,'') = 'IH' then '${label}'`)
  .join("\n")}
${Object.entries(STAGE_LABEL).map(([stage, label]) => `  when (${STAGE_SQL}) = ${stage} then '${label}'`).join("\n")}
  else '-' end`;

/**
 * ── ນິຍາມ "ວຽກຄ້າງ" (17-07-2026) ──
 * **ຄ້າງ = ທຸກໃບ ຍົກເວັ້ນສົ່ງຄືນສຳເລັດ.** ບໍ່ໄດ້ຕັດໃບຍົກເລີກອອກອີກຕໍ່ໄປ.
 *
 * ແຕ່ກ່ອນ `status <> 6` ຕັດໃບຍົກເລີກອອກໝົດ ⇒ ເຄື່ອງທີ່ຍົກເລີກແລ້ວ **ແຕ່ຍັງຢູ່ຮ້ານ**
 * ຫາຍອອກຈາກທຸກຕົວເລກ ທັງທີ່ຍັງເປັນວຽກ: ຍັງຕ້ອງອອກໃບຄືນເຄື່ອງ ແລະ ເກັບເງິນ.
 * ງານຈົບເມື່ອ**ເຄື່ອງອອກຈາກຮ້ານ** ບໍ່ແມ່ນເມື່ອກົດຍົກເລີກ.
 *
 * ⚠️ ຕອນປ່ຽນນິຍາມ ມີໃບຍົກເລີກເກົ່າ 570 ໃບທີ່ບໍ່ເຄີຍຖືກໝາຍຄືນ (ເກົ່າສຸດ 1,397 ມື້)
 * ຖືກປິດດ້ວຍ migrations/2026-07-17-close-cancelled-returns.sql (ໃສ່ວັນທີ່ຍົກເລີກຈິງ)
 * ບໍ່ດັ່ງນັ້ນວຽກຄ້າງຈະເດັ້ງຈາກ 103 ເປັນ 673 ໃບໃນວັນດຽວ ໂດຍບໍ່ມີວຽກເພີ່ມແທ້ໆ.
 *
 * 3 ກຸ່ມນີ້ **ບໍ່ຕັດກັນພໍດີອີກຕໍ່ໄປ**: ໃບຍົກເລີກທີ່ຍັງບໍ່ຄືນ ຢູ່ທັງ OPEN_JOBS ແລະ
 * CANCELLED_JOBS (ຕັ້ງໃຈ — ມັນຄ້າງຢູ່ ແລະ ມັນຖືກຍົກເລີກ ພ້ອມກັນ).
 */
export const OPEN_JOBS = "a.return_complete is null";
export const DONE_JOBS = "a.return_complete is not null";
export const CANCELLED_JOBS = "a.status = 6";

/**
 * ── ແຍກ **ງານເຄມ** ອອກຈາກ **ງານສ້ອມປົກກະຕິ** (31-07-2026) ──
 * ເຄມນອນຢູ່ tb_product ຄືກັນ (ຕ້ອງມີບ່ອນເກັບຮູບ · ຊ່າງ · ຜົນກວດ · ອາໄຫຼ່) ແຕ່
 * **ບໍ່ແມ່ນວຽກສ້ອມ** ⇒ ຄິວສ້ອມ · ລາຍງານສ້ອມ · KPI · ຄ່າຄອມ ຕ້ອງບໍ່ນັບມັນ
 * ແລະ ເຄມມີຄິວ/ລາຍງານຂອງຕົນເອງ (dashboard-status.claimStatuses · ເມນູກຸ່ມ "ເຄມ").
 * ໃຊ້ alias `a`.
 */
export const NOT_CLAIM = "coalesce(a.job_kind,'repair') <> 'claim'";
export const IS_CLAIM = "coalesce(a.job_kind,'repair') = 'claim'";

/**
 * ຕັດເຄື່ອງທີ່ໝາຍ "ນັບບໍ່ພົບ (ຫາຍ)" ຕອນກວດນັບ (ods_stock_count.found=false) ອອກຈາກຄິວ pending
 * — pending ເຫຼືອສະເພາະ job ທີ່ຍັງນັບໄດ້. ຍ້ອນຄືນໄດ້ (ລຶບ mark → ກັບເຂົ້າຄິວ). ໃຊ້ alias `a`.
 */
export const NOT_MISSING = "a.code not in (select job_code from ods_stock_count where found = false)";

/**
 * ຕັດ **ໃບຮ້ອງຂໍຍົກເລີກ ທີ່ຍັງບໍ່ອະນຸມັດ** (STAGE_SQL = -1: status=6 ແຕ່ cancel_finish ຫວ່າງ)
 * ອອກຈາກ "ວຽກສ້ອມຄ້າງ". ໃບກຸ່ມນີ້ຢູ່ຄິວ /approvals/cancellations ລໍຕົກລົງວ່າຈະຍົກເລີກ
 * ຫຼືບໍ່ — ຍັງບໍ່ແມ່ນວຽກສ້ອມ. ມັນຕົກເປັນ stage -1 ເຊິ່ງ **ບໍ່ມີ bucket ໃນ pipeline** ⇒ ຖ້າ
 * ນັບເຂົ້າ total ຈະໄດ້ total > ຜົນບວກຂັ້ນ (0–11). ຕັດອອກ ⇒ total = ຜົນບວກຂັ້ນ ພໍດີ.
 * (ໃບຍົກເລີກ-ອະນຸມັດ-ເຄື່ອງຍັງຢູ່ = cancel_finish ບໍ່ຫວ່າງ → stage 11 ຍັງຄ້າງຢູ່ ຄືເກົ່າ.)
 */
export const NOT_PENDING_CANCEL = "not (a.status = 6 and a.cancel_finish is null)";

/**
 * ເວລາທີ່ **ເຂົ້າຂັ້ນປັດຈຸບັນ** — ຄູ່ກັບ INSTALL_STAGE_TIME_COL ຂອງຝັ່ງຕິດຕັ້ງ.
 *
 * ຝັ່ງຕິດຕັ້ງມີອັນນີ້ມາແຕ່ຕົ້ນ ແຕ່ຝັ່ງສ້ອມບໍ່ມີ ⇒ ວັດ "ຄ້າງຢູ່ຂັ້ນນີ້ດົນປານໃດ" ບໍ່ໄດ້
 * ໄດ້ແຕ່ວັດ "ເປີດງານມາດົນປານໃດ" ເຊິ່ງບອກຄໍຂວດບໍ່ໄດ້: ວຽກທີ່ເປີດມາ 300 ມື້ ອາດຫາກໍ່
 * ຍ້າຍມາຂັ້ນນີ້ມື້ວານກໍ່ໄດ້. ແຕ່ລະຂັ້ນນັບຈາກເວລາທີ່ຂັ້ນກ່ອນໜ້າຈົບ.
 *
 * ຂັ້ນ 3/4 (ສະເໜີລາຄາ) ແລະ 5/8: ຖ້າຖັນທີ່ຄວນມີເປັນ null (ຂໍ້ມູນເກົ່າຂອງ ods)
 * ໃຫ້ຖອຍໄປໃຊ້ຖັນກ່ອນໜ້າ ດ້ວຍ coalesce — ບໍ່ດັ່ງນັ້ນຈະໄດ້ null ແລ້ວແຖວນັ້ນຫາຍຈາກການນັບ.
 */
export const STAGE_TIME_COL = `case (${STAGE_SQL})
  when 16 then coalesce(a.claim_decided_at, a.time_finish_check)
  when 15 then coalesce(a.claim_decided_at, a.time_finish_check)
  when 14 then coalesce(a.claim_decided_at, a.time_finish_check)
  when 13 then a.time_finish_check
  when 12 then a.return_complete
  -- ຂັ້ນ 11 ມີ 2 ທາງເຂົ້າ: ສ້ອມສຳເລັດຜ່ານ QC (qc_finish) · ຫຼື ຍົກເລີກແລ້ວເຄື່ອງຍັງຢູ່
  -- (qc_finish = null, ໃຫ້ນັບແຕ່ວັນອະນຸມັດຍົກເລີກ) — ບໍ່ດັ່ງນັ້ນ elapsed = NULL ອາຍຸ blank
  when 11 then coalesce(a.qc_finish, a.cancel_finish, a.cancel_start)
  when 10 then a.time_finish_repair
  when 9  then a.time_repair
  when 8  then coalesce(a.spare_finish, a.qt_finish, a.time_finish_check)
  when 7  then a.spare_order
  when 6  then coalesce(a.spare_arrive, a.spare_reg)
  when 5  then coalesce(a.spare_arrive, a.qt_finish, a.time_finish_check)
  when 4  then coalesce(a.qt_start, a.time_finish_check)
  when 3  then a.time_finish_check
  when 2  then a.time_check
  when -1 then coalesce(a.cancel_start, a.time_register)
  else a.time_register
end`;

/**
 * ວິນາທີທີ່ຄ້າງຢູ່ຂັ້ນປັດຈຸບັນ (ບໍ່ແມ່ນ "ຕັ້ງແຕ່ເປີດງານ").
 *
 * ── ນາລິກາ **ຢຸດ** ຕອນວຽກຖືກໝາຍວ່າ "ມີບັນຫາ" (17-07-2026) ──
 * ນັບເຖິງ `coalesce(ເວລາທີ່ໝາຍທຸງ, ດຽວນີ້)` ⇒ ໝາຍທຸງແລ້ວເວລາຢຸດຢູ່ຈຸດນັ້ນ,
 * ປົດທຸງແລ້ວເດີນຕໍ່. ເປັນຫຍັງ: ວຽກທີ່ລໍອາໄຫຼ່ນອກ 300 ມື້ ບໍ່ແມ່ນຄວາມຊັກຊ້າຂອງຄົນ
 * ⇒ ປ່ອຍໃຫ້ນາລິກາເດີນ ຕົວເລກ SLA/ຄໍຂວດຈະຖືກມັນກົບໄວ້ຈົນອ່ານບໍ່ອອກ.
 * ⚠️ ຢຸດ**ນາລິກາ**ເທົ່ານັ້ນ — ວຽກຍັງຢູ່ຂັ້ນເດີມ ແລະ ຍັງນັບເປັນວຽກຄ້າງ (OPEN_JOBS)
 * ບໍ່ດັ່ງນັ້ນຈະກາຍເປັນ "ຫຼົບອອກຈາກຄິວ" ຄືບັກຂອງໃບຍົກເລີກ.
 * ຖ້າທຸງເກົ່າກວ່າເວລາເຂົ້າຂັ້ນ (ໝາຍໄວ້ຕັ້ງແຕ່ຂັ້ນກ່ອນ) ຈະໄດ້ຄ່າລົບ → greatest(0,…) = 0.
 *
 * ⚙️ ຜູ້ຈັດການ**ປິດສະວິດ**ໄດ້ (/manage/settings) ⇒ ນາລິກາເດີນປົກກະຕິທຸກວຽກ
 * ເຖິງວ່າຈະມີທຸງເກົ່າຄ້າງຢູ່ (ທຸງບໍ່ຖືກລຶບ — ເປີດຄືນແລ້ວໄດ້ຄືເກົ່າ).
 */
export const STAGE_ELAPSED_SQL = `greatest(0, round(extract(epoch from (
  coalesce(case when ${HOLD_ENABLED_SQL} then ${holdSinceSql("repair")} end, localtimestamp) - (${STAGE_TIME_COL})
))))::int`;
