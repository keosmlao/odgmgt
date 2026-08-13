const { pool, query, queryOne } = require("../lib/db");
// ນັດວັນສົ່ງ / ປັກໝຸດ / ປ່ຽນສະຖານະ ເຮັດໃຫ້ "ບິນລໍຈັດຖ້ຽວ" ປ່ຽນທັນທີ ຈຶ່ງຕ້ອງ
// ລ້າງລາຍການລວມທີ່ເກັບໄວ້ ບໍ່ດັ່ງນັ້ນຄົນນັດແລ້ວຈະບໍ່ເຫັນບິນຈົນກວ່າ cache ໝົດອາຍຸ
const { invalidatePendingList } = require("./helpers");

const pendingBillCache = globalThis;

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

async function ensurePendingBillSchemaInternal(db) {
  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_pending_bill (
      bill_no character varying PRIMARY KEY,
      scheduled_date date,
      remark text,
      action_status character varying,
      delivery_route_code character varying,
      delivery_round_code character varying,
      updated_by character varying,
      updated_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_pending_bill
    ADD COLUMN IF NOT EXISTS action_status character varying
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_pending_bill
    ADD COLUMN IF NOT EXISTS delivery_route_code character varying
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_pending_bill
    ADD COLUMN IF NOT EXISTS delivery_round_code character varying
  `);
  // Pre-trip transport (warehouse) override — independent of ic_trans_shipment
  // so admin can assign a transport branch to manual / service bills without
  // touching the ERP shipment row.
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_pending_bill
    ADD COLUMN IF NOT EXISTS transport_code character varying
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_pending_bill_transport
    ON public.odg_tms_pending_bill (transport_code) WHERE transport_code IS NOT NULL
  `);
  // Planned delivery location set by dispatcher on a pending bill. The driver
  // app reads this for the navigation pin so they head to the right spot
  // even before any GPS is captured at delivery time.
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_pending_bill
    ADD COLUMN IF NOT EXISTS planned_lat character varying
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_pending_bill
    ADD COLUMN IF NOT EXISTS planned_lng character varying
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_pending_bill_scheduled
    ON public.odg_tms_pending_bill (scheduled_date)
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_pending_bill_status
    ON public.odg_tms_pending_bill (action_status) WHERE action_status IS NOT NULL
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_pending_bill_route
    ON public.odg_tms_pending_bill (delivery_route_code) WHERE delivery_route_code IS NOT NULL
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_pending_bill_round
    ON public.odg_tms_pending_bill (delivery_round_code) WHERE delivery_round_code IS NOT NULL
  `);
  // Append-only change log for the schedule fields. The main row only keeps the
  // latest value (it's an UPSERT), so this is the only place the dispatcher can
  // see how a bill's delivery date / remark / status evolved over time.
  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_pending_bill_history (
      id BIGSERIAL PRIMARY KEY,
      bill_no character varying NOT NULL,
      scheduled_date date,
      remark text,
      action_status character varying,
      delivery_route_code character varying,
      delivery_round_code character varying,
      transport_code character varying,
      planned_lat character varying,
      planned_lng character varying,
      changed_by character varying,
      changed_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_pending_bill_history
    ADD COLUMN IF NOT EXISTS planned_lat character varying
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_pending_bill_history
    ADD COLUMN IF NOT EXISTS planned_lng character varying
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_pending_bill_history_bill
    ON public.odg_tms_pending_bill_history (bill_no, changed_at DESC)
  `);
  // Free-form "ອື່ນໆ" bills created by the dispatcher for deliveries that have
  // no ERP document (no ic_trans row, no service tb_product row). The row IS
  // the bill: customer + item lines live here, and the generated bill_no joins
  // odg_tms_pending_bill / odg_tms_detail like any other bill number.
  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_custom_bill (
      bill_no character varying PRIMARY KEY,
      cust_name character varying NOT NULL,
      telephone character varying,
      items jsonb NOT NULL DEFAULT '[]'::jsonb,
      remark text,
      created_by character varying,
      created_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  await safeDdl(db, `
    CREATE SEQUENCE IF NOT EXISTS public.odg_tms_custom_bill_seq
  `);
  // Parent sale-bill key for sub-bills created by the "ຈັດຖ້ຽວທີ່ເຫຼືອຕາມສາຂາ"
  // split tool: one multi-warehouse ERP bill becomes one custom sub-bill per
  // delivery branch, all sharing the original bill_no here so the split can be
  // traced back (and guarded against re-splitting the same branch). NULL for a
  // hand-typed "ອື່ນໆ" bill that has no parent.
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_custom_bill
    ADD COLUMN IF NOT EXISTS parent_bill_no character varying
  `);
}

// Bump the cache version whenever the DDL changes so existing dev/prod
// processes re-run the ALTER TABLE migrations on next call (the global cache
// otherwise persists across hot-reloads).
const PENDING_BILL_SCHEMA_VERSION = "v9_custom_bill_parent";

async function ensurePendingBillSchema() {
  const readyKey = `__tmsPendingBillSchemaReady_${PENDING_BILL_SCHEMA_VERSION}`;
  const promiseKey = `__tmsPendingBillSchemaPromise_${PENDING_BILL_SCHEMA_VERSION}`;
  if (pendingBillCache[readyKey]) return;
  if (!pendingBillCache[promiseKey]) {
    pendingBillCache[promiseKey] = ensurePendingBillSchemaInternal(pool)
      .then(() => {
        pendingBillCache[readyKey] = true;
      })
      .catch((err) => {
        pendingBillCache[promiseKey] = null;
        throw err;
      });
  }
  await pendingBillCache[promiseKey];
}

async function getPendingBillScheduleMap(billNos) {
  if (!Array.isArray(billNos) || billNos.length === 0) {
    return new Map();
  }
  await ensurePendingBillSchema();
  const rows = await query(
    `SELECT bill_no,
            to_char(scheduled_date,'YYYY-MM-DD') as scheduled_date,
            to_char(scheduled_date,'DD-MM-YYYY') as scheduled_date_display,
            COALESCE(remark, '') as remark,
            COALESCE(action_status, '') as action_status,
            COALESCE(delivery_route_code, '') as delivery_route_code,
            COALESCE(delivery_round_code, '') as delivery_round_code,
            COALESCE(transport_code, '') as transport_code,
            COALESCE(planned_lat, '') as planned_lat,
            COALESCE(planned_lng, '') as planned_lng,
            COALESCE(updated_by, '') as updated_by,
            to_char(updated_at,'DD-MM-YYYY HH24:MI') as updated_at
     FROM public.odg_tms_pending_bill
     WHERE bill_no = ANY($1::varchar[])`,
    [billNos]
  );
  return new Map(rows.map((r) => [r.bill_no, r]));
}

// How many times each bill's delivery date (scheduled_date) was actually
// CHANGED, from odg_tms_pending_bill_history. Every save appends a history row
// (even when only the remark/status/route changes), so we count transitions
// where the date moves from one non-null value to a DIFFERENT non-null value.
// The first time a date is set (NULL → date) is the initial assignment, not a
// reschedule, so it is excluded. Drives the "rescheduled too many times" red
// flag in the pending queue.
async function getPendingBillRescheduleCountMap(billNos) {
  if (!Array.isArray(billNos) || billNos.length === 0) {
    return new Map();
  }
  await ensurePendingBillSchema();
  const rows = await query(
    `WITH h AS (
       SELECT bill_no, scheduled_date,
              LAG(scheduled_date) OVER (PARTITION BY bill_no ORDER BY changed_at, id) AS prev_date
       FROM public.odg_tms_pending_bill_history
       WHERE bill_no = ANY($1::varchar[])
     )
     SELECT bill_no,
            COUNT(*) FILTER (
              WHERE scheduled_date IS NOT NULL
                AND prev_date IS NOT NULL
                AND scheduled_date IS DISTINCT FROM prev_date
            )::int AS reschedule_count
     FROM h
     GROUP BY bill_no`,
    [billNos]
  );
  return new Map(rows.map((r) => [r.bill_no, Number(r.reschedule_count ?? 0)]));
}

// Newest-first change log for one bill's schedule (date / remark / status /
// route / round). Drives the "ປະຫວັດການປ່ຽນວັນຈັດສົ່ງ" timeline in the drawer.
async function getPendingBillScheduleHistory(billNo) {
  const code = String(billNo ?? "").trim();
  if (!code) return [];
  await ensurePendingBillSchema();
  return query(
    `SELECT
       to_char(scheduled_date,'DD-MM-YYYY') as scheduled_date_display,
       COALESCE(remark, '') as remark,
       COALESCE(action_status, '') as action_status,
       COALESCE(delivery_route_code, '') as delivery_route_code,
       COALESCE(delivery_round_code, '') as delivery_round_code,
       COALESCE(planned_lat, '') as planned_lat,
       COALESCE(planned_lng, '') as planned_lng,
       COALESCE(changed_by, '') as changed_by,
       to_char(changed_at,'DD-MM-YYYY HH24:MI') as changed_at
     FROM public.odg_tms_pending_bill_history
     WHERE bill_no = $1
     ORDER BY changed_at DESC, id DESC
     LIMIT 50`,
    [code]
  );
}

async function upsertPendingBillSchedule({
  billNo,
  scheduledDate,
  remark,
  actionStatus,
  deliveryRouteCode,
  deliveryRoundCode,
  transportCode,
  userCode,
}) {
  const code = String(billNo ?? "").trim();
  if (!code) throw new Error("bill_no is required");
  await ensurePendingBillSchema();

  const date = scheduledDate ? String(scheduledDate).trim() || null : null;
  const note = remark ? String(remark).trim() || null : null;
  const status = actionStatus ? String(actionStatus).trim() || null : null;
  const route = deliveryRouteCode ? String(deliveryRouteCode).trim() || null : null;
  const round = deliveryRoundCode ? String(deliveryRoundCode).trim() || null : null;
  const transport = transportCode ? String(transportCode).trim() || null : null;
  const user = userCode ? String(userCode).trim() || null : null;

  // If all fields are blank, drop the row instead of keeping an empty entry.
  if (!date && !note && !status && !route && !round && !transport) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO public.odg_tms_pending_bill_history
           (bill_no, scheduled_date, remark, action_status, delivery_route_code, delivery_round_code, transport_code, planned_lat, planned_lng, changed_by)
         SELECT bill_no, NULL::date, NULL, NULL, NULL, NULL, NULL, planned_lat, planned_lng, $2
         FROM public.odg_tms_pending_bill
         WHERE bill_no = $1`,
        [code, user]
      );
      await client.query(
        `DELETE FROM public.odg_tms_pending_bill WHERE bill_no = $1`,
        [code]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return { success: true, removed: true };
  }

  await pool.query(
    `INSERT INTO public.odg_tms_pending_bill (bill_no, scheduled_date, remark, action_status, delivery_route_code, delivery_round_code, transport_code, updated_by, updated_at)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, LOCALTIMESTAMP(0))
     ON CONFLICT (bill_no) DO UPDATE
       SET scheduled_date = EXCLUDED.scheduled_date,
           remark = EXCLUDED.remark,
           action_status = EXCLUDED.action_status,
           delivery_route_code = EXCLUDED.delivery_route_code,
           delivery_round_code = EXCLUDED.delivery_round_code,
           transport_code = EXCLUDED.transport_code,
           updated_by = EXCLUDED.updated_by,
           updated_at = LOCALTIMESTAMP(0)`,
    [code, date, note, status, route, round, transport, user]
  );
  // Append the new state to the change history (best-effort — never block the
  // save itself on the audit write).
  try {
    await pool.query(
      `INSERT INTO public.odg_tms_pending_bill_history
         (bill_no, scheduled_date, remark, action_status, delivery_route_code, delivery_round_code, transport_code, planned_lat, planned_lng, changed_by)
       SELECT bill_no, scheduled_date, remark, action_status, delivery_route_code, delivery_round_code, transport_code, planned_lat, planned_lng, updated_by
       FROM public.odg_tms_pending_bill
       WHERE bill_no = $1`,
      [code]
    );
  } catch (err) {
    console.error("pending_bill history insert failed:", err);
  }
  invalidatePendingList();
  return { success: true };
}

// Bulk-update a list of bills with the same patch (e.g. mark all as ready,
// reassign to a round). Only fields that are explicitly provided are updated;
// pass null to clear a field. Uses a single transaction so all rows succeed
// or fail together.
/**
 * @param {{ billNos: string[], patch: { scheduledDate?: string|null, deliveryRoundCode?: string|null, deliveryRouteCode?: string|null, actionStatus?: string|null }, userCode?: string|null }} input
 */
async function bulkUpdatePendingBills(input) {
  const { billNos, patch, userCode } = input || {};
  const codes = (Array.isArray(billNos) ? billNos : [])
    .map((b) => String(b ?? "").trim())
    .filter(Boolean);
  if (codes.length === 0) return { success: true, updated: 0 };
  await ensurePendingBillSchema();

  const sets = [];
  const params = [];
  let i = 1;
  if ("scheduledDate" in (patch || {})) {
    const v = patch.scheduledDate ? String(patch.scheduledDate).trim() || null : null;
    params.push(v);
    sets.push(`scheduled_date = $${i}::date`);
    i++;
  }
  if ("actionStatus" in (patch || {})) {
    const v = patch.actionStatus ? String(patch.actionStatus).trim() || null : null;
    params.push(v);
    sets.push(`action_status = $${i}`);
    i++;
  }
  if ("deliveryRouteCode" in (patch || {})) {
    const v = patch.deliveryRouteCode ? String(patch.deliveryRouteCode).trim() || null : null;
    params.push(v);
    sets.push(`delivery_route_code = $${i}`);
    i++;
  }
  if ("deliveryRoundCode" in (patch || {})) {
    const v = patch.deliveryRoundCode ? String(patch.deliveryRoundCode).trim() || null : null;
    params.push(v);
    sets.push(`delivery_round_code = $${i}`);
    i++;
  }
  if (sets.length === 0) return { success: true, updated: 0 };
  const userParam = userCode ? String(userCode).trim() || null : null;
  params.push(userParam);
  sets.push(`updated_by = $${i}`);
  i++;
  sets.push("updated_at = LOCALTIMESTAMP(0)");
  params.push(codes);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Insert rows for bills that don't yet have a pending_bill record so the
    // UPDATE has something to hit. Conflict = do nothing because UPDATE will
    // pick them up.
    await client.query(
      `INSERT INTO public.odg_tms_pending_bill (bill_no)
       SELECT unnest($1::varchar[]) ON CONFLICT (bill_no) DO NOTHING`,
      [codes]
    );
    const result = await client.query(
      `UPDATE public.odg_tms_pending_bill SET ${sets.join(", ")}
       WHERE bill_no = ANY($${i}::varchar[])`,
      params
    );
    // Snapshot each touched bill's resulting schedule into the change history.
    await client.query(
      `INSERT INTO public.odg_tms_pending_bill_history
         (bill_no, scheduled_date, remark, action_status, delivery_route_code, delivery_round_code, transport_code, planned_lat, planned_lng, changed_by)
       SELECT bill_no, scheduled_date, remark, action_status, delivery_route_code, delivery_round_code, transport_code, planned_lat, planned_lng, updated_by
       FROM public.odg_tms_pending_bill
       WHERE bill_no = ANY($1::varchar[])`,
      [codes]
    );
    await client.query("COMMIT");
    invalidatePendingList();
    return { success: true, updated: result.rowCount ?? codes.length };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function getPendingBillSchedule(billNo) {
  const code = String(billNo ?? "").trim();
  if (!code) return null;
  await ensurePendingBillSchema();
  return queryOne(
    `SELECT bill_no,
            to_char(scheduled_date,'YYYY-MM-DD') as scheduled_date,
            COALESCE(remark, '') as remark,
            COALESCE(action_status, '') as action_status,
            COALESCE(delivery_route_code, '') as delivery_route_code,
            COALESCE(delivery_round_code, '') as delivery_round_code,
            COALESCE(transport_code, '') as transport_code,
            COALESCE(planned_lat, '') as planned_lat,
            COALESCE(planned_lng, '') as planned_lng,
            COALESCE(updated_by, '') as updated_by,
            to_char(updated_at,'DD-MM-YYYY HH24:MI') as updated_at
     FROM public.odg_tms_pending_bill
     WHERE bill_no = $1`,
    [code]
  );
}

// Set or clear the dispatcher's planned delivery location on a pending bill.
// Stored separately from scheduled_date / route / round — those are touched
// from the schedule dialog and we don't want to entangle the two flows.
async function upsertPendingBillLocation({ billNo, lat, lng, userCode }) {
  const code = String(billNo ?? "").trim();
  if (!code) throw new Error("bill_no is required");
  await ensurePendingBillSchema();

  const latStr = lat === null || lat === undefined || lat === "" ? null : String(lat).trim();
  const lngStr = lng === null || lng === undefined || lng === "" ? null : String(lng).trim();
  const user = userCode ? String(userCode).trim() || null : null;

  if (latStr === null || lngStr === null) {
    await pool.query(
      `INSERT INTO public.odg_tms_pending_bill (bill_no, planned_lat, planned_lng, updated_by, updated_at)
       VALUES ($1, NULL, NULL, $2, LOCALTIMESTAMP(0))
       ON CONFLICT (bill_no) DO UPDATE
         SET planned_lat = NULL,
             planned_lng = NULL,
             updated_by = EXCLUDED.updated_by,
             updated_at = LOCALTIMESTAMP(0)`,
      [code, user]
    );
    try {
      await pool.query(
        `INSERT INTO public.odg_tms_pending_bill_history
           (bill_no, scheduled_date, remark, action_status, delivery_route_code, delivery_round_code, transport_code, planned_lat, planned_lng, changed_by)
         SELECT bill_no, scheduled_date, remark, action_status, delivery_route_code, delivery_round_code, transport_code, planned_lat, planned_lng, updated_by
         FROM public.odg_tms_pending_bill
         WHERE bill_no = $1`,
        [code]
      );
    } catch (err) {
      console.error("pending_bill location history insert failed:", err);
    }
    return { success: true, cleared: true };
  }

  await pool.query(
    `INSERT INTO public.odg_tms_pending_bill (bill_no, planned_lat, planned_lng, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, LOCALTIMESTAMP(0))
     ON CONFLICT (bill_no) DO UPDATE
       SET planned_lat = EXCLUDED.planned_lat,
           planned_lng = EXCLUDED.planned_lng,
           updated_by = EXCLUDED.updated_by,
           updated_at = LOCALTIMESTAMP(0)`,
    [code, latStr, lngStr, user]
  );
  try {
    await pool.query(
      `INSERT INTO public.odg_tms_pending_bill_history
         (bill_no, scheduled_date, remark, action_status, delivery_route_code, delivery_round_code, transport_code, planned_lat, planned_lng, changed_by)
       SELECT bill_no, scheduled_date, remark, action_status, delivery_route_code, delivery_round_code, transport_code, planned_lat, planned_lng, updated_by
       FROM public.odg_tms_pending_bill
       WHERE bill_no = $1`,
      [code]
    );
  } catch (err) {
    console.error("pending_bill location history insert failed:", err);
  }
  invalidatePendingList();
  return { success: true };
}

module.exports = {
  ensurePendingBillSchema,
  getPendingBillScheduleMap,
  getPendingBillRescheduleCountMap,
  getPendingBillScheduleHistory,
  getPendingBillSchedule,
  upsertPendingBillSchedule,
  bulkUpdatePendingBills,
  upsertPendingBillLocation,
};
