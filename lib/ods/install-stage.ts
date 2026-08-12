// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
/**
 * 9 ຄິວຫຼັກຂອງງານຕິດຕັ້ງ — ຄິດຈາກ timestamp ຂອງ ods_tb_install.
 * ຕ້ອງ alias ຕາຕະລາງເປັນ `a` ເມື່ອນຳ SQL ນີ້ໄປໃຊ້.
 *
 * 0 ເປີດງານ/ຈັດຊ່າງ → 1 ຊ່າງຮັບ → 2 ເບີກອາໄຫຼ່ → 3 ຮັບອາໄຫຼ່
 * → 4 ລໍຕິດຕັ້ງ → 5 ກຳລັງຕິດຕັ້ງ → 6 QC → 7 ລູກຄ້າປະເມີນ → 8 ປິດງານ.
 * ຂັ້ນ 9 ເປັນປະຫວັດປິດແລ້ວ ແລະ -1 ເປັນງານຍົກເລີກ; ບໍ່ແມ່ນຄິວເປີດ.
 * ງານບໍ່ໃຊ້ອາໄຫຼ່ຂ້າມ 2-3 ໄປ 4 ຫຼັງຊ່າງຮັບ.
 */
/** ມີຫຼັກຖານວ່າລູກຄ້າປະເມີນແລ້ວ — ຮອງຮັບຂໍ້ມູນເກົ່າທີ່ມີຄະແນນແຕ່ຂາດ complain_finish. */
export const INSTALL_FEEDBACK_DONE_SQL = `(a.complain_finish is not null
  or exists (
    select 1 from cust_complain feedback
    where feedback.product_code = a.code and feedback.topic_code = '002'
  ))`;

/** timestamp ປະເມີນ; fallback ຫາເວລາຄຳຕອບລ່າສຸດຂອງຂໍ້ມູນເກົ່າ. */
export const INSTALL_FEEDBACK_TIME_SQL = `coalesce(
  a.complain_finish,
  (select max(feedback.create_date_time_now) from cust_complain feedback
   where feedback.product_code = a.code and feedback.topic_code = '002')
)`;

export const INSTALL_STAGE_SQL = `case
  when a.cancel_date is not null                     then -1
  when a.job_finish is not null                      then 9
  when a.finish_install is not null
   and a.qc_finish is not null
   and ${INSTALL_FEEDBACK_DONE_SQL}                  then 8
  when a.finish_install is not null
   and a.qc_finish is not null                       then 7
  when a.finish_install is not null                  then 6
  when a.start_install is not null                   then 5
  when a.tech_code is null or a.tech_code = ''       then 0
  when a.tech_confirm is null                        then 1
  when coalesce(a.used_spare,0) = 0
   and a.reg_start is null
   and a.reg_finish is null
   and a.pick_finish is null                         then 4
  when a.reg_start is null                           then 2
  when a.pick_finish is null                         then 3
  else 4
end`;

export const INSTALL_STAGE_LABEL: Record<number, string> = {
  [-1]: "ຍົກເລີກແລ້ວ",
  0: "ເປີດງານ / ລໍຖ້າຈັດຊ່າງ",
  1: "ລໍຖ້າຊ່າງຮັບ",
  2: "ລໍຖ້າເບີກອາໄຫຼ່",
  3: "ລໍຖ້າຮັບອາໄຫຼ່ຈາກການເບີກ",
  4: "ລໍຖ້າຕິດຕັ້ງ",
  5: "ກຳລັງຕິດຕັ້ງ",
  6: "ລໍຖ້າກວດ QC",
  7: "ລໍຖ້າລູກຄ້າປະເມີນ",
  8: "ລໍຖ້າປິດງານ",
  9: "ປິດງານແລ້ວ",
};

/** ສີຂອງປ້າຍສະຖານະ — ໃຫ້ໜ້າຕາຄືກັນທຸກໜ້າ */
export const INSTALL_STAGE_CHIP: Record<number, string> = {
  [-1]: "bg-brand-orange-100 text-brand-orange-700",
  0: "bg-brand-orange-300 text-brand-900",
  1: "bg-brand-orange-300 text-brand-900",
  2: "bg-brand-50 text-brand-700",
  3: "bg-brand-50 text-brand-700",
  4: "bg-brand-50 text-brand-700",
  5: "bg-brand-100 text-brand-700",
  6: "bg-brand-300 text-brand-900",
  7: "bg-brand-50 text-brand-800",
  8: "bg-brand-orange-50 text-brand-orange-700",
  9: "bg-slate-100 text-slate-600",
};

/** ຊື່ຂັ້ນ ໃນຮູບ SQL — ສ້າງຈາກ INSTALL_STAGE_LABEL ບ່ອນດຽວ (ເບິ່ງ lib/stage) */
export const INSTALL_STAGE_LABEL_SQL = `case (${INSTALL_STAGE_SQL})
${Object.entries(INSTALL_STAGE_LABEL).map(([stage, label]) => `  when ${stage} then '${label}'`).join("\n")}
  else '-' end`;

export const installStageLabel = (stage: number | null) =>
  stage == null ? "-" : (INSTALL_STAGE_LABEL[stage] ?? "-");
export const installStageChip = (stage: number | null) =>
  stage == null ? "bg-slate-100 text-slate-500" : (INSTALL_STAGE_CHIP[stage] ?? "bg-slate-100 text-slate-500");

/* ── ເງື່ອນໄຂ 3 ກຸ່ມໃຫຍ່ — ລວມກັນແລ້ວໄດ້ທຸກແຖວຂອງ ods_tb_install ພໍດີ ── */

/** ງານທີ່ຍັງດຳເນີນຢູ່ (ຂັ້ນ 0..8) */
export const INSTALL_OPEN = "a.cancel_date is null and a.job_finish is null";
/** ງານທີ່ປິດແລ້ວ (ຂັ້ນ 9) */
export const INSTALL_CLOSED = "a.cancel_date is null and a.job_finish is not null";
/** ງານທີ່ຍົກເລີກ (ຂັ້ນ -1) */
export const INSTALL_CANCELLED = "a.cancel_date is not null";

/** ເງື່ອນໄຂ WHERE ຂອງຂັ້ນນຶ່ງ */
export const installStageIs = (stage: number) => `(${INSTALL_STAGE_SQL}) = ${Number(stage)}`;

/**
 * ຖັນເວລາທີ່ "ນັບຄ້າງ" ຂອງແຕ່ລະຂັ້ນ — ໃຊ້ກັບ <Elapsed/>.
 * ຂັ້ນນຶ່ງນັບຈາກເວລາທີ່ເຂົ້າຂັ້ນນັ້ນ (ຂັ້ນ 0 ຍັງບໍ່ມີຫຍັງ ຈຶ່ງນັບຈາກເປີດງານ).
 */
export const INSTALL_STAGE_TIME_COL = `case (${INSTALL_STAGE_SQL})
  when 9 then a.job_finish
  when 8 then ${INSTALL_FEEDBACK_TIME_SQL}
  when 7 then a.qc_finish
  when 6 then a.finish_install
  when 5 then a.start_install
  when 4 then coalesce(a.pick_finish, a.tech_confirm, a.time_register)
  when 3 then a.reg_start
  when 2 then a.tech_confirm
  when 1 then coalesce(a.assigt_time, a.time_register)
  when -1 then a.cancel_date
  else a.time_register
end`;

/**
 * ໂມງຂອງຄິວ "ລໍຖ້າຊ່າງຮັບງານ" — ນັບຈາກ **ເວລາຈັດຊ່າງ** ບໍ່ແມ່ນເວລາເປີດງານ.
 *
 * ຖັນ assigt_time / user_assigt ມີຢູ່ໃນຕາຕະລາງແລ້ວ ແຕ່ຖືກຂຽນພຽງ 3/6,832 ແຖວ
 * (ຜູ້ໃຊ້ 'keo', ຕຸລາ 2024) ⇒ ວັດບໍ່ໄດ້ວ່າ "ຜູ້ຈັດຊ້າ" ຫຼື "ຊ່າງຮັບຊ້າ".
 * assignTech / updateInstall stamp ໃຫ້ແລ້ວ (ເບິ່ງ actions/installation.ts).
 * coalesce ກັບ time_register ໄວ້ ເພື່ອບໍ່ໃຫ້ 6,829 ແຖວເກົ່າສະແດງໂມງ 20,000 ວັນ.
 */
export const INSTALL_ACCEPT_CLOCK = "coalesce(a.assigt_time, a.time_register)";

/* ── ໂມງຄ້າງຂອງງານ **ຫຼາຍຮອບ** (12-08-2026) ───────────────────────── */

/**
 * ເວລາທີ່ຊ່າງອອກຈາກໜ້າງານ **ຮອບຫຼ້າສຸດ** (ຮອບເກັບຢູ່ `ods_job_checkin`).
 * ຮອບທີ່ຍັງ check-in ຄ້າງບໍ່ນັບ — ຊ່າງຍັງຢູ່ໜ້າງານ ຈຶ່ງບໍ່ແມ່ນ "ຄ້າງ".
 */
export const INSTALL_LAST_VISIT_SQL = `(select max(v.checkout_at) from ods_job_checkin v
  where v.workflow = 'install' and v.job_code = a.code)`;

/**
 * **ໂມງທີ່ໃຊ້ວັດ "ຄ້າງ"** — ຕ່າງຈາກ INSTALL_STAGE_TIME_COL ທີ່ບອກ "ເຂົ້າຂັ້ນນີ້ຕອນໃດ".
 *
 * ── ເປັນຫຍັງຈຶ່ງແຍກ (12-08-2026) ──
 * ງານຕິດຕັ້ງ 1 ໃບ = **ຫຼາຍຮອບເຂົ້າໜ້າງານ** (ລໍງານໄຟຟ້າ · ຝົນຕົກ · ລູກຄ້າຂໍເລື່ອນ)
 * ⇒ ຂັ້ນ 4/5 ຄາຢູ່ດົນເປັນເລື່ອງປົກກະຕິ. ໂມງເກົ່ານັບຈາກ `start_install` ຕົວດຽວ
 * ⇒ INST-6892 ຂຶ້ນ "48 ມື້" ທັງທີ່ຊ່າງເຂົ້າໄປແລ້ວຫຼາຍຮອບ ແລະ ນັດຮອບໜ້າໄວ້ແລ້ວ
 * ⇒ ຕົວເລກວັດ "ງານຍາວ" ບໍ່ແມ່ນ "ຖືກລືມ" ⇒ ຫົວໜ້າໃຊ້ຕັດສິນຫຍັງບໍ່ໄດ້.
 *
 * ຂັ້ນ **4 ລໍຖ້າຕິດຕັ້ງ · 5 ກຳລັງຕິດຕັ້ງ** (ຂັ້ນທີ່ນັດຮອບຕໍ່ໄປໄດ້ — ເບິ່ງ lib/job-flow)
 * ຈຶ່ງນັບຈາກ **ອັນໃໝ່ສຸດ** ໃນ 3 ຢ່າງ:
 *   ① ເວລາເຂົ້າຂັ້ນ  ② ອອກຈາກໜ້າງານຮອບຫຼ້າສຸດ  ③ ວັນນັດ
 * ⇒ ນັດໄວ້ວັນໜ້າ = ໂມງເປັນ 0 (ຍັງບໍ່ຮອດຕາເວັນນັດ ບໍ່ມີຫຍັງໃຫ້ໄລ່) ·
 *   ເລີຍວັນນັດ = ນັບຈາກວັນນັດ (**ຜິດນັດຈິງ**) · ບໍ່ເຄີຍນັດ = ນັບຈາກຮອບຫຼ້າສຸດ.
 * ຂັ້ນອື່ນບໍ່ມີຮອບໜ້າງານ ⇒ ໃຊ້ເວລາເຂົ້າຂັ້ນຄືເກົ່າ.
 */
export const INSTALL_WAIT_TIME_COL = `case
  when (${INSTALL_STAGE_SQL}) in (4,5)
    then greatest((${INSTALL_STAGE_TIME_COL}), ${INSTALL_LAST_VISIT_SQL}, a.appoint_date::timestamp)
  else (${INSTALL_STAGE_TIME_COL})
end`;

/** ຈຳນວນຮອບເຂົ້າໜ້າງານທັງໝົດ (ລວມຮອບທີ່ຊ່າງຍັງຢູ່ໜ້າງານ) */
export const INSTALL_VISIT_ROUNDS_SQL = `(select count(*) from ods_job_checkin v
  where v.workflow = 'install' and v.job_code = a.code)::int`;

/** ນາທີລວມທີ່ຢູ່ໜ້າງານ — ນັບສະເພາະຮອບທີ່ check-out ແລ້ວ (ຮອບທີ່ຍັງເປີດຢູ່ ຍັງບໍ່ຮູ້ຄວາມຍາວ) */
export const INSTALL_VISIT_MINUTES_SQL = `(select coalesce(round(
    sum(extract(epoch from (v.checkout_at - v.checkin_at))) / 60), 0)
  from ods_job_checkin v
  where v.workflow = 'install' and v.job_code = a.code and v.checkout_at is not null)::int`;

/**
 * ງານທີ່ **ນັດໄວ້ແລ້ວ ແລະ ວັນນັດຍັງບໍ່ຮອດ** — ບໍ່ຖືວ່າຄ້າງ.
 * ໜ້າລາຍການສະແດງເປັນປ້າຍ "ນັດ DD-MM" ແທນນາລິກາ (ເບິ່ງ installations/shared).
 */
export const INSTALL_APPOINT_WAIT_SQL = `((${INSTALL_STAGE_SQL}) in (4,5)
  and a.appoint_date is not null and a.appoint_date::date >= current_date)`;

/** ຈຳນວນວິນາທີທີ່ຄ້າງ — ສົ່ງໃຫ້ <Elapsed seconds=... /> */
export const INSTALL_ELAPSED_SQL = `greatest(0, round(extract(epoch from (localtimestamp - (${INSTALL_WAIT_TIME_COL})))))::int`;
