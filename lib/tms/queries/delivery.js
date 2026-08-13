const { pool } = require("../lib/db");
const { getFixedYearSqlFilter } = require("../lib/fixed-year");
const { getLaoToday } = require("../lib/lao-date");

const deliveryCache = globalThis;

async function safeDdl(db, sql) {
  try {
    await db.query(sql);
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

async function runQuery(client, text, params = []) {
  const result = await client.query(text, [...params]);
  return result.rows;
}

async function runQueryOne(client, text, params = []) {
  const rows = await runQuery(client, text, params);
  return rows[0] ?? null;
}

async function ensureDeliveryWorkflowSchemaInternal(db) {
  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_detail_item (
      roworder BIGSERIAL PRIMARY KEY,
      doc_no character varying NOT NULL,
      bill_no character varying NOT NULL,
      item_code character varying NOT NULL,
      item_name character varying,
      qty numeric DEFAULT 0,
      selected_qty numeric DEFAULT 0,
      delivered_qty numeric DEFAULT 0,
      unit_code character varying,
      create_date_time_now timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_detail_item
    ADD COLUMN IF NOT EXISTS delivered_qty numeric DEFAULT 0
  `);
  // returned_qty (ຄືນສາງ) = quantity the driver could NOT deliver and sent back
  // to the warehouse. Settled = delivered_qty + returned_qty; a line is only
  // "remaining" (still owed to the customer) while settled < selected_qty.
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_detail_item
    ADD COLUMN IF NOT EXISTS returned_qty numeric DEFAULT 0
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_detail_item_bill_item
    ON public.odg_tms_detail_item (bill_no, item_code)
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_detail_item_doc_no
    ON public.odg_tms_detail_item (doc_no)
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms
    ADD COLUMN IF NOT EXISTS admin_close_at timestamp without time zone
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms
    ADD COLUMN IF NOT EXISTS admin_close_user character varying
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms
    ADD COLUMN IF NOT EXISTS dispatch_started_at timestamp without time zone
  `);
  // Idempotency log for mobile driver actions. The app sends a client-generated
  // action_id with each queueable action; the server claims it once so an
  // offline-outbox replay (or a double-submit whose first attempt's response was
  // lost) can't apply the same action twice — e.g. re-add delivered_qty / COD.
  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_mobile_action_log (
      action_id character varying PRIMARY KEY,
      action character varying,
      bill_no character varying,
      doc_no character varying,
      processed_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);

  // Per-bill pickup origin override. NULL → use ic_trans_shipment.transport_code
  // as default. Special value '__CUSTOMER__' → pickup at customer's home/shop.
  // Any other value → transport_type.code.
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_detail
    ADD COLUMN IF NOT EXISTS pickup_transport_code character varying
  `);

  // Mandatory delivery condition picked when a bill is added to a trip:
  //   to_customer (ສົ່ງລູກຄ້າ) · to_branch (ສົ່ງສາຂາ, pairs with
  //   forward_transport_code) · to_carrier (ສົ່ງຂົນສົ່ງ) · to_bus (ຝາກລົດເມ).
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_detail
    ADD COLUMN IF NOT EXISTS delivery_condition character varying
  `);

  // Parent sale bill key — when one customer order is split across multiple
  // warehouses (or branches), each sub-bill gets its own bill_no but shares
  // the parent_bill_no so the driver app can group them in the UI and (later)
  // offer a single signature/photo at the customer for all sub-bills.
  // NULL = standalone bill (no parent), preserves backward compat for upstream
  // systems that don't populate this field.
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_detail
    ADD COLUMN IF NOT EXISTS parent_bill_no character varying
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_detail_parent_bill_no
    ON public.odg_tms_detail (parent_bill_no)
    WHERE parent_bill_no IS NOT NULL
  `);

  // Same parent_bill_no on the draft table so when the dispatcher adds a
  // bill to the draft (search → addBillToDraft) and later saves the job
  // (createJob reading from the draft), the parent link is preserved.
  // Without this, only direct data.bills[] submissions can carry parent_bill_no.
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_listbill_draft
    ADD COLUMN IF NOT EXISTS parent_bill_no character varying
  `);

  // Proof-of-pickup captured at the customer's home/shop for '__CUSTOMER__'
  // pickup bills (reverse-logistics / collect-from-customer trips). The driver
  // taps "ຮັບສິນຄ້າຈາກລານລູກຄ້າ" on arrival and captures a photo of the goods
  // plus the customer's signature — separate from the delivery photo/signature
  // (url_img / sight_img) that gets captured later at the drop-off point.
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_detail
    ADD COLUMN IF NOT EXISTS recipt_img text
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_detail
    ADD COLUMN IF NOT EXISTS recipt_sign_img text
  `);

  // ── COD / cash-on-delivery (Module B) ──
  // cod_amount = amount the driver is expected to collect for this bill;
  // collected_amount / payment_method / collected_at record what was actually
  // taken at delivery so the office can reconcile cash per trip.
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_detail
    ADD COLUMN IF NOT EXISTS cod_amount numeric DEFAULT 0
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_detail
    ADD COLUMN IF NOT EXISTS collected_amount numeric
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_detail
    ADD COLUMN IF NOT EXISTS payment_method character varying
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_detail
    ADD COLUMN IF NOT EXISTS collected_at timestamp without time zone
  `);

  // ── Failed-delivery reason + reschedule (Module D) ──
  // cancel_reason_code = standardized code (no_one|refused|wrong_addr|...) set
  // on cancel; reschedule_date = a new delivery date when the driver defers a
  // bill instead of cancelling it outright.
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_detail
    ADD COLUMN IF NOT EXISTS cancel_reason_code character varying
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_detail
    ADD COLUMN IF NOT EXISTS reschedule_date date
  `);

  // checkin_at — moment the driver tapped "Check in" at the destination.
  // sent_start used to double as both "dispatch start" and "checkin time",
  // which conflated two different events. We keep sent_start as a backward-
  // compat mirror but checkin_at is now the canonical timestamp for arrival.
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_detail
    ADD COLUMN IF NOT EXISTS checkin_at timestamp without time zone
  `);
  // Backfill existing rows so the new column matches what sent_start already
  // recorded. Idempotent: only fills NULLs.
  await safeDdl(db, `
    UPDATE public.odg_tms_detail
    SET checkin_at = sent_start
    WHERE checkin_at IS NULL AND sent_start IS NOT NULL
  `);

  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_travel_history (
      roworder BIGSERIAL PRIMARY KEY,
      doc_no character varying NOT NULL,
      doc_date date NOT NULL,
      lat character varying NOT NULL,
      lng character varying NOT NULL,
      recorded_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_travel_history_doc_no
    ON public.odg_tms_travel_history (doc_no)
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_travel_history_doc_date
    ON public.odg_tms_travel_history (doc_date)
  `);
  // Per-point telemetry captured alongside the phone's GPS fix. All nullable
  // and varchar to match the lat/lng convention (mobile sends everything as
  // strings; missing fields arrive as null). imei identifies which device
  // produced the point — the same key the hardware GPS log (odg_tms_gps_
  // realtime_log) uses, so phone + tracker data line up.
  for (const col of [
    "imei character varying",
    "speed character varying",
    "heading character varying",
    "accuracy character varying",
    "battery character varying",
    "signal character varying",
  ]) {
    await safeDdl(db, `
      ALTER TABLE public.odg_tms_travel_history
      ADD COLUMN IF NOT EXISTS ${col}
    `);
  }
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_travel_history_imei
    ON public.odg_tms_travel_history (imei)
  `);

  // Static-ish device identity, one row per phone keyed by IMEI. Upserted on
  // each location batch so it always reflects the latest model/OS/app/SIM the
  // app reported, plus who was driving and when we last heard from it.
  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_mobile_device (
      imei character varying PRIMARY KEY,
      driver character varying,
      model character varying,
      os_version character varying,
      app_version character varying,
      carrier character varying,
      sim_phone character varying,
      last_doc_no character varying,
      updated_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_mobile_device_driver
    ON public.odg_tms_mobile_device (driver)
  `);

  await safeDdl(db, `
    ALTER TABLE public.odg_tms
    ADD COLUMN IF NOT EXISTS lat_start character varying
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms
    ADD COLUMN IF NOT EXISTS lng_start character varying
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms
    ADD COLUMN IF NOT EXISTS lat_end character varying
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms
    ADD COLUMN IF NOT EXISTS lng_end character varying
  `);

  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_delivery_images (
      roworder BIGSERIAL PRIMARY KEY,
      bill_no character varying NOT NULL,
      doc_date date NOT NULL,
      image_data text NOT NULL,
      created_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_delivery_images_bill_no
    ON public.odg_tms_delivery_images (bill_no)
  `);

  // Per-user "read" state for the topbar activity feed. The notification_key
  // is built in SQL from (type|doc_no|bill_no|event_epoch) so a row uniquely
  // identifies a single event-for-user pair regardless of which user marks
  // it read first.
  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_notification_reads (
      user_code character varying NOT NULL,
      notification_key character varying NOT NULL,
      read_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0),
      PRIMARY KEY (user_code, notification_key)
    )
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_notification_reads_user
    ON public.odg_tms_notification_reads (user_code)
  `);

  // ບິນເບີກບໍ່ຄົບ — append-only log of every pickup where the quantity the
  // driver actually received at the warehouse differed from what the
  // dispatcher put on the trip. The trip itself is corrected in place
  // (odg_tms_detail_item.selected_qty), so this table is the ONLY record that
  // the correction happened; it also drives the dispatcher's activity feed.
  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_pickup_variance (
      roworder BIGSERIAL PRIMARY KEY,
      doc_no character varying NOT NULL,
      bill_no character varying NOT NULL,
      item_code character varying NOT NULL,
      item_name character varying,
      unit_code character varying,
      planned_qty numeric DEFAULT 0,
      reported_qty numeric DEFAULT 0,
      actual_qty numeric DEFAULT 0,
      diff_qty numeric DEFAULT 0,
      over_reported boolean DEFAULT false,
      driver character varying,
      remark text,
      created_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0),
      acknowledged_at timestamp without time zone,
      acknowledged_by character varying
    )
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_pickup_variance_bill
    ON public.odg_tms_pickup_variance (bill_no, created_at DESC)
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_pickup_variance_doc
    ON public.odg_tms_pickup_variance (doc_no)
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_pickup_variance_open
    ON public.odg_tms_pickup_variance (created_at DESC) WHERE acknowledged_at IS NULL
  `);
}

async function ensureDeliveryWorkflowSchema(client) {
  // Schema is process-global — once any caller has applied the DDL in this
  // process, every subsequent call (pool or transaction) is a no-op. Without
  // this short-circuit each mobile API request was re-running ~10 DDL
  // statements, which can stall under concurrent load while ALTER TABLE waits
  // for an ACCESS EXCLUSIVE lock.
  if (deliveryCache.__tmsDeliverySchemaReady_v9) return;

  const isSharedPool = !client || client === pool;
  if (!isSharedPool) {
    await ensureDeliveryWorkflowSchemaInternal(client);
    deliveryCache.__tmsDeliverySchemaReady_v9 = true;
    return;
  }

  if (!deliveryCache.__tmsDeliverySchemaPromise_v9) {
    deliveryCache.__tmsDeliverySchemaPromise_v9 = ensureDeliveryWorkflowSchemaInternal(pool)
      .then(() => {
        deliveryCache.__tmsDeliverySchemaReady_v9 = true;
      })
      .catch((err) => {
        deliveryCache.__tmsDeliverySchemaPromise_v9 = null;
        throw err;
      });
  }
  await deliveryCache.__tmsDeliverySchemaPromise_v9;
}

async function ensureJobDeliveryItems(docNo, client) {
  const db = client ?? pool;
  await ensureDeliveryWorkflowSchema(db);

  await db.query(
    `INSERT INTO public.odg_tms_detail_item(
      doc_no,
      bill_no,
      item_code,
      item_name,
      qty,
      selected_qty,
      delivered_qty,
      unit_code
    )
    SELECT
      d.doc_no,
      d.bill_no,
      t.item_code,
      MAX(t.item_name) AS item_name,
      SUM(COALESCE(t.qty, 0))::numeric AS qty,
      SUM(COALESCE(t.qty, 0))::numeric AS selected_qty,
      0::numeric AS delivered_qty,
      MAX(t.unit_code) AS unit_code
    FROM public.odg_tms_detail d
    INNER JOIN ic_trans_detail t ON t.doc_no = d.bill_no
    WHERE d.doc_no = $1
      AND ${getFixedYearSqlFilter("d.doc_date")}
      AND t.item_code NOT LIKE '97%'
      AND NOT EXISTS (
        SELECT 1
        FROM public.odg_tms_detail_item i
        WHERE i.doc_no = d.doc_no AND i.bill_no = d.bill_no
      )
    GROUP BY d.doc_no, d.bill_no, t.item_code
    ORDER BY d.bill_no, t.item_code`,
    [docNo]
  );
}

async function ensureBillDeliveryItems(billNo, client) {
  const db = client ?? pool;
  await ensureDeliveryWorkflowSchema(db);

  const bill = await runQueryOne(
    db,
    `SELECT doc_no
     FROM public.odg_tms_detail
     WHERE bill_no = $1 AND ${getFixedYearSqlFilter("doc_date")}
     LIMIT 1`,
    [billNo]
  );

  if (!bill?.doc_no) return;
  await ensureJobDeliveryItems(bill.doc_no, db);
}

// docNo pins the summary to one trip. Callers that decide whether to CLOSE a
// bill must pass it: the fallback below guesses the "most active" trip, and a
// bill split across two open trips would otherwise be judged on the wrong one.
async function getBillDeliveryItemSummary(billNo, client, docNo) {
  const db = client ?? pool;
  await ensureBillDeliveryItems(billNo, db);

  const docScope = docNo
    ? "$2"
    : `(
        SELECT d.doc_no FROM public.odg_tms_detail d
        WHERE d.bill_no = $1 AND ${getFixedYearSqlFilter("d.doc_date")}
        ORDER BY (CASE WHEN COALESCE(d.status, 0) NOT IN (1, 2) THEN 0 ELSE 1 END),
                 d.create_date_time_now DESC NULLS LAST
        LIMIT 1
      )`;

  return runQueryOne(
    db,
    `SELECT
      COUNT(*)::int AS total_item_count,
      COUNT(*) FILTER (
        WHERE COALESCE(delivered_qty, 0)::numeric > 0
      )::int AS delivered_item_count,
      COUNT(*) FILTER (
        WHERE GREATEST(COALESCE(selected_qty, 0)::numeric - COALESCE(delivered_qty, 0)::numeric - COALESCE(returned_qty, 0)::numeric, 0) > 0
      )::int AS remaining_item_count,
      COALESCE(SUM(COALESCE(selected_qty, 0)::numeric), 0)::numeric AS selected_qty_total,
      COALESCE(SUM(COALESCE(delivered_qty, 0)::numeric), 0)::numeric AS delivered_qty_total,
      COALESCE(SUM(COALESCE(returned_qty, 0)::numeric), 0)::numeric AS returned_qty_total,
      COALESCE(
        SUM(GREATEST(COALESCE(selected_qty, 0)::numeric - COALESCE(delivered_qty, 0)::numeric - COALESCE(returned_qty, 0)::numeric, 0)),
        0
      )::numeric AS remaining_qty_total
    FROM public.odg_tms_detail_item
    WHERE bill_no = $1
      AND doc_no = ${docScope}`,
    docNo ? [billNo, docNo] : [billNo]
  );
}

async function getOpenBillCount(docNo, client) {
  const db = client ?? pool;
  const row = await runQueryOne(
    db,
    `SELECT COUNT(*)::int AS open_bill_count
     FROM public.odg_tms_detail
     WHERE doc_no = $1
       AND ${getFixedYearSqlFilter("doc_date")}
       AND COALESCE(status, 0) NOT IN (1, 2)`,
    [docNo]
  );
  return Number(row?.open_bill_count ?? 0);
}

async function getBillDeliveryItems(params, client) {
  const db = client ?? pool;

  if (params.docNo) await ensureJobDeliveryItems(params.docNo, db);
  if (params.billNo) await ensureBillDeliveryItems(params.billNo, db);

  const where =
    params.docNo && params.billNo
      ? "i.doc_no = $1 AND i.bill_no = $2"
      : params.docNo
      ? "i.doc_no = $1"
      : `i.bill_no = $1 AND i.doc_no = (
          SELECT d.doc_no FROM public.odg_tms_detail d
          WHERE d.bill_no = $1 AND ${getFixedYearSqlFilter("d.doc_date")}
          ORDER BY (CASE WHEN COALESCE(d.status, 0) NOT IN (1, 2) THEN 0 ELSE 1 END),
                   d.create_date_time_now DESC NULLS LAST
          LIMIT 1
        )`;
  const values =
    params.docNo && params.billNo
      ? [params.docNo, params.billNo]
      : [params.docNo ?? params.billNo];

  return runQuery(
    db,
    `SELECT
      i.doc_no,
      i.bill_no,
      i.item_code,
      MAX(i.item_name) AS item_name,
      GREATEST(SUM(COALESCE(i.selected_qty, 0))::numeric - SUM(COALESCE(i.delivered_qty, 0))::numeric - SUM(COALESCE(i.returned_qty, 0))::numeric, 0)::numeric AS qty,
      SUM(COALESCE(i.selected_qty, 0))::numeric AS selected_qty,
      SUM(COALESCE(i.delivered_qty, 0))::numeric AS delivered_qty,
      SUM(COALESCE(i.returned_qty, 0))::numeric AS returned_qty,
      GREATEST(SUM(COALESCE(i.selected_qty, 0))::numeric - SUM(COALESCE(i.delivered_qty, 0))::numeric - SUM(COALESCE(i.returned_qty, 0))::numeric, 0)::numeric AS remaining_qty,
      MAX(i.unit_code) AS unit_code,
      COALESCE(MAX(w.name_1), '') AS wh_code
    FROM public.odg_tms_detail_item i
    LEFT JOIN (
      -- Pick one warehouse per (bill, item) so a multi-warehouse split in
      -- ic_trans_detail doesn't multiply rows in the result.
      SELECT DISTINCT ON (doc_no, item_code) doc_no, item_code, wh_code
      FROM ic_trans_detail
    ) t
      ON t.doc_no = i.bill_no
     AND t.item_code = i.item_code
    LEFT JOIN public.ic_warehouse w ON w.code = t.wh_code
    WHERE ${where}
    GROUP BY i.doc_no, i.bill_no, i.item_code
    ORDER BY i.bill_no, i.item_code`,
    values
  );
}

async function getBillPhaseSummary(docNo, client) {
  const db = client ?? pool;
  await ensureJobDeliveryItems(docNo, db);

  return runQuery(
    db,
    `SELECT
      bill_no,
      COUNT(*)::int AS total_item_count,
      COUNT(*) FILTER (
        WHERE COALESCE(delivered_qty, 0)::numeric > 0
      )::int AS delivered_item_count,
      COUNT(*) FILTER (
        WHERE GREATEST(COALESCE(selected_qty, 0)::numeric - COALESCE(delivered_qty, 0)::numeric - COALESCE(returned_qty, 0)::numeric, 0) > 0
      )::int AS remaining_item_count,
      COALESCE(SUM(COALESCE(delivered_qty, 0)::numeric), 0)::numeric AS delivered_qty_total,
      COALESCE(SUM(COALESCE(returned_qty, 0)::numeric), 0)::numeric AS returned_qty_total,
      COALESCE(
        SUM(GREATEST(COALESCE(selected_qty, 0)::numeric - COALESCE(delivered_qty, 0)::numeric - COALESCE(returned_qty, 0)::numeric, 0)),
        0
      )::numeric AS remaining_qty_total
    FROM public.odg_tms_detail_item
    WHERE doc_no = $1
    GROUP BY bill_no`,
    [docNo]
  );
}

async function saveDeliveryImages(billNo, images, client) {
  if (!images || images.length === 0) return;

  const db = client ?? pool;
  await ensureDeliveryWorkflowSchema(db);

  const billRow = await runQueryOne(
    db,
    `SELECT doc_date::text
     FROM public.odg_tms_detail
     WHERE bill_no = $1
       AND ${getFixedYearSqlFilter("doc_date")}
     LIMIT 1`,
    [billNo]
  );

  const docDate = billRow?.doc_date ?? getLaoToday();

  for (const imageData of images) {
    if (imageData && imageData.length > 0) {
      await db.query(
        `INSERT INTO public.odg_tms_delivery_images (bill_no, doc_date, image_data)
         SELECT $1::varchar, $2::date, $3::text
         WHERE NOT EXISTS (
           SELECT 1 FROM public.odg_tms_delivery_images
           WHERE bill_no = $1::varchar AND image_data = $3::text
         )`,
        [billNo, docDate, imageData]
      );
    }
  }
}

module.exports = {
  ensureDeliveryWorkflowSchema,
  ensureJobDeliveryItems,
  ensureBillDeliveryItems,
  getBillDeliveryItemSummary,
  getOpenBillCount,
  getBillDeliveryItems,
  getBillPhaseSummary,
  saveDeliveryImages,
};
