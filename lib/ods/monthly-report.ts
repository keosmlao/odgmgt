// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name; imports rewritten.
import { query, queryOdg } from "@/lib/ods/db";

/**
 * **ລາຍງານປະຈຳເດືອນຂອງຜູ້ຈັດການ** — ລວມລາຍຮັບເປັນ**ບາດ**ຈາກ 3 ແຫຼ່ງ:
 *
 *   ຕິດຕັ້ງ   = ຄ່າບໍລິການຕິດຕັ້ງ (ic_inventory 9701xx) ໃນບິນຂາຍ ERP (trans_flag 44)
 *   ສ້ອມແປງ  = ໃບສະເໜີລາຄາທີ່ລູກຄ້າຮັບແລ້ວ (ic_trans flag 17 · 1/1) — ນິຍາມດຽວກັບ
 *              lib/service-money (ACCEPTED_QUOTE) ⇒ ຕົວເລກຕົງກັບລາຍງານລາຍຮັບງານສ້ອມ
 *   ອື່ນໆ    = ຕິດຕັ້ງໂຄງການ · ຄ່າໄລຍະທາງ · ວຽກບຳລຸງຮັກສາ (ods_tb_maintenance)
 *
 * ── ບົດຮຽນຈາກຂໍ້ມູນຈິງ (ວັດ 03-08-2026) ──
 * · ແຖວ ic_trans_detail.sum_amount ເປັນ**ບາດ**ຢູ່ແລ້ວ ເຖິງໃບຈະເປັນສະກຸນກີບ
 *   (ກວດ: line_sum = ic_trans.total_amount ບໍ່ແມ່ນ total_amount_2) ⇒ ບໍ່ຕ້ອງແປງ.
 * · **ຍົກເວັ້ນ**ໃບໂຄງການ *HSV* (CAHSV/INHSV ສຳນັກງານໃຫຍ່): ປ້ອນຄ່າເປັນ**ກີບ**ທັງໃບ
 *   ທັງທີ່ currency_code='01' (ແຖວ 1-2 ລ້ານ/ແຖວ — ຄ່າຕິດຕັ້ງ 2 ລ້ານບາດບໍ່ມີຈິງ)
 *   ⇒ ໃບຕະກູນ HSV ຫານອັດຕາກີບ (tb_bill_rate code 02) ກ່ອນລວມ.
 * · ຄ່າຕິດຕັ້ງເຄື່ອງໃຊ້ໄຟຟ້າ (970101-0013) ເກືອບທຸກແຖວລາຄາ 0 (ຕິດຕັ້ງຟຣີພ່ວງການຂາຍ)
 *   — ຕົວເລກຕ່ຳແມ່ນຄວາມຈິງ ບໍ່ແມ່ນ bug.
 */

export const REV_CATEGORIES = ["install_ac", "install_app", "repair_ac", "repair_app", "other"] as const;
export type RevCategory = (typeof REV_CATEGORIES)[number];

export type MonthRevenue = Record<RevCategory, number> & {
  /** YYYY-MM */
  month: string;
  total: number;
  /** ເປົ້າຂອງເດືອນ (ods_revenue_target) — 0 ຖ້າຍັງບໍ່ຕັ້ງ */
  target: number;
};

/**
 * ລະຫັດບໍລິການຕິດຕັ້ງ**ແອ** — pin ຕາຍຕົວຈາກ ic_inventory ຈິງ (03-08-2026)
 * ຢ່າໃຊ້ "ທີ່ເຫຼືອ = ແອ": ລະຫັດ 970102-0012/0013 ເປັນເຄື່ອງປັບອາກາດແຕ່ຢູ່ຕະກູນ 970102
 * ແລະ ລະຫັດໃໝ່ທີ່ ERP ເພີ່ມພາຍຫຼັງຕ້ອງຖືກຈັດເປັນເຄື່ອງໃຊ້ໄຟຟ້າໂດຍປົກກະຕິ.
 * export ໃຫ້ໜ້າອື່ນຈັດໝວດດ້ວຍກົດດຽວກັນ (ເຊັ່ນ /install-revenue).
 */
export const INSTALL_AC_ITEMS = new Set([
  "970101-0001", // SERVICE CHARGE ຄ່າຕິດຕັ້ງແອ
  "970101-0015", // ແອ WT 9000-12000 BTU
  "970101-0016", // ແອ WT 18000-36000 BTU
  "970101-0017", // ຕູ້ຕັ້ງ Floor Standing
  "970101-0018", // Cassette Type
  "970101-0019", // ຕໍ່ທໍ່ແອ
  "970102-0012", // ເຄື່ອງປັບອາກາດ Floor Standing (ຢູ່ຕະກູນ 970102)
  "970102-0013", // ເຄື່ອງປັບອາກາດ Cassette (ຢູ່ຕະກູນ 970102)
]);

/** ບໍ່ແມ່ນທັງແອ/ເຄື່ອງໃຊ້ໄຟຟ້າ — ເຂົ້າໝວດ "ລາຍໄດ້ອື່ນໆ" */
export const INSTALL_OTHER_ITEMS = new Set([
  "970101-0004", // ບໍລິການຕິດຕັ້ງໂຄງການ (ໃບ *HSV — ຄ່າເປັນກີບ)
  "970101-0020", // ຄ່າບໍລິການໄລຍະທາງ KM (ໃຊ້ໄດ້ທັງສອງໝວດ ແຍກບໍ່ອອກ)
]);

/** ໝວດສິນຄ້າ "ແອ" ຂອງ ERP (ic_category) — ໃຊ້ຈັດໝວດງານສ້ອມຕາມ item_code ຂອງວຽກ */
const ERP_AC_CATEGORY = "032";
/** ຄ່າເກົ່າຂອງ tb_product.p_type ທີ່ໝາຍເຖິງແອ (ວຽກທີ່ບໍ່ມີ item_code) */
const LEGACY_AC_TYPES = new Set(["032", "03", "ແອ"]);

const emptyMonth = (month: string): MonthRevenue => ({
  month, install_ac: 0, install_app: 0, repair_ac: 0, repair_app: 0, other: 0, total: 0, target: 0,
});

const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;

/** ອັດຕາກີບຕໍ່ບາດ (tb_bill_rate code 02 ~690) — 0 = ອ່ານບໍ່ໄດ້ (ແຖວກີບຈະຖືກຂ້າມ) */
/** ອັດຕາ ກີບ/ບາດ (tb_bill_rate code 02) — export ໃຫ້ໜ້າອື່ນແປງໜ່ວຍໄດ້ດ້ວຍອັດຕາດຽວກັນ */
export async function kipPerBaht(): Promise<number> {
  const result = await queryOdg<{ rate: string | null }>(
    `select exchange_rate rate from tb_bill_rate where code='02'`,
  );
  return Number(result.rows[0]?.rate ?? 0);
}

/**
 * ຕາຕະລາງລາຍຮັບລາຍເດືອນ ຂອງ `year` ແລະ `year-1` (ເອົາປີກາຍມານຳເພື່ອຖັນທຽບ) —
 * key = "YYYY-MM" ຄົບທຸກເດືອນຂອງສອງປີ (ເດືອນບໍ່ມີຂໍ້ມູນ = 0 ບໍ່ແມ່ນ undefined).
 *
 * ── engine ວັດ 04-08-2026: ໄວ + ຕົງກັບ /install-revenue ──
 * ສູດເກົ່າ scan ic_trans_detail ທຸກແຖວ 2 ປີ + fallback subquery ຕໍ່ແຖວ ≈ 31 ວິນາທີ.
 * ສູດໃໝ່ ≈ 1 ວິນາທີ ໂດຍ:
 *   ① ຕິດຕັ້ງ **linked** = CTE ຈາກໃບງານ (ຄື /install-revenue) ນັບຕາມ **ວັນປິດງານສຸດທ້າຍ**
 *      ຂອງບິນ ⇒ ບິນດຽວບໍ່ຖືກນັບຊ້ຳ 2 ເດືອນ · ຕົງກັບໜ້າລາຍຮັບງານຕິດຕັ້ງ
 *   ② ຕິດຕັ້ງ **unlinked** = ບິນມີ 9701xx ມີລາຄາ ແຕ່ບໍ່ມີໃບງານອ້າງ (ຄືກ່ອງເຕືອນ
 *      ຂອງ /install-revenue) ນັບຕາມວັນທີບິນ — ລວມທັງສອງສ່ວນຈຶ່ງຕົງກັນພໍດີ
 *   ③ fallback ລາຄາຂັ້ນ ② (ລາຄາທີ່ເຄີຍອອກບິນຫຼ້າສຸດ) ຍ້າຍມາຄິດໃນ JS ຈາກ
 *      price history ທີ່ດຶງເທື່ອດຽວ (ແທນ subquery ຕໍ່ແຖວທີ່ຊ້າ)
 * ທຸກ query ແລ່ນຂະໜານດ້ວຍ Promise.all.
 */
export async function monthlyRevenueMatrix(year: number): Promise<Map<string, MonthRevenue>> {
  const from = `${year - 1}-01-01`;
  const to = `${year + 1}-01-01`;

  const matrix = new Map<string, MonthRevenue>();
  for (const y of [year - 1, year]) {
    for (let m = 1; m <= 12; m++) matrix.set(monthKey(y, m), emptyMonth(monthKey(y, m)));
  }
  const add = (month: string, category: RevCategory, amount: number) => {
    const row = matrix.get(month);
    if (!row || !Number.isFinite(amount)) return;
    row[category] += amount;
    row.total += amount;
  };

  /** CTE ຈັບຄູ່ ໃບງານຕິດຕັ້ງ → ບິນ (ຄື lib/service-money) — ໄວ ເພາະເລີ່ມຈາກໃບງານ ບໍ່ແມ່ນ scan ບິນ */
  const anchorCtes = `with jobs as (
      select trim(a.doc_ref_1) bill, a.job_finish
        from ods.ods_tb_install a
       where a.cancel_date is null and a.job_finish::date between $1 and $2
         and nullif(trim(coalesce(a.doc_ref_1,'')),'') is not null
    ), anchor as (
      select j.bill, max(j.job_finish) finished from jobs j group by j.bill
    )`;
  /** ມູນຄ່າແຖວດ້ວຍ fallback ຂັ້ນ ① ຢ່າງດຽວ (std price) — ຂັ້ນ ② ຄິດໃນ JS ຈາກ pending */
  const lineStd = `coalesce(nullif(d.sum_amount, 0), d.qty * coalesce(std.sale_price1, 0))`;
  const acList = [...INSTALL_AC_ITEMS].map((c) => `'${c}'`).join(", ");
  const othList = [...INSTALL_OTHER_ITEMS].map((c) => `'${c}'`).join(", ");

  type LinkedMonth = {
    month: string;
    ac: number; app: number; oth: number;
    ac_kip: number; app_kip: number; oth_kip: number;
  };
  type PendingRow = { item_code: string; qty: number; month: string; anchor_date: Date; kip: boolean };
  type UnlinkedDoc = { month: string; kip: boolean; baht: number; ac: number; app: number; oth: number };

  const [rate, linked, pending, unlinked, repair, maint, targets] = await Promise.all([
    kipPerBaht(),

    /* ── ① ຕິດຕັ້ງ linked: ຍອດຕາມເດືອນທີ່ບິນປິດງານສຸດທ້າຍ (ຕົງກັບ /install-revenue) ── */
    query<LinkedMonth>(
      `${anchorCtes}, std as (
        select c.item_code,
            (select pr.sale_price1 from public.ic_inventory_price pr
              where pr.ic_code = c.item_code and pr.currency_code = '01'
                and coalesce(pr.sale_price1,0) > 0
              order by pr.from_date desc nulls last, pr.roworder desc limit 1) sale_price1
          from (select distinct item_code from public.ic_trans_detail
                 where item_code like '9701%' and doc_date >= $1 and doc_date < $2) c
      ), bills as (
        select anc.finished, bool_or(d.item_code = '970101-0004') kip,
            sum(case when d.item_code in (${acList}) then ${lineStd} else 0 end)::float8 ac,
            sum(case when d.item_code like '9701%' and d.item_code not in (${acList})
              and d.item_code not in (${othList}) then ${lineStd} else 0 end)::float8 app,
            sum(case when d.item_code in (${othList}) then ${lineStd} else 0 end)::float8 oth
          from public.ic_trans_detail d
          join anchor anc on anc.bill = d.doc_no
          left join std on std.item_code = d.item_code
         where d.item_code like '9701%'
         group by d.doc_no, anc.finished
      )
      select to_char(finished,'YYYY-MM') as month,
          sum(ac)::float8 ac, sum(app)::float8 app, sum(oth)::float8 oth,
          sum(case when kip then ac else 0 end)::float8 ac_kip,
          sum(case when kip then app else 0 end)::float8 app_kip,
          sum(case when kip then oth else 0 end)::float8 oth_kip
        from bills
       group by 1`,
      [from, to],
    ),

    /* ── ② ແຖວລາຄາ 0 ທີ່ບໍ່ມີ std price ⇒ ຕ້ອງ fallback ② (ລາຄາທີ່ເຄີຍອອກບິນຫຼ້າສຸດ) ── */
    query<PendingRow>(
      `${anchorCtes}
      select d.item_code, d.qty::float8 qty, to_char(anc.finished,'YYYY-MM') as month,
          anc.finished::date anchor_date,
          exists (select 1 from public.ic_trans_detail k
                   where k.doc_no = d.doc_no and k.item_code = '970101-0004') kip
        from public.ic_trans_detail d
        join anchor anc on anc.bill = d.doc_no
       where d.item_code like '9701%' and coalesce(d.sum_amount,0) = 0
         and not exists (select 1 from public.ic_inventory_price pr
                          where pr.ic_code = d.item_code and pr.currency_code = '01'
                            and coalesce(pr.sale_price1,0) > 0)`,
      [from, to],
    ),

    /* ── ③ ຕິດຕັ້ງ unlinked: ບິນມີ 9701xx ມີລາຄາ ແຕ່ບໍ່ມີໃບງານອ້າງ — ນັບຕາມວັນທີບິນ ── */
    query<UnlinkedDoc>(
      `select to_char(t.doc_date,'YYYY-MM') as month,
          bool_or(d.item_code = '970101-0004') kip,
          sum(coalesce(nullif(d.sum_amount, 0), d.qty * coalesce(
            (select pr.sale_price1 from public.ic_inventory_price pr
              where pr.ic_code = d.item_code and pr.currency_code = '01'
                and coalesce(pr.sale_price1,0) > 0
              order by pr.from_date desc nulls last, pr.roworder desc limit 1),
            (select p2.price from public.ic_trans_detail p2
               join public.ic_trans t2 on t2.doc_no = p2.doc_no
              where p2.item_code = d.item_code and coalesce(p2.price,0) > 0
                and t2.doc_date <= t.doc_date
              order by t2.doc_date desc limit 1), 0)))::float8 baht,
          sum(case when d.item_code in (${acList}) then coalesce(nullif(d.sum_amount, 0), d.qty * coalesce(
            (select pr.sale_price1 from public.ic_inventory_price pr
              where pr.ic_code = d.item_code and pr.currency_code = '01'
                and coalesce(pr.sale_price1,0) > 0
              order by pr.from_date desc nulls last, pr.roworder desc limit 1),
            (select p2.price from public.ic_trans_detail p2
               join public.ic_trans t2 on t2.doc_no = p2.doc_no
              where p2.item_code = d.item_code and coalesce(p2.price,0) > 0
                and t2.doc_date <= t.doc_date
              order by t2.doc_date desc limit 1), 0)) else 0 end)::float8 ac,
          sum(case when d.item_code like '9701%' and d.item_code not in (${acList})
            and d.item_code not in (${othList}) then coalesce(nullif(d.sum_amount, 0), d.qty * coalesce(
            (select pr.sale_price1 from public.ic_inventory_price pr
              where pr.ic_code = d.item_code and pr.currency_code = '01'
                and coalesce(pr.sale_price1,0) > 0
              order by pr.from_date desc nulls last, pr.roworder desc limit 1),
            (select p2.price from public.ic_trans_detail p2
               join public.ic_trans t2 on t2.doc_no = p2.doc_no
              where p2.item_code = d.item_code and coalesce(p2.price,0) > 0
                and t2.doc_date <= t.doc_date
              order by t2.doc_date desc limit 1), 0)) else 0 end)::float8 app,
          sum(case when d.item_code in (${othList}) then coalesce(nullif(d.sum_amount, 0), d.qty * coalesce(
            (select pr.sale_price1 from public.ic_inventory_price pr
              where pr.ic_code = d.item_code and pr.currency_code = '01'
                and coalesce(pr.sale_price1,0) > 0
              order by pr.from_date desc nulls last, pr.roworder desc limit 1),
            (select p2.price from public.ic_trans_detail p2
               join public.ic_trans t2 on t2.doc_no = p2.doc_no
              where p2.item_code = d.item_code and coalesce(p2.price,0) > 0
                and t2.doc_date <= t.doc_date
              order by t2.doc_date desc limit 1), 0)) else 0 end)::float8 oth
        from public.ic_trans t
        join public.ic_trans_detail d on d.doc_no = t.doc_no and d.item_code like '9701%'
       where t.trans_flag = 44 and t.side_code = '400'
         and t.doc_date::date between $1 and $2
         and not exists (select 1 from ods.ods_tb_install a
              where trim(a.doc_ref_1) = t.doc_no and a.cancel_date is null)
       group by t.doc_no, t.doc_date`,
      [from, to],
    ),

    /* ── ສ້ອມແປງ (ODS) — ໃບສະເໜີລາຄາທີ່ຮັບແລ້ວ ຕໍ່ວຽກ (ນິຍາມດຽວກັບ service-money) ── */
    query<{ month: string; item_code: string | null; p_type: string | null; amount: number }>(
      `select to_char(x.d,'YYYY-MM') as month, x.item_code, x.p_type, sum(x.quoted)::float8 amount
         from (
           select max(q.doc_date) d,
                  nullif(trim(coalesce(a.item_code,'')),'') item_code,
                  trim(coalesce(a.p_type,'')) p_type,
                  sum(q.total_amount) quoted
             from ic_trans q
             join tb_product a on a.code = q.product_code
            where q.trans_flag = 17
              and coalesce(q.aprove_status,0) = 1
              and coalesce(q.aprove_status_2,0) = 1
              and q.doc_date >= $1 and q.doc_date < $2
            group by a.code, 2, 3
         ) x
        group by 1, 2, 3`,
      [from, to],
    ),

    /* ── ອື່ນໆ: ວຽກບຳລຸງຮັກສາ (ຈ່າຍແລ້ວ) — ຄ່າເປັນກີບ ── */
    query<{ month: string; amount: number }>(
      `select to_char(m.paid_at,'YYYY-MM') as month, sum(m.total)::float8 amount
         from ods_tb_maintenance m
        where m.paid_at is not null and m.paid_at >= $1 and m.paid_at < $2
        group by 1`,
      [from, to],
    ).catch(() => ({ rows: [] as { month: string; amount: number }[] })),

    /* ── ເປົ້າ (ODS) ── */
    query<{ year: number; month: number; amount: number }>(
      `select year, month, amount::float8 amount from ods_revenue_target where year between $1 and $2`,
      [year - 1, year],
    ).catch(() => ({ rows: [] as { year: number; month: number; amount: number }[] })),
  ]);

  /** ໃບ HSV (ມີແຖວ 970101-0004) ຄ່າເປັນ **ກີບ** ⇒ ຫານອັດຕາກ່ອນ (ກົດດຽວກັບ /install-revenue) */
  const conv = (value: number, kipPart: number) =>
    value - kipPart + (rate > 0 ? kipPart / rate : 0);

  for (const row of linked.rows) {
    add(row.month, "install_ac", conv(row.ac, row.ac_kip));
    add(row.month, "install_app", conv(row.app, row.app_kip));
    add(row.month, "other", conv(row.oth, row.oth_kip));
  }
  for (const doc of unlinked.rows) {
    const factor = doc.kip && rate > 0 ? 1 / rate : 1;
    // ໝວດອື່ນໆ = baht − ac − app (ບໍ່ sum ແຍກ ເພື່ອບໍ່ໃຫ້ປັດເສດເຫຼືອໄປຫາຍ)
    add(doc.month, "install_ac", doc.ac * factor);
    add(doc.month, "install_app", doc.app * factor);
    add(doc.month, "other", (doc.baht - doc.ac - doc.app) * factor);
  }

  /* ── fallback ② ຂອງ pending: ດຶງປະຫວັດລາຄາທີ່ເຄີຍອອກບິນ ເທື່ອດຽວ ແລ້ວຄິດໃນ JS ── */
  if (pending.rows.length > 0) {
    const codes = [...new Set(pending.rows.map((row) => row.item_code))];
    const hist = await query<{ item_code: string; dt: Date; price: number }>(
      `select p2.item_code, t2.doc_date::date dt, max(p2.price)::float8 price
         from public.ic_trans_detail p2
         join public.ic_trans t2 on t2.doc_no = p2.doc_no
        where p2.item_code = any($1::varchar[]) and coalesce(p2.price,0) > 0
          and t2.doc_date < $2
        group by 1, 2`,
      [codes, to],
    );
    const series = new Map<string, { dt: Date; price: number }[]>();
    for (const row of hist.rows) {
      if (!series.has(row.item_code)) series.set(row.item_code, []);
      series.get(row.item_code)!.push(row);
    }
    for (const arr of series.values()) arr.sort((a, b) => a.dt.getTime() - b.dt.getTime());
    /** ລາຄາທີ່ເຄີຍອອກບິນຫຼ້າສຸດ ທີ່ບໍ່ເກີນວັນອ້າງອີງ (ຄື fallback ② ຂອງ installLineBaht) */
    const priceAsOf = (code: string, dt: Date) => {
      const arr = series.get(code);
      if (!arr) return 0;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].dt.getTime() <= dt.getTime()) return arr[i].price;
      }
      return 0;
    };
    for (const row of pending.rows) {
      let value = row.qty * priceAsOf(row.item_code, row.anchor_date);
      if (row.kip && rate > 0) value /= rate;
      const category: RevCategory = INSTALL_OTHER_ITEMS.has(row.item_code)
        ? "other"
        : INSTALL_AC_ITEMS.has(row.item_code)
          ? "install_ac"
          : "install_app";
      add(row.month, category, value);
    }
  }

  /* ── ສ້ອມແປງ: ຈັດໝວດແອ/ໄຟຟ້າ ດ້ວຍ ic_category ຂອງ ERP (ດຶງເທື່ອດຽວທັງຊຸດ) ── */
  const codes = [...new Set(repair.rows.map((row) => row.item_code).filter((c): c is string => !!c))];
  const acCodes = new Set<string>();
  if (codes.length) {
    const cats = await queryOdg<{ code: string; item_category: string | null }>(
      `select code, item_category from ic_inventory where code = any($1::varchar[])`,
      [codes],
    );
    for (const row of cats.rows) if (row.item_category === ERP_AC_CATEGORY) acCodes.add(row.code);
  }
  for (const row of repair.rows) {
    const isAc = row.item_code
      ? acCodes.has(row.item_code)
      : LEGACY_AC_TYPES.has(row.p_type ?? "");
    add(row.month, isAc ? "repair_ac" : "repair_app", row.amount);
  }

  for (const row of maint.rows) add(row.month, "other", rate > 0 ? row.amount / rate : 0);

  for (const row of targets.rows) {
    const cell = matrix.get(monthKey(row.year, row.month));
    if (cell) cell.target = row.amount;
  }

  return matrix;
}
