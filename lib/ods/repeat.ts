// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
import { query } from "@/lib/ods/db";

/**
 * ສ້ອມຊ້ຳ — ເຄື່ອງໜ່ວຍດຽວກັນ (serial number) ກັບມາສ້ອມອີກ ພາຍໃນ 30 ມື້
 * ນັບແຕ່ວັນທີ່ສົ່ງຄືນຄັ້ງກ່ອນ.
 *
 * ── ເປັນຫຍັງຕ້ອງມີ ──
 * ລະບົບເກົ່າບໍ່ຜູກໃບໃໝ່ກັບໃບເກົ່າເລີຍ ⇒ ບໍ່ມີໃຜຮູ້ວ່າ "ສ້ອມແລ້ວບໍ່ຫາຍ" ມີເທົ່າໃດ.
 * ຂໍ້ມູນຈິງ: **118 ໃບ** ໃນປະຫວັດ (9 ໃບຍັງເປີດຢູ່ດຽວນີ້) ⇒ ຄ່າຄອມຖືກຈ່າຍສອງເທື່ອ
 * ໃຫ້ວຽກທີ່ຈິງໆແມ່ນຄັ້ງດຽວ ແລະ ລູກຄ້າຄົນນັ້ນຫອບເຄື່ອງມາສອງເທື່ອ ໂດຍບໍ່ມີໃຜເຫັນ.
 *
 * ── ເປັນຫຍັງກອງ serial ──
 * `sn` ມີຄ່າຫຼອກເຕັມ: '-' 1,513 ໃບ · 'NONE' 252 ໃບ. ຖ້າບໍ່ກອງ ຈະໄດ້ "ສ້ອມຊ້ຳ"
 * 1,624 ໃບ ເຊິ່ງເປັນຕົວເລກປອມທັງໝົດ (ທຸກໃບທີ່ບໍ່ໃສ່ serial ຈະຈັບຄູ່ກັນເອງ).
 * ⇒ ນັບສະເພາະ serial ທີ່ເປັນຂອງຈິງ (ຍາວ ≥ 4 ແລະ ບໍ່ແມ່ນຄຳຫຼອກ).
 */

/** serial ທີ່ໃຊ້ໄດ້ຈິງ — ຫຼີກຄ່າຫຼອກ */
const realSn = (col: string) =>
  `length(trim(coalesce(${col},''))) >= 4
   and upper(trim(coalesce(${col},''))) not in ('-','NONE','N/A','NA','ບໍ່ມີ','0000')`;

/** ໜ້າຕ່າງເວລາ — ກັບມາພາຍໃນ 30 ມື້ ນັບແຕ່ສົ່ງຄືນ = ຖືວ່າສ້ອມບໍ່ຈົບ */
export const REPEAT_DAYS = 30;

/** ໃບເກົ່າຂອງເຄື່ອງໜ່ວຍດຽວກັນ (ອັນລ່າສຸດກ່ອນໜ້າ) — join ກັບ tb_product a */
const PREVIOUS_JOIN = `join lateral (
    select p.code, p.return_complete, p.issue, p.issue_2, p.emp_code
      from tb_product p
     where ${realSn("p.sn")}
       and p.sn = a.sn and p.code <> a.code
       and p.return_complete is not null
       and p.return_complete <= a.time_register
       and p.return_complete >= a.time_register - interval '${REPEAT_DAYS} days'
     order by p.return_complete desc
     limit 1) prev on true`;

export type RepeatJob = {
  code: string;
  sn: string;
  product: string | null;
  customer: string | null;
  tech: string | null;
  prev_code: string;
  prev_tech: string | null;
  prev_returned: string | null;
  days_between: number;
};

const COLUMNS = `a.code, a.sn, a.name_1 as product,
  concat_ws('-', c.name_1, c.tel) as customer,
  nullif(a.emp_code,'') as tech,
  prev.code as prev_code,
  nullif(prev.emp_code,'') as prev_tech,
  to_char(prev.return_complete,'DD-MM-YYYY') as prev_returned,
  greatest(0, extract(day from (a.time_register - prev.return_complete))::int) as days_between`;

/** ໃບທີ່ຍັງເປີດຢູ່ ແລະ ເປັນການສ້ອມຊ້ຳ — ຂຶ້ນຢູ່ໜ້າລວມ */
export async function openRepeatJobs(): Promise<RepeatJob[]> {
  return (
    await query<RepeatJob>(
      `select ${COLUMNS}
         from tb_product a
         ${PREVIOUS_JOIN}
         left join ar_customer c on c.code = a.cust_code
        where a.status <> 6 and a.return_complete is null and ${realSn("a.sn")}
        order by a.time_register desc`,
    )
  ).rows;
}

/** ໃບເກົ່າຂອງໃບນີ້ (ຖ້າມີ) — ໃຊ້ຕິດປ້າຍເຕືອນຢູ່ໜ້າໃບຮັບເຄື່ອງ */
export async function previousJobOf(code: string): Promise<RepeatJob | null> {
  return (
    (
      await query<RepeatJob>(
        `select ${COLUMNS}
           from tb_product a
           ${PREVIOUS_JOIN}
           left join ar_customer c on c.code = a.cust_code
          where a.code = $1 and ${realSn("a.sn")}`,
        [code],
      )
    ).rows[0] ?? null
  );
}
