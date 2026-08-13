// Centralised notification dispatcher for delivery events.
// Failures are logged but never thrown — callers should fire-and-forget so a
// transient WA/LINE outage can't break the order workflow.
const { query, queryOne } = require("../lib/db");
const { sendDeliveryFlex } = require("../lib/line");
const { getSetting } = require("./settings");
const { ensureDeliveryWorkflowSchema } = require("./delivery");
const { ensureChatterSchema } = require("./chatter");
const { isChatterAdmin } = require("../lib/chatter-helpers");
const { getBranchScope, branchFilterJob } = require("./helpers");
const { getFixedYearSqlFilter } = require("../lib/fixed-year");

// Optional fallback recipient when the bill's sale_code has no line_id mapped.
// Set to a LINE groupId / userId of the OA admin so updates aren't lost.
const LINE_FALLBACK_TO = process.env.LINE_FALLBACK_TO || "";

const STATUS_COLOR = {
  "📋 ຖ້ຽວຈັດສົ່ງໄດ້ຖືກສ້າງ": "blue",
  "📦 ເບີກເຄື່ອງແລ້ວ": "amber",
  "🚚 ເລີ່ມຈັດສົ່ງ": "sky",
  "📍 ຮອດຈຸດສົ່ງ": "sky",
  "✅ ຈັດສົ່ງສຳເລັດ": "green",
  "❌ ຍົກເລີກຈັດສົ່ງ": "red",
};

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "";

async function getCustomerLineTestTo() {
  const [enabled, to] = await Promise.all([
    getSetting("line.customer.test_enabled", ""),
    getSetting("line.customer.test_to", ""),
  ]);
  return enabled === "1" || enabled === "true"
    ? to || process.env.LINE_CUSTOMER_TEST_TO || ""
    : "";
}

function trackingLink(billNo) {
  if (!PUBLIC_BASE_URL) return `/track?bill=${encodeURIComponent(billNo)}`;
  const base = PUBLIC_BASE_URL.replace(/\/$/, "");
  return `${base}/track?bill=${encodeURIComponent(billNo)}`;
}

// Timeline of delivery checkpoints for a bill — used by the LINE Flex bubble
// to show progress at a glance. The "active" step is the one matching the
// label that triggered the notification (passed in by the caller).
async function getBillTimeline(billNo, activeLabel, overrides = {}) {
  try {
    const row = await queryOne(
      `SELECT to_char(d.create_date_time_now,'DD-MM HH24:MI') as created_at,
              to_char(d.recipt_job,'DD-MM HH24:MI') as picked_at,
              to_char(j.dispatch_started_at,'DD-MM HH24:MI') as dispatch_at,
              to_char(d.sent_end,'DD-MM HH24:MI') as finished_at,
              COALESCE(d.status, 0) as status
       FROM public.odg_tms_detail d
       LEFT JOIN public.odg_tms j ON j.doc_no = d.doc_no
       WHERE d.bill_no = $1
       ORDER BY d.create_date_time_now DESC NULLS LAST
       LIMIT 1`,
      [billNo]
    );
    if (!row) return [];
    const cancelled = Number(row.status) === 2;
    const finalLabel = cancelled ? "❌ ຍົກເລີກ" : "✅ ສຳເລັດ";
    const steps = [
      { key: "created", label: "📋 ສ້າງຖ້ຽວ", time: row.created_at, done: true },
      { key: "picked", label: "📦 ເບີກເຄື່ອງ", time: row.picked_at, done: Boolean(row.picked_at) },
      {
        key: "dispatch",
        label: "🚚 ເລີ່ມຈັດສົ່ງ",
        time: overrides.dispatchAt || row.dispatch_at,
        done: Boolean(overrides.dispatchAt || row.dispatch_at),
      },
      {
        key: "finished",
        label: finalLabel,
        time: row.finished_at,
        done: Boolean(row.finished_at),
      },
    ];

    // Mark the step matching the active label so it pops in the bubble.
    const labelMap = {
      "📋 ຖ້ຽວຈັດສົ່ງໄດ້ຖືກສ້າງ": "created",
      "📦 ເບີກເຄື່ອງແລ້ວ": "picked",
      "🚚 ເລີ່ມຈັດສົ່ງ": "dispatch",
      "📍 ຮອດຈຸດສົ່ງ": "dispatch",
      "✅ ຈັດສົ່ງສຳເລັດ": "finished",
      "❌ ຍົກເລີກຈັດສົ່ງ": "finished",
    };
    const activeKey = labelMap[String(activeLabel ?? "")];
    if (activeKey) {
      const target = steps.find((s) => s.key === activeKey);
      if (target) target.active = true;
    }

    return steps;
  } catch (err) {
    console.warn("[notify] timeline lookup failed:", err?.message ?? err);
    return [];
  }
}

// Translate odg_tms_pending_bill.action_status into the Lao label shown in
// the LINE bubble's pre-trip section. Mirrors contactStatusLabel in
// tracking.js but kept local so this module has no cross-imports.
function preTripContactLabel(status) {
  switch (status) {
    case "contacted_ready":
      return "ພ້ອມຮັບ";
    case "contact_failed":
      return "ຕິດຕໍ່ບໍ່ໄດ້";
    case "customer_postponed":
      return "ລູກຄ້າເລື່ອນວັນຮັບ";
    case "customer_cancelled":
      return "ລູກຄ້າປະຕິເສດ/ຍົກເລີກ";
    case "delivery_scheduled":
      return "ຕາຕະລາງການຈັດສົ່ງ";
    default:
      return "";
  }
}

// Pre-trip status snapshot for the LINE bubble's "ສະຖານະບິນກ່ອນຈັດຖ້ຽວ"
// section. Pulls from odg_tms_pending_bill (the warehouse pre-call workflow)
// and the round/route reference tables. Returns null if nothing's set so the
// caller can skip the section entirely.
async function getBillPreTrip(billNo) {
  try {
    const row = await queryOne(
      `SELECT pb.action_status,
              to_char(pb.scheduled_date,'DD-MM-YYYY') AS scheduled_date,
              COALESCE(dr.name,'')      AS delivery_round_name,
              COALESCE(dr.time_label,'') AS delivery_round_time,
              COALESCE(rt.name,'')      AS delivery_route_name
       FROM public.odg_tms_pending_bill pb
       LEFT JOIN public.odg_tms_delivery_round dr ON dr.code = pb.delivery_round_code
       LEFT JOIN public.odg_tms_delivery_route rt ON rt.code = pb.delivery_route_code
       WHERE pb.bill_no = $1
       LIMIT 1`,
      [billNo]
    );
    if (!row) return null;
    const contact = preTripContactLabel(row.action_status);
    const round = [row.delivery_round_name, row.delivery_round_time].filter(Boolean).join(" ").trim();
    const result = {
      contact,
      scheduledDate: row.scheduled_date || "",
      round,
      route: row.delivery_route_name || "",
    };
    if (!result.contact && !result.scheduledDate && !result.round && !result.route) return null;
    return result;
  } catch (err) {
    console.warn("[notify] pre-trip lookup failed:", err?.message ?? err);
    return null;
  }
}

async function getBillContext(billNo) {
  // Split the lookup so a malformed date value on one of the joined tables
  // (ic_trans / ar_customer have legacy empty-string dates that pg refuses to
  // parse when the row is fetched whole) can't poison the whole query. Each
  // sub-select casts only the text fields we need.
  const base = await queryOne(
    `SELECT d.bill_no::text, d.doc_no::text,
            COALESCE(d.cust_code::text, '') as cust_code,
            COALESCE(d.telephone::text, '') as bill_phone,
            COALESCE(j.car::text, '') as car_code,
            COALESCE(j.driver::text, '') as driver_code,
            COALESCE(car.name_1::text, j.car::text, '') as car_name,
            COALESCE(drv.name_1::text, j.driver::text, '') as driver_name
     FROM public.odg_tms_detail d
     LEFT JOIN public.odg_tms j ON j.doc_no = d.doc_no
     LEFT JOIN public.odg_tms_car car ON car.code = j.car
     LEFT JOIN public.odg_tms_driver drv ON drv.code = j.driver
     WHERE d.bill_no = $1
     ORDER BY d.create_date_time_now DESC NULLS LAST
     LIMIT 1`,
    [billNo]
  );
  if (!base) return null;

  // Customer details — cast each column to text BEFORE COALESCE so legacy
  // date-typed columns with empty values don't fail the implicit '' coercion.
  let cust = { cust_name: "", cust_phone: "", cust_line_id: "" };
  if (base.cust_code) {
    try {
      const c = await queryOne(
        `SELECT COALESCE(name_1::text, '') as cust_name,
                COALESCE(telephone::text, '') as cust_phone,
                COALESCE(register_line_id::text, '') as cust_line_id
         FROM public.ar_customer WHERE code = $1 LIMIT 1`,
        [base.cust_code]
      );
      if (c) cust = c;
    } catch (err) {
      console.warn("[notify] ar_customer lookup failed:", err?.message ?? err);
    }
  }

  // Sales person — sale_code lives on ic_trans, line_id on erp_user.
  let sale = { sale_code: "", sale_name: "", sale_line_id: "" };
  try {
    const s = await queryOne(
      `SELECT COALESCE(b.sale_code::text, '') as sale_code,
              COALESCE(u.name_1::text, '') as sale_name,
              COALESCE(u.line_id::text, '') as sale_line_id
       FROM ic_trans b
       LEFT JOIN erp_user u ON u.code = b.sale_code
       WHERE b.doc_no = $1
       LIMIT 1`,
      [base.bill_no]
    );
    if (s) sale = s;
  } catch (err) {
    console.warn("[notify] ic_trans lookup failed:", err?.message ?? err);
  }

  return {
    ...base,
    cust_phone: base.bill_phone || cust.cust_phone || "",
    cust_name: cust.cust_name,
    cust_line_id: cust.cust_line_id,
    ...sale,
  };
}

// Push the same Flex bubble used for sales staff to the customer's LINE OA
// (uses ar_customer.register_line_id — the userId saved when the customer
// added the OA as a friend). The customer flex includes the public tracking
// link so they can open the live map directly from chat.
async function notifyCustomerLine(billNo, statusLabel, options = {}) {
  try {
    const [ctx, customerTestTo, preTrip] = await Promise.all([
      getBillContext(billNo),
      getCustomerLineTestTo(),
      getBillPreTrip(billNo),
    ]);
    if (!ctx) return;
    const recipient = ctx.cust_line_id || (customerTestTo ? "customer-line-missing" : "");
    if (!recipient) return; // customer hasn't linked LINE — silently skip
    const timeline = await getBillTimeline(billNo, statusLabel, {
      dispatchAt: options.dispatchAt,
    });
    await sendDeliveryFlex({
      to: recipient,
      statusLabel,
      color: STATUS_COLOR[statusLabel] ?? "default",
      billNo,
      docNo: ctx.doc_no,
      customerName: ctx.cust_name,
      carName: ctx.car_name,
      driverName: ctx.driver_name,
      statusNote: options.note,
      trackingUrl: trackingLink(billNo),
      testTo: customerTestTo,
      preTrip,
      timeline,
    });
  } catch (err) {
    console.warn("[notify] customer LINE failed:", err?.message ?? err);
  }
}

async function notifySalesLine(billNo, statusLabel, options = {}) {
  try {
    const [ctx, preTrip] = await Promise.all([
      getBillContext(billNo),
      getBillPreTrip(billNo),
    ]);
    if (!ctx) return;

    // Prefer the bill's own sales person; fall back to a configured OA target
    // so updates aren't dropped when sale_code lacks a line_id mapping.
    const recipient = ctx.sale_line_id || LINE_FALLBACK_TO;
    if (!recipient) {
      console.warn("[notify] no LINE recipient for bill", billNo);
      return;
    }

    const timeline = await getBillTimeline(billNo, statusLabel, {
      dispatchAt: options.dispatchAt,
    });
    await sendDeliveryFlex({
      to: recipient,
      statusLabel,
      color: STATUS_COLOR[statusLabel] ?? "default",
      billNo,
      docNo: ctx.doc_no,
      customerName: ctx.cust_name,
      carName: ctx.car_name,
      driverName: ctx.driver_name,
      statusNote: options.note,
      trackingUrl: trackingLink(billNo),
      preTrip,
      timeline,
    });
  } catch (err) {
    console.warn("[notify] sales LINE failed:", err?.message ?? err);
  }
}

// Convenience: full job-created fan-out — one customer-LINE per customer
// plus one sales-LINE per bill (the sales LINE flex now carries the wa.me
// share URL, so we no longer push WhatsApp via Meta API).
async function notifyJobCreated(docNo) {
  try {
    const bills = await query(
      `SELECT bill_no FROM public.odg_tms_detail WHERE doc_no = $1`,
      [docNo]
    );
    const label = "📋 ຖ້ຽວຈັດສົ່ງໄດ້ຖືກສ້າງ";
    for (const b of bills) {
      void notifyCustomerLine(b.bill_no, label);
      void notifySalesLine(b.bill_no, label);
    }
  } catch (err) {
    console.warn("[notify] job-created fanout failed:", err?.message ?? err);
  }
}

// FCM push to the app_sale_order Flutter app for every salesperson, head and
// manager linked to bills on this job. Salesperson = ic_trans.sale_code on
// each bill; head/manager = anyone in the same department flagged as 'head'
// or 'manager' (via odg_employee.app_role, with position_code 11/12 as the
// legacy fallback when app_role is NULL).
//
// Fire-and-forget — caller (createJob) should `void` it. Errors are logged
// but never thrown so a push failure can't roll back a job that's already
// committed.
async function notifyJobCreatedToSales(docNo) {
  if (!docNo) return;
  try {
    const job = await queryOne(
      `SELECT to_char(date_logistic,'DD-MM-YYYY') AS date_logistic,
              (SELECT COUNT(*) FROM public.odg_tms_detail WHERE doc_no = $1) AS bill_count
       FROM public.odg_tms WHERE doc_no = $1`,
      [docNo]
    );
    if (!job) return;

    // Resolve recipients in a single round-trip: salespersons of every bill
    // on the job, then heads + managers sharing each salesperson's department.
    const recipientRows = await query(
      `WITH sales AS (
         SELECT DISTINCT NULLIF(TRIM(ic.sale_code), '') AS sale_code
         FROM public.odg_tms_detail d
         INNER JOIN public.ic_trans ic ON ic.doc_no = d.bill_no
         WHERE d.doc_no = $1
       ),
       sales_emps AS (
         SELECT e.employee_code, e.department_code
         FROM public.odg_employee e
         INNER JOIN sales s ON s.sale_code = e.employee_code
         WHERE e.employee_code IS NOT NULL
           AND COALESCE(e.employment_status, 'ACTIVE') = 'ACTIVE'
       )
       SELECT employee_code, role FROM (
         SELECT employee_code, 'salesperson' AS role FROM sales_emps
         UNION
         SELECT e.employee_code,
                CASE
                  WHEN COALESCE(NULLIF(TRIM(e.app_role), ''), '') = 'manager' THEN 'manager'
                  WHEN COALESCE(NULLIF(TRIM(e.app_role), ''), '') = 'head' THEN 'head'
                  WHEN e.app_role IS NULL AND e.position_code = '11' THEN 'manager'
                  WHEN e.app_role IS NULL AND e.position_code = '12' THEN 'head'
                  ELSE NULL
                END AS role
         FROM public.odg_employee e
         INNER JOIN sales_emps se ON se.department_code = e.department_code
         WHERE e.employee_code IS NOT NULL
           AND COALESCE(e.employment_status, 'ACTIVE') = 'ACTIVE'
           AND (
             COALESCE(NULLIF(TRIM(e.app_role), ''), '') IN ('manager', 'head')
             OR (e.app_role IS NULL AND e.position_code IN ('11', '12'))
           )
       ) t
       WHERE role IS NOT NULL`,
      [docNo]
    );

    const codes = Array.from(
      new Set(recipientRows.map((r) => r.employee_code).filter(Boolean))
    );
    if (codes.length === 0) return;

    const { pushToEmployees } = require("./push");
    const body = job.date_logistic
      ? `ຖ້ຽວ ${docNo} · ${job.bill_count} ບິນ · ສົ່ງ ${job.date_logistic}`
      : `ຖ້ຽວ ${docNo} · ${job.bill_count} ບິນ`;
    await pushToEmployees(codes, "📦 ບິນຖືກຈັດເຂົ້າຖ້ຽວແລ້ວ", body, {
      type: "job_created",
      doc_no: docNo,
    });
  } catch (err) {
    console.warn(
      "[notify] notifyJobCreatedToSales failed:",
      err?.message ?? err
    );
  }
}

// ບິນເບີກບໍ່ຄົບ — the driver reported a different quantity at the warehouse
// than the trip planned, so the trip was corrected down and the shortfall went
// back into the pending pool. Push the news to the people who own the plan:
// the dispatcher who created the trip, plus dispatch staff of the trip's origin
// branch. The same event also lands in the web activity feed (see the
// 'pickup_variance' branch in getActivityNotifications), which is the durable
// channel — this push is the immediate nudge.
//
// Fire-and-forget: callers `void` it, and every failure is swallowed so a push
// problem can never undo a committed pickup.
async function notifyPickupVariance({ billNo, docNo, driverCode, variance }) {
  try {
    const bill = String(billNo ?? "").trim();
    const doc = String(docNo ?? "").trim();
    if (!bill || !doc || !variance?.lines?.length) return;

    const job = await queryOne(
      `SELECT COALESCE(NULLIF(TRIM(j.user_created), ''), '') AS user_created,
              COALESCE(NULLIF(TRIM(j.origin_transport_code), ''), '') AS origin_transport_code,
              COALESCE(NULLIF(TRIM(drv.name_1), ''), j.driver, '') AS driver_name,
              COALESCE(NULLIF(TRIM(cust.name_1), ''), d.cust_code, '') AS cust_name
       FROM public.odg_tms j
       LEFT JOIN public.odg_tms_driver drv ON drv.code = j.driver
       LEFT JOIN public.odg_tms_detail d ON d.doc_no = j.doc_no AND d.bill_no = $2
       LEFT JOIN public.ar_customer cust ON cust.code = d.cust_code
       WHERE j.doc_no = $1
       LIMIT 1`,
      [doc, bill]
    ).catch(() => null);

    const codes = new Set();
    if (job?.user_created) codes.add(job.user_created);
    if (job?.origin_transport_code) {
      const branchStaff = await query(
        `SELECT code FROM erp_user WHERE NULLIF(TRIM(logistic_code), '') = $1`,
        [job.origin_transport_code]
      ).catch(() => []);
      for (const row of branchStaff) {
        if (row?.code) codes.add(row.code);
      }
    }
    const { describePickupVariance } = require("../lib/pickup-variance");
    const detail = variance.lines
      .slice(0, 4)
      .map(
        (line) =>
          `• ${line.item_name}: ຖ້ຽວ ${line.planned_qty} → ຮັບ ${line.reported_qty}${
            line.over_reported ? " (ເກີນ — ບໍ່ໄດ້ປັບ)" : ""
          }`
      )
      .join("\n");
    const more = variance.lines.length > 4 ? `\n… ອີກ ${variance.lines.length - 4} ລາຍການ` : "";
    const body = [
      `ບິນ ${bill}${job?.cust_name ? ` · ${job.cust_name}` : ""}`,
      job?.driver_name ? `ຄົນຂັບ ${job.driver_name} · ຖ້ຽວ ${doc}` : `ຖ້ຽວ ${doc}`,
      describePickupVariance(variance),
      detail + more,
    ]
      .filter(Boolean)
      .join("\n");

    const { pushToTopic } = require("./push");
    await pushToTopic({
      candidates: codes,
      title: "⚠️ ເບີກເຄື່ອງບໍ່ຄົບຕາມຖ້ຽວ",
      body,
      data: { type: "pickup_variance", bill_no: bill, doc_no: doc },
      // Never ping the driver about their own report.
      excludeCode: driverCode,
    });
  } catch (err) {
    console.warn("[notify] pickup-variance failed:", err?.message ?? err);
  }
}

/**
 * ຄົນຂັບແຈ້ງ "ສົ່ງສຳເລັດ" — ດັນແຈ້ງເຕືອນຫາຫ້ອງຈັດສົ່ງທັນທີ.
 *
 * ຜູ້ຮັບຄືຄົນດຽວກັບແຈ້ງເຕືອນເບີກເຄື່ອງບໍ່ຄົບ: ຄົນສ້າງຖ້ຽວ + ພະນັກງານສາຂາຕົ້ນທາງ
 * (ຍົກເວັ້ນຄົນຂັບເອງ) ບວກກັບຄົນທີ່ຕິກເປີດປະເພດນີ້ເອງ. `pushToTopic` ຍິງເຂົ້າ
 * ທັງສອງແອັບ ເພາະຫົວໜ້າບາງຄົນລົງທະບຽນ token ໄວ້ໃນແອັບຄົນຂັບເທົ່ານັ້ນ.
 *
 * Best-effort ທັງໝົດ: ການແຈ້ງເຕືອນລົ້ມເຫຼວຕ້ອງບໍ່ເຮັດໃຫ້ການປິດບິນລົ້ມເຫຼວ —
 * ຜູ້ເອີ້ນຈຶ່ງເອີ້ນແບບ void ຫຼັງ COMMIT ແລ້ວ.
 */
async function notifyBillDelivered({
  billNo,
  docNo,
  driverCode,
  fullyDelivered = true,
  collectedAmount = 0,
}) {
  try {
    const bill = String(billNo ?? "").trim();
    const doc = String(docNo ?? "").trim();
    if (!bill || !doc) return;

    const job = await queryOne(
      `SELECT COALESCE(NULLIF(TRIM(j.user_created), ''), '') AS user_created,
              COALESCE(NULLIF(TRIM(j.origin_transport_code), ''), '') AS origin_transport_code,
              COALESCE(NULLIF(TRIM(drv.name_1), ''), j.driver, '') AS driver_name,
              COALESCE(NULLIF(TRIM(cust.name_1), ''), d.cust_code, '') AS cust_name,
              to_char(d.sent_end, 'HH24:MI') AS closed_time
       FROM public.odg_tms j
       LEFT JOIN public.odg_tms_driver drv ON drv.code = j.driver
       LEFT JOIN public.odg_tms_detail d ON d.doc_no = j.doc_no AND d.bill_no = $2
       LEFT JOIN public.ar_customer cust ON cust.code = d.cust_code
       WHERE j.doc_no = $1
       LIMIT 1`,
      [doc, bill]
    ).catch(() => null);

    const codes = new Set();
    if (job?.user_created) codes.add(job.user_created);
    if (job?.origin_transport_code) {
      const branchStaff = await query(
        `SELECT code FROM erp_user WHERE NULLIF(TRIM(logistic_code), '') = $1`,
        [job.origin_transport_code]
      ).catch(() => []);
      for (const row of branchStaff) {
        if (row?.code) codes.add(row.code);
      }
    }
    const amount = Number(collectedAmount ?? 0);
    const body = [
      `ບິນ ${bill}${job?.cust_name ? ` · ${job.cust_name}` : ""}`,
      job?.driver_name ? `ຄົນຂັບ ${job.driver_name} · ຖ້ຽວ ${doc}` : `ຖ້ຽວ ${doc}`,
      job?.closed_time ? `ເວລາ ${job.closed_time}` : "",
      Number.isFinite(amount) && amount > 0
        ? `ເກັບເງິນ ${amount.toLocaleString("en-US")} ກີບ`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    // ຜູ້ຮັບ = ຜູ້ກ່ຽວຂ້ອງກັບຖ້ຽວ + ຄົນທີ່ຕິກເປີດ "ແຈ້ງສົ່ງສຳເລັດ" ເອງ.
    const { pushToTopic } = require("./push");
    await pushToTopic({
      candidates: codes,
      title: fullyDelivered ? "✅ ສົ່ງສຳເລັດ" : "📦 ສົ່ງບາງສ່ວນ",
      body,
      // bill_no lets the app open the POD proof for exactly this bill.
      data: { type: "bill_delivered", bill_no: bill, doc_no: doc },
      // ຄົນຂັບຫາກໍ່ກົດສົ່ງເອງ — ບໍ່ຕ້ອງເຕືອນຄືນ ນອກຈາກລາວຕິກເປີດເອງ.
      excludeCode: driverCode,
    });
  } catch (err) {
    console.warn("[notify] bill-delivered failed:", err?.message ?? err);
  }
}

// Fan-out a status update to both the sales OA and the customer LINE in one
// call so mobile.js doesn't have to remember both.
async function notifyBillStatus(billNo, statusLabel, options = {}) {
  void notifySalesLine(billNo, statusLabel, options);
  void notifyCustomerLine(billNo, statusLabel, options);
}

// Composite key used to identify a single activity event across the union
// branches. Built identically here and on the client mark-read call so the
// reads table stays consistent.
const NOTIFICATION_KEY_SQL = `
  type || '|' || doc_no || '|' || COALESCE(bill_no, '') ||
  '|' || EXTRACT(EPOCH FROM event_at)::bigint::text
`;

// The bell shows what just happened, and it runs on EVERY page load plus a
// 30-second poll — so it must never scan the whole year. odg_tms_detail alone
// holds ~70k rows / 636 MB; sorting all of it to keep 30 rows was the single
// slowest thing on every screen (measured 660-765 ms). A recency window cuts
// that roughly in half and changes nothing the user can see: entries older
// than this were never reachable behind a 30-row limit anyway.
const ACTIVITY_WINDOW = "30 days";

async function getActivityNotifications(session, limit = 30) {
  // Ensures the per-user reads table exists before joining against it —
  // first request after a fresh server boot would otherwise 500 with
  // "relation does not exist".
  await ensureDeliveryWorkflowSchema();
  await ensureChatterSchema().catch(() => undefined);
  const scope = getBranchScope(session);
  const max = Math.min(Math.max(Number(limit) || 30, 1), 80);
  const userCode = String(session?.usercode ?? "");
  // Sales staff are notified only about conversations on their own bills;
  // everyone else (dispatch / management) is treated as admin and sees all.
  const isAdmin = isChatterAdmin(session);
  // Branch-scoped dispatchers only get chatter for their own branch's bills;
  // head office (unscoped) sees all. Sales match via sale_code/mention/follow.
  const adminBranches = scope.scoped ? scope.branches : [];
  return query(
    `WITH activity AS (
      SELECT
        'job_created' AS type,
        a.doc_no,
        NULL::text AS bill_no,
        'ສ້າງຖ້ຽວໃໝ່' AS title,
        CONCAT('ຖ້ຽວ ', a.doc_no, ' · ', COALESCE(car.name_1, a.car, '-')) AS body,
        a.create_date_time_now AS event_at,
        '/jobs' AS href,
        'blue' AS tone
      FROM public.odg_tms a
      LEFT JOIN public.odg_tms_car car ON car.code = a.car
      WHERE a.create_date_time_now IS NOT NULL
        AND a.create_date_time_now >= now() - interval '${ACTIVITY_WINDOW}'
        AND ${getFixedYearSqlFilter("a.doc_date")}
        ${branchFilterJob(scope, "a")}

      UNION ALL

      SELECT
        'bill_pickup' AS type,
        d.doc_no,
        d.bill_no,
        'ເບີກເຄື່ອງແລ້ວ' AS title,
        CONCAT('ບິນ ', d.bill_no, ' · ', COALESCE(cu.name_1, d.cust_code, '-')) AS body,
        d.recipt_job AS event_at,
        CONCAT('/tracking?search=', d.bill_no) AS href,
        'amber' AS tone
      FROM public.odg_tms_detail d
      LEFT JOIN public.odg_tms a ON a.doc_no = d.doc_no
      LEFT JOIN public.ar_customer cu ON cu.code = d.cust_code
      WHERE d.recipt_job IS NOT NULL
        AND d.recipt_job >= now() - interval '${ACTIVITY_WINDOW}'
        AND ${getFixedYearSqlFilter("d.doc_date")}
        ${branchFilterJob(scope, "a")}

      UNION ALL

      -- ເບີກເຄື່ອງບໍ່ຄົບ: one entry per pickup event (rows written in the same
      -- transaction share created_at to the second), not one per item line.
      SELECT
        'pickup_variance' AS type,
        v.doc_no,
        v.bill_no,
        'ເບີກເຄື່ອງບໍ່ຄົບຕາມຖ້ຽວ' AS title,
        CONCAT(
          'ບິນ ', v.bill_no, ' · ', COALESCE(NULLIF(TRIM(cu.name_1), ''), d.cust_code, '-'),
          ' · ', COUNT(*)::text, ' ລາຍການ',
          CASE WHEN SUM(GREATEST(-v.diff_qty, 0)) > 0
               THEN CONCAT(' · ຂາດ ', TRIM(TO_CHAR(SUM(GREATEST(-v.diff_qty, 0)), 'FM999999990.###')), ' ໜ່ວຍ')
               ELSE '' END
        ) AS body,
        MAX(v.created_at) AS event_at,
        CONCAT('/tracking?search=', v.bill_no) AS href,
        'rose' AS tone
      FROM public.odg_tms_pickup_variance v
      LEFT JOIN public.odg_tms a ON a.doc_no = v.doc_no
      LEFT JOIN public.odg_tms_detail d ON d.doc_no = v.doc_no AND d.bill_no = v.bill_no
      LEFT JOIN public.ar_customer cu ON cu.code = d.cust_code
      WHERE v.created_at IS NOT NULL
        AND v.created_at >= now() - interval '${ACTIVITY_WINDOW}'
        AND ${getFixedYearSqlFilter("a.doc_date")}
        ${branchFilterJob(scope, "a")}
      GROUP BY v.doc_no, v.bill_no, date_trunc('second', v.created_at),
               cu.name_1, d.cust_code

      UNION ALL

      SELECT
        'bill_dispatch' AS type,
        d.doc_no,
        d.bill_no,
        CASE WHEN d.sent_end IS NULL THEN 'ເລີ່ມຈັດສົ່ງ' ELSE 'ມີການເຄື່ອນໄຫວຈັດສົ່ງ' END AS title,
        CONCAT('ບິນ ', d.bill_no, ' · ', COALESCE(cu.name_1, d.cust_code, '-')) AS body,
        d.sent_start AS event_at,
        CONCAT('/tracking?search=', d.bill_no) AS href,
        'sky' AS tone
      FROM public.odg_tms_detail d
      LEFT JOIN public.odg_tms a ON a.doc_no = d.doc_no
      LEFT JOIN public.ar_customer cu ON cu.code = d.cust_code
      WHERE d.sent_start IS NOT NULL
        AND d.sent_start >= now() - interval '${ACTIVITY_WINDOW}'
        AND ${getFixedYearSqlFilter("d.doc_date")}
        ${branchFilterJob(scope, "a")}

      UNION ALL

      SELECT
        CASE WHEN COALESCE(d.status, 0) = 2 THEN 'bill_cancelled' ELSE 'bill_completed' END AS type,
        d.doc_no,
        d.bill_no,
        CASE WHEN COALESCE(d.status, 0) = 2 THEN 'ຍົກເລີກຈັດສົ່ງ' ELSE 'ຈັດສົ່ງສຳເລັດ' END AS title,
        CONCAT('ບິນ ', d.bill_no, ' · ', COALESCE(cu.name_1, d.cust_code, '-')) AS body,
        d.sent_end AS event_at,
        CONCAT('/tracking?search=', d.bill_no) AS href,
        CASE WHEN COALESCE(d.status, 0) = 2 THEN 'rose' ELSE 'emerald' END AS tone
      FROM public.odg_tms_detail d
      LEFT JOIN public.odg_tms a ON a.doc_no = d.doc_no
      LEFT JOIN public.ar_customer cu ON cu.code = d.cust_code
      WHERE d.sent_end IS NOT NULL
        AND d.sent_end >= now() - interval '${ACTIVITY_WINDOW}'
        AND COALESCE(d.status, 0) IN (1, 2)
        AND ${getFixedYearSqlFilter("d.doc_date")}
        ${branchFilterJob(scope, "a")}

      UNION ALL

      SELECT
        'job_closed' AS type,
        a.doc_no,
        NULL::text AS bill_no,
        'ປິດຖ້ຽວແລ້ວ' AS title,
        CONCAT('ຖ້ຽວ ', a.doc_no, ' · ', COALESCE(car.name_1, a.car, '-')) AS body,
        COALESCE(a.admin_close_at, a.job_close) AS event_at,
        '/jobs/closed' AS href,
        'slate' AS tone
      FROM public.odg_tms a
      LEFT JOIN public.odg_tms_car car ON car.code = a.car
      WHERE COALESCE(a.admin_close_at, a.job_close) IS NOT NULL
        AND COALESCE(a.admin_close_at, a.job_close) >= now() - interval '${ACTIVITY_WINDOW}'
        AND ${getFixedYearSqlFilter("a.doc_date")}
        ${branchFilterJob(scope, "a")}

      UNION ALL

      SELECT
        'chatter_message' AS type,
        cm.record_id AS doc_no,
        cm.record_id AS bill_no,
        CASE
          WHEN (',' || COALESCE(cm.mentions, '') || ',') LIKE ('%,' || $2 || ',%')
            THEN 'ຖືກແທັກໃນບິນ'
          ELSE 'ຂໍ້ຄວາມໃໝ່ໃນບິນ'
        END AS title,
        CONCAT(COALESCE(cm.author_name, cm.author_code, '-'), ': ', LEFT(cm.body, 60)) AS body,
        cm.created_at AS event_at,
        CONCAT('/tracking?search=', cm.record_id) AS href,
        'teal' AS tone
      FROM public.odg_chatter_message cm
      LEFT JOIN public.ic_trans it ON it.doc_no = cm.record_id
      WHERE cm.model = 'bill'
        AND cm.msg_type IN ('note', 'comment')
        AND $2 <> ''
        AND COALESCE(cm.author_code, '') <> $2
        AND cm.created_at >= now() - interval '30 days'
        AND (
          (',' || COALESCE(cm.mentions, '') || ',') LIKE ('%,' || $2 || ',%')
          OR EXISTS (SELECT 1 FROM public.odg_chatter_follower cf
                     WHERE cf.model = 'bill' AND cf.record_id = cm.record_id AND cf.user_code = $2)
          OR COALESCE(it.sale_code, '') = $2
          OR EXISTS (
                SELECT 1 FROM public.odg_employee me
                JOIN public.odg_employee sp ON sp.department_code = me.department_code
                WHERE me.employee_code = $2
                  AND me.position_code IN ('11', '12')
                  AND sp.employee_code = COALESCE(it.sale_code, ''))
          OR ($3 AND (cardinality($4::text[]) = 0 OR EXISTS (
                SELECT 1 FROM public.ic_trans_shipment ss
                WHERE ss.doc_no = cm.record_id AND ss.transport_code = ANY($4::text[]))))
        )

      UNION ALL

      SELECT
        'dm' AS type,
        cm.record_id AS doc_no,
        NULL::text AS bill_no,
        'ຂໍ້ຄວາມສ່ວນຕົວ' AS title,
        CONCAT(COALESCE(cm.author_name, cm.author_code, '-'), ': ', LEFT(cm.body, 60)) AS body,
        cm.created_at AS event_at,
        ('?dm=' || cm.record_id) AS href,
        'teal' AS tone
      FROM public.odg_chatter_message cm
      WHERE cm.model = 'dm'
        AND cm.msg_type IN ('note', 'comment')
        AND $2 <> ''
        AND COALESCE(cm.author_code, '') <> $2
        AND (cm.record_id LIKE ('dm:' || $2 || '|%') OR cm.record_id LIKE ('dm:%|' || $2))
        AND cm.created_at >= now() - interval '30 days'
    )
    SELECT
      type,
      doc_no,
      bill_no,
      title,
      body,
      href,
      tone,
      to_char(event_at, 'DD-MM-YYYY HH24:MI') AS event_time,
      EXTRACT(EPOCH FROM (now() - event_at))::int AS age_seconds,
      ${NOTIFICATION_KEY_SQL} AS notification_key,
      (r.user_code IS NOT NULL) AS read
    FROM activity
    LEFT JOIN public.odg_tms_notification_reads r
      ON r.user_code = $2
     AND r.notification_key = ${NOTIFICATION_KEY_SQL}
    WHERE event_at IS NOT NULL
    ORDER BY event_at DESC
    LIMIT $1`,
    [max, userCode, isAdmin, adminBranches]
  );
}

async function markActivityNotificationRead(session, notificationKey) {
  await ensureDeliveryWorkflowSchema();
  const userCode = String(session?.usercode ?? "");
  const key = String(notificationKey ?? "");
  if (!userCode || !key) return { success: false };
  await query(
    `INSERT INTO public.odg_tms_notification_reads (user_code, notification_key)
     VALUES ($1, $2)
     ON CONFLICT (user_code, notification_key) DO NOTHING`,
    [userCode, key]
  );
  return { success: true };
}

async function markAllActivityNotificationsRead(session, limit = 80) {
  const userCode = String(session?.usercode ?? "");
  if (!userCode) return { success: false };
  // Fetch the visible notifications and bulk-insert their keys for this
  // user — keeps "mark all" semantics consistent with what the dropdown
  // actually shows.
  const rows = await getActivityNotifications(session, limit);
  if (rows.length === 0) return { success: true, marked: 0 };
  const values = [];
  const placeholders = [];
  rows.forEach((row, i) => {
    placeholders.push(`($1, $${i + 2})`);
    values.push(String(row.notification_key));
  });
  await query(
    `INSERT INTO public.odg_tms_notification_reads (user_code, notification_key)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (user_code, notification_key) DO NOTHING`,
    [userCode, ...values]
  );
  return { success: true, marked: rows.length };
}

// Best-effort heads-up to the receiving branch's staff that a delivered bill was
// re-routed to them as "ສົ່ງຕໍ່ສາຂາ" and now sits in their available queue for
// onward delivery. Fire-and-forget — it only reaches users who have a registered
// push token (driver app or sales app); the bill also simply appears in their
// available-bills list regardless of whether the push lands.
async function notifyBillForwardedToBranch(billNo, branchCode, branchName) {
  try {
    const code = String(branchCode ?? "").trim();
    const bill = String(billNo ?? "").trim();
    if (!code || !bill) return;

    const recipients = await query(
      `SELECT code FROM erp_user WHERE NULLIF(TRIM(logistic_code), '') = $1`,
      [code]
    );
    const codes = recipients.map((r) => r.code).filter(Boolean);

    const meta = await queryOne(
      `SELECT COALESCE(NULLIF(TRIM(c.name_1), ''), s.cust_code, '') AS cust_name
       FROM public.ic_trans_shipment s
       LEFT JOIN ar_customer c ON c.code = s.cust_code
       WHERE s.doc_no = $1 LIMIT 1`,
      [bill]
    ).catch(() => null);

    const title = "📦 ມີບິນສົ່ງຕໍ່ເຂົ້າສາຂາ";
    const body = [
      `ບິນ ${bill}`,
      meta?.cust_name ? `ລູກຄ້າ ${meta.cust_name}` : null,
      `➡️ ${branchName || code} — ກະລຸນາຈັດສົ່ງຕໍ່ຫາລູກຄ້າ`,
    ]
      .filter(Boolean)
      .join("\n");
    // Try both token tables (driver app + sales/web app); each no-ops cleanly
    // for recipients without a token.
    const { pushToTopic } = require("./push");
    await pushToTopic({
      candidates: codes,
      title,
      body,
      data: { type: "bill_forwarded", bill_no: bill, branch_code: code },
    });
  } catch (err) {
    console.warn("[notify] forwarded-to-branch failed:", err?.message ?? err);
  }
}

module.exports = {
  notifyJobCreated,
  notifyJobCreatedToSales,
  notifyBillForwardedToBranch,
  notifyBillStatus,
  notifyPickupVariance,
  notifyBillDelivered,
  notifyCustomerLine,
  notifySalesLine,
  getActivityNotifications,
  markActivityNotificationRead,
  markAllActivityNotificationsRead,
  trackingLink,
};
