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

/**
 * No-op in odgmgt. TMS runs the real thing.
 *
 * Upstream this applies 25 DDL statements — 18 of them ALTER TABLE on
 * odg_tms, odg_tms_detail, odg_tms_detail_item and odg_tms_listbill_draft —
 * the first time any request touches the delivery workflow. That is correct in
 * TMS, which owns those tables. Here it is not: this app only reads them, and
 * ALTER TABLE takes an ACCESS EXCLUSIVE lock on tables TMS is actively writing,
 * so every restart had this app queue behind — and hold up — live traffic.
 * TMS's own comment upstream warns it "can stall under concurrent load while
 * ALTER TABLE waits for an ACCESS EXCLUSIVE lock".
 *
 * The symptom was a 30-second client timeout on the first load of the truck
 * utilisation screen after a restart, against 618 ms once the schema check had
 * already run.
 *
 * If a column this app reads is ever missing, the fix is to deploy TMS, not to
 * re-enable this.
 */
async function ensureDeliveryWorkflowSchemaInternal() {
  // intentionally empty — see above
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
