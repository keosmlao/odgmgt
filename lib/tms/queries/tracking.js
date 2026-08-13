const { pool, query, queryOne } = require("../lib/db");
const { getFixedYearSqlFilter } = require("../lib/fixed-year");
const {
  customerAreaSql,
  getBranchScope,
  branchFilterShipment,
  branchFilterJob,
} = require("./helpers");
const { ensurePendingBillSchema } = require("./pending-bill");
const { ensureDeliveryRouteSchema } = require("./delivery-route");
const { ensureDeliveryRoundSchema } = require("./delivery-round");
const { ensureDeliveryWorkflowSchema } = require("./delivery");
const gpsOpenApi = require("./gps-openapi");

const trackingCache = globalThis;
const REALTIME_PROVIDER_MIN_GAP_MS = Math.max(
  0,
  Number.parseInt(
    process.env.GPS_TRACKER_REALTIME_MIN_GAP_MS ??
      process.env.GPS_TRACKER_MIN_GAP_MS ??
      "1200",
    10
  ) || 1200
);
const REALTIME_PROVIDER_429_COOLDOWN_MS = Math.max(
  5_000,
  Number.parseInt(
    process.env.GPS_TRACKER_REALTIME_429_COOLDOWN_MS ??
      process.env.GPS_TRACKER_429_COOLDOWN_MS ??
      "30000",
    10
  ) || 30_000
);
const REALTIME_DB_FRESH_MS = Math.max(
  5_000,
  Number.parseInt(
    process.env.GPS_TRACKER_REALTIME_DB_FRESH_MS ?? "55000",
    10
  ) || 55_000
);

// ==================== Tracking ====================

function contactStatusLabel(status) {
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

function salesRoleFromSession(session) {
  const appRole = String(session?.app_role ?? "").trim().toLowerCase();
  const pos = String(session?.position_code ?? "").trim();
  if (appRole === "manager" || (!appRole && pos === "11")) return "manager";
  if (appRole === "head" || (!appRole && pos === "12")) return "head";
  if (appRole === "salesperson" || appRole === "pc" || (!appRole && pos === "13")) return "salesperson";
  return appRole || "";
}

function canSeeDepartmentSales(session) {
  const role = salesRoleFromSession(session);
  return role === "manager" || role === "head";
}

function pendingStepsFromRow(row) {
  if (!row) return [];
  const date = row.pending_updated_date || row.scheduled_date_display || row.bill_date || row.doc_date || "-";
  const time = row.pending_updated_time || "";
  const steps = [];
  const contact = contactStatusLabel(row.action_status);
  if (contact) {
    steps.push({ doc_date: date, doc_time: time, status: contact, remark: row.pending_remark || "" });
  }
  if (row.scheduled_date_display) {
    steps.push({ doc_date: row.scheduled_date_display, doc_time: "", status: "ກຳນົດວັນຮັບ", remark: "" });
  }
  if (row.delivery_route_code) {
    steps.push({
      doc_date: row.scheduled_date_display || date,
      doc_time: "",
      status: "ເລືອກເສັ້ນທາງ",
      remark: row.delivery_route_name || row.delivery_route_code,
    });
  }
  if (row.delivery_round_code) {
    steps.push({
      doc_date: row.scheduled_date_display || date,
      doc_time: row.delivery_round_time_label || "",
      status: "ເລືອກຮອບ",
      remark: row.delivery_round_name || row.delivery_round_code,
    });
  }
  return steps;
}

async function getPendingTrackingRow(session, search) {
  await ensurePendingBillSchema();
  await ensureDeliveryRouteSchema();
  await ensureDeliveryRoundSchema();
  const scope = getBranchScope(session);
  const branchClause = scope.scoped ? `AND s.transport_code IN (${scope.branchListSql})` : "";
  const serviceBranchClause = scope.scoped ? "AND false" : "";
  const text = String(search ?? "").trim().toUpperCase();
  const [shipmentRow, serviceRow] = await Promise.all([
    queryOne(
      `SELECT
         COALESCE(t.doc_no, s.doc_no, pb.bill_no) as bill_no,
         to_char(COALESCE(t.doc_date, s.doc_date),'DD-MM-YYYY') as bill_date,
         to_char(COALESCE(t.doc_date, s.doc_date),'DD-MM-YYYY') as doc_date,
         COALESCE(NULLIF(TRIM(c.name_1), ''), COALESCE(t.cust_code, s.cust_code), '-') as customer_name,
         COALESCE(pb.action_status, '') as action_status,
         COALESCE(pb.remark, '') as pending_remark,
         to_char(pb.updated_at,'DD-MM-YYYY') as pending_updated_date,
         to_char(pb.updated_at,'HH24:MI') as pending_updated_time,
         to_char(pb.scheduled_date,'YYYY-MM-DD') as scheduled_date,
         to_char(pb.scheduled_date,'DD-MM-YYYY') as scheduled_date_display,
         COALESCE(pb.delivery_route_code, '') as delivery_route_code,
         COALESCE(rt.name, '') as delivery_route_name,
         COALESCE(pb.delivery_round_code, '') as delivery_round_code,
         COALESCE(dr.name, '') as delivery_round_name,
         COALESCE(dr.time_label, '') as delivery_round_time_label
       FROM public.odg_tms_pending_bill pb
       LEFT JOIN public.ic_trans_shipment s ON s.doc_no = pb.bill_no
       LEFT JOIN public.ic_trans t ON t.doc_no = pb.bill_no
       LEFT JOIN public.ar_customer c ON c.code = COALESCE(t.cust_code, s.cust_code)
       LEFT JOIN public.odg_tms_delivery_route rt ON rt.code = pb.delivery_route_code
       LEFT JOIN public.odg_tms_delivery_round dr ON dr.code = pb.delivery_round_code
       WHERE UPPER(pb.bill_no) LIKE $1
         ${branchClause}
       ORDER BY pb.updated_at DESC NULLS LAST
       LIMIT 1`,
      [`%${text}%`]
    ),
    queryOne(
      `SELECT
         pb.bill_no,
         to_char(MAX(COALESCE(p.time_register, p.create_date_time_now)),'DD-MM-YYYY') as bill_date,
         to_char(MAX(COALESCE(p.time_register, p.create_date_time_now)),'DD-MM-YYYY') as doc_date,
         COALESCE(MAX(NULLIF(TRIM(p.name_1), '')), MAX(NULLIF(TRIM(p.p_model), '')), pb.bill_no) as customer_name,
         COALESCE(pb.action_status, '') as action_status,
         COALESCE(pb.remark, '') as pending_remark,
         to_char(pb.updated_at,'DD-MM-YYYY') as pending_updated_date,
         to_char(pb.updated_at,'HH24:MI') as pending_updated_time,
         to_char(pb.scheduled_date,'YYYY-MM-DD') as scheduled_date,
         to_char(pb.scheduled_date,'DD-MM-YYYY') as scheduled_date_display,
         COALESCE(pb.delivery_route_code, '') as delivery_route_code,
         COALESCE(rt.name, '') as delivery_route_name,
         COALESCE(pb.delivery_round_code, '') as delivery_round_code,
         COALESCE(dr.name, '') as delivery_round_name,
         COALESCE(dr.time_label, '') as delivery_round_time_label
       FROM public.odg_tms_pending_bill pb
       INNER JOIN public.tb_product p ON p.code = pb.bill_no
       LEFT JOIN public.odg_tms_delivery_route rt ON rt.code = pb.delivery_route_code
       LEFT JOIN public.odg_tms_delivery_round dr ON dr.code = pb.delivery_round_code
       WHERE UPPER(pb.bill_no) LIKE $1
         ${serviceBranchClause}
       GROUP BY pb.bill_no, pb.action_status, pb.remark, pb.updated_at, pb.scheduled_date,
                pb.delivery_route_code, rt.name, pb.delivery_round_code, dr.name, dr.time_label
       ORDER BY pb.updated_at DESC NULLS LAST
       LIMIT 1`,
      [`%${text}%`]
    ),
  ]);
  return shipmentRow || serviceRow || null;
}

async function getBillAttempts(billNo, branchClause = "") {
  return query(
    `SELECT
       d.doc_no,
       to_char(MAX(d.doc_date), 'DD-MM-YYYY') AS doc_date,
       COALESCE(
         to_char(MAX(j.create_date_time_now), 'DD-MM-YYYY HH24:MI'),
         to_char(MAX(d.create_date_time_now), 'DD-MM-YYYY HH24:MI'),
         '-'
       ) AS created_at,
       -- Trip-level metadata: car name + driver name + destination address
       -- so each attempt row in the UI can show what was sent / by whom /
       -- where without an extra round-trip per attempt.
       COALESCE(MAX(NULLIF(TRIM(car.name_1), '')), MAX(NULLIF(TRIM(j.car), '')), '') AS car,
       COALESCE(MAX(NULLIF(TRIM(drv.name_1), '')), MAX(NULLIF(TRIM(j.driver), '')), '') AS driver,
       COALESCE(MAX(NULLIF(TRIM(s.destination), '')), '') AS destination,
       -- Delivery type: forward_transport_code NULL = delivered to customer,
       -- non-NULL = forwarded to a sister branch. Forward name lets the UI
       -- render "ສົ່ງສາຂາ <name>" without a second lookup.
       COALESCE(MAX(NULLIF(TRIM(d.forward_transport_code), '')), '') AS forward_transport_code,
       COALESCE(MAX(NULLIF(TRIM(fwd.name_1), '')), '') AS forward_transport_name,
       COUNT(*)::int AS row_count,
       COUNT(*) FILTER (WHERE COALESCE(d.status, 0) = 1)::int AS completed_count,
       COUNT(*) FILTER (WHERE COALESCE(d.status, 0) = 2)::int AS cancelled_count,
       COUNT(*) FILTER (
         WHERE d.checkin_at IS NOT NULL
           AND d.sent_end IS NULL
           AND COALESCE(d.status, 0) NOT IN (1, 2)
       )::int AS active_count,
       -- Trip-level status (0=ລໍຖ້າ, 1=ຮັບຖ້ຽວ, 2=ກຳລັງຈັດສົ່ງ,
       -- 3=ຄົນຂັບປິດງານ, 4=admin ປິດ). Frontend uses this so a bill's row
       -- shows "ກຳລັງຈັດສົ່ງ" once the truck rolls, even before checkin.
       COALESCE(MAX(j.job_status), 0)::int AS job_status,
       to_char(MAX(d.sent_end) FILTER (WHERE COALESCE(d.status, 0) = 2), 'DD-MM-YYYY HH24:MI') AS cancelled_at,
       COALESCE(
         (ARRAY_AGG(NULLIF(TRIM(d.remark), '') ORDER BY d.sent_end DESC NULLS LAST)
           FILTER (WHERE COALESCE(d.status, 0) = 2)
         )[1],
         ''
       ) AS cancel_remark,
       -- Items dispatched in this attempt — frontend uses them to show what
       -- was sent. selected_qty = what was loaded; delivered_qty = what
       -- actually arrived (smaller when partial / cancelled). When the row
       -- table hasn't been populated yet (driver never tapped pickup; trip
       -- cancelled before pickup) fall back to ic_trans_detail so the user
       -- still sees what the bill contained.
       COALESCE(
         (SELECT json_agg(json_build_object(
            'item_code', i.item_code,
            'item_name', i.item_name,
            'qty', i.qty,
            'selected_qty', i.selected_qty,
            'delivered_qty', i.delivered_qty,
            'unit_code', i.unit_code
          ) ORDER BY i.roworder NULLS LAST, i.item_code)
          FROM public.odg_tms_detail_item i
          WHERE i.bill_no = $1 AND i.doc_no = d.doc_no),
         (SELECT json_agg(json_build_object(
            'item_code', sub.item_code,
            'item_name', sub.item_name,
            'qty', sub.qty,
            'selected_qty', sub.qty,
            'delivered_qty', 0,
            'unit_code', sub.unit_code
          ) ORDER BY sub.item_code)
          FROM (
            SELECT t.item_code,
                   MAX(t.item_name) AS item_name,
                   SUM(COALESCE(t.qty, 0))::numeric AS qty,
                   MAX(t.unit_code) AS unit_code
            FROM ic_trans_detail t
            WHERE t.doc_no = $1 AND t.item_code NOT LIKE '97%'
            GROUP BY t.item_code
          ) sub),
         '[]'::json
       ) AS items,
       MAX(COALESCE(j.create_date_time_now, d.create_date_time_now, d.doc_date::timestamp)) AS sort_at
     FROM public.odg_tms_detail d
     LEFT JOIN public.odg_tms j ON j.doc_no = d.doc_no
     LEFT JOIN public.odg_tms_car car ON car.code = j.car
     LEFT JOIN public.odg_tms_driver drv ON drv.code = j.driver
     LEFT JOIN public.ic_trans_shipment s ON s.doc_no = d.bill_no
     LEFT JOIN public.transport_type fwd ON fwd.code = d.forward_transport_code
     WHERE d.bill_no = $1
       AND ${getFixedYearSqlFilter("d.doc_date")}
       ${branchClause.replaceAll("a.", "d.")}
     GROUP BY d.doc_no
     ORDER BY sort_at DESC NULLS LAST, d.doc_no DESC`,
    [billNo]
  );
}

// Sale-bill items (ic_trans_detail) — fallback for bills not yet dispatched
// into a trip (no odg_tms_detail_item rows), so the product list is never
// empty for a real bill. selected_qty = ordered qty; delivered_qty = 0.
async function getSaleItems(billNo) {
  return query(
    `SELECT t.item_code,
            MAX(t.item_name) AS item_name,
            SUM(COALESCE(t.qty, 0))::numeric AS qty,
            SUM(COALESCE(t.qty, 0))::numeric AS selected_qty,
            0::numeric AS delivered_qty,
            MAX(t.unit_code) AS unit_code
     FROM public.ic_trans_detail t
     WHERE t.doc_no = $1 AND t.item_code NOT LIKE '97%'
     GROUP BY t.item_code
     ORDER BY t.item_code`,
    [String(billNo ?? "").trim()]
  );
}

async function trackBill(session, search) {
  await ensureDeliveryWorkflowSchema();
  const scope = getBranchScope(session);
  const branchClause = scope.scoped
    ? `AND EXISTS (SELECT 1 FROM public.ic_trans_shipment __ts WHERE __ts.doc_no = a.bill_no AND __ts.transport_code IN (${scope.branchListSql}))`
    : "";
  const row = await queryOne(`SELECT a.doc_no, to_char(a.doc_date,'DD-MM-YYYY') as doc_date, bill_no, to_char(bill_date,'DD-MM-YYYY') as bill_date,
      a.car as car_code, c.name_1 as car, d.name_1 as driver, b2.code as driver_code,
      COALESCE(b2.employee_photo, '') as driver_photo,
      COALESCE(b.origin_transport_code, '') as origin_transport_code,
      COALESCE(ott.name_1, '') as origin_transport_name,
      COALESCE(a.forward_transport_code, '') as forward_transport_code,
      COALESCE(fwd.name_1, '') as forward_transport_name,
      c.imei as car_imei,
      url_img, COALESCE(a.sight_img, '') as sight_img,
      COALESCE(a.recipt_img, '') as recipt_img,
      COALESCE(a.recipt_sign_img, '') as recipt_sign_img,
      COALESCE(img.delivery_images, ARRAY[]::text[]) as delivery_images,
      a.lat, a.lng, a.lat_end, a.lng_end, a.remark,
      COALESCE(a.status, 0) as bill_status,
      (SELECT json_agg(json_build_object(
        'doc_date', doc_date,
        'doc_time', doc_time,
        'status', status,
        'remark', remark
      ) ORDER BY event_at ASC NULLS LAST) FROM (
        SELECT create_date_time_now AS event_at, to_char(create_date_time_now,'DD-MM-YYYY') as doc_date, to_char(create_date_time_now,'HH24:MI') as doc_time, 'ຈັດຖ້ຽວແລ້ວ' as status, '' as remark FROM odg_tms_detail WHERE bill_no=a.bill_no AND doc_no=a.doc_no
        UNION ALL SELECT recipt_job, to_char(recipt_job,'DD-MM-YYYY'), to_char(recipt_job,'HH24:MI'), 'ຮັບຖ້ຽວ / ເບີກເຄື່ອງ', COALESCE(NULLIF(TRIM(ott.name_1), ''), NULLIF(TRIM(b.origin_transport_code), ''), '') FROM odg_tms_detail WHERE recipt_job IS NOT NULL AND bill_no=a.bill_no AND doc_no=a.doc_no
        UNION ALL SELECT b.dispatch_started_at, to_char(b.dispatch_started_at,'DD-MM-YYYY'), to_char(b.dispatch_started_at,'HH24:MI'), 'ເລີ່ມຈັດສົ່ງ', '' WHERE b.dispatch_started_at IS NOT NULL
        UNION ALL SELECT sent_end, to_char(sent_end,'DD-MM-YYYY'), to_char(sent_end,'HH24:MI'), case when status=2 then 'ຍົກເລີກຈັດສົ່ງ' else 'ຈັດສົ່ງສຳເລັດ' end, remark FROM odg_tms_detail WHERE sent_end IS NOT NULL AND bill_no=a.bill_no AND doc_no=a.doc_no
      ) events) as list
    FROM odg_tms_detail a
    LEFT JOIN odg_tms b ON b.doc_no=a.doc_no
    LEFT JOIN odg_tms_car c ON c.code=a.car
    LEFT JOIN odg_tms_driver d ON d.code=b.driver
    LEFT JOIN biotime_employee b2 ON b2.code = b.driver
    LEFT JOIN transport_type ott ON ott.code = b.origin_transport_code
    LEFT JOIN public.transport_type fwd ON fwd.code = a.forward_transport_code
    LEFT JOIN LATERAL (
      SELECT array_agg(di.image_data ORDER BY di.created_at ASC, di.roworder ASC) as delivery_images
      FROM public.odg_tms_delivery_images di
      WHERE di.bill_no = a.bill_no
    ) img ON true
    WHERE bill_no LIKE $1 AND ${getFixedYearSqlFilter("a.doc_date")} ${branchClause}
    ORDER BY COALESCE(b.create_date_time_now, a.create_date_time_now, a.doc_date::timestamp) DESC NULLS LAST,
             a.doc_no DESC
    LIMIT 1`, [search.toUpperCase()]);

  if (!row) {
    const pending = await getPendingTrackingRow(session, search);
    if (!pending) return null;
    return {
      doc_no: "",
      doc_date: pending.doc_date || "-",
      bill_no: pending.bill_no,
      bill_date: pending.bill_date || "-",
      car: "",
      driver: "",
      url_img: "",
      sight_img: "",
      recipt_img: "",
      recipt_sign_img: "",
      delivery_images: [],
      lat: "",
      lng: "",
      lat_end: "",
      lng_end: "",
      remark: pending.pending_remark || "",
      bill_status: 0,
      list: pendingStepsFromRow(pending),
      items: await getSaleItems(pending.bill_no),
      attempts: [],
      car_position: null,
      tracking_stage: "pending",
      customer_name: pending.customer_name || "",
      scheduled_date: pending.scheduled_date || "",
      scheduled_date_display: pending.scheduled_date_display || "",
      delivery_route_code: pending.delivery_route_code || "",
      delivery_route_name: pending.delivery_route_name || "",
      delivery_round_code: pending.delivery_round_code || "",
      delivery_round_name: pending.delivery_round_name || "",
      delivery_round_time_label: pending.delivery_round_time_label || "",
      action_status: pending.action_status || "",
    };
  }
  const attempts = await getBillAttempts(row.bill_no, branchClause);
  const pending = await getPendingTrackingRow(session, row.bill_no);
  const pendingSteps = pendingStepsFromRow(pending);

  // Items selected for this dispatch (with delivered progress).
  let items = await query(
    `SELECT i.item_code, i.item_name,
            COALESCE(i.qty, 0)::numeric as qty,
            COALESCE(i.selected_qty, 0)::numeric as selected_qty,
            COALESCE(i.delivered_qty, 0)::numeric as delivered_qty,
            i.unit_code
     FROM public.odg_tms_detail_item i
     INNER JOIN public.odg_tms_detail d
       ON d.bill_no = i.bill_no AND d.doc_no = i.doc_no
     WHERE i.bill_no = $1 AND d.doc_no = $2
     ORDER BY i.roworder NULLS LAST, i.item_code`,
    [row.bill_no, row.doc_no]
  );
  // Dispatch rows not populated yet → show the sale's items instead.
  if (!items || items.length === 0) {
    items = await getSaleItems(row.bill_no);
  }

  // Latest GPS position for the car. We query odg_tms_gps_current (the live
  // sync table) by car_code first, falling back to imei. Wrap in try/catch
  // so any GPS issue never breaks the bill tracking.
  // Live position for the map. PREFER the driver's PHONE GPS (mobile app
  // travel_history for this trip); fall back to the car's GPS device.
  let car_position = null;
  try {
    if (row.doc_no) {
      car_position = await queryOne(
        `SELECT lat::float as lat, lng::float as lng,
                COALESCE(speed::float, 0) as speed,
                COALESCE(heading::float, 0) as heading,
                to_char(recorded_at::timestamp,'DD-MM-YYYY HH24:MI:SS') as recorded_at,
                '' as address, '' as state_detail,
                GREATEST(0, EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'Asia/Bangkok') - recorded_at::timestamp)))::int as age_seconds
         FROM public.odg_tms_travel_history
         WHERE doc_no = $1 AND lat IS NOT NULL AND lng IS NOT NULL
         ORDER BY recorded_at DESC NULLS LAST
         LIMIT 1`,
        [String(row.doc_no).trim()]
      );
    }
    if (!car_position) {
      const params = [];
      const conds = [];
      if (row.car_code) {
        params.push(String(row.car_code).trim());
        conds.push(`car_code = $${params.length}`);
      }
      if (row.car_imei) {
        params.push(String(row.car_imei).trim());
        conds.push(`imei = $${params.length}`);
      }
      if (conds.length > 0) {
        // recorded_at is wall-clock Bangkok time (UTC+7) without tz; the DB
        // runs in UTC, so compare against NOW() in Bangkok for a sane age.
        car_position = await queryOne(
          `SELECT lat::float as lat, lng::float as lng,
                  COALESCE(speed::float, 0) as speed,
                  COALESCE(heading::float, 0) as heading,
                  to_char(recorded_at::timestamp,'DD-MM-YYYY HH24:MI:SS') as recorded_at,
                  COALESCE(address, '') as address,
                  COALESCE(state_detail, '') as state_detail,
                  GREATEST(0, EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'Asia/Bangkok') - recorded_at::timestamp)))::int as age_seconds
           FROM public.odg_tms_gps_current
           WHERE ${conds.join(" OR ")}
           ORDER BY recorded_at DESC NULLS LAST
           LIMIT 1`,
          params
        );
      }
    }
  } catch (err) {
    console.warn("[trackBill] gps lookup failed:", err?.message ?? err);
  }

  return {
    ...row,
    list: [...pendingSteps, ...((row.list || []).filter(Boolean))],
    items,
    car_position,
    attempts,
    tracking_stage: "dispatch",
    scheduled_date: pending?.scheduled_date || "",
    scheduled_date_display: pending?.scheduled_date_display || "",
    delivery_route_code: pending?.delivery_route_code || "",
    delivery_route_name: pending?.delivery_route_name || "",
    delivery_round_code: pending?.delivery_round_code || "",
    delivery_round_name: pending?.delivery_round_name || "",
    delivery_round_time_label: pending?.delivery_round_time_label || "",
    action_status: pending?.action_status || "",
  };
}

async function getSalesBillTrackingList(session, opts = {}) {
  await ensurePendingBillSchema();
  await ensureDeliveryRouteSchema();
  await ensureDeliveryRoundSchema();
  await ensureDeliveryWorkflowSchema();
  // Sales scope:
  // - salesperson/admin: their own bills only (t.creator_code = session.usercode —
  //   the salesperson who created the bill; ERP sale_code is a separate area/rep
  //   code that is often blank or different, so it must NOT be used for scoping)
  // - head/manager: whole sales department, read-only, with owner shown in UI.
  const empDept = String(session?.emp_department_code ?? "").trim();
  const userCode = String(session?.usercode ?? "").trim();
  if (!empDept || !userCode) return [];
  const deptScope = canSeeDepartmentSales(session);
  const scopeRole = salesRoleFromSession(session) || "admin";
  const scopeLabel = deptScope ? "ທັງໝົດໃນພະແນກ" : "ຂອງຕົນເອງ";

  const fromDate = String(opts.fromDate ?? "").trim() || "1900-01-01";
  const toDate = String(opts.toDate ?? "").trim() || "2999-12-31";
  const search = String(opts.search ?? "").trim();
  // This list is the undelivered/in-progress tracking view (status <> 1).
  // Completed-delivery bills have their own query: getSalesDeliveredBillTrackingList.
  const statusClause = "AND COALESCE(latest.status, 0) <> 1";
  const params = [deptScope ? empDept : userCode, fromDate, toDate, deptScope, scopeRole, scopeLabel];
  const scopeClause = deptScope
    ? "COALESCE(NULLIF(TRIM(sale_e.department_code), ''), '') = $1"
    : "COALESCE(NULLIF(TRIM(t.creator_code), ''), '') = $1";
  let searchClause = "";
  if (search) {
    params.push(`%${search.toUpperCase()}%`);
    searchClause = `AND (
      UPPER(t.doc_no) LIKE $${params.length}
      OR UPPER(COALESCE(c.name_1, '')) LIKE $${params.length}
      OR UPPER(COALESCE(t.cust_code, '')) LIKE $${params.length}
      OR UPPER(COALESCE(t.remark, '')) LIKE $${params.length}
    )`;
  }

  return query(
    `SELECT
       t.doc_no AS bill_no,
       to_char(t.doc_date,'DD-MM-YYYY') AS bill_date,
       to_char(t.doc_date,'YYYY-MM-DD') AS bill_date_iso,
       GREATEST(0, (CURRENT_DATE - t.doc_date::date))::int AS days_open,
       to_char(t.send_date,'DD-MM-YYYY') AS send_date_display,
       to_char(t.send_date,'YYYY-MM-DD') AS send_date,
       COALESCE(NULLIF(TRIM(c.name_1), ''), t.cust_code, '-') AS customer_name,
       COALESCE(NULLIF(TRIM(t.cust_code), ''), '') AS cust_code,
       COALESCE(NULLIF(TRIM(c.telephone), ''), '') AS telephone,
       COALESCE(NULLIF(TRIM(t.remark), ''), '') AS sales_remark,
       COALESCE(NULLIF(TRIM(t.creator_code), ''), '') AS sale_code,
       COALESCE(NULLIF(TRIM(sale_e.fullname_lo), ''), NULLIF(TRIM(sale_e.nickname), ''), NULLIF(TRIM(t.creator_code), ''), '') AS salesperson,
       $4::boolean AS scope_readonly,
       $5::text AS scope_role,
       $6::text AS scope_label,
       COALESCE(NULLIF(TRIM(tt.name_1), ''), NULLIF(TRIM(s.transport_code), ''), '') AS transport_name,
       COALESCE(pb.action_status, '') AS action_status,
       COALESCE(pb.remark, '') AS pending_remark,
       to_char(pb.updated_at,'DD-MM-YYYY HH24:MI') AS pending_updated_at,
       to_char(pb.scheduled_date,'DD-MM-YYYY') AS scheduled_date_display,
       COALESCE(pb.delivery_route_code, '') AS delivery_route_code,
       COALESCE(rt.name, '') AS delivery_route_name,
       COALESCE(pb.delivery_round_code, '') AS delivery_round_code,
       COALESCE(dr.name, '') AS delivery_round_name,
       COALESCE(dr.time_label, '') AS delivery_round_time_label,
       COALESCE(latest.doc_no, '') AS job_no,
       to_char(latest.doc_date,'DD-MM-YYYY') AS job_date,
       COALESCE(latest.status, 0)::int AS bill_status,
       COALESCE(latest.job_status, 0)::int AS job_status,
       to_char(latest.recipt_job,'DD-MM-YYYY HH24:MI') AS received_at,
       to_char(latest.sent_start,'DD-MM-YYYY HH24:MI') AS sent_start_at,
       to_char(latest.sent_end,'DD-MM-YYYY HH24:MI') AS sent_end_at,
       COALESCE(NULLIF(TRIM(car.name_1), ''), latest.car, '') AS car,
       COALESCE(NULLIF(TRIM(car.plate_no), ''), '') AS car_plate,
       COALESCE(NULLIF(TRIM(driver.name_1), ''), job.driver, '') AS driver,
       COALESCE(NULLIF(TRIM(driver.tel), ''), '') AS driver_phone,
       COALESCE(attempts.attempt_count, 0)::int AS attempt_count,
       COALESCE(attempts.completed_count, 0)::int AS completed_count,
       COALESCE(attempts.cancelled_count, 0)::int AS cancelled_count,
       CASE
         WHEN latest.status = 1 THEN 'delivered'
         WHEN latest.status = 2 THEN 'cancelled'
         WHEN latest.sent_start IS NOT NULL OR COALESCE(latest.job_status, 0) >= 2 THEN 'in_delivery'
         WHEN latest.recipt_job IS NOT NULL OR COALESCE(latest.job_status, 0) = 1 THEN 'received'
         WHEN latest.doc_no IS NOT NULL THEN 'assigned'
         WHEN pb.bill_no IS NOT NULL THEN 'pending'
         WHEN s.doc_no IS NOT NULL THEN 'shipment_opened'
         ELSE 'opened'
       END AS current_stage
     FROM public.ic_trans t
     LEFT JOIN public.ic_trans_shipment s ON s.doc_no = t.doc_no
     LEFT JOIN public.ar_customer c ON c.code = t.cust_code
     LEFT JOIN public.odg_employee sale_e ON sale_e.employee_code = t.creator_code
     LEFT JOIN public.transport_type tt ON tt.code = s.transport_code
     LEFT JOIN public.odg_tms_pending_bill pb ON pb.bill_no = t.doc_no
     LEFT JOIN public.odg_tms_delivery_route rt ON rt.code = pb.delivery_route_code
     LEFT JOIN public.odg_tms_delivery_round dr ON dr.code = pb.delivery_round_code
     LEFT JOIN LATERAL (
       SELECT d.doc_no, d.doc_date, d.status, d.recipt_job, d.sent_start, d.sent_end,
              d.car, j.driver, j.car AS job_car, j.job_status,
              COALESCE(j.create_date_time_now, d.create_date_time_now, d.doc_date::timestamp) AS sort_at
       FROM public.odg_tms_detail d
       LEFT JOIN public.odg_tms j ON j.doc_no = d.doc_no
       WHERE d.bill_no = t.doc_no
         AND ${getFixedYearSqlFilter("d.doc_date")}
       ORDER BY sort_at DESC NULLS LAST, d.doc_no DESC
       LIMIT 1
     ) latest ON true
     LEFT JOIN public.odg_tms job ON job.doc_no = latest.doc_no
     LEFT JOIN public.odg_tms_car car ON car.code = COALESCE(latest.job_car, latest.car)
     LEFT JOIN public.odg_tms_driver driver ON driver.code = COALESCE(job.driver, latest.driver)
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS attempt_count,
              COUNT(*) FILTER (WHERE COALESCE(d.status, 0) = 1)::int AS completed_count,
              COUNT(*) FILTER (WHERE COALESCE(d.status, 0) = 2)::int AS cancelled_count
       FROM public.odg_tms_detail d
       WHERE d.bill_no = t.doc_no
         AND ${getFixedYearSqlFilter("d.doc_date")}
     ) attempts ON true
     WHERE ${scopeClause}
       AND t.trans_flag = 44
       AND NOT EXISTS (
         SELECT 1 FROM public.ic_trans_detail rd
         INNER JOIN public.ic_trans r ON r.doc_no = rd.doc_no AND r.trans_flag = 48
         WHERE rd.ref_doc_no = t.doc_no
       )
       AND COALESCE(NULLIF(TRIM(s.transport_code), ''), '') NOT IN ('', '02-0004')
       AND COALESCE(t.send_date, t.doc_date)::date BETWEEN $2::date AND $3::date
       AND ${getFixedYearSqlFilter("t.doc_date")}
       ${statusClause}
       ${searchClause}
     ORDER BY COALESCE(t.send_date, t.doc_date) DESC, t.doc_no DESC
     LIMIT 500`,
    params
  );
}

// Completed-delivery tracking list for sales ("ບິນສົ່ງສຳເລັດ").
//
// Driven by the delivery ledger (odg_tms_detail.status = 1) — the same
// definition of "delivered" used by the dashboard / driver-leaderboard /
// delivery-calendar — NOT by the undelivered list's `latest.status` /
// trans_flag=44 / ic_trans_shipment.transport_code filters. Those filters
// silently dropped genuinely-delivered bills here:
//   - manual/transfer bills (trans_flag 70/72/56) and flag-44 bills whose
//     shipment row has no transport_code (their branch lives in pb.transport_code),
//   - bills delivered once but later re-attempted/returned (latest row not status=1),
//   - bills delivered this month but billed in an earlier month (list filtered
//     by bill date, not delivery date).
// One row per bill = its most recent completed attempt; ranged by DELIVERY date
// (sent_end) so "delivered in this period" means what sales expects.
async function getSalesDeliveredBillTrackingList(session, opts = {}) {
  await ensurePendingBillSchema();
  await ensureDeliveryWorkflowSchema();
  const empDept = String(session?.emp_department_code ?? "").trim();
  const userCode = String(session?.usercode ?? "").trim();
  if (!empDept || !userCode) return [];
  const deptScope = canSeeDepartmentSales(session);
  const scopeRole = salesRoleFromSession(session) || "admin";
  const scopeLabel = deptScope ? "ທັງໝົດໃນພະແນກ" : "ຂອງຕົນເອງ";

  const fromDate = String(opts.fromDate ?? "").trim() || "1900-01-01";
  const toDate = String(opts.toDate ?? "").trim() || "2999-12-31";
  const search = String(opts.search ?? "").trim();
  const params = [deptScope ? empDept : userCode, fromDate, toDate, deptScope, scopeRole, scopeLabel];
  const scopeClause = deptScope
    ? "COALESCE(NULLIF(TRIM(sale_e.department_code), ''), '') = $1"
    : "COALESCE(NULLIF(TRIM(t.creator_code), ''), '') = $1";
  let searchClause = "";
  if (search) {
    params.push(`%${search.toUpperCase()}%`);
    searchClause = `AND (
      UPPER(t.doc_no) LIKE $${params.length}
      OR UPPER(COALESCE(c.name_1, '')) LIKE $${params.length}
      OR UPPER(COALESCE(t.cust_code, '')) LIKE $${params.length}
    )`;
  }

  return query(
    `SELECT
       t.doc_no AS bill_no,
       to_char(t.doc_date,'DD-MM-YYYY') AS bill_date,
       to_char(t.doc_date,'YYYY-MM-DD') AS bill_date_iso,
       COALESCE(NULLIF(TRIM(c.name_1), ''), t.cust_code, '-') AS customer_name,
       COALESCE(NULLIF(TRIM(t.cust_code), ''), '') AS cust_code,
       COALESCE(NULLIF(TRIM(c.telephone), ''), '') AS telephone,
       COALESCE(NULLIF(TRIM(t.creator_code), ''), '') AS sale_code,
       COALESCE(NULLIF(TRIM(sale_e.fullname_lo), ''), NULLIF(TRIM(sale_e.nickname), ''), NULLIF(TRIM(t.creator_code), ''), '') AS salesperson,
       $4::boolean AS scope_readonly,
       $5::text AS scope_role,
       $6::text AS scope_label,
       COALESCE(NULLIF(TRIM(tt.name_1), ''), NULLIF(TRIM(s.transport_code), ''), NULLIF(TRIM(pb.transport_code), ''), '') AS transport_name,
       to_char(deliv.sent_end,'DD-MM-YYYY HH24:MI') AS sent_end_at,
       COALESCE(NULLIF(TRIM(car.name_1), ''), '') AS car,
       COALESCE(NULLIF(TRIM(car.plate_no), ''), '') AS car_plate,
       COALESCE(NULLIF(TRIM(driver.name_1), ''), job.driver, '') AS driver,
       COALESCE(NULLIF(TRIM(driver.tel), ''), '') AS driver_phone
     FROM (
       SELECT DISTINCT ON (d.bill_no) d.bill_no, d.doc_no, d.sent_end, d.car
       FROM public.odg_tms_detail d
       WHERE d.status = 1
         AND ${getFixedYearSqlFilter("d.doc_date")}
         AND COALESCE(d.sent_end::date, d.doc_date) BETWEEN $2::date AND $3::date
       ORDER BY d.bill_no, d.sent_end DESC NULLS LAST, d.doc_no DESC
     ) deliv
     JOIN public.ic_trans t ON t.doc_no = deliv.bill_no
     LEFT JOIN public.ic_trans_shipment s ON s.doc_no = t.doc_no
     LEFT JOIN public.ar_customer c ON c.code = t.cust_code
     LEFT JOIN public.odg_employee sale_e ON sale_e.employee_code = t.creator_code
     LEFT JOIN public.odg_tms_pending_bill pb ON pb.bill_no = t.doc_no
     LEFT JOIN public.transport_type tt ON tt.code = COALESCE(NULLIF(TRIM(s.transport_code), ''), pb.transport_code)
     LEFT JOIN public.odg_tms job ON job.doc_no = deliv.doc_no
     LEFT JOIN public.odg_tms_car car ON car.code = COALESCE(job.car, deliv.car)
     LEFT JOIN public.odg_tms_driver driver ON driver.code = job.driver
     WHERE ${scopeClause}
       AND ${getFixedYearSqlFilter("t.doc_date")}
       AND t.trans_flag <> 48
       ${searchClause}
     ORDER BY deliv.sent_end DESC NULLS LAST, t.doc_no DESC
     LIMIT 500`,
    params
  );
}

async function trackSalesBill(session, billNo) {
  const empDept = String(session?.emp_department_code ?? "").trim();
  const userCode = String(session?.usercode ?? "").trim();
  const clean = String(billNo ?? "").trim().toUpperCase();
  if (!empDept || !userCode || !clean) return null;
  const deptScope = canSeeDepartmentSales(session);
  const scopeClause = deptScope
    ? "COALESCE(NULLIF(TRIM(u.department_code), ''), '') = $2"
    : "COALESCE(NULLIF(TRIM(t.creator_code), ''), '') = $2";
  const ownBill = await queryOne(
    `SELECT t.doc_no
     FROM public.ic_trans t
     LEFT JOIN public.odg_employee u ON u.employee_code = t.creator_code
     WHERE t.doc_no = $1
       AND t.trans_flag = 44
       AND ${scopeClause}
       AND ${getFixedYearSqlFilter("t.doc_date")}
     LIMIT 1`,
    [clean, deptScope ? empDept : userCode]
  );
  if (!ownBill) return null;
  // Already authorised by department; clear logistic_code so trackBill is NOT
  // branch-scoped — a salesperson must see the full timeline of their dept's
  // bill no matter which branch delivered it.
  const tracked = await trackBill({ ...session, logistic_code: "" }, clean);
  if (tracked) return tracked;
  // Bill is neither dispatched nor in the pending workflow yet, so trackBill
  // found nothing. Still surface the sale's items (timeline falls back to the
  // selected row on the page) so the ສິນຄ້າ tab is never empty for a real bill.
  return {
    bill_no: clean,
    doc_no: "",
    list: [],
    items: await getSaleItems(clean),
    attempts: [],
    car_position: null,
  };
}

// Public tracking — strips internal fields (driver, customer details) so a
// customer-facing page can show delivery status without exposing private
// data. Looks up the most recent dispatch for the given bill_no.
async function trackBillPublic(billNo) {
  await ensureDeliveryWorkflowSchema();
  const text = String(billNo ?? "").trim().toUpperCase();
  if (!text) return null;

  const row = await queryOne(
    `SELECT a.doc_no, to_char(a.doc_date,'DD-MM-YYYY') as doc_date,
            a.bill_no, to_char(a.bill_date,'DD-MM-YYYY') as bill_date,
            a.car as car_code, c.name_1 as car, c.imei as car_imei,
            d.name_1 as driver, COALESCE(b2.employee_photo, '') as driver_photo,
            COALESCE(j.origin_transport_code, '') as origin_transport_code,
            COALESCE(ott.name_1, '') as origin_transport_name,
            COALESCE(a.forward_transport_code, '') as forward_transport_code,
            COALESCE(fwd.name_1, '') as forward_transport_name,
            a.lat, a.lng, a.lat_end, a.lng_end,
            acd.latitude::float as dest_lat, acd.longitude::float as dest_lng,
            COALESCE(a.url_img, '') as url_img,
            COALESCE(a.sight_img, '') as sight_img,
            COALESCE(img.delivery_images, ARRAY[]::text[]) as delivery_images,
            COALESCE(a.remark, '') as bill_remark,
            COALESCE(a.status, 0) as bill_status,
            (SELECT json_agg(json_build_object(
              'doc_date', doc_date,
              'doc_time', doc_time,
              'status', status,
              'remark', remark
            ) ORDER BY event_at ASC NULLS LAST) FROM (
              SELECT create_date_time_now AS event_at, to_char(create_date_time_now,'DD-MM-YYYY') as doc_date, to_char(create_date_time_now,'HH24:MI') as doc_time, 'ຈັດຖ້ຽວແລ້ວ' as status, '' as remark FROM odg_tms_detail WHERE bill_no=a.bill_no AND doc_no=a.doc_no
              UNION ALL SELECT recipt_job, to_char(recipt_job,'DD-MM-YYYY'), to_char(recipt_job,'HH24:MI'), 'ຮັບຖ້ຽວ / ເບີກເຄື່ອງ', COALESCE(NULLIF(TRIM(ott.name_1), ''), NULLIF(TRIM(j.origin_transport_code), ''), '') FROM odg_tms_detail WHERE recipt_job IS NOT NULL AND bill_no=a.bill_no AND doc_no=a.doc_no
              UNION ALL SELECT j.dispatch_started_at, to_char(j.dispatch_started_at,'DD-MM-YYYY'), to_char(j.dispatch_started_at,'HH24:MI'), 'ເລີ່ມຈັດສົ່ງ', '' WHERE j.dispatch_started_at IS NOT NULL
              UNION ALL SELECT sent_end, to_char(sent_end,'DD-MM-YYYY'), to_char(sent_end,'HH24:MI'), case when status=2 then 'ຍົກເລີກຈັດສົ່ງ' else 'ຈັດສົ່ງສຳເລັດ' end, remark FROM odg_tms_detail WHERE sent_end IS NOT NULL AND bill_no=a.bill_no AND doc_no=a.doc_no
            ) events) as list
     FROM odg_tms_detail a
     LEFT JOIN odg_tms_car c ON c.code = a.car
     LEFT JOIN odg_tms j ON j.doc_no = a.doc_no
     LEFT JOIN ic_trans_shipment its ON its.doc_no = a.bill_no
     LEFT JOIN ar_customer_detail acd ON acd.ar_code = its.cust_code
     LEFT JOIN odg_tms_driver d ON d.code = j.driver
     LEFT JOIN biotime_employee b2 ON b2.code = j.driver
     LEFT JOIN transport_type ott ON ott.code = j.origin_transport_code
     LEFT JOIN public.transport_type fwd ON fwd.code = a.forward_transport_code
     LEFT JOIN LATERAL (
       SELECT array_agg(di.image_data ORDER BY di.created_at ASC, di.roworder ASC) as delivery_images
       FROM public.odg_tms_delivery_images di
       WHERE di.bill_no = a.bill_no
     ) img ON true
     WHERE bill_no = $1 AND ${getFixedYearSqlFilter("a.doc_date")}
     ORDER BY COALESCE(j.create_date_time_now, a.create_date_time_now, a.doc_date::timestamp) DESC NULLS LAST,
              a.doc_no DESC
     LIMIT 1`,
    [text]
  );
  if (!row) return null;
  const attempts = await getBillAttempts(row.bill_no);

  // Items at delivery progress (no internal codes leaked beyond what shows
  // on the customer's invoice anyway).
  const items = await query(
    `SELECT i.item_code, i.item_name,
            COALESCE(i.selected_qty, 0)::numeric as selected_qty,
            COALESCE(i.delivered_qty, 0)::numeric as delivered_qty,
            i.unit_code
     FROM public.odg_tms_detail_item i
     INNER JOIN public.odg_tms_detail d
       ON d.bill_no = i.bill_no AND d.doc_no = i.doc_no
     WHERE i.bill_no = $1 AND d.doc_no = $2
     ORDER BY i.roworder NULLS LAST, i.item_code`,
    [row.bill_no, row.doc_no]
  );

  // Current vehicle position (best-effort — never blocks tracking). Mirror the
  // dashboard trackBill: PREFER the driver's PHONE GPS (mobile app
  // travel_history for this trip), then fall back to the car's GPS device.
  let car_position = null;
  try {
    if (row.doc_no) {
      car_position = await queryOne(
        `SELECT lat::float as lat, lng::float as lng,
                COALESCE(speed::float, 0) as speed,
                COALESCE(heading::float, 0) as heading,
                to_char(recorded_at::timestamp,'DD-MM-YYYY HH24:MI:SS') as recorded_at,
                GREATEST(0, EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'Asia/Bangkok') - recorded_at::timestamp)))::int as age_seconds
         FROM public.odg_tms_travel_history
         WHERE doc_no = $1 AND lat IS NOT NULL AND lng IS NOT NULL
         ORDER BY recorded_at DESC NULLS LAST
         LIMIT 1`,
        [String(row.doc_no).trim()]
      );
    }
    if (!car_position) {
      const params = [];
      const conds = [];
      if (row.car_code) {
        params.push(String(row.car_code).trim());
        conds.push(`car_code = $${params.length}`);
      }
      if (row.car_imei) {
        params.push(String(row.car_imei).trim());
        conds.push(`imei = $${params.length}`);
      }
      if (conds.length > 0) {
        const pos = await queryOne(
          `SELECT lat::float as lat, lng::float as lng,
                  COALESCE(speed::float, 0) as speed,
                  COALESCE(heading::float, 0) as heading,
                  to_char(recorded_at::timestamp,'DD-MM-YYYY HH24:MI:SS') as recorded_at,
                  GREATEST(0, EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'Asia/Bangkok') - recorded_at::timestamp)))::int as age_seconds
           FROM public.odg_tms_gps_current
           WHERE ${conds.join(" OR ")}
           ORDER BY recorded_at DESC NULLS LAST
           LIMIT 1`,
          params
        );
        if (pos) car_position = pos;
      }
    }
  } catch (err) {
    console.warn("[trackBillPublic] gps lookup failed:", err?.message ?? err);
  }

  // Live ETA: straight-line distance from the driver's current position to the
  // customer, at an urban average speed. Only while the bill is still in
  // progress (status 0) and we have both a live position and a customer point.
  let eta = null;
  if (
    car_position &&
    Number(row.bill_status) === 0 &&
    row.dest_lat != null &&
    row.dest_lng != null
  ) {
    const km = haversineKm(
      car_position.lat,
      car_position.lng,
      Number(row.dest_lat),
      Number(row.dest_lng)
    );
    if (Number.isFinite(km)) {
      eta = {
        distance_km: Math.round(km * 10) / 10,
        minutes: Math.max(1, Math.round((km / 25) * 60)), // ~25 km/h urban avg
      };
    }
  }

  // Strip private fields (car_imei, car_code, dest_*) before returning.
  const {
    car_imei: _imei,
    car_code: _code,
    dest_lat: _dlat,
    dest_lng: _dlng,
    ...safe
  } = row;
  void _imei;
  void _code;
  void _dlat;
  void _dlng;
  return { ...safe, items, car_position, attempts, eta };
}

// Great-circle distance in km between two lat/lng points (Haversine).
function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Bills currently in active delivery — used by the tracking search to power
// an autocomplete. "Active" = on an approved job, not yet completed/cancelled
// at the bill level.
async function searchActiveDeliveryBills(session, q) {
  const scope = getBranchScope(session);
  await ensurePendingBillSchema();
  await ensureDeliveryRouteSchema();
  await ensureDeliveryRoundSchema();
  const text = String(q ?? "").trim();
  const params = [];
  let searchClause = "";
  if (text) {
    params.push(`%${text.toUpperCase()}%`);
    searchClause = `AND (UPPER(d.bill_no) LIKE $${params.length} OR UPPER(d.cust_code) LIKE $${params.length} OR UPPER(COALESCE(cu.name_1,'')) LIKE $${params.length})`;
  }
  const branchClause = scope.scoped
    ? `AND EXISTS (SELECT 1 FROM public.ic_trans_shipment __ts WHERE __ts.doc_no = d.bill_no AND __ts.transport_code IN (${scope.branchListSql}))`
    : "";
  const activeRows = await query(
    `SELECT
       d.bill_no, d.doc_no,
       to_char(d.bill_date,'DD-MM-YYYY') as bill_date,
       d.cust_code,
       COALESCE(NULLIF(TRIM(cu.name_1),''), d.cust_code, '-') as cust_name,
       ${customerAreaSql('d.cust_code')} as cust_area,
       COALESCE(NULLIF(TRIM(car.name_1),''), j.car, '-') as car,
       COALESCE(NULLIF(TRIM(drv.name_1),''), j.driver, '-') as driver,
       CASE
         WHEN d.sent_start IS NOT NULL THEN 'ກຳລັງຈັດສົ່ງ'
         WHEN d.recipt_job  IS NOT NULL THEN 'ເບີກເຄື່ອງແລ້ວ'
         ELSE 'ລໍຖ້າຈັດສົ່ງ'
       END as phase
     FROM public.odg_tms_detail d
     INNER JOIN public.odg_tms j ON j.doc_no = d.doc_no
     LEFT JOIN ar_customer cu ON cu.code = d.cust_code
     LEFT JOIN public.odg_tms_car car ON car.code = j.car
     LEFT JOIN public.odg_tms_driver drv ON drv.code = j.driver
     WHERE COALESCE(j.approve_status,0) = 1
       AND COALESCE(j.job_status,0) IN (1, 2)
       AND COALESCE(d.status,0) NOT IN (1, 2)
       AND ${getFixedYearSqlFilter("d.doc_date")}
       ${searchClause}
       ${branchClause}
     ORDER BY (d.sent_start IS NOT NULL) DESC,
              d.create_date_time_now DESC NULLS LAST,
              d.bill_no
     LIMIT 30`,
    params
  );
  const pendingParams = [];
  let pendingSearchClause = "";
  if (text) {
    pendingParams.push(`%${text.toUpperCase()}%`);
    pendingSearchClause = `AND (UPPER(pb.bill_no) LIKE $${pendingParams.length} OR UPPER(COALESCE(cu.name_1,'')) LIKE $${pendingParams.length})`;
  }
  const pendingRows = await query(
    `SELECT
       pb.bill_no,
       '' as doc_no,
       COALESCE(to_char(t.doc_date,'DD-MM-YYYY'), to_char(s.doc_date,'DD-MM-YYYY'), '-') as bill_date,
       COALESCE(t.cust_code, s.cust_code, '') as cust_code,
       COALESCE(NULLIF(TRIM(cu.name_1), ''), COALESCE(t.cust_code, s.cust_code), pb.bill_no) as cust_name,
       COALESCE(rt.name, pb.delivery_route_code, '-') as car,
       COALESCE(dr.name, pb.delivery_round_code, '-') as driver,
       CASE
         WHEN COALESCE(pb.action_status, '') = 'contacted_ready'
          AND pb.scheduled_date IS NOT NULL
          AND COALESCE(NULLIF(TRIM(pb.delivery_route_code), ''), NULL) IS NOT NULL
          AND COALESCE(NULLIF(TRIM(pb.delivery_round_code), ''), NULL) IS NOT NULL
           THEN 'ລໍຖ້າຈັດຖ້ຽວ'
         WHEN COALESCE(pb.action_status, '') = 'contacted_ready'
           THEN 'ພ້ອມຮັບ/ກຳລັງວາງແຜນ'
         WHEN COALESCE(pb.action_status, '') = 'delivery_scheduled'
           THEN 'ນັດວັນຈັດສົ່ງແລ້ວ'
         ELSE 'ຕ້ອງຕິດຕາມ'
       END as phase
     FROM public.odg_tms_pending_bill pb
     LEFT JOIN public.ic_trans_shipment s ON s.doc_no = pb.bill_no
     LEFT JOIN public.ic_trans t ON t.doc_no = pb.bill_no
     LEFT JOIN public.ar_customer cu ON cu.code = COALESCE(t.cust_code, s.cust_code)
     LEFT JOIN public.odg_tms_delivery_route rt ON rt.code = pb.delivery_route_code
     LEFT JOIN public.odg_tms_delivery_round dr ON dr.code = pb.delivery_round_code
     WHERE NOT EXISTS (
       SELECT 1 FROM public.odg_tms_detail d
       WHERE d.bill_no = pb.bill_no
         AND COALESCE(d.status, 0) NOT IN (1, 2)
         AND ${getFixedYearSqlFilter("d.doc_date")}
     )
       ${scope.scoped ? `AND s.transport_code IN (${scope.branchListSql})` : ""}
       ${pendingSearchClause}
     ORDER BY pb.updated_at DESC NULLS LAST
     LIMIT 30`,
    pendingParams
  );
  // Any sale bill in ic_trans (even ones never put into a trip) so a user can
  // look up + track an arbitrary bill, not just active/pending ones.
  let icRows = [];
  if (text) {
    const icBranch = scope.scoped
      ? `AND EXISTS (SELECT 1 FROM public.ic_trans_shipment __ts WHERE __ts.doc_no = t.doc_no AND __ts.transport_code IN (${scope.branchListSql}))`
      : "";
    icRows = await query(
      `SELECT
         t.doc_no AS bill_no,
         COALESCE(latest.doc_no, '') AS doc_no,
         to_char(t.doc_date,'DD-MM-YYYY') AS bill_date,
         COALESCE(NULLIF(TRIM(t.cust_code), ''), '') AS cust_code,
         COALESCE(NULLIF(TRIM(cu.name_1), ''), t.cust_code, '-') AS cust_name,
         ${customerAreaSql('t.cust_code')} as cust_area,
         COALESCE(NULLIF(TRIM(car.name_1), ''), latest.car, '-') AS car,
         COALESCE(NULLIF(TRIM(drv.name_1), ''), j.driver, '-') AS driver,
         CASE
           WHEN latest.status = 1 THEN 'ສົ່ງສຳເລັດ'
           WHEN latest.status = 2 THEN 'ຍົກເລີກ'
           WHEN latest.sent_start IS NOT NULL THEN 'ກຳລັງຈັດສົ່ງ'
           WHEN latest.recipt_job IS NOT NULL THEN 'ເບີກເຄື່ອງແລ້ວ'
           WHEN latest.doc_no IS NOT NULL THEN 'ຈັດຖ້ຽວແລ້ວ'
           ELSE 'ບິນຂາຍ'
         END AS phase
       FROM public.ic_trans t
       LEFT JOIN public.ar_customer cu ON cu.code = t.cust_code
       LEFT JOIN LATERAL (
         SELECT d.doc_no, d.status, d.recipt_job, d.sent_start, d.car
         FROM public.odg_tms_detail d
         WHERE d.bill_no = t.doc_no
         ORDER BY d.create_date_time_now DESC NULLS LAST
         LIMIT 1
       ) latest ON true
       LEFT JOIN public.odg_tms j ON j.doc_no = latest.doc_no
       LEFT JOIN public.odg_tms_car car ON car.code = COALESCE(j.car, latest.car)
       LEFT JOIN public.odg_tms_driver drv ON drv.code = j.driver
       WHERE t.trans_flag = 44
         AND NOT EXISTS (
           SELECT 1 FROM public.ic_trans_detail rd
           INNER JOIN public.ic_trans r ON r.doc_no = rd.doc_no AND r.trans_flag = 48
           WHERE rd.ref_doc_no = t.doc_no
         )
         AND (UPPER(t.doc_no) LIKE $1 OR UPPER(COALESCE(t.cust_code,'')) LIKE $1 OR UPPER(COALESCE(cu.name_1,'')) LIKE $1)
         AND ${getFixedYearSqlFilter("t.doc_date")}
         ${icBranch}
       ORDER BY t.doc_date DESC
       LIMIT 10`,
      [`%${text.toUpperCase()}%`]
    );
  }
  const seen = new Set();
  return [...activeRows, ...pendingRows, ...icRows].filter((row) => {
    if (seen.has(row.bill_no)) return false;
    seen.add(row.bill_no);
    return true;
  }).slice(0, 10);
}

// ==================== GPS ====================

async function safeDdl(sql) {
  try {
    await pool.query(sql);
  } catch (err) {
    const msg = String(err?.message ?? "");
    if (
      err?.code === "23505" ||
      msg.includes("pg_class_relname_nsp_index") ||
      msg.includes("pg_type_typname_nsp_index") ||
      /already exists/i.test(msg)
    ) {
      return;
    }
    throw err;
  }
}

async function ensureRealtimeSchemaInternal() {
  await safeDdl(
    `ALTER TABLE public.odg_tms_car ADD COLUMN IF NOT EXISTS imei character varying`
  );
  await safeDdl(`
    CREATE TABLE IF NOT EXISTS public.odg_tms_gps_realtime_latest (
      imei character varying PRIMARY KEY,
      car_code character varying,
      car_name character varying,
      lat numeric,
      lng numeric,
      speed numeric DEFAULT 0,
      heading numeric DEFAULT 0,
      recorded_at timestamp without time zone,
      address text,
      provider_synced_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_realtime_latest ADD COLUMN IF NOT EXISTS car_code character varying`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_realtime_latest ADD COLUMN IF NOT EXISTS car_name character varying`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_realtime_latest ADD COLUMN IF NOT EXISTS lat numeric`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_realtime_latest ADD COLUMN IF NOT EXISTS lng numeric`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_realtime_latest ADD COLUMN IF NOT EXISTS speed numeric DEFAULT 0`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_realtime_latest ADD COLUMN IF NOT EXISTS heading numeric DEFAULT 0`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_realtime_latest ADD COLUMN IF NOT EXISTS recorded_at timestamp without time zone`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_realtime_latest ADD COLUMN IF NOT EXISTS address text`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_realtime_latest ADD COLUMN IF NOT EXISTS provider_synced_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)`
  );
  await safeDdl(`
    CREATE INDEX IF NOT EXISTS idx_odg_tms_gps_realtime_latest_synced_at
    ON public.odg_tms_gps_realtime_latest (provider_synced_at DESC)
  `);
}

async function ensureRealtimeSchema() {
  if (trackingCache.__tmsGpsRealtimeSchemaReady) return;
  if (!trackingCache.__tmsGpsRealtimeSchemaPromise) {
    trackingCache.__tmsGpsRealtimeSchemaPromise = ensureRealtimeSchemaInternal()
      .then(() => {
        trackingCache.__tmsGpsRealtimeSchemaReady = true;
      })
      .catch((err) => {
        trackingCache.__tmsGpsRealtimeSchemaPromise = null;
        throw err;
      });
  }
  await trackingCache.__tmsGpsRealtimeSchemaPromise;
}

function getGpsTrackerConfig() {
  const baseUrl = process.env.GPS_TRACKER_API_URL || "https://apis.thaigpstracker.co.th";
  const user = process.env.GPS_TRACKER_USER || "";
  const pass = process.env.GPS_TRACKER_PASS || "";
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  return { baseUrl, auth };
}

function getRealtimeCacheMap() {
  if (!trackingCache.__tmsGpsRealtimeLastGood) {
    trackingCache.__tmsGpsRealtimeLastGood = new Map();
  }
  return trackingCache.__tmsGpsRealtimeLastGood;
}

function getRealtimeSyncMap() {
  if (!trackingCache.__tmsGpsRealtimeSyncByImei) {
    trackingCache.__tmsGpsRealtimeSyncByImei = new Map();
  }
  return trackingCache.__tmsGpsRealtimeSyncByImei;
}

function normalizeDbRealtimeRow(row) {
  if (!row) return null;
  return {
    imei: String(row.imei ?? "").trim(),
    lat: String(row.lat ?? "").trim(),
    lng: String(row.lng ?? "").trim(),
    speed: String(row.speed ?? "").trim(),
    heading: String(row.heading ?? "").trim(),
    recorded_at: String(row.recorded_at ?? "").trim(),
    address: String(row.address ?? "").trim(),
    car_code: String(row.car_code ?? "").trim(),
    car_name: String(row.car_name ?? "").trim(),
    provider_synced_at: String(row.provider_synced_at ?? "").trim(),
  };
}

function parseTimestampMs(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return Number.NaN;
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso);
  const ts = Date.parse(hasZone ? iso : `${iso}+07:00`);
  return Number.isFinite(ts) ? ts : Number.NaN;
}

function isRealtimeFresh(row) {
  const ts = parseTimestampMs(row?.provider_synced_at);
  return Number.isFinite(ts) && Date.now() - ts <= REALTIME_DB_FRESH_MS;
}

async function readStoredGpsRealtime(imei) {
  await ensureRealtimeSchema();
  const cleanImei = String(imei ?? "").trim();
  if (!cleanImei) return null;
  const row =
    (await queryOne(
      `SELECT
         c.imei,
         c.code AS car_code,
         c.name_1 AS car_name,
         COALESCE(r.lat::text, '') AS lat,
         COALESCE(r.lng::text, '') AS lng,
         COALESCE(r.speed::text, '') AS speed,
         COALESCE(r.heading::text, '') AS heading,
         COALESCE(to_char(r.recorded_at,'YYYY-MM-DD"T"HH24:MI:SS'), '') AS recorded_at,
         COALESCE(r.address, '') AS address,
         COALESCE(to_char(r.provider_synced_at,'YYYY-MM-DD"T"HH24:MI:SS'), '') AS provider_synced_at
       FROM public.odg_tms_car c
       LEFT JOIN public.odg_tms_gps_realtime_latest r ON r.imei = c.imei
       WHERE c.imei = $1
       LIMIT 1`,
      [cleanImei]
    )) ??
    (await queryOne(
      `SELECT
         imei,
         COALESCE(car_code, '') AS car_code,
         COALESCE(car_name, '') AS car_name,
         COALESCE(lat::text, '') AS lat,
         COALESCE(lng::text, '') AS lng,
         COALESCE(speed::text, '') AS speed,
         COALESCE(heading::text, '') AS heading,
         COALESCE(to_char(recorded_at,'YYYY-MM-DD"T"HH24:MI:SS'), '') AS recorded_at,
         COALESCE(address, '') AS address,
         COALESCE(to_char(provider_synced_at,'YYYY-MM-DD"T"HH24:MI:SS'), '') AS provider_synced_at
       FROM public.odg_tms_gps_realtime_latest
       WHERE imei = $1
       LIMIT 1`,
      [cleanImei]
    ));
  return normalizeDbRealtimeRow(row);
}

async function readStoredGpsRealtimeAll() {
  await ensureRealtimeSchema();
  const rows = await query(
    `SELECT
       c.imei,
       c.code AS car_code,
       c.name_1 AS car_name,
       COALESCE(r.lat::text, '') AS lat,
       COALESCE(r.lng::text, '') AS lng,
       COALESCE(r.speed::text, '') AS speed,
       COALESCE(r.heading::text, '') AS heading,
       COALESCE(to_char(r.recorded_at,'YYYY-MM-DD"T"HH24:MI:SS'), '') AS recorded_at,
       COALESCE(r.address, '') AS address,
       COALESCE(to_char(r.provider_synced_at,'YYYY-MM-DD"T"HH24:MI:SS'), '') AS provider_synced_at
     FROM public.odg_tms_car c
     LEFT JOIN public.odg_tms_gps_realtime_latest r ON r.imei = c.imei
     WHERE c.imei IS NOT NULL AND btrim(c.imei) <> ''
     ORDER BY c.name_1 ASC, c.code ASC`
  );
  return rows.map(normalizeDbRealtimeRow);
}

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

async function saveRealtimeToDb(row) {
  await ensureRealtimeSchema();
  const cleanImei = String(row?.imei ?? "").trim();
  if (!cleanImei) return;
  await query(
    `INSERT INTO public.odg_tms_gps_realtime_latest (
       imei, car_code, car_name, lat, lng, speed, heading,
       recorded_at, address, provider_synced_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (imei) DO UPDATE
     SET
       car_code = EXCLUDED.car_code,
       car_name = EXCLUDED.car_name,
       lat = EXCLUDED.lat,
       lng = EXCLUDED.lng,
       speed = EXCLUDED.speed,
       heading = EXCLUDED.heading,
       recorded_at = EXCLUDED.recorded_at,
       address = EXCLUDED.address,
       provider_synced_at = EXCLUDED.provider_synced_at`,
    [
      cleanImei,
      String(row?.car_code ?? "").trim(),
      String(row?.car_name ?? "").trim(),
      toNumberOrNull(row?.lat),
      toNumberOrNull(row?.lng),
      toNumberOrNull(row?.speed),
      toNumberOrNull(row?.heading),
      String(row?.recorded_at ?? "").trim() || null,
      String(row?.address ?? "").trim(),
      String(row?.provider_synced_at ?? "").trim() || null,
    ]
  );
}

async function runRealtimeProviderRequest(task) {
  const previous = trackingCache.__tmsGpsRealtimeQueue ?? Promise.resolve();
  const scheduled = previous
    .catch(() => undefined)
    .then(async () => {
      const cooldownUntil = trackingCache.__tmsGpsRealtimeCooldownUntil ?? 0;
      if (Date.now() < cooldownUntil) {
        const error = new Error("GPS realtime provider is cooling down after HTTP 429");
        error.code = "GPS_PROVIDER_RATE_LIMIT";
        error.cooldownMs = cooldownUntil - Date.now();
        throw error;
      }
      const lastAt = trackingCache.__tmsGpsRealtimeLastAt ?? 0;
      const waitMs = Math.max(
        0,
        REALTIME_PROVIDER_MIN_GAP_MS - (Date.now() - lastAt)
      );
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      const result = await task();
      trackingCache.__tmsGpsRealtimeLastAt = Date.now();
      return result;
    });
  trackingCache.__tmsGpsRealtimeQueue = scheduled.catch(() => undefined);
  return scheduled;
}

function parseRetryAfterMs(headerValue) {
  const raw = String(headerValue ?? "").trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function setRealtimeProviderCooldown(res) {
  const retryAfterMs = parseRetryAfterMs(res?.headers?.get?.("retry-after"));
  const cooldownMs = Math.max(
    5_000,
    retryAfterMs ?? REALTIME_PROVIDER_429_COOLDOWN_MS
  );
  trackingCache.__tmsGpsRealtimeCooldownUntil = Date.now() + cooldownMs;
  console.warn(
    `[gps-realtime] provider rate limit HTTP 429; using cached positions for ${Math.ceil(cooldownMs / 1000)}s`
  );
}

function normalizeRealtimeTimestamp(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.test(raw)) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function formatBangkokNow() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function parseRealtimeLatLng(row) {
  const latlng = String(row?.latlng ?? row?.latLng ?? row?.location ?? "").trim();
  if (latlng.includes(",")) {
    const [latStr = "", lngStr = ""] = latlng.split(",").map((value) => value.trim());
    const lat = Number(latStr);
    const lng = Number(lngStr);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat: String(lat), lng: String(lng) };
    }
  }
  const lat = Number(row?.lat ?? row?.latitude ?? row?.Lat ?? NaN);
  const lng = Number(row?.lng ?? row?.lon ?? row?.long ?? row?.longitude ?? NaN);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { lat: String(lat), lng: String(lng) };
  }
  return null;
}

async function fetchRealtimeJson(cleanImei, config) {
  const url = `${config.baseUrl}/exporter/log/getRealTime/${encodeURIComponent(cleanImei)}`;
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await runRealtimeProviderRequest(async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30_000);
        try {
          return await fetch(url, {
            headers: { Authorization: `Basic ${config.auth}` },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }
      });

      if (!res.ok) {
        if (res.status === 429) {
          setRealtimeProviderCooldown(res);
          return null;
        }
        if (res.status >= 500) {
          if (attempt < MAX_ATTEMPTS) {
            const waitMs = 2000 * attempt;
            console.warn(
              `[gps-realtime] retry imei=${cleanImei} attempt=${attempt}/${MAX_ATTEMPTS} status=${res.status} wait=${waitMs}ms`
            );
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            continue;
          }
          throw new Error(`GPS realtime HTTP ${res.status}`);
        }
        return null;
      }

      try {
        return await res.json();
      } catch (error) {
        if (attempt < MAX_ATTEMPTS) {
          const waitMs = 2000 * attempt;
          console.warn(
            `[gps-realtime] non-JSON imei=${cleanImei} attempt=${attempt}/${MAX_ATTEMPTS} wait=${waitMs}ms`
          );
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        throw error;
      }
    } catch (error) {
      if (error?.code === "GPS_PROVIDER_RATE_LIMIT") {
        return null;
      }
      if (attempt < MAX_ATTEMPTS) {
        const waitMs = 2000 * attempt;
        console.warn(
          `[gps-realtime] retry imei=${cleanImei} attempt=${attempt}/${MAX_ATTEMPTS} error=${error?.message ?? error} wait=${waitMs}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      throw error;
    }
  }

  return null;
}

async function fetchGpsForImei(imei, carCode, carName, config) {
  const cleanImei = imei.trim();
  if (!cleanImei) return null;
  try {
    const json = await fetchRealtimeJson(cleanImei, config);
    // Provider shape: { data: [ { username, log_list: [ <gpsRow> ] } ], ... }
    // Be defensive: also accept top-level log_list/array variants.
    const dataItem =
      (Array.isArray(json?.data) && json.data[0]) ||
      (Array.isArray(json) && json[0]) ||
      json;
    const row =
      (Array.isArray(dataItem?.log_list) && dataItem.log_list[0]) ||
      (Array.isArray(json?.log_list) && json.log_list[0]) ||
      (dataItem && typeof dataItem === "object" && "imei" in dataItem ? dataItem : null);
    if (!row) {
      return getRealtimeCacheMap().get(cleanImei) ?? null;
    }

    // One-time debug: log the first row's full shape so we can adjust field mapping
    if (!trackingCache.__tmsRealtimeShapeLogged) {
      trackingCache.__tmsRealtimeShapeLogged = true;
      console.log(
        `[gps-realtime] sample provider row imei=${cleanImei} keys=${Object.keys(row).join(",")} full=${JSON.stringify(row).slice(0, 800)}`
      );
    }

    const coords = parseRealtimeLatLng(row);
    const providerSyncedAt = formatBangkokNow();
    const speedRaw =
      row.speed ??
      row.velocity ??
      row.spd ??
      row.Speed ??
      row.SPD ??
      row.gpsSpeed ??
      row.speedKmh ??
      "";
    const headingRaw =
      row.heading ??
      row.direction ??
      row.course ??
      row.Course ??
      row.head ??
      row.Heading ??
      row.bearing ??
      "";
    const recordedRaw =
      row.gpsDateTime ??
      row.dateTime ??
      row.datetime ??
      row.date_time_log ??
      row.date_time_recv ??
      row.time ??
      row.gpsTime ??
      row.dtServer ??
      row.logDateTime ??
      row.deviceTime ??
      "";
    const engineStateRaw =
      row.engine_state ?? row.engineState ?? row.engine ?? row.ignition ?? "";
    const stateDetailRaw =
      row.state_detail ?? row.stateDetail ?? row.status ?? row.statusText ?? "";
    const mileageRaw = row.mileage ?? row.odometer ?? row.totalDistance ?? "";
    const satRaw = row.sat ?? row.satellites ?? row.gpsSat ?? "";
    const gsmRaw = row.gsm ?? row.gsmSignal ?? row.signal ?? "";
    const hdopRaw = row.hdop ?? row.HDOP ?? "";
    const oilRaw = row.oil ?? row.fuel ?? row.fuelLevel ?? "";
    // Keep ad_data/input_state as JSON strings for storage; UI parses back
    const adData = row.ad_data ?? row.adData ?? row.analog ?? null;
    const inputState = row.input_state ?? row.inputState ?? row.inputs ?? null;
    const current = {
      imei: cleanImei,
      lat: coords?.lat ?? "",
      lng: coords?.lng ?? "",
      speed: String(speedRaw),
      heading: String(headingRaw),
      recorded_at: normalizeRealtimeTimestamp(recordedRaw),
      address: String(row.address ?? row.poi ?? row.addr ?? ""),
      engine_state: engineStateRaw === "" || engineStateRaw == null ? "" : String(engineStateRaw),
      state_detail: String(stateDetailRaw ?? ""),
      mileage: mileageRaw === "" || mileageRaw == null ? "" : String(mileageRaw),
      sat: satRaw === "" || satRaw == null ? "" : String(satRaw),
      gsm: gsmRaw === "" || gsmRaw == null ? "" : String(gsmRaw),
      hdop: hdopRaw === "" || hdopRaw == null ? "" : String(hdopRaw),
      oil: oilRaw === "" || oilRaw == null ? "" : String(oilRaw),
      ad_data: adData ? JSON.stringify(adData) : "",
      input_state: inputState ? JSON.stringify(inputState) : "",
      car_code: carCode,
      car_name: carName,
      provider_synced_at: providerSyncedAt,
    };
    if (current.lat && current.lng) {
      getRealtimeCacheMap().set(cleanImei, current);
      return current;
    }
    return current;
  } catch (error) {
    if (error?.code === "GPS_PROVIDER_RATE_LIMIT") {
      console.warn(
        `[gps-realtime] rate limited imei=${cleanImei}; using cached position`
      );
    } else {
      console.error(`GPS fetch failed for imei=${cleanImei}`, error);
    }
    return getRealtimeCacheMap().get(cleanImei) ?? null;
  }
}

async function getGpsRealtime(imei) {
  const cleanImei = imei.trim();
  if (!cleanImei) return null;
  const car = await queryOne(
    "SELECT code, name_1 FROM public.odg_tms_car WHERE imei=$1 LIMIT 1",
    [cleanImei]
  );
  if (gpsOpenApi.isOpenApiConfigured()) {
    try {
      const row = await gpsOpenApi.fetchPosition(cleanImei);
      if (row) {
        const merged = { ...row, car_code: car?.code ?? "", car_name: car?.name_1 ?? "" };
        if (merged.lat && merged.lng) getRealtimeCacheMap().set(cleanImei, merged);
        return merged;
      }
    } catch (error) {
      console.warn(
        `[gps-realtime] openapi imei=${cleanImei} failed (${error?.code ?? ""}); ໃຊ້ provider ເກົ່າແທນ`
      );
    }
  }
  return fetchGpsForImei(cleanImei, car?.code ?? "", car?.name_1 ?? "", getGpsTrackerConfig());
}

/**
 * ຕຳແໜ່ງລ່າສຸດຂອງທຸກຄັນ.
 *
 * ເສັ້ນທາງທຳອິດຄື Lao GPS Open API: GET /positions = 1 request ໄດ້ທຸກຄັນ.
 * ຂອງເກົ່າຕ້ອງຍິງ 1 request ຕໍ່ 1 IMEI (23 ຄັນ = 23 request ຕໍ່ຮອບ) ຈຶ່ງຕິດ
 * HTTP 429 ເປັນປະຈຳ ແລ້ວຕົກໄປໃຊ້ຕຳແໜ່ງເກົ່າໃນ cache.
 * ຖ້າ Open API ຍັງບໍ່ໄດ້ຕັ້ງຄ່າ ຫຼື ລົ້ມ ໃຫ້ຕົກກັບໄປໃຊ້ຂອງເກົ່າ ເພື່ອບໍ່ໃຫ້
 * ແຜນທີ່ຫາຍໄປທັງໜ້າ.
 */
async function getGpsRealtimeAll() {
  const cars = await query(
    `SELECT code, name_1, imei FROM public.odg_tms_car
     WHERE imei IS NOT NULL AND btrim(imei) <> ''
     ORDER BY name_1 ASC, code ASC`
  );
  if (cars.length === 0) return [];

  const blank = (car) => ({
    imei: car.imei,
    lat: "",
    lng: "",
    speed: "",
    heading: "",
    recorded_at: "",
    address: "",
    car_code: car.code,
    car_name: car.name_1,
  });

  if (gpsOpenApi.isOpenApiConfigured()) {
    const started = Date.now();
    try {
      const byImei = await gpsOpenApi.fetchAllPositions();
      const result = cars.map((car) => {
        const hit = byImei.get(String(car.imei).trim());
        if (!hit) return blank(car);
        const row = { ...hit, car_code: car.code, car_name: car.name_1 };
        if (row.lat && row.lng) getRealtimeCacheMap().set(row.imei, row);
        return row;
      });
      const withCoords = result.filter((r) => r.lat && r.lng).length;
      console.log(
        `[gps-realtime] openapi cars=${cars.length} with_coords=${withCoords} elapsed=${Date.now() - started}ms`
      );
      return result;
    } catch (error) {
      console.warn(
        `[gps-realtime] openapi failed (${error?.code ?? ""} ${error?.message ?? error}); ໃຊ້ provider ເກົ່າແທນ`
      );
    }
  }

  console.log(
    `[gps-realtime] legacy provider cars=${cars.length} env_user=${process.env.GPS_TRACKER_USER ? "set" : "MISSING"} env_pass=${process.env.GPS_TRACKER_PASS ? "set" : "MISSING"}`
  );
  const config = getGpsTrackerConfig();
  const started = Date.now();
  const result = await Promise.all(
    cars.map(async (car) => {
      const gps = await fetchGpsForImei(car.imei, car.code, car.name_1, config);
      return gps ?? blank(car);
    })
  );
  const withCoords = result.filter((r) => r.lat && r.lng).length;
  console.log(
    `[gps-realtime] legacy done cars=${cars.length} with_coords=${withCoords} elapsed=${Date.now() - started}ms`
  );
  return result;
}

// ==================== Locations ====================

async function getLocations(session, search) {
  const scope = getBranchScope(session);
  const branchClause = branchFilterShipment(scope, "a");
  if (search) {
    return query(`SELECT doc_no, to_char(doc_date,'DD-MM-YYYY') as doc_date, transport_name, destination, b.name_1 as log_name, latitude, longitude FROM ic_trans_shipment a LEFT JOIN public.transport_type b ON b.code=a.transport_code WHERE a.transport_code != '02-0004' AND ${getFixedYearSqlFilter("a.doc_date")} ${branchClause} AND (doc_no LIKE $1 OR transport_name LIKE $1) ORDER BY a.doc_date DESC LIMIT 20`, [`%${search}%`]);
  }
  return query(`SELECT doc_no, to_char(doc_date,'DD-MM-YYYY') as doc_date, transport_name, destination, b.name_1 as log_name, latitude, longitude FROM ic_trans_shipment a LEFT JOIN public.transport_type b ON b.code=a.transport_code WHERE a.transport_code != '02-0004' AND ${getFixedYearSqlFilter("a.doc_date")} ${branchClause} ORDER BY a.doc_date DESC LIMIT 20`);
}

// List the trips that have phone-collected location points, newest activity
// first. One row per job (doc_no) with a rollup of its travel_history points:
// how many, when we last heard from the phone, and the latest battery / IMEI /
// device model. Branch-scoped like the rest of the job views.
async function getPhoneTrackingJobs(session) {
  await ensureDeliveryWorkflowSchema();
  const scope = getBranchScope(session);
  return query(
    `SELECT
       t.doc_no,
       to_char(t.doc_date,'DD-MM-YYYY') AS doc_date,
       COALESCE(NULLIF(TRIM(c.name_1), ''), t.car, '-') AS car,
       COALESCE(NULLIF(TRIM(d.name_1), ''), t.driver, '-') AS driver,
       COALESCE(t.job_status, 0) AS job_status,
       agg.point_count,
       to_char(agg.last_at,'DD-MM-YYYY HH24:MI:SS') AS last_at,
       COALESCE(agg.last_battery, '') AS last_battery,
       COALESCE(agg.last_imei, '') AS last_imei,
       COALESCE(dev.model, '') AS device_model
     FROM public.odg_tms t
     JOIN LATERAL (
       SELECT
         COUNT(*)::int AS point_count,
         MAX(h.recorded_at) AS last_at,
         (array_agg(h.battery ORDER BY h.recorded_at DESC))[1] AS last_battery,
         (array_agg(h.imei ORDER BY h.recorded_at DESC))[1] AS last_imei
       FROM public.odg_tms_travel_history h
       WHERE h.doc_no = t.doc_no AND ${getFixedYearSqlFilter("h.doc_date")}
     ) agg ON agg.point_count > 0
     LEFT JOIN public.odg_tms_car c ON c.code = t.car
     LEFT JOIN public.odg_tms_driver d ON d.code = t.driver
     LEFT JOIN public.odg_tms_mobile_device dev ON dev.imei = agg.last_imei
     WHERE ${getFixedYearSqlFilter("t.doc_date")} ${branchFilterJob(scope, "t")}
     ORDER BY agg.last_at DESC NULLS LAST
     LIMIT 200`
  );
}

// Live fleet view of phone tracking — one marker per PHONE/driver at its
// latest position, never per trip. EVERY phone that has reported in the fixed
// year is included (any trip status), so the map shows the whole fleet; idle /
// closed-trip phones simply read as offline via the client's staleness check.
// We can't key purely on imei because the legacy
// save_travel_history path stores points with a NULL imei (only the batch
// /api/mobile/location path sets it), so an imei-only key silently drops all
// of that data. Instead each active trip's latest fix is bucketed by
//   unit_key = COALESCE(imei, driver, car, doc_no)
// — phone first, then the trip's driver/car so nothing is lost — and DISTINCT
// ON collapses every bucket to its single most-recent fix. recorded_at comes
// back as 'YYYY-MM-DD HH24:MI:SS' so the client's gps-time helpers can parse
// it for the online/offline staleness check.
async function getPhoneFleet(session) {
  await ensureDeliveryWorkflowSchema();
  // The driver app reports here when it CAN'T post GPS mid-trip (gps_off /
  // no_permission / auth_expired). Self-creating so a fresh DB doesn't error on
  // the LATERAL join below before any report has ever arrived.
  await query(
    `CREATE TABLE IF NOT EXISTS public.odg_tms_tracking_status (
       id BIGSERIAL PRIMARY KEY,
       doc_no character varying NOT NULL,
       driver character varying,
       status character varying NOT NULL,
       recorded_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
     )`
  );
  const scope = getBranchScope(session);
  return query(
    `SELECT
       z.unit_key,
       z.imei,
       z.doc_no,
       to_char(z.doc_date,'DD-MM-YYYY') AS doc_date,
       COALESCE(NULLIF(TRIM(c.name_1), ''), z.car_code, '-') AS car,
       COALESCE(NULLIF(TRIM(dr.name_1), ''), NULLIF(TRIM(z.driver_code), ''), NULLIF(TRIM(dev.driver), ''), '-') AS driver,
       COALESCE(z.job_status, 0) AS job_status,
       z.lat,
       z.lng,
       COALESCE(z.speed, '')    AS speed,
       COALESCE(z.heading, '')  AS heading,
       COALESCE(z.accuracy, '') AS accuracy,
       COALESCE(z.battery, '')  AS battery,
       COALESCE(z.signal, '')   AS signal,
       to_char(z.recorded_at,'YYYY-MM-DD HH24:MI:SS') AS recorded_at,
       GREATEST(0, EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'Asia/Bangkok') - z.recorded_at)))::int AS age_seconds,
       z.point_count,
       COALESCE(dev.model, '')     AS device_model,
       COALESCE(dev.sim_phone, '') AS sim_phone,
       COALESCE(dw.stationary_secs, 0)::int AS stationary_secs,
       -- Latest tracking problem reported in the last 15 min ('' when healthy).
       COALESCE(ts.status, '') AS tracking_status
     FROM (
       SELECT DISTINCT ON (tl.unit_key)
         tl.unit_key, tl.imei, tl.doc_no, tl.doc_date, tl.car_code,
         tl.driver_code, tl.job_status, tl.lat, tl.lng, tl.speed, tl.heading,
         tl.accuracy, tl.battery, tl.signal, tl.recorded_at, tl.point_count
       FROM (
         SELECT
           t.doc_no, t.doc_date, t.car AS car_code, t.driver AS driver_code,
           t.job_status,
           last.lat, last.lng, last.speed, last.heading, last.accuracy,
           last.battery, last.signal, last.imei, last.recorded_at,
           agg.point_count,
           COALESCE(NULLIF(TRIM(last.imei), ''), NULLIF(TRIM(t.driver), ''), NULLIF(TRIM(t.car), ''), t.doc_no) AS unit_key
         FROM public.odg_tms t
         JOIN LATERAL (
           SELECT COUNT(*)::int AS point_count
           FROM public.odg_tms_travel_history h
           WHERE h.doc_no = t.doc_no AND ${getFixedYearSqlFilter("h.doc_date")}
         ) agg ON agg.point_count > 0
         JOIN LATERAL (
           SELECT h.lat, h.lng, h.speed, h.heading, h.accuracy, h.battery,
                  h.signal, h.imei, h.recorded_at
           FROM public.odg_tms_travel_history h
           WHERE h.doc_no = t.doc_no AND ${getFixedYearSqlFilter("h.doc_date")}
           ORDER BY h.recorded_at DESC, h.roworder DESC
           LIMIT 1
         ) last ON TRUE
         WHERE ${getFixedYearSqlFilter("t.doc_date")}
           ${branchFilterJob(scope, "t")}
       ) tl
       ORDER BY tl.unit_key, tl.recorded_at DESC, tl.doc_no DESC
     ) z
     LEFT JOIN public.odg_tms_mobile_device dev ON dev.imei = NULLIF(TRIM(z.imei), '')
     LEFT JOIN public.odg_tms_driver dr ON dr.code = COALESCE(NULLIF(TRIM(z.driver_code), ''), dev.driver)
     LEFT JOIN public.odg_tms_car c ON c.code = z.car_code
     -- "How long parked here": seconds since the last fix that was FAR (>~65m)
     -- from the current position. Scans only this trip's points in the last 12h
     -- (cast guarded — lat/lng are varchar, bad strings are ignored, not fatal).
     LEFT JOIN LATERAL (
       SELECT GREATEST(0, EXTRACT(EPOCH FROM (z.recorded_at - COALESCE(
         MAX(h.recorded_at) FILTER (WHERE
           ABS((CASE WHEN h.lat ~ '^-?[0-9.]+$' THEN h.lat::float8 END)
               - (CASE WHEN z.lat ~ '^-?[0-9.]+$' THEN z.lat::float8 END)) > 0.0006
           OR ABS((CASE WHEN h.lng ~ '^-?[0-9.]+$' THEN h.lng::float8 END)
               - (CASE WHEN z.lng ~ '^-?[0-9.]+$' THEN z.lng::float8 END)) > 0.0006
         ),
         MIN(h.recorded_at)
       ))))::bigint AS stationary_secs
       FROM public.odg_tms_travel_history h
       WHERE h.doc_no = z.doc_no
         AND ${getFixedYearSqlFilter("h.doc_date")}
         AND h.recorded_at >= z.recorded_at - INTERVAL '12 hours'
     ) dw ON TRUE
     -- Most recent tracking-health report for this trip, only if it's fresh
     -- (≤15 min) — a stale report shouldn't keep flagging a now-healthy driver.
     LEFT JOIN LATERAL (
       SELECT s.status
       FROM public.odg_tms_tracking_status s
       WHERE s.doc_no = z.doc_no
         AND s.recorded_at >= (NOW() AT TIME ZONE 'Asia/Bangkok') - INTERVAL '15 minutes'
       ORDER BY s.recorded_at DESC
       LIMIT 1
     ) ts ON TRUE
     ORDER BY z.recorded_at DESC NULLS LAST
     LIMIT 500`
  );
}

// Full ordered trail for one trip: every phone point with its telemetry, plus
// the job header and the device identity. Returns null when the trip isn't in
// the caller's branch scope (same gate trackBill uses), so a scoped user can't
// read another branch's track by guessing a doc_no.
async function getPhoneTrail(session, docNo) {
  const clean = String(docNo ?? "").trim();
  if (!clean) return null;
  await ensureDeliveryWorkflowSchema();
  const scope = getBranchScope(session);

  const job = await queryOne(
    `SELECT
       t.doc_no,
       to_char(t.doc_date,'DD-MM-YYYY') AS doc_date,
       COALESCE(NULLIF(TRIM(c.name_1), ''), t.car, '-') AS car,
       COALESCE(NULLIF(TRIM(d.name_1), ''), t.driver, '-') AS driver,
       COALESCE(t.job_status, 0) AS job_status
     FROM public.odg_tms t
     LEFT JOIN public.odg_tms_car c ON c.code = t.car
     LEFT JOIN public.odg_tms_driver d ON d.code = t.driver
     WHERE t.doc_no = $1 AND ${getFixedYearSqlFilter("t.doc_date")} ${branchFilterJob(scope, "t")}
     LIMIT 1`,
    [clean]
  );
  if (!job) return null;

  // Decimate the trail to ~1500 points max. At a 5-second cadence a long trip
  // produces thousands of points, which bloats the payload and makes the
  // Leaflet polyline render heavily. We evenly down-sample but always keep the
  // first and last fix so the route's start/end stay accurate; short trips
  // (≤ MAX_POINTS) are returned in full.
  const points = await query(
    `WITH pts AS (
       SELECT lat, lng, recorded_at, roworder, speed, heading, accuracy,
              battery, signal, imei,
              row_number() OVER (ORDER BY recorded_at ASC, roworder ASC) AS rn,
              count(*) OVER () AS total
       FROM public.odg_tms_travel_history
       WHERE doc_no = $1 AND ${getFixedYearSqlFilter("doc_date")}
     )
     SELECT
       lat, lng,
       to_char(recorded_at,'DD-MM-YYYY HH24:MI:SS') AS recorded_at,
       COALESCE(speed, '')    AS speed,
       COALESCE(heading, '')  AS heading,
       COALESCE(accuracy, '') AS accuracy,
       COALESCE(battery, '')  AS battery,
       COALESCE(signal, '')   AS signal,
       COALESCE(imei, '')     AS imei
     FROM pts
     WHERE total <= 1500
        OR rn = 1
        OR rn = total
        OR (rn % GREATEST(1, CEIL(total / 1500.0)::int)) = 0
     ORDER BY recorded_at ASC, roworder ASC`,
    [clean]
  );

  // Device identity keyed by whichever IMEI the points carry.
  const imei = points.find((p) => p.imei)?.imei ?? "";
  const device = imei
    ? await queryOne(
        `SELECT imei, COALESCE(model,'') AS model, COALESCE(os_version,'') AS os_version,
                COALESCE(app_version,'') AS app_version, COALESCE(carrier,'') AS carrier,
                COALESCE(sim_phone,'') AS sim_phone,
                to_char(updated_at,'DD-MM-YYYY HH24:MI:SS') AS updated_at
         FROM public.odg_tms_mobile_device WHERE imei = $1`,
        [imei]
      )
    : null;

  return { job, device, points };
}

// ---- ເບີດບິນປະຈຳວັນ (Daily opened bills, sales-facing) ----
// Bills a salesperson opened on a given day (ic_trans.doc_date), so they can set
// the delivery date + transport branch before dispatch picks them up. Scope is
// the same as getSalesBillTrackingList: salesperson sees their own bills,
// head/manager sees the whole sales department. Both may edit (the page allows
// Save for all sales roles).
async function getDailyOpenedBillsForSales(session, opts = {}) {
  await ensurePendingBillSchema();
  const empDept = String(session?.emp_department_code ?? "").trim();
  const userCode = String(session?.usercode ?? "").trim();
  if (!empDept || !userCode) return [];
  const deptScope = canSeeDepartmentSales(session);
  const scopeRole = salesRoleFromSession(session) || "admin";
  const scopeLabel = deptScope ? "ທັງໝົດໃນພະແນກ" : "ຂອງຕົນເອງ";

  const date = String(opts.date ?? "").trim();
  if (!date) return [];
  const search = String(opts.search ?? "").trim();
  const params = [deptScope ? empDept : userCode, date, scopeRole, scopeLabel];
  const scopeClause = deptScope
    ? "COALESCE(NULLIF(TRIM(sale_e.department_code), ''), '') = $1"
    : "COALESCE(NULLIF(TRIM(t.creator_code), ''), '') = $1";
  let searchClause = "";
  if (search) {
    params.push(`%${search.toUpperCase()}%`);
    searchClause = `AND (
      UPPER(t.doc_no) LIKE $${params.length}
      OR UPPER(COALESCE(c.name_1, '')) LIKE $${params.length}
      OR UPPER(COALESCE(t.cust_code, '')) LIKE $${params.length}
      OR UPPER(COALESCE(t.remark, '')) LIKE $${params.length}
    )`;
  }

  return query(
    `SELECT
       t.doc_no AS bill_no,
       to_char(t.doc_date,'DD-MM-YYYY') AS bill_date,
       to_char(t.doc_date,'YYYY-MM-DD') AS bill_date_iso,
       to_char(t.create_date_time_now,'DD-MM-YYYY HH24:MI') AS created_at,
       COALESCE(NULLIF(TRIM(c.name_1), ''), t.cust_code, '-') AS customer_name,
       COALESCE(NULLIF(TRIM(t.cust_code), ''), '') AS cust_code,
       COALESCE(NULLIF(TRIM(t.creator_code), ''), '') AS sale_code,
       COALESCE(NULLIF(TRIM(sale_e.fullname_lo), ''), NULLIF(TRIM(sale_e.nickname), ''), NULLIF(TRIM(t.creator_code), ''), '') AS salesperson,
       COALESCE(NULLIF(TRIM(t.remark), ''), '') AS sales_remark,
       -- current schedule (from odg_tms_pending_bill) merged in for the editors
       to_char(pb.scheduled_date,'YYYY-MM-DD') AS scheduled_date,
       to_char(pb.scheduled_date,'DD-MM-YYYY') AS scheduled_date_display,
       COALESCE(pb.transport_code, '') AS transport_code,
       COALESCE(NULLIF(TRIM(tt_pb.name_1), ''), NULLIF(TRIM(tt_ship.name_1), ''), NULLIF(TRIM(s.transport_code), ''), '') AS transport_name,
       COALESCE(pb.action_status, '') AS action_status,
       COALESCE(pb.delivery_route_code, '') AS delivery_route_code,
       COALESCE(pb.delivery_round_code, '') AS delivery_round_code,
       COALESCE(NULLIF(TRIM(pb.updated_by), ''), '') AS updated_by,
       -- "locked" = the transport/dispatch side has engaged with the bill. Those
       -- fields (contact status / route / round) are set only by dispatch in the
       -- bills-pending screen; sales never sets them. Once any is present, sales
       -- can no longer change the delivery date or branch.
       (
         COALESCE(NULLIF(TRIM(pb.action_status), ''), NULL) IS NOT NULL
         OR COALESCE(NULLIF(TRIM(pb.delivery_route_code), ''), NULL) IS NOT NULL
         OR COALESCE(NULLIF(TRIM(pb.delivery_round_code), ''), NULL) IS NOT NULL
       ) AS locked,
       to_char(pb.updated_at,'DD-MM-YYYY HH24:MI') AS pending_updated_at,
       $3::text AS scope_role,
       $4::text AS scope_label
     FROM public.ic_trans t
     LEFT JOIN public.ic_trans_shipment s ON s.doc_no = t.doc_no
     LEFT JOIN public.ar_customer c ON c.code = t.cust_code
     LEFT JOIN public.odg_employee sale_e ON sale_e.employee_code = t.creator_code
     LEFT JOIN public.odg_tms_pending_bill pb ON pb.bill_no = t.doc_no
     LEFT JOIN public.transport_type tt_pb ON tt_pb.code = NULLIF(TRIM(pb.transport_code), '')
     LEFT JOIN public.transport_type tt_ship ON tt_ship.code = s.transport_code
     WHERE ${scopeClause}
       AND t.trans_flag = 44
       AND NOT EXISTS (
         SELECT 1 FROM public.ic_trans_detail rd
         INNER JOIN public.ic_trans r ON r.doc_no = rd.doc_no AND r.trans_flag = 48
         WHERE rd.ref_doc_no = t.doc_no
       )
       AND t.doc_date::date = $2::date
       AND ${getFixedYearSqlFilter("t.doc_date")}
       ${searchClause}
     ORDER BY t.create_date_time_now DESC NULLS LAST, t.doc_no DESC
     LIMIT 500`,
    params
  );
}

// Selectable transport branches for the sales date/branch editor. Includes
// "ລູກຄ້າຮັບເອງ" (02-0004) so sales can mark a self-pickup. Excludes only the
// external-flow types ThunJai (02-0005) and technician-pickup (02-0006).
async function getSalesTransportBranches() {
  return query(
    `SELECT code, name_1 FROM public.transport_type
     WHERE code LIKE '02-%' AND code NOT IN ('02-0005', '02-0006')
     ORDER BY code ASC`
  );
}

// Back-office/dispatch staff assigned to a transport branch, via the
// odg_tms_worker_branch mapping → odg_employee (NOT erp_user). Returns employee
// codes, which double as the chatter recipient key (push + LINE fan-out).
async function getBranchStaffForNotify(branchCode) {
  const code = String(branchCode ?? "").trim();
  if (!code) return [];
  // odg_tms_worker_branch is created/maintained by the worker-branch admin flow
  // (master-data.js). Callers run this inside a best-effort try/catch, so a
  // missing table degrades to "no branch recipients" rather than failing a save.
  return query(
    `SELECT e.employee_code AS code,
            COALESCE(NULLIF(TRIM(e.fullname_lo), ''), NULLIF(TRIM(e.nickname), ''), e.employee_code) AS name
     FROM public.odg_tms_worker_branch wb
     INNER JOIN public.odg_employee e ON e.employee_code = wb.worker_code
     WHERE wb.transport_code = $1 AND e.employment_status = 'ACTIVE'`,
    [code]
  );
}

// Defence-in-depth for saveSalesBillSchedule: confirm the bill is inside the
// caller's sales scope (own bill / own department) before allowing a write.
// The list already hides out-of-scope bills; this guards direct action calls.
async function isSalesBillInScope(session, billNo) {
  const empDept = String(session?.emp_department_code ?? "").trim();
  const userCode = String(session?.usercode ?? "").trim();
  const code = String(billNo ?? "").trim();
  if (!empDept || !userCode || !code) return false;
  const deptScope = canSeeDepartmentSales(session);
  const scopeClause = deptScope
    ? "COALESCE(NULLIF(TRIM(sale_e.department_code), ''), '') = $2"
    : "COALESCE(NULLIF(TRIM(t.creator_code), ''), '') = $2";
  const row = await queryOne(
    `SELECT 1 FROM public.ic_trans t
     LEFT JOIN public.odg_employee sale_e ON sale_e.employee_code = t.creator_code
     WHERE t.doc_no = $1 AND t.trans_flag = 44 AND ${scopeClause} LIMIT 1`,
    [code, deptScope ? empDept : userCode]
  );
  return !!row;
}

module.exports = {
  trackBill,
  getSalesBillTrackingList,
  getSalesDeliveredBillTrackingList,
  trackSalesBill,
  trackBillPublic,
  searchActiveDeliveryBills,
  getGpsRealtime,
  getGpsRealtimeAll,
  getLocations,
  getPhoneTrackingJobs,
  getPhoneFleet,
  getPhoneTrail,
  getDailyOpenedBillsForSales,
  getSalesTransportBranches,
  getBranchStaffForNotify,
  isSalesBillInScope,
};
