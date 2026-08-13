const { query, queryOne } = require("../lib/db");
const { getFixedYearSqlFilter } = require("../lib/fixed-year");
const {
  customerAreaSql,
  billOpenedAtSql,
  getBranchScope,
  branchFilterJob,
  getNextMonthStart,
  ensureForwardBranchColumn,
} = require("./helpers");

// ເວລາເປີດບິນ ສຳລັບ query ທີ່ join ic_trans ເປັນ `t` ແລະ ic_trans_shipment ເປັນ `s`.
// ເບິ່ງ billOpenedAtSql — create_date_time_now ຂອງສອງຕາຕະລາງນີ້ເປັນ UTC ຈຶ່ງໃຊ້
// ບໍ່ໄດ້ (ບິນທີ່ເປີດຫຼັງ 17:00 ຈະຖືກນັບເປັນມື້ຖັດໄປ).
const BILL_OPENED_AT = billOpenedAtSql("t", "s.doc_date::timestamp");

async function getReportDaily(session, fromDate, toDate) {
  const scope = getBranchScope(session);
  await ensureForwardBranchColumn();
  return query(`SELECT to_char(a.create_date_time_now,'DD-MM-YYYY HH24:MI') as doc_date, doc_no, to_char(date_logistic,'DD-MM-YYYY') as date_logistic, to_char(a.job_close,'DD-MM-YYYY HH24:MI') as job_code, b.name_1 as car, c.name_1 as driver, item_bill, d.name_1 as user_created, approve_status, case when approve_status=0 then 'ລໍຖ້າອະນຸມັດ' else case when job_status=0 then 'ລໍຖ້າຈັດສົ່ງ' when job_status=1 then 'ຮັບຖ້ຽວ / ເບີກເຄື່ອງ' when job_status=2 then 'ກຳລັງຈັດສົ່ງ' when job_status=3 then 'ຄົນຂັບປິດງານ' else 'admin ປິດຖ້ຽວ' end end as status, job_status, coalesce(b.imei,'') as imei FROM odg_tms a LEFT JOIN public.odg_tms_car b ON b.code=a.car LEFT JOIN public.odg_tms_driver c ON c.code=a.driver LEFT JOIN erp_user d ON d.code=a.user_created WHERE date_logistic BETWEEN $1 AND $2 ${branchFilterJob(scope, "a")} ORDER BY a.date_logistic, a.create_date_time_now`, [fromDate, toDate]);
}

async function getReportByDriver(session, fromDate, toDate, driverId) {
  const { getTransportDepartmentEmployees } = require("./master-data");
  const drivers = await getTransportDepartmentEmployees();
  let listitem = [];
  if (driverId) {
    const scope = getBranchScope(session);
    await ensureForwardBranchColumn();
    listitem = await query(`SELECT to_char(a.create_date_time_now,'DD-MM-YYYY HH24:MI') as doc_date, doc_no, to_char(date_logistic,'DD-MM-YYYY') as date_logistic, to_char(a.job_close,'DD-MM-YYYY HH24:MI') as job_code, b.name_1 as car, c.name_1 as driver, item_bill, d.name_1 as user_created, approve_status, case when approve_status=0 then 'ລໍຖ້າອະນຸມັດ' else case when job_status=0 then 'ລໍຖ້າຈັດສົ່ງ' when job_status=1 then 'ຮັບຖ້ຽວ / ເບີກເຄື່ອງ' when job_status=2 then 'ກຳລັງຈັດສົ່ງ' when job_status=3 then 'ຄົນຂັບປິດງານ' else 'admin ປິດຖ້ຽວ' end end as status, job_status FROM odg_tms a LEFT JOIN public.odg_tms_car b ON b.code=a.car LEFT JOIN public.odg_tms_driver c ON c.code=a.driver LEFT JOIN erp_user d ON d.code=a.user_created WHERE doc_date BETWEEN $1 AND $2 AND a.driver=$3 ${branchFilterJob(scope, "a")} ORDER BY doc_no`, [fromDate, toDate, driverId]);
  }
  return { drivers, listitem };
}

async function getReportByCar(session, fromDate, toDate, carId) {
  const cars = await query("SELECT code, name_1 FROM public.odg_tms_car");
  let listitem = [];
  if (carId) {
    const scope = getBranchScope(session);
    await ensureForwardBranchColumn();
    listitem = await query(`SELECT to_char(doc_date,'DD-MM-YYYY') as doc_date, doc_no, to_char(date_logistic,'DD-MM-YYYY') as date_logistic, to_char(a.job_close,'DD-MM-YYYY HH24:MI') as job_code, b.name_1 as car, c.name_1 as driver, item_bill, d.name_1 as user_created, approve_status, case when approve_status=0 then 'ລໍຖ້າອະນຸມັດ' else case when job_status=0 then 'ລໍຖ້າຈັດສົ່ງ' when job_status=1 then 'ຮັບຖ້ຽວ / ເບີກເຄື່ອງ' when job_status=2 then 'ກຳລັງຈັດສົ່ງ' when job_status=3 then 'ຄົນຂັບປິດງານ' else 'admin ປິດຖ້ຽວ' end end as status, job_status, COALESCE(a.miles_start,'') as miles_start, COALESCE(a.miles_end,'') as miles_end, CASE WHEN regexp_replace(COALESCE(a.miles_start,''), '[^0-9.]', '', 'g') ~ E'^\\\\d+(\\\\.\\\\d+)?$' AND regexp_replace(COALESCE(a.miles_end,''), '[^0-9.]', '', 'g') ~ E'^\\\\d+(\\\\.\\\\d+)?$' AND regexp_replace(a.miles_end, '[^0-9.]', '', 'g')::numeric >= regexp_replace(a.miles_start, '[^0-9.]', '', 'g')::numeric THEN (regexp_replace(a.miles_end, '[^0-9.]', '', 'g')::numeric - regexp_replace(a.miles_start, '[^0-9.]', '', 'g')::numeric) ELSE NULL END as distance_km FROM odg_tms a LEFT JOIN public.odg_tms_car b ON b.code=a.car LEFT JOIN public.odg_tms_driver c ON c.code=a.driver LEFT JOIN erp_user d ON d.code=a.user_created WHERE doc_date BETWEEN $1 AND $2 AND a.car=$3 ${branchFilterJob(scope, "a")} ORDER BY doc_no`, [fromDate, toDate, carId]);
  }
  return { cars, listitem };
}

async function getReportByBill(session, fromDate, toDate) {
  const scope = getBranchScope(session);
  return query(`SELECT to_char(a.create_date_time_now,'DD-MM-YYYY HH24:MI') as doc_date, a.doc_no, bill_no, to_char(bill_date,'DD-MM-YYYY') as bill_date, b.name_1 as cust_code, to_char(a.date_logistic,'DD-MM-YYYY') as date_logistic, a.status, url_img, COALESCE(a.sight_img,'') as sight_img, COALESCE(img.delivery_images, ARRAY[]::text[]) as delivery_images, case when sent_start IS NULL then 'ລໍຖ້າຈັດສົ່ງ / ເບີກເຄື່ອງ' when sent_start IS NOT NULL AND sent_end IS NULL then 'ກຳລັງຈັດສົ່ງ' else case when a.status=1 then 'ຈັດສົ່ງສຳເລັດ' else 'ຍົກເລີກຈັດສົ່ງ' end end as status_trans, d.name_1 as car, e.name_1 as driver, count_item, a.remark, to_char(a.recipt_job,'DD-MM-YYYY HH24:MI') as recipt_job, to_char(a.sent_start,'DD-MM-YYYY HH24:MI') as sent_start, to_char(a.sent_end,'DD-MM-YYYY HH24:MI') as sent_end FROM public.odg_tms_detail a LEFT JOIN ar_customer b ON b.code=a.cust_code LEFT JOIN odg_tms c ON c.doc_no=a.doc_no LEFT JOIN public.odg_tms_car d ON d.code=a.car LEFT JOIN public.odg_tms_driver e ON e.code=c.driver LEFT JOIN public.ic_trans_shipment s ON s.doc_no=a.bill_no LEFT JOIN LATERAL (SELECT array_agg(di.image_data ORDER BY di.created_at ASC, di.roworder ASC) as delivery_images FROM public.odg_tms_delivery_images di WHERE di.bill_no = a.bill_no) img ON true WHERE a.doc_date BETWEEN $1 AND $2 ${scope.scoped ? `AND s.transport_code IN (${scope.branchListSql})` : ""} ORDER BY a.roworder`, [fromDate, toDate]);
}

async function getReportMonthlyCar(session, monthly) {
  const scope = getBranchScope(session);
  await ensureForwardBranchColumn();
  return query(
    `SELECT
       a.car AS car_code,
       b.name_1 AS car,
       COALESCE(b.imei, '') AS imei,
       COUNT(a.doc_no)::int AS qty,
       COALESCE(MAX(gps.total_km), 0)::numeric AS total_km,
       to_char(a.doc_date,'MM') AS month,
       to_char(a.doc_date,'yyyy') AS year
     FROM odg_tms a
     LEFT JOIN public.odg_tms_car b ON b.code = a.car
     LEFT JOIN (
       SELECT imei, SUM(COALESCE(distance_km, 0))::numeric AS total_km
       FROM public.odg_tms_gps_daily
       WHERE to_char(usage_date, 'yyyy-MM') = $1
       GROUP BY imei
     ) gps ON gps.imei = NULLIF(TRIM(b.imei), '')
     WHERE to_char(a.doc_date,'yyyy-MM') = $1
       ${branchFilterJob(scope, "a")}
     GROUP BY a.car, b.name_1, b.imei, to_char(a.doc_date,'MM'), to_char(a.doc_date,'yyyy')
     ORDER BY COUNT(a.doc_no) DESC, b.name_1 ASC`,
    [monthly]
  );
}

async function getReportMonthlyDriver(session, monthly) {
  const { getTransportDepartmentEmployees } = require("./master-data");
  const scope = getBranchScope(session);
  const employees = await getTransportDepartmentEmployees();
  const jobBranchFilter = scope.scoped
    ? `AND EXISTS (
        SELECT 1 FROM public.odg_tms_detail __dd
        JOIN public.ic_trans_shipment __ss ON __ss.doc_no = __dd.bill_no
        WHERE __dd.doc_no = a.doc_no AND __ss.transport_code IN (${scope.branchListSql})
      )`
    : "";
  const counts = await query(
    `SELECT a.driver, COUNT(a.doc_no)::int AS qty
     FROM public.odg_tms a
     WHERE to_char(a.doc_date, 'yyyy-MM') = $1
       ${jobBranchFilter}
     GROUP BY a.driver`,
    [monthly]
  );
  const countMap = new Map();
  for (const row of counts) countMap.set(row.driver, Number(row.qty) || 0);

  const [year, month] = monthly.split("-");
  const result = employees.map((e) => ({
    driver: e.name_1,
    driver_code: e.code,
    qty: countMap.get(e.code) ?? 0,
    month,
    year,
  }));
  result.sort((a, b) => {
    const diff = b.qty - a.qty;
    if (diff !== 0) return diff;
    return a.driver.localeCompare(b.driver);
  });
  return result;
}

// Monthly delivery KPI for management review.
// The month is event-based:
//   opened    — closed bills with delivery in the month, using real open
//               timestamp from the shipment/sales bill
//               (ic_trans.create_date_time_now, shipment create timestamp,
//               then doc_date fallback).
//   assigned  — bills arranged into delivery trips in the month, using the
//               delivery detail creation timestamp. Some were opened in an
//               earlier month; those are carry_in.
//   carry_out — bills opened in the month but not completed before next month.
//   multi_round_bills — distinct bills touched in the month that have more
//               than one approved delivery detail across their history.
//   on_time   — delivered within 24h, measured two ways:
//               1) bill open time -> sent_end, denominator = opened
//               2) delivery date/start -> sent_end, denominator = assigned
// Only the three managed transport branches are included in delivery KPIs.
// 02-0001 is the Khua Luang/Odean branch in current master data.
const MONTHLY_DELIVERY_BRANCH_CODES = ["02-0001", "02-0002", "02-0003"];
const MONTHLY_DELIVERY_BRANCH_NAMES = {
  "02-0001": "ຂົນສົ່ງຂົວຫຼວງ",
  "02-0002": "ຂົນສົ່ງດອນຕິ້ວ",
  "02-0003": "ຂົນສົ່ງປາກເຊ",
};

async function getReportMonthlyDelivery(session, monthly) {
  const scope = getBranchScope(session);
  const monthStart = `${monthly}-01`;
  const [yearText, monthText] = monthly.split("-");
  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  const nextMonthStart =
    month === 12
      ? `${year + 1}-01-01`
      : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const branchCodeSql = MONTHLY_DELIVERY_BRANCH_CODES.map((code) => `'${code}'`).join(",");
  const openedBranchClause = scope.scoped ? `AND s.transport_code IN (${scope.branchListSql})` : "";
  const deliveredBranchClause = scope.scoped ? `AND s.transport_code IN (${scope.branchListSql})` : "";
  const rows = await query(
    `WITH params AS (
       SELECT $1::timestamp AS start_at, $2::timestamp AS end_at
     ),
     opened_source AS (
       SELECT
         s.doc_no AS bill_no,
         COALESCE(NULLIF(TRIM(s.transport_code), ''), 'unknown') AS branch_code,
         COALESCE(NULLIF(TRIM(sale_u.department::text), ''), 'unknown') AS department_code,
         COALESCE(
           NULLIF(TRIM(dep.name_1::text), ''),
           NULLIF(TRIM(sale_u.department::text), ''),
           'ບໍ່ລະບຸພະແນກ'
         ) AS department_name,
         ${BILL_OPENED_AT} AS opened_at,
         completed.sent_end AS completed_at,
         p.end_at AS month_end_at
       FROM public.ic_trans_shipment s
       LEFT JOIN public.ic_trans t ON t.doc_no = s.doc_no
       LEFT JOIN erp_user sale_u ON sale_u.code = t.sale_code
       LEFT JOIN erp_department_list dep ON dep.code = sale_u.department
       LEFT JOIN LATERAL (
         SELECT MIN(done.sent_end) AS sent_end
         FROM public.odg_tms_detail done
         LEFT JOIN public.odg_tms done_job ON done_job.doc_no = done.doc_no
         WHERE done.bill_no = s.doc_no
           AND done.status = 1
           AND done.sent_end IS NOT NULL
           AND COALESCE(done_job.approve_status,0) = 1
       ) completed ON true
       CROSS JOIN params p
       WHERE ${BILL_OPENED_AT} >= p.start_at
         AND ${BILL_OPENED_AT} < p.end_at
         AND s.transport_code IS NOT NULL
         AND s.transport_code IN (${branchCodeSql})
         ${openedBranchClause}
     ),
     opened_rollup AS (
       SELECT
         branch_code,
         COUNT(*)::int AS opened,
         COUNT(*) FILTER (WHERE completed_at IS NULL)::int AS pending,
         COUNT(*) FILTER (
           WHERE completed_at IS NULL
              OR completed_at >= month_end_at
         )::int AS carry_out,
         COUNT(*) FILTER (
           WHERE completed_at IS NOT NULL
             AND completed_at <= opened_at + INTERVAL '24 hours'
         )::int AS on_time_from_open,
         COUNT(*) FILTER (
           WHERE completed_at IS NULL
              OR completed_at > opened_at + INTERVAL '24 hours'
         )::int AS breach_from_open
       FROM opened_source
       GROUP BY branch_code
     ),
     department_opened_rollup AS (
       SELECT
         department_code,
         MAX(department_name) AS department_name,
         COUNT(*)::int AS opened,
         COUNT(*) FILTER (WHERE completed_at IS NULL)::int AS pending,
         COUNT(*) FILTER (
           WHERE completed_at IS NULL
              OR completed_at >= month_end_at
         )::int AS carry_out,
         COUNT(*) FILTER (
           WHERE completed_at IS NOT NULL
             AND completed_at <= opened_at + INTERVAL '24 hours'
         )::int AS on_time_from_open,
         COUNT(*) FILTER (
           WHERE completed_at IS NULL
              OR completed_at > opened_at + INTERVAL '24 hours'
         )::int AS breach_from_open
       FROM opened_source
       GROUP BY department_code
     ),
     assigned_source AS (
       SELECT
         d.bill_no,
         COALESCE(NULLIF(TRIM(s.transport_code), ''), 'unknown') AS branch_code,
         COALESCE(NULLIF(TRIM(sale_u.department::text), ''), 'unknown') AS department_code,
         COALESCE(
           NULLIF(TRIM(dep.name_1::text), ''),
           NULLIF(TRIM(sale_u.department::text), ''),
           'ບໍ່ລະບຸພະແນກ'
         ) AS department_name,
         d.status,
         d.sent_start,
         COALESCE(d.date_logistic::timestamp, a.date_logistic::timestamp, d.sent_start, a.dispatch_started_at) AS delivery_date_at,
         d.sent_end,
         ${BILL_OPENED_AT} AS bill_opened_at,
         COALESCE(history.delivery_rounds, 0) AS delivery_rounds,
         p.start_at AS month_start_at,
         p.end_at AS month_end_at
       FROM public.odg_tms_detail d
       LEFT JOIN public.odg_tms a ON a.doc_no = d.doc_no
       LEFT JOIN public.ic_trans_shipment s ON s.doc_no = d.bill_no
       LEFT JOIN public.ic_trans t ON t.doc_no = d.bill_no
       LEFT JOIN erp_user sale_u ON sale_u.code = t.sale_code
       LEFT JOIN erp_department_list dep ON dep.code = sale_u.department
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS delivery_rounds
         FROM public.odg_tms_detail hist
         LEFT JOIN public.odg_tms hist_job ON hist_job.doc_no = hist.doc_no
         WHERE hist.bill_no = d.bill_no
           AND COALESCE(hist_job.approve_status,0) = 1
       ) history ON true
       CROSS JOIN params p
       WHERE d.create_date_time_now >= p.start_at
         AND d.create_date_time_now < p.end_at
         AND COALESCE(a.approve_status,0) = 1
         AND COALESCE(NULLIF(TRIM(s.transport_code), ''), '') IN (${branchCodeSql})
         ${deliveredBranchClause}
     ),
     assigned_rollup AS (
       SELECT
         branch_code,
         COUNT(*)::int AS assigned,
         COUNT(DISTINCT bill_no)::int AS assigned_bills,
         COUNT(DISTINCT bill_no) FILTER (WHERE delivery_rounds > 1)::int AS multi_round_bills,
         COUNT(DISTINCT bill_no) FILTER (WHERE bill_opened_at < month_start_at)::int AS carry_in,
         COUNT(DISTINCT bill_no) FILTER (
           WHERE bill_opened_at >= month_start_at
             AND bill_opened_at < month_end_at
         )::int AS same_month_assigned,
         COUNT(*) FILTER (WHERE status = 1 AND sent_end IS NOT NULL)::int AS delivered,
         COUNT(*) FILTER (WHERE status = 2 AND sent_end IS NOT NULL)::int AS cancelled,
         COUNT(*) FILTER (
           WHERE status = 1
             AND sent_end IS NOT NULL
             AND delivery_date_at IS NOT NULL
             AND sent_end <= delivery_date_at + INTERVAL '24 hours'
         )::int AS on_time_from_start,
         COUNT(*) FILTER (
           WHERE NOT (
             status = 1
             AND sent_end IS NOT NULL
             AND delivery_date_at IS NOT NULL
             AND sent_end <= delivery_date_at + INTERVAL '24 hours'
           )
           AND COALESCE(status,0) <> 2
             AND (
               delivery_date_at IS NULL
               OR sent_end IS NULL
               OR sent_end > delivery_date_at + INTERVAL '24 hours'
             )
         )::int AS breach_from_start
       FROM assigned_source
       GROUP BY branch_code
     ),
     department_assigned_rollup AS (
       SELECT
         department_code,
         MAX(department_name) AS department_name,
         COUNT(*)::int AS assigned,
         COUNT(DISTINCT bill_no)::int AS assigned_bills,
         COUNT(DISTINCT bill_no) FILTER (WHERE delivery_rounds > 1)::int AS multi_round_bills,
         COUNT(DISTINCT bill_no) FILTER (WHERE bill_opened_at < month_start_at)::int AS carry_in,
         COUNT(DISTINCT bill_no) FILTER (
           WHERE bill_opened_at >= month_start_at
             AND bill_opened_at < month_end_at
         )::int AS same_month_assigned,
         COUNT(*) FILTER (WHERE status = 1 AND sent_end IS NOT NULL)::int AS delivered,
         COUNT(*) FILTER (WHERE status = 2 AND sent_end IS NOT NULL)::int AS cancelled,
         COUNT(*) FILTER (
           WHERE status = 1
             AND sent_end IS NOT NULL
             AND delivery_date_at IS NOT NULL
             AND sent_end <= delivery_date_at + INTERVAL '24 hours'
         )::int AS on_time_from_start,
         COUNT(*) FILTER (
           WHERE NOT (
             status = 1
             AND sent_end IS NOT NULL
             AND delivery_date_at IS NOT NULL
             AND sent_end <= delivery_date_at + INTERVAL '24 hours'
           )
           AND COALESCE(status,0) <> 2
             AND (
               delivery_date_at IS NULL
               OR sent_end IS NULL
               OR sent_end > delivery_date_at + INTERVAL '24 hours'
             )
         )::int AS breach_from_start
       FROM assigned_source
       GROUP BY department_code
     )
     SELECT
       'branch' AS dimension,
       COALESCE(o.branch_code, d.branch_code) AS branch_code,
       NULL::text AS department_code,
       NULL::text AS department_name,
       COALESCE(o.opened, 0)::int AS opened,
       COALESCE(d.assigned, 0)::int AS assigned,
       COALESCE(d.assigned_bills, 0)::int AS assigned_bills,
       COALESCE(d.multi_round_bills, 0)::int AS multi_round_bills,
       COALESCE(d.carry_in, 0)::int AS carry_in,
       COALESCE(d.same_month_assigned, 0)::int AS same_month_assigned,
       COALESCE(d.delivered, 0)::int AS delivered,
       COALESCE(o.pending, 0)::int AS pending,
       GREATEST(COALESCE(o.opened, 0) - COALESCE(d.same_month_assigned, 0), 0)::int AS carry_out,
       COALESCE(d.cancelled, 0)::int AS cancelled,
       COALESCE(o.on_time_from_open, 0)::int AS on_time_from_open,
       COALESCE(o.breach_from_open, 0)::int AS breach_from_open,
       COALESCE(d.on_time_from_start, 0)::int AS on_time_from_start,
       COALESCE(d.breach_from_start, 0)::int AS breach_from_start
     FROM opened_rollup o
     FULL JOIN assigned_rollup d USING (branch_code)
     UNION ALL
     SELECT
       'department' AS dimension,
       NULL::text AS branch_code,
       COALESCE(o.department_code, d.department_code) AS department_code,
       COALESCE(o.department_name, d.department_name, 'ບໍ່ລະບຸພະແນກ') AS department_name,
       COALESCE(o.opened, 0)::int AS opened,
       COALESCE(d.assigned, 0)::int AS assigned,
       COALESCE(d.assigned_bills, 0)::int AS assigned_bills,
       COALESCE(d.multi_round_bills, 0)::int AS multi_round_bills,
       COALESCE(d.carry_in, 0)::int AS carry_in,
       COALESCE(d.same_month_assigned, 0)::int AS same_month_assigned,
       COALESCE(d.delivered, 0)::int AS delivered,
       COALESCE(o.pending, 0)::int AS pending,
       GREATEST(COALESCE(o.opened, 0) - COALESCE(d.same_month_assigned, 0), 0)::int AS carry_out,
       COALESCE(d.cancelled, 0)::int AS cancelled,
       COALESCE(o.on_time_from_open, 0)::int AS on_time_from_open,
       COALESCE(o.breach_from_open, 0)::int AS breach_from_open,
       COALESCE(d.on_time_from_start, 0)::int AS on_time_from_start,
       COALESCE(d.breach_from_start, 0)::int AS breach_from_start
     FROM department_opened_rollup o
     FULL JOIN department_assigned_rollup d USING (department_code)
     ORDER BY dimension, branch_code, department_code`,
    [monthStart, nextMonthStart]
  );

  const branchNameRows = await query(
    `SELECT code, COALESCE(NULLIF(TRIM(name_1), ''), code) AS name
     FROM transport_type
     WHERE code = ANY($1::text[])`,
    [MONTHLY_DELIVERY_BRANCH_CODES]
  );
  const branchNames = {
    ...Object.fromEntries(branchNameRows.map((r) => [r.code, r.name])),
    ...MONTHLY_DELIVERY_BRANCH_NAMES,
  };

  const toEntry = (r) => ({
    opened: Number(r.opened) || 0,
    assigned: Number(r.assigned) || 0,
    assigned_bills: Number(r.assigned_bills) || 0,
    multi_round_bills: Number(r.multi_round_bills) || 0,
    carry_in: Number(r.carry_in) || 0,
    same_month_assigned: Number(r.same_month_assigned) || 0,
    delivered: Number(r.delivered) || 0,
    pending: Number(r.pending) || 0,
    carry_out: Number(r.carry_out) || 0,
    cancelled: Number(r.cancelled) || 0,
    on_time: Number(r.on_time_from_open) || 0,
    breach: Number(r.breach_from_open) || 0,
    on_time_from_open: Number(r.on_time_from_open) || 0,
    breach_from_open: Number(r.breach_from_open) || 0,
    on_time_from_start: Number(r.on_time_from_start) || 0,
    breach_from_start: Number(r.breach_from_start) || 0,
  });

  const overall = {
    opened: 0,
    assigned: 0,
    assigned_bills: 0,
    multi_round_bills: 0,
    carry_in: 0,
    same_month_assigned: 0,
    delivered: 0,
    pending: 0,
    carry_out: 0,
    cancelled: 0,
    on_time: 0,
    breach: 0,
    on_time_from_open: 0,
    breach_from_open: 0,
    on_time_from_start: 0,
    breach_from_start: 0,
  };
  const branchRows = rows.filter((r) => r.dimension === "branch");
  const departmentRows = rows.filter((r) => r.dimension === "department");

  const branches = branchRows.map((r) => {
    const code = String(r.branch_code || "").trim();
    const entry = {
      branch_code: code || "unknown",
      branch_name: (code && branchNames[code]) || code || "ບໍ່ລະບຸສາຂາ",
      ...toEntry(r),
    };
    for (const key of Object.keys(overall)) {
      overall[key] += Number(entry[key]) || 0;
    }
    return entry;
  });

  const departments = departmentRows.map((r) => ({
    department_code: String(r.department_code || "").trim() || "unknown",
    department_name: String(r.department_name || "").trim() || "ບໍ່ລະບຸພະແນກ",
    ...toEntry(r),
  }));

  branches.sort((a, b) => a.branch_code.localeCompare(b.branch_code));
  departments.sort((a, b) => {
    const assignedDiff = (Number(b.assigned) || 0) - (Number(a.assigned) || 0);
    if (assignedDiff !== 0) return assignedDiff;
    return a.department_name.localeCompare(b.department_name);
  });
  // ບິນຄ້າງສົ່ງແຕ່ລະມື້ — ນັບບິນທີ່ເປີດແຕ່ລະວັນ (ໃນເດືອນ) ແລະ ຍັງບໍ່ສຳເລັດ.
  const dailyRows = await query(
    `WITH params AS (SELECT $1::timestamp AS start_at, $2::timestamp AS end_at),
     opened_source AS (
       SELECT s.doc_no AS bill_no,
         ${BILL_OPENED_AT} AS opened_at,
         (SELECT MIN(done.sent_end) FROM public.odg_tms_detail done
            LEFT JOIN public.odg_tms done_job ON done_job.doc_no = done.doc_no
            WHERE done.bill_no = s.doc_no AND done.status = 1 AND done.sent_end IS NOT NULL
              AND COALESCE(done_job.approve_status,0) = 1) AS completed_at
       FROM public.ic_trans_shipment s
       LEFT JOIN public.ic_trans t ON t.doc_no = s.doc_no
       CROSS JOIN params p
       WHERE ${BILL_OPENED_AT} >= p.start_at
         AND ${BILL_OPENED_AT} < p.end_at
         AND s.transport_code IS NOT NULL
         AND s.transport_code IN (${branchCodeSql})
         ${openedBranchClause}
     )
     SELECT to_char(opened_at::date, 'YYYY-MM-DD') AS day,
            to_char(opened_at::date, 'DD/MM') AS day_label,
            COUNT(DISTINCT bill_no)::int AS opened,
            COUNT(DISTINCT bill_no) FILTER (WHERE completed_at IS NULL)::int AS pending,
            COUNT(DISTINCT bill_no) FILTER (WHERE completed_at IS NOT NULL)::int AS delivered
     FROM opened_source
     GROUP BY opened_at::date
     ORDER BY opened_at::date`,
    [monthStart, nextMonthStart]
  );
  const daily = dailyRows.map((r) => ({
    day: r.day,
    day_label: r.day_label,
    opened: Number(r.opened) || 0,
    pending: Number(r.pending) || 0,
    delivered: Number(r.delivered) || 0,
  }));

  // ສະຫຼຸບຕາມເຂດ (ນະຄອນຫຼວງ vs ຕ່າງແຂວງ) — ສະເລ່ຍ "ມື້ທີ່ຈັດສົ່ງສຳເລັດ"
  // ນັບຈາກ ວັນນັດຈັດສົ່ງ (date_logistic) ຫາ ວັນສຳເລັດ (sent_end). province '01' = ນະຄອນຫຼວງ.
  const zoneRows = await query(
    `WITH params AS (SELECT $1::timestamp AS start_at, $2::timestamp AS end_at),
     zone_source AS (
       SELECT d.bill_no,
         CASE WHEN TRIM(COALESCE(cust.province,'')) = '01' THEN 'ນະຄອນຫຼວງ' ELSE 'ຕ່າງແຂວງ' END AS zone,
         d.status,
         COALESCE(d.date_logistic::timestamp, a.date_logistic::timestamp, d.sent_start, a.dispatch_started_at) AS appt_at,
         ${BILL_OPENED_AT} AS bill_opened_at,
         d.sent_end
       FROM public.odg_tms_detail d
       LEFT JOIN public.odg_tms a ON a.doc_no = d.doc_no
       LEFT JOIN public.ic_trans_shipment s ON s.doc_no = d.bill_no
       LEFT JOIN public.ic_trans t ON t.doc_no = d.bill_no
       LEFT JOIN public.ar_customer cust ON cust.code = s.cust_code
       CROSS JOIN params p
       WHERE d.create_date_time_now >= p.start_at
         AND d.create_date_time_now < p.end_at
         AND COALESCE(a.approve_status,0) = 1
         AND COALESCE(NULLIF(TRIM(s.transport_code), ''), '') IN (${branchCodeSql})
         ${deliveredBranchClause}
     )
     SELECT zone,
       COUNT(DISTINCT bill_no)::int AS assigned_bills,
       COUNT(*) FILTER (WHERE status = 1 AND sent_end IS NOT NULL)::int AS delivered,
       COUNT(*) FILTER (
         WHERE status = 1 AND sent_end IS NOT NULL AND appt_at IS NOT NULL
           AND sent_end::date <= appt_at::date
       )::int AS on_time_appt,
       ROUND(AVG(sent_end::date - appt_at::date) FILTER (
         WHERE status = 1 AND sent_end IS NOT NULL AND appt_at IS NOT NULL
       ), 2) AS avg_days_from_appt,
       ROUND(AVG(sent_end::date - bill_opened_at::date) FILTER (
         WHERE status = 1 AND sent_end IS NOT NULL AND bill_opened_at IS NOT NULL
       ), 2) AS avg_days_from_open
     FROM zone_source
     GROUP BY zone`,
    [monthStart, nextMonthStart]
  );
  const zoneOrder = ["ນະຄອນຫຼວງ", "ຕ່າງແຂວງ"];
  const zones = zoneRows
    .map((r) => ({
      zone: r.zone,
      assigned_bills: Number(r.assigned_bills) || 0,
      delivered: Number(r.delivered) || 0,
      on_time_appt: Number(r.on_time_appt) || 0,
      avg_days_from_appt: r.avg_days_from_appt == null ? null : Number(r.avg_days_from_appt),
      avg_days_from_open: r.avg_days_from_open == null ? null : Number(r.avg_days_from_open),
    }))
    .sort((a, b) => zoneOrder.indexOf(a.zone) - zoneOrder.indexOf(b.zone));

  // ການນຳໃຊ້ລົດ — ຖ້ຽວທີ່ແລ່ນ, ລົດທີ່ໃຊ້ງານ, ສະເລ່ຍຖ້ຽວ/ຄັນ/ມື້ (job ທີ່ອະນຸມັດ
  // ແລະ ມີບິນຢູ່ສາຂາ KPI).
  const fleetRow = await queryOne(
    `WITH j AS (
       SELECT DISTINCT a.doc_no, a.car, a.create_date_time_now::date AS d
       FROM public.odg_tms a
       WHERE a.create_date_time_now >= $1::timestamp
         AND a.create_date_time_now < $2::timestamp
         AND COALESCE(a.approve_status,0) = 1
         AND COALESCE(NULLIF(TRIM(a.car), ''), '') <> ''
         AND EXISTS (
           SELECT 1 FROM public.odg_tms_detail dd
           LEFT JOIN public.ic_trans_shipment ss ON ss.doc_no = dd.bill_no
           WHERE dd.doc_no = a.doc_no
             AND COALESCE(NULLIF(TRIM(ss.transport_code), ''), '') IN (${branchCodeSql})
         )
     )
     SELECT COUNT(*)::int AS total_trips,
            COUNT(DISTINCT car)::int AS active_cars,
            COUNT(DISTINCT (car, d))::int AS car_days,
            ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT (car, d)), 0), 2) AS trips_per_car_per_day
     FROM j`,
    [monthStart, nextMonthStart]
  );
  const fleet = {
    total_trips: Number(fleetRow?.total_trips) || 0,
    active_cars: Number(fleetRow?.active_cars) || 0,
    car_days: Number(fleetRow?.car_days) || 0,
    trips_per_car_per_day:
      fleetRow?.trips_per_car_per_day == null ? null : Number(fleetRow.trips_per_car_per_day),
  };

  // ສັດສ່ວນການລັດຄິວ — ບິນທີ່ສົ່ງສຳເລັດ ໃນຂະນະທີ່ມີບິນ (ສາຂາດຽວກັນ) ທີ່ນັດໃຫ້
  // ສົ່ງກ່ອນ (appointment ກ່ອນ) ແຕ່ຍັງບໍ່ສຳເລັດ → ໄດ້ສົ່ງຂ້າມຄິວຄົນທີ່ຄວນໄດ້ກ່ອນ.
  const queueRow = await queryOne(
    `WITH bills AS (
       SELECT s.doc_no AS bill_no,
         COALESCE(NULLIF(TRIM(s.transport_code), ''), '') AS branch,
         (SELECT MIN(COALESCE(dd.date_logistic::timestamp, dd.sent_start))
            FROM public.odg_tms_detail dd
            LEFT JOIN public.odg_tms aa ON aa.doc_no = dd.doc_no
            WHERE dd.bill_no = s.doc_no AND COALESCE(aa.approve_status,0) = 1) AS appt_at,
         (SELECT MIN(dn.sent_end)
            FROM public.odg_tms_detail dn
            LEFT JOIN public.odg_tms dj ON dj.doc_no = dn.doc_no
            WHERE dn.bill_no = s.doc_no AND dn.status = 1 AND dn.sent_end IS NOT NULL
              AND COALESCE(dj.approve_status,0) = 1) AS completed_at
       FROM public.ic_trans_shipment s
       LEFT JOIN public.ic_trans t ON t.doc_no = s.doc_no
       WHERE ${BILL_OPENED_AT} >= $1::timestamp
         AND ${BILL_OPENED_AT} < $2::timestamp
         AND s.transport_code IS NOT NULL
         AND s.transport_code IN (${branchCodeSql})
         ${openedBranchClause}
     )
     SELECT
       COUNT(*) FILTER (WHERE completed_at IS NOT NULL)::int AS delivered,
       COUNT(*) FILTER (
         WHERE completed_at IS NOT NULL AND EXISTS (
           SELECT 1 FROM bills a
           WHERE a.branch = b.branch AND a.appt_at IS NOT NULL AND a.appt_at < b.appt_at
             AND (a.completed_at IS NULL OR a.completed_at > b.completed_at)
         )
       )::int AS jumped
     FROM bills b`,
    [monthStart, nextMonthStart]
  );
  const qDelivered = Number(queueRow?.delivered) || 0;
  const qJumped = Number(queueRow?.jumped) || 0;
  const queue = {
    delivered: qDelivered,
    jumped: qJumped,
    rate: qDelivered > 0 ? (qJumped / qDelivered) * 100 : 0,
  };

  return { month: monthly, overall, branches, departments, daily, zones, fleet, queue };
}

async function getMonthlyDeliveryKpi(session, monthly) {
  const report = await getReportMonthlyDelivery(session, monthly);
  return {
    branches: report.branches.map((branch) => {
      const opened = Number(branch.opened) || 0;
      return {
        branch_code: branch.branch_code,
        branch_name: branch.branch_name,
        opened,
        assigned: Number(branch.assigned) || 0,
        assigned_bills: Number(branch.assigned_bills) || 0,
        multi_round_bills: Number(branch.multi_round_bills) || 0,
        carry_in: Number(branch.carry_in) || 0,
        carry_out: Number(branch.carry_out) || 0,
        dispatched: Number(branch.assigned) || 0,
        delivered: Number(branch.delivered) || 0,
        pending: Number(branch.pending) || 0,
        kpi_success: Number(branch.on_time_from_open ?? branch.on_time) || 0,
        returns: 0,
        failed_closed: Number(branch.cancelled) || 0,
        avg_days_from_appt: null,
      };
    }),
    fleet: {
      active_vehicles: 0,
      active_drivers: 0,
      total_trips: 0,
      vehicle_days: 0,
    },
  };
}

// Daily pending-bills report grouped by sale department + transport branch.
// Reuses getBillsPending so the figures stay in sync with /bills-pending and
// the dashboard's "ຄ້າງສົ່ງ" tile — no duplicated WHERE clauses to drift.
//
// Returns:
//   { rows, days, departments, transports, totals }
//   - rows: per-bill records (date, department, transport, bill_no, ...)
//   - days/departments/transports: distinct sorted dimensions for filter UI
//   - totals: aggregate { bills, items, qty } for the whole range
async function getReportPendingDaily(session, fromDate, toDate) {
  const { getBillsPending } = require("./bills");
  const { trans } = await getBillsPending(session, fromDate, toDate, "all");

  const rows = trans.map((bill) => ({
    send_date: bill.send_date ?? null,
    send_date_display: bill.send_date_display ?? bill.send_date ?? "-",
    department: (bill.department && String(bill.department).trim()) || "(ບໍ່ກຳນົດພະແນກ)",
    transport_code: bill.transport_code ?? "",
    transport: (bill.transport && String(bill.transport).trim()) || "(ບໍ່ກຳນົດຂົນສົ່ງ)",
    doc_no: bill.doc_no,
    customer: bill.transport_name || bill.cust_name || bill.cust_code || "-",
    sale: bill.sale ?? "",
    remaining_count: Number(bill.remaining_count ?? 0),
    remaining_qty_total: Number(bill.remaining_qty_total ?? 0),
    scheduled_date_display: bill.scheduled_date_display ?? "",
    action_status: bill.action_status ?? "",
    source_type: bill.source_type ?? "ic_trans_shipment",
  }));

  const sortedUnique = (vals) => Array.from(new Set(vals)).sort();
  const totals = rows.reduce(
    (acc, r) => {
      acc.bills += 1;
      acc.items += r.remaining_count;
      acc.qty += r.remaining_qty_total;
      return acc;
    },
    { bills: 0, items: 0, qty: 0 }
  );

  return {
    rows,
    days: sortedUnique(rows.map((r) => r.send_date_display).filter(Boolean)),
    departments: sortedUnique(rows.map((r) => r.department)),
    transports: sortedUnique(rows.map((r) => r.transport)),
    totals,
  };
}

// Helper: per-bill rows for a given final status (1 = ສຳເລັດ, 2 = ຍົກເລີກ),
// grouped + filterable by sale department + transport branch the same way
// the pending report does. Driven by sent_end so partial deliveries on the
// same bill across multiple trips each count once per attempt.
async function getReportByDeliveryStatus(session, fromDate, toDate, status) {
  const scope = getBranchScope(session);
  const branchClause = scope.scoped
    ? `AND s.transport_code IN (${scope.branchListSql})`
    : "";
  const rows = await query(
    `SELECT
       to_char(d.sent_end, 'YYYY-MM-DD') AS finished_date,
       to_char(d.sent_end, 'DD-MM-YYYY') AS finished_date_display,
       to_char(d.sent_end, 'HH24:MI') AS finished_time,
       d.bill_no,
       d.doc_no,
       COALESCE(NULLIF(TRIM(cust.name_1), ''), d.cust_code, '-') AS customer,
       COALESCE(NULLIF(TRIM(dep.name_1::text), ''), NULLIF(TRIM(saleU.department::text), ''), '(ບໍ່ກຳນົດພະແນກ)') AS department,
       COALESCE(NULLIF(TRIM(saleU.name_1::text), ''), '') AS sale,
       COALESCE(NULLIF(TRIM(s.transport_code), ''), '') AS transport_code,
       COALESCE(NULLIF(TRIM(tt.name_1::text), ''), '(ບໍ່ກຳນົດຂົນສົ່ງ)') AS transport,
       COALESCE(NULLIF(TRIM(carT.name_1::text), ''), d.car, '-') AS car,
       COALESCE(NULLIF(TRIM(drvT.name_1::text), ''), j.driver, '-') AS driver,
       COALESCE(NULLIF(TRIM(d.count_item::text), ''), '0')::int AS item_count,
       COALESCE(d.remark, '') AS remark
     FROM public.odg_tms_detail d
     LEFT JOIN odg_tms j ON j.doc_no = d.doc_no
     LEFT JOIN public.ic_trans_shipment s ON s.doc_no = d.bill_no
     LEFT JOIN public.ic_trans ic ON ic.doc_no = d.bill_no
     LEFT JOIN erp_user saleU ON saleU.code = ic.sale_code
     LEFT JOIN erp_department_list dep ON dep.code = saleU.department
     LEFT JOIN public.transport_type tt ON tt.code = s.transport_code
     LEFT JOIN ar_customer cust ON cust.code = d.cust_code
     LEFT JOIN public.odg_tms_car carT ON carT.code = d.car
     LEFT JOIN public.odg_tms_driver drvT ON drvT.code = j.driver
     WHERE COALESCE(d.status, 0) = $3
       AND d.sent_end IS NOT NULL
       AND d.sent_end::date BETWEEN $1::date AND $2::date
       AND ${getFixedYearSqlFilter("d.doc_date")}
       ${branchClause}
     ORDER BY d.sent_end DESC, d.bill_no`,
    [fromDate, toDate, status]
  );

  const sortedUnique = (vals) => Array.from(new Set(vals)).sort();
  const totals = rows.reduce(
    (acc, r) => {
      acc.bills += 1;
      acc.items += Number(r.item_count) || 0;
      return acc;
    },
    { bills: 0, items: 0 }
  );
  return {
    rows,
    days: sortedUnique(rows.map((r) => r.finished_date_display)),
    departments: sortedUnique(rows.map((r) => r.department)),
    transports: sortedUnique(rows.map((r) => r.transport)),
    totals,
  };
}

async function getReportDeliveredDaily(session, fromDate, toDate) {
  return getReportByDeliveryStatus(session, fromDate, toDate, 1);
}

async function getReportCancelledDaily(session, fromDate, toDate) {
  return getReportByDeliveryStatus(session, fromDate, toDate, 2);
}

// Per-attempt items: what was loaded into this trip for this bill, and how
// much actually got delivered. Falls back to ic_trans_detail when the row
// table is empty (cancelled before pickup) so the UI can still show what
// the bill contained.
async function getAttemptDeliveryItems(docNo, billNo) {
  const items = await query(
    `SELECT i.item_code,
            i.item_name,
            COALESCE(i.qty, 0)::numeric AS qty,
            COALESCE(i.selected_qty, 0)::numeric AS selected_qty,
            COALESCE(i.delivered_qty, 0)::numeric AS delivered_qty,
            i.unit_code
     FROM public.odg_tms_detail_item i
     WHERE i.doc_no = $1 AND i.bill_no = $2
     ORDER BY i.roworder NULLS LAST, i.item_code`,
    [docNo, billNo]
  );
  if (items.length > 0) return items;
  return query(
    `SELECT t.item_code,
            MAX(t.item_name) AS item_name,
            SUM(COALESCE(t.qty, 0))::numeric AS qty,
            SUM(COALESCE(t.qty, 0))::numeric AS selected_qty,
            0::numeric AS delivered_qty,
            MAX(t.unit_code) AS unit_code
     FROM ic_trans_detail t
     WHERE t.doc_no = $1 AND t.item_code NOT LIKE '97%'
     GROUP BY t.item_code
     ORDER BY t.item_code`,
    [billNo]
  );
}

// Daily-activity movement summary over a date range — a flow ledger for the
// delivery pipeline, expressed as: ຍອດຍົກມາ + ເປີດບິນ − ຈັດສົ່ງ = ຄົງເຫຼືອ.
//   ຄົງເຫຼືອ (remaining) — pending RIGHT NOW. MUST equal the bills-pending page,
//      so it is taken verbatim from getBillsPending (the canonical pending list),
//      NOT recomputed here — earlier recomputation inflated it badly.
//   ເປີດບິນ (opened)    — sale bills (trans_flag=44) opened in [from,to] by doc_date.
//   ຈັດສົ່ງ (delivered) — bills with a completed customer delivery (odg_tms_detail
//      status=1, bill level) whose final sent_end falls in [from,to]. Bill level,
//      not item level, so bills delivered without item-detail rows still count.
//   ຍອດຍົກມາ (carry_in) — DERIVED so the ledger balances: remaining + delivered −
//      opened (= pending at the start of the window). Keeps ຄົງເຫຼືອ exact.
// Quantities mirror the same buckets: remaining = canonical remaining_qty_total,
// opened = bill net qty (goods minus trans_flag=48 returns), delivered = units
// actually handed over. Returns are netted so a fully-returned bill drops out.
async function getReportDailyActivity(session, fromDate, toDate) {
  const scope = getBranchScope(session);
  await ensureForwardBranchColumn();
  const branchList = scope.scoped
    ? scope.branchListSql
    : MONTHLY_DELIVERY_BRANCH_CODES.map((c) => `'${c}'`).join(", ");

  // ── ຄົງເຫຼືອ / ຄ້າງສົ່ງ : reuse the canonical pending list so the number is
  // byte-for-byte the same as the bills-pending page (pending as of toDate). ──
  const { getBillsPending } = require("./bills.js");
  const { FIXED_YEAR_START, FIXED_YEAR_END } = require("../lib/fixed-year");
  // Full-year window = exactly what the bills-pending page passes, so the count
  // equals the page's current "ຄ້າງສົ່ງ" total (e.g. 86) regardless of the
  // report's date filter — pending is a "right now" figure, not date-sliced.
  const pending = await getBillsPending(session, FIXED_YEAR_START, FIXED_YEAR_END, "all");
  const pendingRows = (pending && pending.trans) || [];
  const pendingByBranch = new Map();
  for (const row of pendingRows) {
    const code = (row.transport_code || "").trim();
    const cur = pendingByBranch.get(code) || { bills: 0, qty: 0 };
    cur.bills += 1;
    cur.qty += Number(row.remaining_qty_total ?? 0);
    pendingByBranch.set(code, cur);
  }

  // ── ເປີດບິນ + ຈັດສົ່ງ per branch (sale bills with deliverable goods) ──
  const flowRows = await query(
    `WITH sale_bills AS (
      SELECT a.doc_no,
             b.doc_date::date AS doc_date,
             COALESCE(NULLIF(TRIM(pb.transport_code), ''), a.transport_code) AS branch_code
      FROM ic_trans_shipment a
      JOIN ic_trans b ON b.doc_no = a.doc_no
      LEFT JOIN public.odg_tms_pending_bill pb ON pb.bill_no = a.doc_no
      WHERE a.trans_flag = 44
        AND b.doc_date::date <= $2::date
        AND ${getFixedYearSqlFilter("a.doc_date")}
        AND COALESCE(NULLIF(TRIM(pb.transport_code), ''), a.transport_code) IN (${branchList})
    ),
    bill_items AS (
      SELECT d.doc_no AS bill_no, SUM(COALESCE(d.qty, 0))::numeric AS total_qty
      FROM ic_trans_detail d
      WHERE d.item_code NOT LIKE '97%'
        AND d.doc_no IN (SELECT doc_no FROM sale_bills)
      GROUP BY d.doc_no
    ),
    returned AS (
      SELECT rd.ref_doc_no AS bill_no, SUM(ABS(COALESCE(rd.qty, 0)))::numeric AS returned_qty
      FROM ic_trans_detail rd
      JOIN ic_trans r ON r.doc_no = rd.doc_no AND r.trans_flag = 48
      WHERE rd.item_code NOT LIKE '97%'
        AND rd.ref_doc_no IN (SELECT doc_no FROM sale_bills)
      GROUP BY rd.ref_doc_no
    ),
    del_dates AS (
      -- Bill-level completion: the last finished customer delivery for the bill.
      SELECT d.bill_no, MAX(d.sent_end) AS last_sent_end
      FROM public.odg_tms_detail d
      WHERE COALESCE(d.status, 0) = 1
        AND NULLIF(TRIM(d.forward_transport_code), '') IS NULL
        AND d.bill_no IN (SELECT doc_no FROM sale_bills)
      GROUP BY d.bill_no
    ),
    del_units AS (
      SELECT item.bill_no,
             SUM(CASE WHEN COALESCE(item.delivered_qty, 0) = 0
                      THEN COALESCE(item.selected_qty, 0)
                      ELSE COALESCE(item.delivered_qty, 0) END)::numeric AS units
      FROM public.odg_tms_detail_item item
      JOIN public.odg_tms_detail det
        ON det.bill_no = item.bill_no AND det.doc_no = item.doc_no
      WHERE COALESCE(det.status, 0) = 1
        AND NULLIF(TRIM(det.forward_transport_code), '') IS NULL
        AND item.bill_no IN (SELECT doc_no FROM sale_bills)
      GROUP BY item.bill_no
    ),
    calc AS (
      SELECT sb.branch_code, sb.doc_date,
             GREATEST(COALESCE(bi.total_qty, 0) - COALESCE(rt.returned_qty, 0), 0)::numeric AS net_total,
             dd.last_sent_end::date AS completion_date,
             COALESCE(du.units, 0)::numeric AS delivered_units
      FROM sale_bills sb
      LEFT JOIN bill_items bi ON bi.bill_no = sb.doc_no
      LEFT JOIN returned rt ON rt.bill_no = sb.doc_no
      LEFT JOIN del_dates dd ON dd.bill_no = sb.doc_no
      LEFT JOIN del_units du ON du.bill_no = sb.doc_no
    )
    SELECT branch_code,
      COUNT(*) FILTER (WHERE doc_date BETWEEN $1::date AND $2::date)::int AS opened_bills,
      COALESCE(SUM(net_total) FILTER (WHERE doc_date BETWEEN $1::date AND $2::date), 0)::numeric AS opened_qty,
      COUNT(*) FILTER (WHERE completion_date BETWEEN $1::date AND $2::date)::int AS delivered_bills,
      COALESCE(SUM(LEAST(delivered_units, net_total)) FILTER (WHERE completion_date BETWEEN $1::date AND $2::date), 0)::numeric AS delivered_qty
    FROM calc
    WHERE net_total > 0
    GROUP BY branch_code`,
    [fromDate, toDate]
  );
  const flowByBranch = new Map(flowRows.map((r) => [r.branch_code, r]));

  const codes = scope.scoped ? scope.branches : MONTHLY_DELIVERY_BRANCH_CODES;
  // Pull live branch names from transport_type — the hardcoded
  // MONTHLY_DELIVERY_BRANCH_NAMES map is stale (02-0001 is "ຂົນສົ່ງໂອດ່ຽນ" now).
  const nameRows = codes.length
    ? await query(
        `SELECT code, COALESCE(NULLIF(TRIM(name_1), ''), code) AS name_1
         FROM transport_type WHERE code = ANY($1::varchar[])`,
        [codes]
      )
    : [];
  const nameMap = new Map(nameRows.map((r) => [r.code, r.name_1]));

  const build = (code) => {
    const f = flowByBranch.get(code);
    const p = pendingByBranch.get(code) || { bills: 0, qty: 0 };
    const openedBills = Number(f?.opened_bills ?? 0);
    const deliveredBills = Number(f?.delivered_bills ?? 0);
    const remainingBills = Number(p.bills);
    const openedQty = Number(f?.opened_qty ?? 0);
    const deliveredQty = Number(f?.delivered_qty ?? 0);
    const remainingQty = Number(p.qty);
    return {
      branch_code: code,
      branch_name: nameMap.get(code) ?? MONTHLY_DELIVERY_BRANCH_NAMES[code] ?? code,
      // ຍອດຍົກມາ derived so the ledger balances with the canonical ຄົງເຫຼືອ.
      carry_bills: remainingBills + deliveredBills - openedBills,
      opened_bills: openedBills,
      delivered_bills: deliveredBills,
      remaining_bills: remainingBills,
      carry_qty: remainingQty + deliveredQty - openedQty,
      opened_qty: openedQty,
      delivered_qty: deliveredQty,
      remaining_qty: remainingQty,
    };
  };
  const branches = codes.map((code) => build(code));
  const total = branches.reduce(
    (acc, b) => {
      acc.carry_bills += b.carry_bills;
      acc.opened_bills += b.opened_bills;
      acc.delivered_bills += b.delivered_bills;
      acc.remaining_bills += b.remaining_bills;
      acc.carry_qty += b.carry_qty;
      acc.opened_qty += b.opened_qty;
      acc.delivered_qty += b.delivered_qty;
      acc.remaining_qty += b.remaining_qty;
      return acc;
    },
    {
      carry_bills: 0, opened_bills: 0, delivered_bills: 0, remaining_bills: 0,
      carry_qty: 0, opened_qty: 0, delivered_qty: 0, remaining_qty: 0,
    }
  );
  return { fromDate, toDate, branches, total };
}

// Same movement ledger as getReportDailyActivity — ຍອດຍົກມາ + ເປີດບິນ − ຈັດສົ່ງ
// = ຄົງເຫຼືອ — but bucketed by the SALE department that opened the bill instead
// of the transport branch that carries it, and returning bill counts AND
// product quantities side by side in one row (the branch report splits those
// across two pages).
//   ຄົງເຫຼືອ (remaining) — pending RIGHT NOW, taken verbatim from the canonical
//      getBillsPending list so the total matches the bills-pending page.
//   ເປີດບິນ (opened)     — sale bills (trans_flag=44) with doc_date in [from,to].
//   ຈັດສົ່ງ (delivered)  — bills whose final customer delivery (odg_tms_detail
//      status=1) completed in [from,to]; qty = units actually handed over.
//   ຍອດຍົກມາ (carry_in)  — DERIVED (remaining + delivered − opened) so the ledger
//      balances against the canonical ຄົງເຫຼືອ.
// The department label is derived exactly the way the pending list derives it
// (odg_employee → odg_department), so both sources fall into identical buckets.
// salesOnly (default) keeps just the sale departments — odg_department rows in
// division 200, i.e. ພະແນກຂາຍ* 201-208 — dropping production / service / office
// departments and bills whose salesperson has no department at all.
const UNASSIGNED_DEPARTMENT = "(ບໍ່ກຳນົດພະແນກ)";
const SALES_DIVISION_CODE = "200";

async function getReportDailyDepartment(
  session,
  fromDate,
  toDate,
  salesOnly = true,
  transportCode = ""
) {
  const scope = getBranchScope(session);
  await ensureForwardBranchColumn();
  // Branches this report may cover: the user's own when they are branch-scoped,
  // otherwise the three delivery branches the ledger is defined over.
  const allowedBranches = scope.scoped ? scope.branches : MONTHLY_DELIVERY_BRANCH_CODES;
  // ສາຂາຂົນສົ່ງ filter — ignored when it names a branch outside the caller's
  // scope, so the parameter can never widen what a branch user may see.
  const picked = String(transportCode ?? "").trim();
  const selectedBranch = allowedBranches.includes(picked) ? picked : "";
  const activeBranches = selectedBranch ? [selectedBranch] : allowedBranches;
  const branchList = activeBranches
    .map((c) => `'${String(c).replace(/'/g, "''")}'`)
    .join(", ");

  // Department master: gives the sales-division whitelist (matched by NAME,
  // because the pending list only carries the display name) and the code used
  // to order the rows the way the org chart does (201, 202, ...).
  const deptRows = await query(
    `SELECT department_code,
            COALESCE(NULLIF(TRIM(department_name_lo), ''), department_code) AS name,
            COALESCE(NULLIF(TRIM(division_code), ''), '') AS division_code
     FROM public.odg_department`
  );
  const codeByName = new Map(deptRows.map((r) => [r.name, r.department_code]));
  const salesNames = new Set(
    deptRows
      .filter((r) => r.division_code === SALES_DIVISION_CODE)
      .map((r) => r.name)
  );
  const isIncluded = (name) => !salesOnly || salesNames.has(name);

  // ── ຄົງເຫຼືອ / ຄ້າງສົ່ງ : canonical pending list, grouped by department ──
  const { getBillsPending } = require("./bills.js");
  const { FIXED_YEAR_START, FIXED_YEAR_END } = require("../lib/fixed-year");
  const pending = await getBillsPending(session, FIXED_YEAR_START, FIXED_YEAR_END, "all");
  const pendingRows = (pending && pending.trans) || [];
  const pendingByDept = new Map();
  for (const row of pendingRows) {
    // The pending list is session-scoped, not filtered by the picked branch —
    // apply the same ສາຂາ filter the flow query uses, or ຄົງເຫຼືອ would keep
    // counting every branch while ເປີດບິນ / ຈັດສົ່ງ show only one.
    if (selectedBranch && (row.transport_code || "").trim() !== selectedBranch) continue;
    const dept = (row.department && String(row.department).trim()) || UNASSIGNED_DEPARTMENT;
    if (!isIncluded(dept)) continue;
    const cur = pendingByDept.get(dept) || { bills: 0, qty: 0 };
    cur.bills += 1;
    cur.qty += Number(row.remaining_qty_total ?? 0);
    pendingByDept.set(dept, cur);
  }

  // ── ເປີດບິນ + ຈັດສົ່ງ per department ──
  const flowRows = await query(
    `WITH sale_bills AS (
      SELECT a.doc_no,
             b.doc_date::date AS doc_date,
             COALESCE(
               NULLIF(TRIM(od.department_name_lo), ''),
               NULLIF(TRIM(oe.department_code::text), ''),
               '${UNASSIGNED_DEPARTMENT}'
             ) AS department
      FROM ic_trans_shipment a
      JOIN ic_trans b ON b.doc_no = a.doc_no
      LEFT JOIN public.odg_tms_pending_bill pb ON pb.bill_no = a.doc_no
      LEFT JOIN public.odg_employee oe ON oe.employee_code = b.sale_code
      LEFT JOIN public.odg_department od ON od.department_code = oe.department_code
      WHERE a.trans_flag = 44
        AND b.doc_date::date <= $2::date
        AND ${getFixedYearSqlFilter("a.doc_date")}
        AND COALESCE(NULLIF(TRIM(pb.transport_code), ''), a.transport_code) IN (${branchList})
        ${salesOnly ? `AND TRIM(od.division_code) = '${SALES_DIVISION_CODE}'` : ""}
    ),
    bill_items AS (
      SELECT d.doc_no AS bill_no, SUM(COALESCE(d.qty, 0))::numeric AS total_qty
      FROM ic_trans_detail d
      WHERE d.item_code NOT LIKE '97%'
        AND d.doc_no IN (SELECT doc_no FROM sale_bills)
      GROUP BY d.doc_no
    ),
    returned AS (
      SELECT rd.ref_doc_no AS bill_no, SUM(ABS(COALESCE(rd.qty, 0)))::numeric AS returned_qty
      FROM ic_trans_detail rd
      JOIN ic_trans r ON r.doc_no = rd.doc_no AND r.trans_flag = 48
      WHERE rd.item_code NOT LIKE '97%'
        AND rd.ref_doc_no IN (SELECT doc_no FROM sale_bills)
      GROUP BY rd.ref_doc_no
    ),
    del_dates AS (
      -- Bill-level completion: the last finished customer delivery for the bill.
      SELECT d.bill_no, MAX(d.sent_end) AS last_sent_end
      FROM public.odg_tms_detail d
      WHERE COALESCE(d.status, 0) = 1
        AND NULLIF(TRIM(d.forward_transport_code), '') IS NULL
        AND d.bill_no IN (SELECT doc_no FROM sale_bills)
      GROUP BY d.bill_no
    ),
    del_units AS (
      SELECT item.bill_no,
             SUM(CASE WHEN COALESCE(item.delivered_qty, 0) = 0
                      THEN COALESCE(item.selected_qty, 0)
                      ELSE COALESCE(item.delivered_qty, 0) END)::numeric AS units
      FROM public.odg_tms_detail_item item
      JOIN public.odg_tms_detail det
        ON det.bill_no = item.bill_no AND det.doc_no = item.doc_no
      WHERE COALESCE(det.status, 0) = 1
        AND NULLIF(TRIM(det.forward_transport_code), '') IS NULL
        AND item.bill_no IN (SELECT doc_no FROM sale_bills)
      GROUP BY item.bill_no
    ),
    calc AS (
      SELECT sb.department, sb.doc_date,
             GREATEST(COALESCE(bi.total_qty, 0) - COALESCE(rt.returned_qty, 0), 0)::numeric AS net_total,
             dd.last_sent_end::date AS completion_date,
             COALESCE(du.units, 0)::numeric AS delivered_units
      FROM sale_bills sb
      LEFT JOIN bill_items bi ON bi.bill_no = sb.doc_no
      LEFT JOIN returned rt ON rt.bill_no = sb.doc_no
      LEFT JOIN del_dates dd ON dd.bill_no = sb.doc_no
      LEFT JOIN del_units du ON du.bill_no = sb.doc_no
    )
    SELECT department,
      COUNT(*) FILTER (WHERE doc_date BETWEEN $1::date AND $2::date)::int AS opened_bills,
      COALESCE(SUM(net_total) FILTER (WHERE doc_date BETWEEN $1::date AND $2::date), 0)::numeric AS opened_qty,
      COUNT(*) FILTER (WHERE completion_date BETWEEN $1::date AND $2::date)::int AS delivered_bills,
      COALESCE(SUM(LEAST(delivered_units, net_total)) FILTER (WHERE completion_date BETWEEN $1::date AND $2::date), 0)::numeric AS delivered_qty
    FROM calc
    WHERE net_total > 0
    GROUP BY department`,
    [fromDate, toDate]
  );
  const flowByDept = new Map(flowRows.map((r) => [r.department, r]));

  // A department shows up if it has movement in the window OR still has bills
  // pending — either way it belongs on the report. In sales-only mode every
  // sale department is listed even when it had no movement at all, so the
  // reader can see the zero rather than wonder whether it was dropped.
  const names = Array.from(
    new Set([
      ...(salesOnly ? salesNames : []),
      ...flowByDept.keys(),
      ...pendingByDept.keys(),
    ])
  ).sort((a, b) => {
    const ca = codeByName.get(a) ?? "zzz";
    const cb = codeByName.get(b) ?? "zzz";
    return ca.localeCompare(cb) || a.localeCompare(b, "lo");
  });

  const departments = names.map((name) => {
    const f = flowByDept.get(name);
    const p = pendingByDept.get(name) || { bills: 0, qty: 0 };
    const openedBills = Number(f?.opened_bills ?? 0);
    const deliveredBills = Number(f?.delivered_bills ?? 0);
    const remainingBills = Number(p.bills);
    const openedQty = Number(f?.opened_qty ?? 0);
    const deliveredQty = Number(f?.delivered_qty ?? 0);
    const remainingQty = Number(p.qty);
    return {
      department: name,
      department_code: codeByName.get(name) ?? "",
      carry_bills: remainingBills + deliveredBills - openedBills,
      opened_bills: openedBills,
      delivered_bills: deliveredBills,
      remaining_bills: remainingBills,
      carry_qty: remainingQty + deliveredQty - openedQty,
      opened_qty: openedQty,
      delivered_qty: deliveredQty,
      remaining_qty: remainingQty,
    };
  });

  const total = departments.reduce(
    (acc, d) => {
      acc.carry_bills += d.carry_bills;
      acc.opened_bills += d.opened_bills;
      acc.delivered_bills += d.delivered_bills;
      acc.remaining_bills += d.remaining_bills;
      acc.carry_qty += d.carry_qty;
      acc.opened_qty += d.opened_qty;
      acc.delivered_qty += d.delivered_qty;
      acc.remaining_qty += d.remaining_qty;
      return acc;
    },
    {
      carry_bills: 0, opened_bills: 0, delivered_bills: 0, remaining_bills: 0,
      carry_qty: 0, opened_qty: 0, delivered_qty: 0, remaining_qty: 0,
    }
  );
  // Branch picker options come from the query itself so the dropdown can never
  // offer a branch this report (or this user) doesn't cover.
  const branchNameRows = allowedBranches.length
    ? await query(
        `SELECT code, COALESCE(NULLIF(TRIM(name_1), ''), code) AS name
         FROM transport_type WHERE code = ANY($1::varchar[])`,
        [allowedBranches]
      )
    : [];
  const branchNames = new Map(branchNameRows.map((r) => [r.code, r.name]));
  const branchOptions = allowedBranches.map((code) => ({
    code,
    name: branchNames.get(code) ?? MONTHLY_DELIVERY_BRANCH_NAMES[code] ?? code,
  }));

  return {
    fromDate,
    toDate,
    salesOnly,
    transportCode: selectedBranch,
    branchOptions,
    departments,
    total,
  };
}

// Bills behind one cell of the daily-activity report. The report only shows
// totals, so a figure that looks wrong is impossible to check — this returns
// the actual rows for a branch + bucket.
//
// bucket: opened | delivered | remaining. ຍອດຍົກມາ (carry) is DERIVED
// (remaining + delivered − opened) and has no bill list of its own.
async function getReportDailyActivityBills(session, fromDate, toDate, branchCode, bucket, department) {
  // department (optional) narrows to one sale department — used by the
  // ແຍກຕາມພະແນກ report, which shows the same buckets split that way.
  const dept = String(department ?? "").trim();
  const scope = getBranchScope(session);
  await ensureForwardBranchColumn();
  const allowed = scope.scoped ? scope.branches : MONTHLY_DELIVERY_BRANCH_CODES;
  const branch = String(branchCode ?? "").trim();
  const branchList = (allowed.includes(branch) ? [branch] : allowed)
    .map((c) => `'${String(c).replace(/'/g, "''")}'`)
    .join(", ");
  const kind = ["opened", "delivered", "remaining"].includes(String(bucket))
    ? String(bucket)
    : "opened";

  if (kind === "remaining") {
    // ຄົງເຫຼືອ is whatever the canonical pending list says right now — same
    // source the report totals use, so the rows always add up to the figure.
    const { getBillsPending } = require("./bills.js");
    const { FIXED_YEAR_START, FIXED_YEAR_END } = require("../lib/fixed-year");
    const pending = await getBillsPending(session, FIXED_YEAR_START, FIXED_YEAR_END, "all");
    return ((pending && pending.trans) || [])
      .filter((r) => !branch || (r.transport_code || "").trim() === branch)
      .filter((r) => !dept || (r.department || "").trim() === dept)
      .map((r) => ({
        bill_no: r.doc_no,
        doc_date: r.doc_date,
        cust_name: r.transport_name || r.cust_name || r.cust_code || "-",
        cust_area: r.cust_area || "",
        sale: r.sale || "",
        department: r.department || "",
        qty: Number(r.remaining_qty_total ?? 0),
        item_count: Number(r.remaining_count ?? 0),
        note: r.scheduled_date_display ? `ນັດ ${r.scheduled_date_display}` : "",
      }));
  }

  const dateCol = kind === "opened" ? "sb.doc_date" : "dd.completion_date";
  return query(
    `WITH sale_bills AS (
      SELECT a.doc_no,
             b.doc_date::date AS doc_date,
             COALESCE(NULLIF(TRIM(pb.transport_code), ''), a.transport_code) AS branch_code
      FROM ic_trans_shipment a
      JOIN ic_trans b ON b.doc_no = a.doc_no
      LEFT JOIN public.odg_tms_pending_bill pb ON pb.bill_no = a.doc_no
      WHERE a.trans_flag = 44
        AND b.doc_date::date <= $2::date
        AND ${getFixedYearSqlFilter("a.doc_date")}
        AND COALESCE(NULLIF(TRIM(pb.transport_code), ''), a.transport_code) IN (${branchList})
    ),
    bill_items AS (
      SELECT d.doc_no AS bill_no, SUM(COALESCE(d.qty, 0))::numeric AS total_qty,
             COUNT(DISTINCT d.item_code)::int AS item_count
      FROM ic_trans_detail d
      WHERE d.item_code NOT LIKE '97%' AND d.doc_no IN (SELECT doc_no FROM sale_bills)
      GROUP BY d.doc_no
    ),
    returned AS (
      SELECT rd.ref_doc_no AS bill_no, SUM(ABS(COALESCE(rd.qty, 0)))::numeric AS returned_qty
      FROM ic_trans_detail rd
      JOIN ic_trans r ON r.doc_no = rd.doc_no AND r.trans_flag = 48
      WHERE rd.item_code NOT LIKE '97%' AND rd.ref_doc_no IN (SELECT doc_no FROM sale_bills)
      GROUP BY rd.ref_doc_no
    ),
    del_dates AS (
      SELECT d.bill_no, MAX(d.sent_end)::date AS completion_date
      FROM public.odg_tms_detail d
      WHERE COALESCE(d.status, 0) = 1
        AND NULLIF(TRIM(d.forward_transport_code), '') IS NULL
        AND d.bill_no IN (SELECT doc_no FROM sale_bills)
      GROUP BY d.bill_no
    )
    SELECT sb.doc_no AS bill_no,
           to_char(sb.doc_date, 'DD-MM-YYYY') AS doc_date,
           COALESCE(NULLIF(TRIM(cust.name_1), ''), s.cust_code, '-') AS cust_name,
           ${customerAreaSql("s.cust_code")} AS cust_area,
           COALESCE(NULLIF(TRIM(oe.fullname_lo), ''), NULLIF(TRIM(oe.nickname), ''), ic.sale_code, '') AS sale,
           COALESCE(NULLIF(TRIM(od.department_name_lo), ''), '') AS department,
           GREATEST(COALESCE(bi.total_qty, 0) - COALESCE(rt.returned_qty, 0), 0)::numeric AS qty,
           COALESCE(bi.item_count, 0) AS item_count,
           COALESCE(to_char(dd.completion_date, 'DD-MM-YYYY'), '') AS note
    FROM sale_bills sb
    LEFT JOIN ic_trans_shipment s ON s.doc_no = sb.doc_no
    LEFT JOIN ic_trans ic ON ic.doc_no = sb.doc_no
    LEFT JOIN ar_customer cust ON cust.code = s.cust_code
    LEFT JOIN public.odg_employee oe ON oe.employee_code = ic.sale_code
    LEFT JOIN public.odg_department od ON od.department_code = oe.department_code
    LEFT JOIN bill_items bi ON bi.bill_no = sb.doc_no
    LEFT JOIN returned rt ON rt.bill_no = sb.doc_no
    LEFT JOIN del_dates dd ON dd.bill_no = sb.doc_no
    WHERE GREATEST(COALESCE(bi.total_qty, 0) - COALESCE(rt.returned_qty, 0), 0) > 0
      AND ${dateCol} BETWEEN $1::date AND $2::date
      ${dept ? `AND COALESCE(NULLIF(TRIM(od.department_name_lo), ''), '') = $3` : ""}
    ORDER BY ${dateCol}, sb.doc_no`,
    dept ? [fromDate, toDate, dept] : [fromDate, toDate]
  );
}

// Same three buckets as getReportDailyActivityBills, but exploded to one row
// per product line — what the dispatcher exports when they need to see the
// goods, not just the bill count.
async function getReportDailyActivityItems(session, fromDate, toDate, branchCode, bucket, department) {
  const bills = await getReportDailyActivityBills(session, fromDate, toDate, branchCode, bucket, department);
  const billNos = bills.map((b) => b.bill_no).filter(Boolean);
  if (billNos.length === 0) return [];
  const meta = new Map(bills.map((b) => [b.bill_no, b]));
  const rows = await query(
    `SELECT d.doc_no AS bill_no,
            d.item_code,
            MAX(d.item_name) AS item_name,
            SUM(COALESCE(d.qty, 0))::numeric AS qty,
            MAX(d.unit_code) AS unit_code
     FROM ic_trans_detail d
     WHERE d.doc_no = ANY($1::varchar[]) AND d.item_code NOT LIKE '97%'
     GROUP BY d.doc_no, d.item_code
     ORDER BY d.doc_no, d.item_code`,
    [billNos]
  );
  return rows.map((r) => {
    const b = meta.get(r.bill_no) ?? {};
    return {
      bill_no: r.bill_no,
      doc_date: b.doc_date ?? "",
      cust_name: b.cust_name ?? "",
      cust_area: b.cust_area ?? "",
      sale: b.sale ?? "",
      department: b.department ?? "",
      item_code: r.item_code,
      item_name: r.item_name,
      qty: Number(r.qty ?? 0),
      unit_code: r.unit_code ?? "",
      note: b.note ?? "",
    };
  });
}

// ══════════════════════════════════════════════════════════════════════════
// ລາຍງານປະສິດທິພາບການຈັດສົ່ງ (ຕໍ່ເດືອນ)
//
// ຕ່າງຈາກ getReportMonthlyDelivery ຢູ່ບ່ອນ: ອັນນີ້ຄິດເປັນ "ຍອດຍົກມາ →
// ເປີດໃນເດືອນ → ສົ່ງສຳເລັດ → ຍອດຍົກໄປ" ຄືບັນຊີ ແລະ ແຍກເວລານຳສົ່ງເປັນຊັ້ນ
// (≤24h / 24–48h / >48h) ແທນທີ່ຈະເປັນແຄ່ ທັນ/ບໍ່ທັນ.
//
// ສົມຜົນທີ່ຮັບປະກັນ: carry_in + opened − delivered = carry_out
// (ພິສູດໄດ້ຈາກນິຍາມ: ທຸກບິນທີ່ເປີດກ່ອນສິ້ນເດືອນ ຖືກແບ່ງເປັນ "ປິດແລ້ວກ່ອນ
// ຕົ້ນເດືອນ", "ປິດພາຍໃນເດືອນ" ຫຼື "ຍັງຄ້າງ" ໂດຍບໍ່ຊ້ອນກັນ)
//
// ຂໍ້ຕົກລົງທີ່ຕ້ອງຮູ້ກ່ອນອ່ານຕົວເລກ:
//  • ບິນ "ສຳເລັດ" = ມີຖ້ຽວທີ່ອະນຸມັດແລ້ວ ແລະ status=1 ຄັ້ງທຳອິດ (MIN(sent_end))
//    — ອັນດຽວກັບທີ່ getReportMonthlyDelivery ໃຊ້ ຈຶ່ງບໍ່ຂັດກັນລະຫວ່າງໜ້າ.
//    ບິນທະຍອຍສົ່ງຈຶ່ງນັບວ່າສຳເລັດຕັ້ງແຕ່ຖ້ຽວທຳອິດ ແລະ ຖືກລາຍງານແຍກຕ່າງຫາກ
//    ໃນ multi_leg_bills / short_bills.
//  • "ເວລາກຳນົດຈັດສົ່ງ" = odg_tms_pending_bill.scheduled_date (ນັດໂດຍຜູ້ຈັດ)
//    ຖ້າບໍ່ມີຈຶ່ງໃຊ້ date_logistic ຂອງຖ້ຽວທຳອິດ. ບໍ່ໃຊ້ ic_trans.send_date
//    ເພາະວັດແລ້ວ (2026-07: 2,288/2,288 ໃບ) ມັນເທົ່າກັບ doc_date ທຸກໃບ ຈຶ່ງເປັນ
//    ວັນເປີດບິນຊ້ຳ ບໍ່ແມ່ນວັນນັດ ແລະ ຈະເຮັດໃຫ້ 2 ຊຸດຕົວເລກຄືກັນໂດຍບໍ່ມີຄວາມໝາຍ.
//    ວັນນັດເປັນ "ວັນ" ບໍ່ແມ່ນ "ເວລາ" ຈຶ່ງທຽບຈາກ 00:00 ຂອງວັນນັ້ນ → ສົ່ງພາຍໃນ
//    ວັນທີ່ນັດ = ≤24h.
//  • scheduled_date ເກັບແຕ່ຄ່າຫຼ້າສຸດ: ບິນທີ່ຖືກເລື່ອນນັດຈະ "ທັນເວລາ" ຕາມນັດ
//    ໃໝ່ — ຈຶ່ງຕ້ອງອ່ານຄູ່ກັບ rescheduled_over_2.
//
// ⚠️ ຢ່າສ້າງກຸ່ມບິນຈາກ ic_trans_shipment.transport_code ຢ່າງດຽວ.
// ວັດຈາກຖານຂໍ້ມູນຈິງ (07/2026) ວິທີນັ້ນຫຼຸດບິນທີ່ສົ່ງສຳເລັດໄປ 452 ໃບ:
//   • 325 ໃບ ບໍ່ມີແຖວໃນ ic_trans_shipment ເລີຍ (ບິນມື/ບິນ custom/ບິນໂອນ)
//     ແຕ່ຖືກຈັດຖ້ຽວ ແລະ ສົ່ງສຳເລັດໂດຍ 3 ສາຂາ
//   • 91 ໃບ ລະຫັດໃນ shipment ເປັນ 02-0007 (ໂພນສະອາດ) ແຕ່ຜູ້ຈັດໂອນມາໃຫ້
//     ດອນຕິ້ວ/ໂອດ່ຽນ ຜ່ານ odg_tms_pending_bill.transport_code
//   • 34 ໃບ ເປັນ 02-0004 (ລູກຄ້າຮັບເອງ) / 02-0008 ໃນ ERP ແຕ່ຄວາມຈິງ 3 ສາຂາ
//     ເປັນຄົນສົ່ງ
// ຈຶ່ງສ້າງກຸ່ມຈາກ "ຝັ່ງການຈັດສົ່ງ" ແທນ: ສາຂາເຈົ້າຂອງບິນ = ສາຂາຂອງຖ້ຽວທີ່ສົ່ງ
// ສຳເລັດ (odg_tms.origin_transport_code) ຖ້າຍັງບໍ່ທັນຈັດຖ້ຽວຈຶ່ງໃຊ້ສາຂາທີ່
// ຜູ້ຈັດມອບໝາຍ (odg_tms_pending_bill.transport_code) ແລ້ວຈຶ່ງເປັນ shipment.
//
// ⚠️ ic_trans ມີ doc_no ຊ້ຳ (4,356 ໃບ ໃນປີ 2026 — ເອກະສານດຽວກັນ 2 trans_flag
// ເຊັ່ນ 70/72). LEFT JOIN ທຳມະດາຈະຄູນແຖວ ແລະ ດັນຍອດຂຶ້ນ (ວັດແລ້ວ +103 ໃບ
// ໃນເດືອນ 07). ຈຶ່ງດຶງດ້ວຍ LATERAL … LIMIT 1.
// ══════════════════════════════════════════════════════════════════════════
// ແຖວດິບ → ຮູບຮ່າງທີ່ໜ້າຈໍໃຊ້. ສົ່ງ null/undefined ມາ ໄດ້ bucket ສູນ.
function toPerfBucket(r) {
  const num = (value) => Number(value) || 0;
  return {
    carry_in: num(r?.carry_in),
    opened: num(r?.opened),
    delivered: num(r?.delivered),
    closed_other: num(r?.closed_other),
    carry_out: num(r?.carry_out),
    handled: num(r?.handled),
    from_open: {
      le_24h: num(r?.open_le24),
      h24_48: num(r?.open_24_48),
      gt_48h: num(r?.open_gt48),
    },
    from_schedule: {
      le_24h: num(r?.sched_le24),
      h24_48: num(r?.sched_24_48),
      gt_48h: num(r?.sched_gt48),
      no_schedule: num(r?.sched_none),
    },
    rescheduled_over_2: num(r?.rescheduled_over_2),
    jumped: { d1: num(r?.jumped_1d), d3: num(r?.jumped_3d), d7: num(r?.jumped_7d) },
    jumped_ready: {
      d1: num(r?.jumped_ready_1d),
      d3: num(r?.jumped_ready_3d),
      d7: num(r?.jumped_ready_7d),
    },
    multi_leg_bills: num(r?.multi_leg_bills),
    short_bills: num(r?.short_bills),
    cancelled_bills: num(r?.cancelled_bills),
    cancelled_legs: num(r?.cancelled_legs),
    avg_lead_open_h: r?.avg_lead_open_h == null ? null : Number(r.avg_lead_open_h),
    median_lead_open_h: r?.median_lead_open_h == null ? null : Number(r.median_lead_open_h),
  };
}

function emptyPerfBucket() {
  return toPerfBucket(null);
}

/**
 * ເລກບິນທີ່ "ສິນຄ້າຍັງບໍ່ຮອດມືລູກຄ້າ" ໃນຂະນະນີ້.
 *
 * ⚠️ ຢ່າຂຽນກົດນີ້ຂຶ້ນມາໃໝ່ໃນ SQL. ກົດຈິງມີຫຼາຍຊັ້ນ (check_status ຂອງ ERP,
 * ຈຳນວນຄົງເຫຼືອຫຼັງຫັກຂອງທີ່ lock ຢູ່ຖ້ຽວ, ໃບຫຼຸດໜີ້, ບິນບໍລິການທີ່ສົ່ງຊ້ຳໄດ້,
 * ບິນສົ່ງຕໍ່ສາຂາ) ແລະ ການຂຽນຄືນເຮັດໃຫ້ຍອດເກີນຄວາມຈິງເຖິງ 3 ເທົ່າ (207 ທຽບກັບ
 * 63 ທີ່ຖືກຕ້ອງ ວັດເມື່ອ 06/08/2026). ຈຶ່ງເອີ້ນໃຊ້ຟັງຊັນທີ່ໜ້າຈໍໃຊ້ຢູ່ແທ້ໆ:
 *
 *   ບິນລໍຈັດຖ້ຽວ (getBillsPending) ∪ ບິນທີ່ຢູ່ເທິງຖ້ຽວທີ່ຍັງບໍ່ຈົບ
 *
 * ຜົນຄື ຍອດຄົງເຫຼືອຂອງເດືອນປັດຈຸບັນຈະຕົງກັບໜ້າ /bills-pending ແລະ
 * /bills-inprogress ສະເໝີ ໂດຍບໍ່ມີທາງແຕກຕ່າງ.
 */
async function getOutstandingBillNos() {
  const { getBillsPending } = require("./bills");
  const { FIXED_YEAR_START, FIXED_YEAR_END } = require("../lib/fixed-year");
  const [pending, onTripRows] = await Promise.all([
    // ບໍ່ສົ່ງ session ໄປ — ຕ້ອງການທັງ 3 ສາຂາ ແລ້ວຄ່ອຍແບ່ງສາຂາດ້ວຍກົດຂອງລາຍງານເອງ
    getBillsPending({}, FIXED_YEAR_START, FIXED_YEAR_END, "all"),
    // ບິນທີ່ຢູ່ເທິງຖ້ຽວທີ່ຍັງບໍ່ຈົບ (ລໍອອກລົດ ຫຼື ກຳລັງສົ່ງ) — ຍັງບໍ່ຮອດມືລູກຄ້າ
    // ແຕ່ບໍ່ຂຶ້ນໜ້າ "ບິນລໍຈັດຖ້ຽວ" ເພາະຖືກຈັດຖ້ຽວແລ້ວ
    query(
      `SELECT DISTINCT d.bill_no
         FROM public.odg_tms_detail d
         JOIN public.odg_tms j ON j.doc_no = d.doc_no
        WHERE COALESCE(d.status, 0) NOT IN (1, 2)
          AND COALESCE(j.approve_status, 0) = 1
          AND COALESCE(j.job_status, 0) <> 4
          AND ${getFixedYearSqlFilter("d.doc_date")}`
    ),
  ]);
  const set = new Set();
  for (const bill of pending.trans ?? []) if (bill?.doc_no) set.add(String(bill.doc_no));
  for (const row of onTripRows) if (row?.bill_no) set.add(String(row.bill_no));
  return Array.from(set);
}

async function getDeliveryPerformance(session, monthly) {
  const scope = getBranchScope(session);
  const monthStart = `${monthly}-01`;
  const nextMonthStart = getNextMonthStart(monthly);
  // ຜູ້ໃຊ້ທີ່ຜູກກັບສາຂາ ເຫັນສະເພາະສາຂາຕົນ ແຕ່ບໍ່ເກີນ 3 ສາຂາ KPI
  const visibleBranches = scope.scoped
    ? MONTHLY_DELIVERY_BRANCH_CODES.filter((code) => scope.branches.includes(code))
    : MONTHLY_DELIVERY_BRANCH_CODES;
  if (visibleBranches.length === 0) {
    return { month: monthly, overall: emptyPerfBucket(), branches: [], departments: [] };
  }
  const branchCodeSql = visibleBranches.map((code) => `'${code}'`).join(",");
  const yearFilter = getFixedYearSqlFilter("d.doc_date");
  const outstandingNow = await getOutstandingBillNos();

  const rows = await query(
    `WITH params AS (
       SELECT $1::timestamp AS month_start, $2::timestamp AS next_month_start
     ),
     -- (ກ) ບິນທີ່ຖືກຈັດຖ້ຽວແລ້ວ — ຍຸບ "ຖ້ຽວ × ບິນ" ເປັນລະດັບບິນ ຄັ້ງດຽວທັງປີ.
     -- trip_branch = ສາຂາຂອງຖ້ຽວທີ່ສົ່ງສຳເລັດເປັນຄັ້ງທຳອິດ ຖ້າຍັງບໍ່ສຳເລັດ
     -- ຈຶ່ງເອົາສາຂາຂອງຖ້ຽວລ່າສຸດ.
     legs AS (
       SELECT d.bill_no,
         COUNT(*) FILTER (WHERE d.status = 1 AND d.sent_end IS NOT NULL)::int AS success_legs,
         COUNT(*) FILTER (
           WHERE COALESCE(d.status, 0) = 2
             AND COALESCE(d.sent_end, d.create_date_time_now) >= p.month_start
             AND COALESCE(d.sent_end, d.create_date_time_now) < p.next_month_start
         )::int AS cancelled_legs_in_month,
         MIN(d.sent_end) FILTER (WHERE d.status = 1) AS first_delivered_at,
         -- ບິນທະຍອຍສົ່ງ "ຮອດມືລູກຄ້າ" ຕອນຖ້ຽວສຸດທ້າຍ ບໍ່ແມ່ນຖ້ຽວທຳອິດ
         MAX(d.sent_end) FILTER (WHERE d.status = 1) AS last_delivered_at,
         MIN(d.date_logistic) AS first_logistic_date,
         MIN(d.doc_date) AS first_trip_date,
         COALESCE(
           (array_agg(j.origin_transport_code ORDER BY d.sent_end ASC NULLS LAST)
             FILTER (WHERE d.status = 1 AND NULLIF(TRIM(j.origin_transport_code), '') IS NOT NULL))[1],
           (array_agg(j.origin_transport_code ORDER BY d.create_date_time_now DESC)
             FILTER (WHERE NULLIF(TRIM(j.origin_transport_code), '') IS NOT NULL))[1]
         ) AS trip_branch
       FROM public.odg_tms_detail d
       JOIN public.odg_tms j ON j.doc_no = d.doc_no
       CROSS JOIN params p
       WHERE COALESCE(j.approve_status, 0) = 1
         AND ${yearFilter}
       GROUP BY d.bill_no
     ),
     -- (ຂ) ບິນຂາຍທີ່ມອບໝາຍໃຫ້ສາຂາ ແຕ່ຍັງບໍ່ທັນຖືກຈັດຖ້ຽວ — ຕ້ອງມີເພື່ອໃຫ້
     -- ຍອດຄ້າງ (carry_in / carry_out) ຄົບ. trans_flag=44 = ບິນຂາຍ, ອັນດຽວກັບ
     -- ທີ່ໜ້າ /bills-pending ໃຊ້ (ຕັດ RWSO/SRH ທີ່ບໍ່ແມ່ນວຽກຈັດສົ່ງອອກ).
     assigned AS (
       SELECT s.doc_no AS bill_no,
         COALESCE(NULLIF(TRIM(pb.transport_code), ''), NULLIF(TRIM(s.transport_code), '')) AS assigned_branch
       FROM public.ic_trans_shipment s
       LEFT JOIN public.odg_tms_pending_bill pb ON pb.bill_no = s.doc_no
       WHERE ${getFixedYearSqlFilter("s.doc_date")} AND s.trans_flag = 44
     ),
     bills AS (
       SELECT COALESCE(a.bill_no, lg.bill_no) AS bill_no,
         COALESCE(NULLIF(TRIM(lg.trip_branch), ''), a.assigned_branch) AS branch_code,
         lg.success_legs, lg.cancelled_legs_in_month, lg.first_delivered_at,
         lg.last_delivered_at, lg.first_logistic_date, lg.first_trip_date
       FROM assigned a
       FULL JOIN legs lg ON lg.bill_no = a.bill_no
     ),
     -- ບິນທີ່ "ຍັງບໍ່ຮອດມືລູກຄ້າ" ໃນຂະນະນີ້ — ມາຈາກຟັງຊັນທີ່ໜ້າຈໍໃຊ້ຢູ່
     -- (ເບິ່ງ getOutstandingBillNos) ບໍ່ແມ່ນກົດທີ່ຂຽນຄືນຢູ່ນີ້
     outstanding_now AS (
       SELECT DISTINCT o.bill_no FROM unnest($3::varchar[]) AS o(bill_no)
     ),
     -- ຈຳນວນຄັ້ງທີ່ "ວັນນັດ" ຖືກປ່ຽນຈິງ (ບໍ່ນັບຄັ້ງທຳອິດທີ່ຕັ້ງຄ່າ NULL → ວັນ)
     resched AS (
       SELECT bill_no,
         COUNT(*) FILTER (
           WHERE scheduled_date IS NOT NULL
             AND prev_date IS NOT NULL
             AND scheduled_date IS DISTINCT FROM prev_date
         )::int AS reschedule_count
       FROM (
         SELECT bill_no, scheduled_date,
           LAG(scheduled_date) OVER (PARTITION BY bill_no ORDER BY changed_at, id) AS prev_date
         FROM public.odg_tms_pending_bill_history
       ) h
       GROUP BY bill_no
     ),
     -- ບິນທີ່ປິດງານແລ້ວແຕ່ຈຳນວນສົ່ງ + ຈຳນວນຄືນສາງ ຍັງໜ້ອຍກວ່າທີ່ເບີກ
     -- (ນິຍາມດຽວກັນກັບໜ້າ /bills-partial)
     short_bills AS (
       SELECT i.bill_no
       FROM public.odg_tms_detail_item i
       JOIN public.odg_tms_detail d ON d.doc_no = i.doc_no AND d.bill_no = i.bill_no
       WHERE COALESCE(d.status, 0) = 1 AND ${yearFilter}
       GROUP BY i.bill_no
       HAVING SUM(COALESCE(i.delivered_qty, 0)) + SUM(COALESCE(i.returned_qty, 0))
            < SUM(COALESCE(i.selected_qty, 0))
     ),
     pool AS (
       SELECT
         b.bill_no,
         b.branch_code,
         COALESCE(NULLIF(TRIM(sale_u.department::text), ''), 'unknown') AS department_code,
         COALESCE(
           NULLIF(TRIM(dep.name_1::text), ''),
           NULLIF(TRIM(sale_u.department::text), ''),
           'ບໍ່ລະບຸພະແນກ'
         ) AS department_name,
         -- ເວລາເປີດບິນ: ic_trans (ເວລາລາວ) → ວັນທີ shipment → ວັນສ້າງບິນມື
         -- → ວັນຂອງຖ້ຽວທຳອິດ (ບິນໂອນທີ່ບໍ່ມີເອກະສານ ERP ເລີຍ)
         COALESCE(
           ${BILL_OPENED_AT},
           s.doc_date::timestamp,
           cb.created_at,
           b.first_trip_date::timestamp
         ) AS opened_at,
         -- ບິນທີ່ຍັງຄ້າງຢູ່ຕອນນີ້ = ຍັງບໍ່ອອກຈາກຍອດ ຈຶ່ງບໍ່ມີວັນສຳເລັດ/ວັນຫຼຸດອອກ.
         -- ບິນທີ່ອອກໄປແລ້ວ ຈຶ່ງລົງວັນທີວ່າອອກຕອນໃດ:
         --   ມີຖ້ຽວສົ່ງສຳເລັດ → ວັນຖ້ຽວສຸດທ້າຍ (ບິນທະຍອຍສົ່ງນັບຕອນຄົບ)
         CASE
           WHEN on_now.bill_no IS NOT NULL THEN NULL
           ELSE b.last_delivered_at
         END AS completed_at,
         -- ບໍ່ມີຖ້ຽວສົ່ງສຳເລັດເລີຍ ແຕ່ອອກຈາກຍອດແລ້ວ (ຄືນຜ່ານໃບຫຼຸດໜີ້ ຫຼື
         -- ຖືກປິດຢູ່ ERP) → ວັນໃບຫຼຸດໜີ້ ຖ້າບໍ່ມີຈຶ່ງນັບແຕ່ວັນເປີດບິນ ເພາະ ERP
         -- ບໍ່ເກັບປະຫວັດການປິດບິນ ຈຶ່ງບອກວັນທີ່ແທ້ບໍ່ໄດ້
         CASE
           WHEN on_now.bill_no IS NOT NULL THEN NULL
           WHEN b.last_delivered_at IS NOT NULL THEN NULL
           ELSE COALESCE(cr.credited_on::timestamp, ${BILL_OPENED_AT}, s.doc_date::timestamp)
         END AS closed_other_at,
         COALESCE(pb.scheduled_date::timestamp, b.first_logistic_date::timestamp) AS scheduled_at,
         COALESCE(NULLIF(TRIM(pb.action_status), ''), '') AS action_status,
         COALESCE(b.success_legs, 0) AS success_legs,
         COALESCE(b.cancelled_legs_in_month, 0) AS cancelled_legs_in_month,
         COALESCE(rs.reschedule_count, 0) AS reschedule_count,
         (sb.bill_no IS NOT NULL) AS is_short
       FROM bills b
       LEFT JOIN outstanding_now on_now ON on_now.bill_no = b.bill_no
       LEFT JOIN LATERAL (
         SELECT MIN(r.doc_date) AS credited_on
         FROM public.ic_trans_detail rd
         JOIN public.ic_trans r ON r.doc_no = rd.doc_no AND r.trans_flag = 48
         WHERE rd.ref_doc_no = b.bill_no
       ) cr ON true
       -- LATERAL … LIMIT 1: ic_trans ມີ doc_no ຊ້ຳ (ເບິ່ງໝາຍເຫດຫົວຟັງຊັນ)
       LEFT JOIN LATERAL (
         SELECT tt.doc_date, tt.doc_time, tt.sale_code FROM public.ic_trans tt
         WHERE tt.doc_no = b.bill_no ORDER BY tt.doc_date, tt.doc_time LIMIT 1
       ) t ON true
       -- ພະແນກຂອງພະນັກງານຂາຍທີ່ເປີດບິນ (ນິຍາມດຽວກັບ KPI ບໍລິຫານການຈັດສົ່ງ)
       LEFT JOIN erp_user sale_u ON sale_u.code = t.sale_code
       LEFT JOIN erp_department_list dep ON dep.code = sale_u.department
       LEFT JOIN public.ic_trans_shipment s ON s.doc_no = b.bill_no
       LEFT JOIN public.odg_tms_custom_bill cb ON cb.bill_no = b.bill_no
       LEFT JOIN resched rs ON rs.bill_no = b.bill_no
       LEFT JOIN short_bills sb ON sb.bill_no = b.bill_no
       LEFT JOIN public.odg_tms_pending_bill pb ON pb.bill_no = b.bill_no
       WHERE b.branch_code IN (${branchCodeSql})
     ),
     flagged AS (
       -- ບິນອອກຈາກຍອດຄ້າງດ້ວຍ 2 ທາງເທົ່ານັ້ນ ແລະ ບໍ່ຊ້ອນກັນ: ສົ່ງສຳເລັດ
       -- (completed_at) ຫຼື ຫຼຸດອອກ (closed_other_at) ຈຶ່ງໄດ້ສົມຜົນ
       -- carry_in + opened − delivered − closed_other = carry_out
       SELECT pool.*,
         (opened_at < p.month_start
            AND (completed_at IS NULL OR completed_at >= p.month_start)
            AND (closed_other_at IS NULL OR closed_other_at >= p.month_start)) AS is_carry_in,
         (opened_at >= p.month_start) AS is_opened,
         (completed_at IS NOT NULL AND completed_at >= p.month_start
            AND completed_at < p.next_month_start) AS is_delivered,
         (completed_at IS NULL AND closed_other_at IS NOT NULL
            AND closed_other_at >= p.month_start
            AND closed_other_at < p.next_month_start) AS is_closed_other,
         ((completed_at IS NULL OR completed_at >= p.next_month_start)
            AND (closed_other_at IS NULL OR closed_other_at >= p.next_month_start)) AS is_carry_out,
         EXTRACT(EPOCH FROM (completed_at - opened_at)) / 3600.0 AS lead_open_h,
         EXTRACT(EPOCH FROM (completed_at - scheduled_at)) / 3600.0 AS lead_sched_h,
         p.next_month_start
       FROM pool CROSS JOIN params p
       -- ບິນທີ່ຍັງບໍ່ເປີດກ່ອນສິ້ນເດືອນ ບໍ່ຢູ່ໃນຍອດຂອງເດືອນນີ້
       WHERE opened_at IS NOT NULL AND opened_at < p.next_month_start
     ),
     -- ບິນທີ່ຖືກລັດຄິວ: ມີບິນທີ່ "ເປີດຫຼັງ" (ສາຂາດຽວກັນ) ຖືກສົ່ງໄປກ່ອນແລ້ວ.
     -- min_done_newer = ເວລາສົ່ງສຳເລັດທຳອິດ ໃນບັນດາບິນທີ່ເປີດຫຼັງບິນນີ້.
     -- ORDER BY opened_at DESC ຈຶ່ງ "ແຖວກ່ອນໜ້າ" = ບິນທີ່ເປີດຫຼັງ.
     --
     -- ⚠️ ຕ້ອງເປັນ ROWS ບໍ່ແມ່ນ RANGE … EXCLUDE GROUP: ວັດແລ້ວ EXCLUDE GROUP
     -- ບັງຄັບໃຫ້ Postgres ຄິດ MIN ຄືນໃໝ່ທຸກແຖວ (O(n²)) ເຮັດໃຫ້ຄຳຂໍນີ້ໃຊ້ເວລາ
     -- 110 ວິນາທີ. ROWS ຄິດແບບສະສົມ O(n) ເຫຼືອ ~2 ວິ. ຜົນຕ່າງມີສະເພາະບິນທີ່
     -- ເປີດວິນາທີດຽວກັນເປັນເປະ ເຊິ່ງບໍ່ມີຜົນຕໍ່ຕົວເລກລວມ.
     queued AS (
       SELECT f.*,
         MIN(completed_at) OVER (
           PARTITION BY branch_code ORDER BY opened_at DESC, bill_no
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ) AS min_done_newer,
         -- ຈຸດອ້າງອີງເວລາ: ບິນທີ່ສົ່ງແລ້ວໃຊ້ເວລາສົ່ງ, ບິນທີ່ຍັງຄ້າງໃຊ້ສິ້ນເດືອນ
         LEAST(COALESCE(completed_at, next_month_start), next_month_start) AS ref_at
       FROM flagged f
     )
     SELECT
       CASE
         WHEN GROUPING(branch_code) = 0 THEN 'branch'
         WHEN GROUPING(department_code) = 0 THEN 'department'
         ELSE 'overall'
       END AS dimension,
       branch_code,
       department_code,
       MAX(department_name) AS department_name,
       COUNT(*) FILTER (WHERE is_carry_in)::int AS carry_in,
       COUNT(*) FILTER (WHERE is_opened)::int AS opened,
       COUNT(*) FILTER (WHERE is_delivered)::int AS delivered,
       COUNT(*) FILTER (WHERE is_closed_other)::int AS closed_other,
       COUNT(*) FILTER (WHERE is_carry_out)::int AS carry_out,
       COUNT(*) FILTER (WHERE is_carry_in OR is_opened)::int AS handled,
       COUNT(*) FILTER (WHERE is_delivered AND lead_open_h <= 24)::int AS open_le24,
       COUNT(*) FILTER (WHERE is_delivered AND lead_open_h > 24 AND lead_open_h <= 48)::int AS open_24_48,
       COUNT(*) FILTER (WHERE is_delivered AND lead_open_h > 48)::int AS open_gt48,
       COUNT(*) FILTER (WHERE is_delivered AND scheduled_at IS NOT NULL AND lead_sched_h <= 24)::int AS sched_le24,
       COUNT(*) FILTER (WHERE is_delivered AND scheduled_at IS NOT NULL AND lead_sched_h > 24 AND lead_sched_h <= 48)::int AS sched_24_48,
       COUNT(*) FILTER (WHERE is_delivered AND scheduled_at IS NOT NULL AND lead_sched_h > 48)::int AS sched_gt48,
       COUNT(*) FILTER (WHERE is_delivered AND scheduled_at IS NULL)::int AS sched_none,
       COUNT(*) FILTER (WHERE (is_carry_in OR is_opened) AND reschedule_count > 2)::int AS rescheduled_over_2,
       COUNT(*) FILTER (WHERE (is_carry_in OR is_opened) AND success_legs >= 2)::int AS multi_leg_bills,
       COUNT(*) FILTER (WHERE (is_carry_in OR is_opened) AND is_short)::int AS short_bills,
       -- ບິນທີ່ຖືກລັດຄິວ ຕາມເກນ N ວັນ (ບິນທີ່ເປີດຫຼັງ ຖືກສົ່ງກ່ອນເກີນ N ວັນ)
       COUNT(*) FILTER (
         WHERE (is_carry_in OR is_opened) AND min_done_newer IS NOT NULL
           AND min_done_newer + INTERVAL '1 day' < ref_at
       )::int AS jumped_1d,
       COUNT(*) FILTER (
         WHERE (is_carry_in OR is_opened) AND min_done_newer IS NOT NULL
           AND min_done_newer + INTERVAL '3 days' < ref_at
       )::int AS jumped_3d,
       COUNT(*) FILTER (
         WHERE (is_carry_in OR is_opened) AND min_done_newer IS NOT NULL
           AND min_done_newer + INTERVAL '7 days' < ref_at
       )::int AS jumped_7d,
       -- ສະເພາະບິນທີ່ຜູ້ຈັດໝາຍວ່າ "ຕິດຕໍ່ແລ້ວ/ພ້ອມສົ່ງ" ແຕ່ຍັງຖືກຂ້າມ
       COUNT(*) FILTER (
         WHERE (is_carry_in OR is_opened) AND action_status = 'contacted_ready'
           AND min_done_newer IS NOT NULL AND min_done_newer + INTERVAL '1 day' < ref_at
       )::int AS jumped_ready_1d,
       COUNT(*) FILTER (
         WHERE (is_carry_in OR is_opened) AND action_status = 'contacted_ready'
           AND min_done_newer IS NOT NULL AND min_done_newer + INTERVAL '3 days' < ref_at
       )::int AS jumped_ready_3d,
       COUNT(*) FILTER (
         WHERE (is_carry_in OR is_opened) AND action_status = 'contacted_ready'
           AND min_done_newer IS NOT NULL AND min_done_newer + INTERVAL '7 days' < ref_at
       )::int AS jumped_ready_7d,
       COUNT(*) FILTER (WHERE (is_carry_in OR is_opened) AND cancelled_legs_in_month > 0)::int AS cancelled_bills,
       COALESCE(SUM(cancelled_legs_in_month) FILTER (WHERE is_carry_in OR is_opened), 0)::int AS cancelled_legs,
       ROUND(AVG(lead_open_h) FILTER (WHERE is_delivered)::numeric, 2) AS avg_lead_open_h,
       ROUND(
         percentile_cont(0.5) WITHIN GROUP (ORDER BY lead_open_h)
           FILTER (WHERE is_delivered)::numeric, 2
       ) AS median_lead_open_h
     FROM queued
     GROUP BY GROUPING SETS ((), (branch_code), (department_code))`,
    [monthStart, nextMonthStart, outstandingNow]
  );

  const branchNameRows = await query(
    `SELECT code, COALESCE(NULLIF(TRIM(name_1), ''), code) AS name
     FROM transport_type
     WHERE code = ANY($1::text[])`,
    [MONTHLY_DELIVERY_BRANCH_CODES]
  );
  // ຊື່ຈາກ transport_type ມາກ່ອນ (02-0001 = "ຂົນສົ່ງໂອດ່ຽນ" ຕາມທີ່ຜູ້ໃຊ້ເອີ້ນ);
  // ຄ່າ hard-code ເປັນພຽງຕົວສຳຮອງເມື່ອຕາຕະລາງບໍ່ມີຊື່
  const branchNames = {
    ...MONTHLY_DELIVERY_BRANCH_NAMES,
    ...Object.fromEntries(branchNameRows.map((r) => [r.code, r.name])),
  };

  const overallRow = rows.find((r) => r.dimension === "overall");
  const branches = rows
    .filter((r) => r.dimension === "branch")
    .map((r) => {
      const code = String(r.branch_code || "").trim() || "unknown";
      return {
        branch_code: code,
        branch_name: branchNames[code] || code || "ບໍ່ລະບຸສາຂາ",
        ...toPerfBucket(r),
      };
    })
    .sort((a, b) => a.branch_code.localeCompare(b.branch_code));

  const departments = rows
    .filter((r) => r.dimension === "department")
    .map((r) => ({
      department_code: String(r.department_code || "").trim() || "unknown",
      department_name: String(r.department_name || "").trim() || "ບໍ່ລະບຸພະແນກ",
      ...toPerfBucket(r),
    }))
    // ພະແນກທີ່ຮັບຜິດຊອບບິນຫຼາຍສຸດຂຶ້ນກ່ອນ
    .sort((a, b) => b.handled - a.handled || a.department_name.localeCompare(b.department_name));

  return { month: monthly, overall: toPerfBucket(overallRow), branches, departments };
}

module.exports = {
  getReportDaily,
  getReportByDriver,
  getReportByCar,
  getReportByBill,
  getReportMonthlyCar,
  getReportMonthlyDriver,
  getReportMonthlyDelivery,
  getMonthlyDeliveryKpi,
  getDeliveryPerformance,
  getReportPendingDaily,
  getReportDeliveredDaily,
  getReportCancelledDaily,
  getReportDailyActivity,
  getReportDailyActivityBills,
  getReportDailyActivityItems,
  getReportDailyDepartment,
  getAttemptDeliveryItems,
};
