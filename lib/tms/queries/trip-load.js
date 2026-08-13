// ສິນຄ້າທີ່ຢູ່ເທິງລົດ ຂອງ "ຖ້ຽວທີ່ສົ່ງອອກແລ້ວ" (ODG TMS) — ສະເພາະການອ່ານ DB.
//
// ຄູ່ກັບ getTripDraftLoad() ໃນ trip-draft.js ທີ່ເຮັດວຽກດຽວກັນສຳລັບ "ຮ່າງຖ້ຽວ".
// ແຍກມາໄວ້ນີ້ເພາະ jobs.js/trip-draft.js require ໂມດູນ .ts ຈຶ່ງໂຫຼດນອກ Next
// ບໍ່ໄດ້ — ໄຟລ໌ນີ້ require ແຕ່ ../lib/db ຈຶ່ງ test ແລະ ຂຽນ script ໃຊ້ໄດ້.
const { query } = require("../lib/db");

/**
 * ລາຍການສິນຄ້າ + ລົດ ຂອງຖ້ຽວທີ່ສົ່ງອອກແລ້ວ.
 *
 * ໃຊ້ selected_qty (ຈຳນວນທີ່ເລືອກຂຶ້ນລົດ) ບໍ່ແມ່ນ qty ຂອງບິນ ເພາະບິນອາດ
 * ທະຍອຍສົ່ງ. ຮວມຕາມ (bill_no, item_code) ບໍ່ດັ່ງນັ້ນລາຍການທີ່ມີຫຼາຍແຖວ
 * ຈະຖືກນັບແຍກ.
 */
async function getTripLoad(docNo) {
  const doc = String(docNo ?? "").trim();
  if (!doc) return { car: "", items: [] };

  const [head] = await query(
    `SELECT MAX(COALESCE(car, '')) AS car FROM public.odg_tms_detail WHERE doc_no = $1`,
    [doc]
  );
  const items = await query(
    `SELECT i.bill_no, i.item_code,
            MAX(i.item_name) AS item_name,
            MAX(i.unit_code) AS unit_code,
            SUM(COALESCE(i.selected_qty, 0))::numeric AS qty,
              -- ຍັງຢູ່ເທິງລົດ: ບິນທີ່ປິດແລ້ວ (ສົ່ງ/ຍົກເລີກ) ຖືວ່າລົງລົດໝົດ;
              -- ບິນທີ່ຍັງເຄື່ອນໄຫວ ຫັກສ່ວນທີ່ສົ່ງ/ຄືນສາງໄປແລ້ວ
              SUM(
                CASE WHEN COALESCE(d.status, 0) IN (1, 2) THEN 0
                     ELSE GREATEST(
                       COALESCE(i.selected_qty, 0)
                         - COALESCE(i.delivered_qty, 0)
                         - COALESCE(i.returned_qty, 0), 0)
                END
              )::numeric AS qty_remaining
       FROM public.odg_tms_detail_item i
       JOIN public.odg_tms_detail d
         ON d.doc_no = i.doc_no AND d.bill_no = i.bill_no
      WHERE i.doc_no = $1
      GROUP BY i.bill_no, i.item_code
     HAVING SUM(COALESCE(i.selected_qty, 0)) > 0`,
    [doc]
  );
  return { car: head?.car ?? "", items };
}

/**
 * ສິນຄ້າ + ລົດ ຂອງຫຼາຍຖ້ຽວພ້ອມກັນ — ສຳລັບຕາຕະລາງລາຍການຖ້ຽວ ທີ່ຕ້ອງສະແດງ
 * % ຂອງທຸກແຖວ ໂດຍບໍ່ຍິງ query ຕໍ່ແຖວ (N+1).
 */
async function getTripLoadsBulk(docNos) {
  const docs = Array.from(
    new Set((docNos ?? []).map((d) => String(d ?? "").trim()).filter(Boolean))
  );
  if (docs.length === 0) return { cars: [], items: [] };

  const [cars, items] = await Promise.all([
    query(
      `SELECT doc_no, MAX(COALESCE(car, '')) AS car
         FROM public.odg_tms_detail
        WHERE doc_no = ANY($1::varchar[])
        GROUP BY doc_no`,
      [docs]
    ),
    query(
      `SELECT i.doc_no, i.bill_no, i.item_code,
              MAX(i.item_name) AS item_name,
              MAX(i.unit_code) AS unit_code,
              SUM(COALESCE(i.selected_qty, 0))::numeric AS qty,
              -- ຍັງຢູ່ເທິງລົດ: ບິນທີ່ປິດແລ້ວ (ສົ່ງ/ຍົກເລີກ) ຖືວ່າລົງລົດໝົດ;
              -- ບິນທີ່ຍັງເຄື່ອນໄຫວ ຫັກສ່ວນທີ່ສົ່ງ/ຄືນສາງໄປແລ້ວ
              SUM(
                CASE WHEN COALESCE(d.status, 0) IN (1, 2) THEN 0
                     ELSE GREATEST(
                       COALESCE(i.selected_qty, 0)
                         - COALESCE(i.delivered_qty, 0)
                         - COALESCE(i.returned_qty, 0), 0)
                END
              )::numeric AS qty_remaining
         FROM public.odg_tms_detail_item i
         JOIN public.odg_tms_detail d
           ON d.doc_no = i.doc_no AND d.bill_no = i.bill_no
        WHERE i.doc_no = ANY($1::varchar[])
        GROUP BY i.doc_no, i.bill_no, i.item_code
       HAVING SUM(COALESCE(i.selected_qty, 0)) > 0`,
      [docs]
    ),
  ]);
  return { cars, items };
}

/** ຊື່ລູກຄ້າຕໍ່ບິນ ຂອງຖ້ຽວ — ໃຊ້ຕິດປ້າຍໃນການແຈກແຈງຕາມບິນ */
async function getTripBillNames(docNo) {
  return query(
    `SELECT DISTINCT d.bill_no,
            COALESCE(NULLIF(TRIM(c.name_1), ''), d.cust_code, '') AS cust_name
       FROM public.odg_tms_detail d
       LEFT JOIN public.ar_customer c ON c.code = d.cust_code
      WHERE d.doc_no = $1`,
    [String(docNo ?? "").trim()]
  );
}

/**
 * ທຸກຖ້ຽວ + ສິນຄ້າ ໃນຊ່ວງວັນ — ດຶງເປັນກ້ອນດຽວສຳລັບລາຍງານຍ້ອນຫຼັງ.
 *
 * ⚠️ ຢ່າ JOIN odg_tms_detail ກັບ odg_tms_detail_item ດ້ວຍ doc_no ຢ່າງດຽວ:
 * odg_tms_detail ມີ 1 ແຖວຕໍ່ "ບິນ" ສະນັ້ນຈະຄູນແຖວສິນຄ້າດ້ວຍຈຳນວນບິນ.
 * ຈຶ່ງດຶງແຍກເປັນ 2 query ແລ້ວປະກອບກັນຢູ່ຊັ້ນເທິງ.
 */
async function getTripsInRange({ dateFrom, dateTo }) {
  const from = String(dateFrom ?? "").trim();
  const to = String(dateTo ?? "").trim() || from;
  if (!from) return { trips: [], items: [] };

  // odg_tms = ຫົວຖ້ຽວ (1 ແຖວ/ຖ້ຽວ) ຈຶ່ງ join ໄດ້ປອດໄພ;
  // odg_tms_detail = 1 ແຖວ/ບິນ ຈຶ່ງຕ້ອງ GROUP ກ່ອນ
  const trips = await query(
    `SELECT d.doc_no,
            MAX(COALESCE(d.car, '')) AS car,
            to_char(MIN(d.doc_date), 'YYYY-MM-DD') AS doc_date,
            MAX(COALESCE(t.origin_transport_code, '')) AS transport_code,
            MAX(COALESCE(t.driver, '')) AS driver,
            COUNT(DISTINCT d.bill_no)::int AS bills
       FROM public.odg_tms_detail d
       LEFT JOIN public.odg_tms t ON t.doc_no = d.doc_no
      WHERE d.doc_date BETWEEN $1::date AND $2::date
      GROUP BY d.doc_no
      ORDER BY MIN(d.doc_date), d.doc_no`,
    [from, to]
  );
  if (trips.length === 0) return { trips: [], items: [] };

  const items = await query(
    `SELECT i.doc_no, i.bill_no, i.item_code,
            MAX(i.item_name) AS item_name,
            MAX(i.unit_code) AS unit_code,
            SUM(COALESCE(i.selected_qty, 0))::numeric AS qty
       FROM public.odg_tms_detail_item i
      WHERE i.doc_no = ANY($1::varchar[])
      GROUP BY i.doc_no, i.bill_no, i.item_code
     HAVING SUM(COALESCE(i.selected_qty, 0)) > 0`,
    [trips.map((t) => t.doc_no)]
  );
  return { trips, items };
}

module.exports = { getTripLoad, getTripLoadsBulk, getTripBillNames, getTripsInRange };
