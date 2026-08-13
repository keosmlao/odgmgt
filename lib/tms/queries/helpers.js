const { query } = require("../lib/db");
const { ensureDeliveryWorkflowSchema } = require("./delivery");

const ensureCache = globalThis;

// Swallow the benign "duplicate key value violates unique constraint
// pg_class_relname_nsp_index" that Postgres throws when two sessions race
// through `CREATE INDEX IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`
// for the same name.
async function safeDdl(sql) {
  try {
    await query(sql);
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

// Wraps an `ensure*` function so concurrent callers share a single in-flight
// promise — the DDL runs exactly once per process.
function once(fn) {
  let promise = null;
  return () => {
    if (!promise) {
      promise = fn().catch((err) => {
        promise = null;
        throw err;
      });
    }
    return promise;
  };
}

function formatInterval(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return `${value}s`;
  if (typeof value !== "object") return String(value);
  const interval = value;
  const parts = [
    Math.trunc(interval.days ?? 0) > 0 ? `${Math.trunc(interval.days)}d` : null,
    Math.trunc(interval.hours ?? 0) > 0 ? `${Math.trunc(interval.hours)}h` : null,
    Math.trunc(interval.minutes ?? 0) > 0 ? `${Math.trunc(interval.minutes)}m` : null,
    `${Math.trunc(interval.seconds ?? 0)}s`,
  ].filter(Boolean);
  return parts.join(" ") || "0s";
}

function getNextMonthStart(monthValue) {
  const [yearText, monthText] = monthValue.split("-");
  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  if (month === 12) return `${year + 1}-01-01`;
  return `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

function toDisplayDate(value) {
  const [year, month, day] = value.split("-");
  return `${day}-${month}-${year}`;
}

function toDisplayMonth(value) {
  const [year, month] = value.split("-");
  return `${month}-${year}`;
}

// "ສົ່ງຕໍ່ສາຂາ" feature
const ensureForwardBranchColumn = once(async () => {
  await safeDdl(`
    ALTER TABLE public.odg_tms_detail
    ADD COLUMN IF NOT EXISTS forward_transport_code character varying
  `);
  await safeDdl(`
    CREATE INDEX IF NOT EXISTS idx_odg_tms_detail_forward
    ON public.odg_tms_detail (forward_transport_code)
    WHERE forward_transport_code IS NOT NULL
  `);
  await safeDdl(`
    ALTER TABLE public.odg_tms
    ADD COLUMN IF NOT EXISTS origin_transport_code character varying
  `);
  await safeDdl(`
    CREATE INDEX IF NOT EXISTS idx_odg_tms_origin_transport
    ON public.odg_tms (origin_transport_code)
    WHERE origin_transport_code IS NOT NULL
  `);
});

const ensureJobListIndexes = once(async () => {
  await ensureForwardBranchColumn();
  await safeDdl(`
    CREATE INDEX IF NOT EXISTS idx_odg_tms_detail_doc_date_doc_no
    ON public.odg_tms_detail (doc_date, doc_no)
  `);
  await safeDdl(`
    CREATE INDEX IF NOT EXISTS idx_odg_tms_detail_doc_no
    ON public.odg_tms_detail (doc_no)
  `);
  await safeDdl(`
    CREATE INDEX IF NOT EXISTS idx_odg_tms_doc_date_status
    ON public.odg_tms (doc_date, approve_status, job_status)
  `);
  // Enforce one detail row per (trip, bill). Best-effort: while legacy duplicate
  // rows still exist the unique index can't build (error 23505, swallowed by
  // safeDdl) — run scripts/migrate-dedup-detail-unique.sql to clean up, then
  // this auto-creates on the next call and rejects future duplicates.
  await safeDdl(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_odg_tms_detail_doc_bill
    ON public.odg_tms_detail (doc_no, bill_no)
  `);
});

async function ensureTmsWorkerTable() {
  if (ensureCache.__tmsEnsureCache?.workerTable) return;
  await query(`
    CREATE TABLE IF NOT EXISTS public.odg_tms_worker (
      roworder BIGSERIAL PRIMARY KEY,
      doc_no character varying NOT NULL,
      doc_date date NOT NULL,
      worker_code character varying NOT NULL,
      worker_name character varying NOT NULL,
      user_create character varying,
      create_date_time_now timestamp without time zone DEFAULT LOCALTIMESTAMP(0),
      CONSTRAINT odg_tms_worker_doc_worker_unique UNIQUE (doc_no, worker_code)
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_odg_tms_worker_doc_no
    ON public.odg_tms_worker (doc_no)
  `);
  ensureCache.__tmsEnsureCache = {
    ...ensureCache.__tmsEnsureCache,
    workerTable: true,
  };
}

async function ensurePendingJobListIndex() {
  if (ensureCache.__tmsEnsureCache?.pendingJobListIndex) return;
  await query(`
    CREATE INDEX IF NOT EXISTS idx_odg_tms_pending_jobs_user_doc
    ON public.odg_tms (user_created, doc_no DESC)
    WHERE approve_status = 0 OR approve_status IS NULL
  `);
  ensureCache.__tmsEnsureCache = {
    ...ensureCache.__tmsEnsureCache,
    pendingJobListIndex: true,
  };
}

const ensureTmsDetailItemTable = once(async () => {
  await ensureDeliveryWorkflowSchema();
  ensureCache.__tmsEnsureCache = {
    ...ensureCache.__tmsEnsureCache,
    detailItemTable: true,
  };
});

async function getRemainingBillProducts(billNo) {
  await ensureTmsDetailItemTable();
  // Items become "available for re-dispatch" once the prior delivery attempt
  // is finished (status=1 done, status=2 cancelled). Active attempts
  // (status NULL/0/3) lock their selected_qty so the same items can't get
  // dispatched twice in parallel.
  // ic_trans_detail can have multiple rows per item_code, so we aggregate
  // first to avoid duplicate rows in the result.
  const rows = await query(
    `WITH bill_items AS (
      SELECT
        d.item_code,
        MAX(d.item_name) AS item_name,
        SUM(COALESCE(d.qty, 0))::numeric AS total_qty,
        MAX(d.unit_code) AS unit_code
      FROM ic_trans_detail d
      WHERE d.doc_no = $1 AND d.item_code NOT LIKE '97%'
      GROUP BY d.item_code
    ),
    active_locked AS (
      SELECT item.item_code,
             COALESCE(SUM(item.selected_qty), 0)::numeric AS locked_qty
      FROM public.odg_tms_detail_item item
      INNER JOIN public.odg_tms_detail det
        ON det.bill_no = item.bill_no AND det.doc_no = item.doc_no
      WHERE item.bill_no = $1
        AND COALESCE(det.status, 0) NOT IN (1, 2)
      GROUP BY item.item_code
    ),
    delivered AS (
      -- Drivers sometimes mark a job done (status=1) without filling
      -- per-item delivered_qty. Treat that data gap as "fully delivered up
      -- to the selected_qty" so the bill stops re-appearing in the pending
      -- list. Cancelled rows (status=2) keep the actual delivered_qty
      -- (typically 0).
      SELECT item.item_code,
             COALESCE(SUM(
               CASE
                 WHEN COALESCE(det.status, 0) = 1
                  AND COALESCE(item.delivered_qty, 0) = 0
                   THEN COALESCE(item.selected_qty, 0)
                 ELSE COALESCE(item.delivered_qty, 0)
               END
             ), 0)::numeric AS delivered_qty
      FROM public.odg_tms_detail_item item
      INNER JOIN public.odg_tms_detail det
        ON det.bill_no = item.bill_no AND det.doc_no = item.doc_no
      WHERE item.bill_no = $1
        AND COALESCE(det.status, 0) IN (1, 2)
        -- A forward-to-branch leg isn't a customer delivery — exclude it so the
        -- forwarded qty stays re-dispatchable at the receiving branch.
        AND NULLIF(TRIM(det.forward_transport_code), '') IS NULL
      GROUP BY item.item_code
    ),
    returned AS (
      -- Goods returned via a credit-note doc (trans_flag=48) whose detail line
      -- ref_doc_no points at this sale; subtract so returned items aren't re-dispatched.
      SELECT rd.item_code,
             COALESCE(SUM(ABS(COALESCE(rd.qty, 0))), 0)::numeric AS returned_qty
      FROM ic_trans_detail rd
      INNER JOIN ic_trans r ON r.doc_no = rd.doc_no AND r.trans_flag = 48
      WHERE rd.ref_doc_no = $1
        AND rd.item_code NOT LIKE '97%'
      GROUP BY rd.item_code
    )
    SELECT
      bi.item_code,
      bi.item_name,
      GREATEST(
        bi.total_qty
        - COALESCE(al.locked_qty, 0)
        - COALESCE(dl.delivered_qty, 0)
        - COALESCE(rt.returned_qty, 0),
        0
      )::numeric AS qty,
      bi.unit_code
    FROM bill_items bi
    LEFT JOIN active_locked al ON al.item_code = bi.item_code
    LEFT JOIN delivered dl ON dl.item_code = bi.item_code
    LEFT JOIN returned rt ON rt.item_code = bi.item_code
    WHERE GREATEST(
      bi.total_qty
      - COALESCE(al.locked_qty, 0)
      - COALESCE(dl.delivered_qty, 0)
      - COALESCE(rt.returned_qty, 0),
      0
    ) > 0
    ORDER BY bi.item_code`,
    [billNo]
  );

  return rows.map((row) => ({
    item_code: row.item_code,
    item_name: row.item_name,
    qty: Number(row.qty ?? 0),
    unit_code: row.unit_code,
  }));
}

/**
 * ບິນໃດແດ່ທີ່ມີລາຍການຢູ່ ERP (ic_trans_detail).
 *
 * ໃຊ້ແຍກ 2 ກໍລະນີທີ່ getRemainingBillProductsMap ຄືນ [] ຄືກັນ ແຕ່ຄວາມໝາຍ
 * ຄົນລະຢ່າງ:
 *   - ບິນໂອນ/ບິນມືທີ່ບໍ່ມີແຖວໃນ ERP  → ຕ້ອງເຊື່ອລາຍການທີ່ຜູ້ໃຊ້ໃສ່ມາ
 *   - ບິນ ERP ທີ່ຈັດຄົບໝົດແລ້ວ        → ຕ້ອງປະຕິເສດ ບໍ່ແມ່ນເຊື່ອຜູ້ໃຊ້
 *
 * ບໍ່ແຍກສອງອັນນີ້ ເຮັດໃຫ້ບິນທີ່ສົ່ງຄົບແລ້ວຖືກຈັດຖ້ຽວຄືນໄດ້ບໍ່ຈຳກັດ.
 */
async function getBillsWithErpDetail(billNos) {
  const bills = Array.from(
    new Set((billNos ?? []).map((b) => String(b ?? "").trim()).filter(Boolean))
  );
  if (bills.length === 0) return new Set();
  const rows = await query(
    `SELECT DISTINCT doc_no FROM ic_trans_detail
      WHERE doc_no = ANY($1::varchar[]) AND item_code NOT LIKE '97%'`,
    [bills]
  );
  return new Set(rows.map((r) => String(r.doc_no)));
}

// Batched version of getRemainingBillProducts: the SAME per-item remaining math
// for many bills in one query. Returns Map<bill_no, [{item_code, item_name,
// qty, unit_code}]> (only items with qty > 0). Used by createJob/addBillsToJob
// to validate a whole trip's bills without an N+1 query-per-bill inside the
// (advisory-locked) transaction.
async function getRemainingBillProductsMap(billNos) {
  await ensureTmsDetailItemTable();
  const map = new Map();
  if (!Array.isArray(billNos) || billNos.length === 0) return map;

  const rows = await query(
    `WITH bill_items AS (
      SELECT
        d.doc_no AS bill_no,
        d.item_code,
        MAX(d.item_name) AS item_name,
        SUM(COALESCE(d.qty, 0))::numeric AS total_qty,
        MAX(d.unit_code) AS unit_code
      FROM ic_trans_detail d
      WHERE d.doc_no = ANY($1::varchar[]) AND d.item_code NOT LIKE '97%'
      GROUP BY d.doc_no, d.item_code
    ),
    active_locked AS (
      SELECT item.bill_no, item.item_code,
             COALESCE(SUM(item.selected_qty), 0)::numeric AS locked_qty
      FROM public.odg_tms_detail_item item
      INNER JOIN public.odg_tms_detail det
        ON det.bill_no = item.bill_no AND det.doc_no = item.doc_no
      WHERE item.bill_no = ANY($1::varchar[])
        AND COALESCE(det.status, 0) NOT IN (1, 2)
      GROUP BY item.bill_no, item.item_code
    ),
    delivered AS (
      SELECT item.bill_no, item.item_code,
             COALESCE(SUM(
               CASE
                 WHEN COALESCE(det.status, 0) = 1
                  AND COALESCE(item.delivered_qty, 0) = 0
                   THEN COALESCE(item.selected_qty, 0)
                 ELSE COALESCE(item.delivered_qty, 0)
               END
             ), 0)::numeric AS delivered_qty
      FROM public.odg_tms_detail_item item
      INNER JOIN public.odg_tms_detail det
        ON det.bill_no = item.bill_no AND det.doc_no = item.doc_no
      WHERE item.bill_no = ANY($1::varchar[])
        AND COALESCE(det.status, 0) IN (1, 2)
        -- A forward-to-branch leg isn't a customer delivery — exclude it so the
        -- forwarded qty stays re-dispatchable at the receiving branch.
        AND NULLIF(TRIM(det.forward_transport_code), '') IS NULL
      GROUP BY item.bill_no, item.item_code
    ),
    returned AS (
      SELECT rd.ref_doc_no AS bill_no, rd.item_code,
             COALESCE(SUM(ABS(COALESCE(rd.qty, 0))), 0)::numeric AS returned_qty
      FROM ic_trans_detail rd
      INNER JOIN ic_trans r ON r.doc_no = rd.doc_no AND r.trans_flag = 48
      WHERE rd.ref_doc_no = ANY($1::varchar[])
        AND rd.item_code NOT LIKE '97%'
      GROUP BY rd.ref_doc_no, rd.item_code
    )
    SELECT
      bi.bill_no,
      bi.item_code,
      bi.item_name,
      bi.unit_code,
      GREATEST(
        bi.total_qty
        - COALESCE(al.locked_qty, 0)
        - COALESCE(dl.delivered_qty, 0)
        - COALESCE(rt.returned_qty, 0),
        0
      )::numeric AS qty
    FROM bill_items bi
    LEFT JOIN active_locked al ON al.bill_no = bi.bill_no AND al.item_code = bi.item_code
    LEFT JOIN delivered dl ON dl.bill_no = bi.bill_no AND dl.item_code = bi.item_code
    LEFT JOIN returned rt ON rt.bill_no = bi.bill_no AND rt.item_code = bi.item_code
    WHERE GREATEST(
      bi.total_qty
      - COALESCE(al.locked_qty, 0)
      - COALESCE(dl.delivered_qty, 0)
      - COALESCE(rt.returned_qty, 0),
      0
    ) > 0
    ORDER BY bi.bill_no, bi.item_code`,
    [billNos]
  );

  for (const row of rows) {
    const list = map.get(row.bill_no) ?? [];
    list.push({
      item_code: row.item_code,
      item_name: row.item_name,
      qty: Number(row.qty ?? 0),
      unit_code: row.unit_code,
    });
    map.set(row.bill_no, list);
  }
  return map;
}

// ── Remaining-count cache ──────────────────────────────────────────────────
// getRemainingSummaryMap has to read ic_trans_detail (2.1 GB / 1.3M rows) to
// work out what is still owed on each bill. Measured at ~15 s for the whole
// pending pool, it was ~99% of getBillsPending's 1.16 s average and the main
// reason the dispatch screens felt slow.
//
// The answer only changes when a bill is dispatched, delivered, returned or
// cancelled — rare compared to how often these screens are opened — so results
// are cached PER BILL for a short window. Callers that change any of those
// things must call invalidateRemainingSummary() so the next read is fresh;
// the TTL is the safety net, not the mechanism.
const REMAINING_CACHE_TTL_MS = 30_000;
const remainingCache = new Map(); // bill_no -> { at, value }

// ຜົນລວມຂອງໜ້າ "ບິນລໍຈັດຖ້ຽວ" — ໜັກ (ວັດໄດ້ ~3.7 ວິ ຕອນເປີດຄັ້ງທຳອິດ) ແລະ
// ຖືກເປີດຊ້ຳໆຈາກ 2 ໜ້າ. ເກັບໄວ້ສັ້ນໆ ແລ້ວລ້າງພ້ອມ remainingCache — ຄຳຕອບ
// ປ່ຽນເມື່ອບິນຖືກຈັດຖ້ຽວ/ສົ່ງ/ຍົກເລີກ ເຊິ່ງເປັນຈຸດດຽວກັນທີ່ເອີ້ນ
// invalidateRemainingSummary() ຢູ່ແລ້ວ ຈຶ່ງບໍ່ມີທາງລືມລ້າງອັນໃດອັນໜຶ່ງ.
const PENDING_LIST_CACHE_TTL_MS = 45_000;
const pendingListCache = new Map(); // key -> { at, value }

/** ລ້າງລາຍການລວມທັນທີ — ໃຊ້ຕອນນັດວັນສົ່ງ/ປັກໝຸດ ທີ່ບໍ່ໄດ້ແຕະຈຳນວນຄົງເຫຼືອ */
function invalidatePendingList() {
  pendingListCache.clear();
}

function readPendingListCache(key) {
  const hit = pendingListCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PENDING_LIST_CACHE_TTL_MS) {
    pendingListCache.delete(key);
    return null;
  }
  return hit.value;
}

function writePendingListCache(key, value) {
  pendingListCache.set(key, { at: Date.now(), value });
}

function invalidateRemainingSummary(billNos) {
  // ບິນໃດປ່ຽນ ລາຍການລວມກໍ່ປ່ຽນ — ລ້າງທັງກ້ອນ ບໍ່ພະຍາຍາມລ້າງເປັນລາຍການ
  pendingListCache.clear();
  if (!billNos) {
    remainingCache.clear();
    return;
  }
  for (const b of Array.isArray(billNos) ? billNos : [billNos]) {
    remainingCache.delete(String(b ?? "").trim());
  }
}

async function getRemainingSummaryMap(billNos) {
  await ensureTmsDetailItemTable();
  if (billNos.length === 0) return new Map();

  // Serve what is still fresh, and only hit the database for the rest.
  const now = Date.now();
  const result = new Map();
  const missing = [];
  for (const raw of billNos) {
    const bill = String(raw ?? "").trim();
    if (!bill) continue;
    const hit = remainingCache.get(bill);
    if (hit && now - hit.at < REMAINING_CACHE_TTL_MS) result.set(bill, hit.value);
    else missing.push(bill);
  }
  if (missing.length === 0) return result;
  const fresh = await getRemainingSummaryMapUncached(missing);
  for (const bill of missing) {
    const value = fresh.get(bill) ?? { remaining_count: 0, remaining_qty_total: 0 };
    remainingCache.set(bill, { at: now, value });
    result.set(bill, value);
  }
  return result;
}

async function getRemainingSummaryMapUncached(billNos) {
  await ensureTmsDetailItemTable();
  if (billNos.length === 0) return new Map();

  // Active attempts lock the items (selected_qty), finished attempts only
  // consume what was actually delivered (delivered_qty). The remainder is
  // available again for re-dispatch — covers cancelled bills and partials.
  // ic_trans_detail can have multiple rows per item_code, so we aggregate
  // first.
  //
  // PERF: the bill list is joined in via unnest() (targets CTE) instead of
  // `col = ANY($1)`. bills-pending feeds thousands of bill numbers here, and
  // with ANY() the planner re-scans the whole array per candidate row (a
  // nested-loop filter measured at ~4s for ~4k bills); the unnest hash join
  // does the same work in a few hundred ms with identical results.
  const rows = await query(
    `WITH targets AS (
      SELECT DISTINCT u.bill_no FROM unnest($1::varchar[]) AS u(bill_no)
    ),
    bill_items AS (
      SELECT
        d.doc_no AS bill_no,
        d.item_code,
        SUM(COALESCE(d.qty, 0))::numeric AS total_qty
      FROM ic_trans_detail d
      INNER JOIN targets t ON t.bill_no = d.doc_no
      WHERE d.item_code NOT LIKE '97%'
      GROUP BY d.doc_no, d.item_code
    ),
    active_locked AS (
      SELECT item.bill_no, item.item_code,
             COALESCE(SUM(item.selected_qty), 0)::numeric AS locked_qty
      FROM public.odg_tms_detail_item item
      INNER JOIN targets t ON t.bill_no = item.bill_no
      INNER JOIN public.odg_tms_detail det
        ON det.bill_no = item.bill_no AND det.doc_no = item.doc_no
      WHERE COALESCE(det.status, 0) NOT IN (1, 2)
      GROUP BY item.bill_no, item.item_code
    ),
    delivered AS (
      -- See note above: when a row is marked done (status=1) but the
      -- driver never filled in delivered_qty, treat the selected_qty as
      -- delivered so the bill drops out of the pending list.
      SELECT item.bill_no, item.item_code,
             COALESCE(SUM(
               CASE
                 WHEN COALESCE(det.status, 0) = 1
                  AND COALESCE(item.delivered_qty, 0) = 0
                   THEN COALESCE(item.selected_qty, 0)
                 ELSE COALESCE(item.delivered_qty, 0)
               END
             ), 0)::numeric AS delivered_qty
      FROM public.odg_tms_detail_item item
      INNER JOIN targets t ON t.bill_no = item.bill_no
      INNER JOIN public.odg_tms_detail det
        ON det.bill_no = item.bill_no AND det.doc_no = item.doc_no
      WHERE COALESCE(det.status, 0) IN (1, 2)
        -- A forward-to-branch leg isn't a customer delivery — exclude it so the
        -- forwarded qty stays re-dispatchable at the receiving branch.
        AND NULLIF(TRIM(det.forward_transport_code), '') IS NULL
      GROUP BY item.bill_no, item.item_code
    ),
    -- Goods returned / credit-noted against the sale bill. A return is its own
    -- ic_trans doc (trans_flag=48) whose ref_doc_no points back at the sale's
    -- doc_no; its detail lines carry the returned qty per item. Subtracting
    -- these makes a fully-returned bill drop off the pending list, and a
    -- partially-returned one show only the un-returned remainder. ABS() guards
    -- against returns being stored as a negative qty.
    returned AS (
      SELECT rd.ref_doc_no AS bill_no, rd.item_code,
             COALESCE(SUM(ABS(COALESCE(rd.qty, 0))), 0)::numeric AS returned_qty
      FROM ic_trans_detail rd
      INNER JOIN targets t ON t.bill_no = rd.ref_doc_no
      INNER JOIN ic_trans r ON r.doc_no = rd.doc_no AND r.trans_flag = 48
      WHERE rd.item_code NOT LIKE '97%'
      GROUP BY rd.ref_doc_no, rd.item_code
    )
    SELECT
      bi.bill_no,
      COUNT(*) FILTER (
        WHERE GREATEST(
          bi.total_qty
          - COALESCE(al.locked_qty, 0)
          - COALESCE(dl.delivered_qty, 0)
          - COALESCE(rt.returned_qty, 0),
          0
        ) > 0
      )::int AS remaining_count,
      COALESCE(
        SUM(GREATEST(
          bi.total_qty
          - COALESCE(al.locked_qty, 0)
          - COALESCE(dl.delivered_qty, 0)
          - COALESCE(rt.returned_qty, 0),
          0
        )), 0
      )::numeric AS remaining_qty_total,
      -- "Total" is net of returns (returned goods aren't to be delivered);
      -- delivered = what already went out on finished attempts.
      COALESCE(SUM(GREATEST(bi.total_qty - COALESCE(rt.returned_qty, 0), 0)), 0)::numeric AS total_qty_total,
      COALESCE(SUM(COALESCE(dl.delivered_qty, 0)), 0)::numeric AS delivered_qty_total
    FROM bill_items bi
    LEFT JOIN active_locked al
      ON al.bill_no = bi.bill_no AND al.item_code = bi.item_code
    LEFT JOIN delivered dl
      ON dl.bill_no = bi.bill_no AND dl.item_code = bi.item_code
    LEFT JOIN returned rt
      ON rt.bill_no = bi.bill_no AND rt.item_code = bi.item_code
    GROUP BY bi.bill_no`,
    [billNos]
  );

  const result = new Map();
  for (const billNo of billNos) {
    result.set(billNo, { remaining_count: 0, remaining_qty_total: 0, total_qty_total: 0, delivered_qty_total: 0 });
  }
  for (const row of rows) {
    result.set(row.bill_no, {
      remaining_count: Number(row.remaining_count ?? 0),
      remaining_qty_total: Number(row.remaining_qty_total ?? 0),
      total_qty_total: Number(row.total_qty_total ?? 0),
      delivered_qty_total: Number(row.delivered_qty_total ?? 0),
    });
  }
  return result;
}

// Returns items for a bill grouped by warehouse (wh_code + item_code).
// Used for the split-by-warehouse UI so dispatchers can see which items
// belong to which warehouse and create separate trips per warehouse.
// Unlike getRemainingBillProducts this does NOT subtract active-locked or
// delivered quantities — it reflects the original ERP invoice structure.
async function getBillItemsByWarehouse(billNo) {
  const rows = await query(
    `SELECT
       COALESCE(NULLIF(TRIM(d.wh_code), ''), '') AS wh_code,
       COALESCE(w.name_1, NULLIF(TRIM(d.wh_code), ''), 'ບໍ່ລະບຸສາງ') AS wh_name,
       d.item_code,
       MAX(d.item_name) AS item_name,
       SUM(COALESCE(d.qty, 0))::numeric AS qty,
       MAX(d.unit_code) AS unit_code
     FROM ic_trans_detail d
     LEFT JOIN public.ic_warehouse w ON w.code = NULLIF(TRIM(d.wh_code), '')
     WHERE d.doc_no = $1 AND d.item_code NOT LIKE '97%'
     GROUP BY COALESCE(NULLIF(TRIM(d.wh_code), ''), ''), COALESCE(w.name_1, NULLIF(TRIM(d.wh_code), ''), 'ບໍ່ລະບຸສາງ'), d.item_code
     ORDER BY wh_code, d.item_code`,
    [billNo]
  );
  return rows.map((row) => ({
    wh_code: row.wh_code,
    wh_name: row.wh_name,
    item_code: row.item_code,
    item_name: row.item_name,
    qty: Number(row.qty ?? 0),
    unit_code: row.unit_code,
  }));
}

// Warehouse→branch mapping + grouping live in a pure, unit-tested module.
const {
  suggestTransportForBranchStock,
  groupRemainingItemsByWarehouse,
} = require("../lib/warehouse-branch");

// Remaining-to-dispatch items for a bill, grouped by source warehouse and its
// suggested delivery branch. Used by the "ຈັດຖ້ຽວທີ່ເຫຼືອຕາມສາຂາ" tool: one sale
// bill whose stock lives in several warehouses (e.g. ຂົວຫຼວງ + ດອນຕິ້ວ) must be
// dispatched as one trip per branch. "Remaining" = the ERP invoice qty per
// (warehouse, item) MINUS whatever has already been placed on a non-cancelled
// trip (selected_qty in odg_tms_detail_item), so re-running the tool only ever
// offers what is still un-dispatched.
//
// Caveat: odg_tms_detail_item carries no wh_code, so already-placed qty is
// attributed per item_code. When the same item_code appears in more than one
// warehouse on the invoice (rare), the subtraction is applied against the
// matching item rows without cross-warehouse attribution — acceptable for the
// common 1-item-1-warehouse case; documented so callers don't over-trust the
// per-warehouse split of a multi-warehouse item.
async function getBillRemainingItemsByWarehouse(billNo) {
  const rows = await query(
    `WITH erp AS (
       SELECT
         COALESCE(NULLIF(TRIM(d.wh_code), ''), '') AS wh_code,
         d.item_code,
         MAX(d.item_name) AS item_name,
         MAX(d.unit_code) AS unit_code,
         SUM(COALESCE(d.qty, 0))::numeric AS erp_qty
       FROM ic_trans_detail d
       WHERE d.doc_no = $1 AND d.item_code NOT LIKE '97%'
       GROUP BY COALESCE(NULLIF(TRIM(d.wh_code), ''), ''), d.item_code
     ),
     placed AS (
       SELECT i.item_code,
              SUM(COALESCE(i.selected_qty, 0))::numeric AS placed_qty
       FROM public.odg_tms_detail_item i
       INNER JOIN public.odg_tms_detail det
         ON det.bill_no = i.bill_no AND det.doc_no = i.doc_no
       WHERE i.bill_no = $1
         AND COALESCE(det.status, 0) <> 2
       GROUP BY i.item_code
     )
     SELECT
       erp.wh_code,
       COALESCE(w.name_1, NULLIF(erp.wh_code, ''), 'ບໍ່ລະບຸສາງ') AS wh_name,
       COALESCE(NULLIF(TRIM(w.branch_stock), ''), '') AS branch_stock,
       erp.item_code,
       erp.item_name,
       erp.unit_code,
       erp.erp_qty,
       COALESCE(p.placed_qty, 0)::numeric AS placed_qty,
       GREATEST(erp.erp_qty - COALESCE(p.placed_qty, 0), 0)::numeric AS remaining_qty
     FROM erp
     LEFT JOIN public.ic_warehouse w ON w.code = NULLIF(erp.wh_code, '')
     LEFT JOIN placed p ON p.item_code = erp.item_code
     ORDER BY erp.wh_code, erp.item_code`,
    [billNo]
  );

  // Group into one entry per warehouse, attaching the suggested branch.
  return groupRemainingItemsByWarehouse(rows);
}

// Web dispatch scope. A user may be scoped to a SET of transport branches:
// `branch_codes` (the multi-branch dispatch assignment) wins, else the legacy
// single `logistic_code`. 02-0004 (customer self-pickup) is never a real scope.
//   scope.branches      — array of branch codes (may be 1 or many)
//   scope.branch        — branches[0], kept for callers that need a single value
//   scope.branchListSql — quoted, comma-joined list for `IN (...)` clauses
function getBranchScope(session) {
  const raw = (session?.branch_codes ?? session?.logistic_code ?? "").trim();
  const branches = raw
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c && c !== "02-0004");
  const scoped = branches.length > 0;
  const branchListSql = branches.map((c) => `'${c.replace(/'/g, "''")}'`).join(", ");
  return {
    scoped,
    branches,
    branch: scoped ? branches[0] : "",
    branchListSql,
    branchOrNull: scoped ? branches[0] : null,
  };
}

function branchFilterShipment(scope, alias = "") {
  if (!scope.scoped) return "";
  const prefix = alias ? `${alias}.` : "";
  return `AND ${prefix}transport_code IN (${scope.branchListSql})`;
}

function branchFilterJob(scope, jobAlias) {
  if (!scope.scoped) return "";
  return `AND (
    ${jobAlias}.origin_transport_code IN (${scope.branchListSql})
    OR (
      ${jobAlias}.origin_transport_code IS NULL
      AND EXISTS (
        SELECT 1 FROM public.odg_tms_detail __dd
        JOIN public.ic_trans_shipment __ss ON __ss.doc_no = __dd.bill_no
        WHERE __dd.doc_no = ${jobAlias}.doc_no
          AND __ss.transport_code IN (${scope.branchListSql})
      )
    )
  )`;
}

// ຈຸດຮັບເຄື່ອງທີ່ໃຊ້ຈິງ — SQL for "where does the driver collect this bill".
//
// Priority:
//   1. odg_tms_detail.pickup_transport_code — the per-bill override the
//      dispatcher set on the trip (includes the '__CUSTOMER__' sentinel).
//   2. odg_tms_pending_bill.transport_code — the branch the dispatcher assigned
//      when scheduling. This is what the bills-pending screen shows.
//   3. ic_trans_shipment.transport_code — the raw ERP value, LAST because it is
//      frequently a pseudo-branch that describes a handover MODE rather than a
//      warehouse (02-0004 ລູກຄ້າຮັບເອງ, 02-0006 ຊ່າງໂອດ່ຽນມາເອົາເອງ,
//      02-0008 ສົ່ງແລ້ວແຕ່ບໍ່ໄດ້ຈັດຖ້ຽວ). Treating those as a pickup point made
//      the trip page and the pending page disagree, and made the driver app
//      refuse the pickup as "ບິນສາຂາອື່ນ".
//
// alias = the odg_tms_detail alias in the surrounding query (needs .bill_no).
function effectivePickupCodeSql(alias = "d") {
  return `COALESCE(
    NULLIF(TRIM(${alias}.pickup_transport_code), ''),
    (SELECT NULLIF(TRIM(pbx.transport_code), '')
     FROM public.odg_tms_pending_bill pbx WHERE pbx.bill_no = ${alias}.bill_no),
    (SELECT NULLIF(TRIM(sx.transport_code), '')
     FROM public.ic_trans_shipment sx WHERE sx.doc_no = ${alias}.bill_no LIMIT 1),
    ''
  )`;
}

// ບ້ານ · ເມືອງ · ແຂວງ of a customer, as one display string.
//
// ar_customer stores these as CODES (tambon '0101001', amper '0101', province
// '01'), so the names have to come from the ERP master tables. Written as a
// self-contained scalar subquery: any bill query can select it by passing its
// customer-code column, with no extra joins to thread through.
//
// custCodeExpr = SQL expression for the customer code (e.g. "d.cust_code").
// Empty string when the customer has no area codes filled in — ~97% of
// customers used on trips this year resolve to at least one level.
function customerAreaSql(custCodeExpr) {
  return `COALESCE((
    SELECT NULLIF(CONCAT_WS(' · ',
      NULLIF(TRIM(tbx.name_1), ''),
      NULLIF(TRIM(amx.name_1), ''),
      NULLIF(TRIM(pvx.name_1), '')
    ), '')
    FROM ar_customer cx
    LEFT JOIN erp_tambon tbx ON tbx.code = NULLIF(TRIM(cx.tambon), '')
    LEFT JOIN erp_amper amx ON amx.code = NULLIF(TRIM(cx.amper), '')
    LEFT JOIN erp_province pvx ON pvx.code = NULLIF(TRIM(cx.province), '')
    WHERE cx.code = ${custCodeExpr}
    LIMIT 1
  ), '')`;
}

// Same three levels as customerAreaSql, but for queries that ALREADY join
// ar_customer: plain joins on the indexed code columns, no correlated
// subquery, and the parts come back separately so the UI can filter by
// ແຂວງ / ເມືອງ instead of only displaying the combined string.
//
// custAlias = the ar_customer alias in the surrounding query.
function customerAreaJoins(custAlias = "cust") {
  return `
    LEFT JOIN erp_tambon arx_tb ON arx_tb.code = NULLIF(TRIM(${custAlias}.tambon), '')
    LEFT JOIN erp_amper arx_am ON arx_am.code = NULLIF(TRIM(${custAlias}.amper), '')
    LEFT JOIN erp_province arx_pv ON arx_pv.code = NULLIF(TRIM(${custAlias}.province), '')`;
}

// SELECT list to pair with customerAreaJoins(): the display string plus each
// level on its own, so the page can build ແຂວງ / ເມືອງ dropdowns from the rows
// it already has.
function customerAreaFields() {
  return `
    COALESCE(NULLIF(CONCAT_WS(' · ',
      NULLIF(TRIM(arx_tb.name_1), ''),
      NULLIF(TRIM(arx_am.name_1), ''),
      NULLIF(TRIM(arx_pv.name_1), '')
    ), ''), '') as cust_area,
    COALESCE(NULLIF(TRIM(arx_tb.name_1), ''), '') as cust_village,
    COALESCE(NULLIF(TRIM(arx_am.name_1), ''), '') as cust_district,
    COALESCE(NULLIF(TRIM(arx_pv.name_1), ''), '') as cust_province`;
}

// ເວລາເປີດບິນຂາຍແທ້ (ເວລາລາວ).
//
// ⚠️ ຢ່າໃຊ້ ic_trans / ic_trans_shipment.create_date_time_now ເປັນເວລາເປີດບິນ:
// ERP ຂຽນຄໍລຳນັ້ນເປັນ UTC — ວັດຈາກຖານຂໍ້ມູນຈິງ (2026-08-05, ບິນແຕ່ 01-07-2026):
// ic_trans_shipment 3,975 ໃບ ຫ່າງຈາກ doc_time ພໍດີ 7 ຊົ່ວໂມງ ແລະ ຊົ່ວໂມງທີ່ບັນທຶກ
// ກະຈຸກຢູ່ 01:00–10:00 ແລ້ວຫາຍໄປຫຼັງ 11:00 (= 08:00–17:00 ເວລາລາວ). ຜົນຄື
// ບິນ INHPB26010788 ທີ່ເປີດ 14:46 ຂຶ້ນຈໍວ່າ 07:46 ແລະ ອາຍຸບິນເກີນຈິງ 7 ຊົ່ວໂມງ.
//
// doc_date + doc_time ຂອງ ic_trans ເປັນເວລາລາວທີ່ພະນັກງານຂາຍເປີດບິນ, ຄືກັບທີ່
// ພິມໃສ່ໜ້າບິນ ແລະ ມີຄົບ 82,803/82,869 ໃບ (99.9%) ຂອງປີ 2026 — tv-dashboard.js
// ໃຊ້ຄູ່ນີ້ຢູ່ກ່ອນແລ້ວດ້ວຍເຫດຜົນດຽວກັນ.
//
// icAlias = alias ຂອງ ic_trans ໃນ query (ຕ້ອງມີ .doc_date ແລະ .doc_time)
// fallbackSql = ໃຊ້ເມື່ອບໍ່ມີແຖວ ic_trans ເລີຍ (ເຊັ່ນ LEFT JOIN ບໍ່ຕິດ)
function billOpenedAtSql(icAlias, fallbackSql = "NULL::timestamp") {
  return `(CASE
    WHEN ${icAlias}.doc_time ~ '^[0-9]{1,2}:[0-9]{2}'
      THEN ${icAlias}.doc_date + ${icAlias}.doc_time::time
    WHEN ${icAlias}.doc_date IS NOT NULL THEN ${icAlias}.doc_date::timestamp
    ELSE ${fallbackSql}
  END)`;
}

module.exports = {
  invalidateRemainingSummary,
  invalidatePendingList,
  readPendingListCache,
  writePendingListCache,
  customerAreaJoins,
  customerAreaFields,
  customerAreaSql,
  billOpenedAtSql,
  effectivePickupCodeSql,
  safeDdl,
  once,
  formatInterval,
  getNextMonthStart,
  toDisplayDate,
  toDisplayMonth,
  ensureForwardBranchColumn,
  ensureJobListIndexes,
  ensureTmsWorkerTable,
  ensurePendingJobListIndex,
  ensureTmsDetailItemTable,
  getRemainingBillProducts,
  getRemainingBillProductsMap,
  getBillsWithErpDetail,
  getRemainingSummaryMap,
  getBillItemsByWarehouse,
  getBillRemainingItemsByWarehouse,
  suggestTransportForBranchStock,
  getBranchScope,
  branchFilterShipment,
  branchFilterJob,
};
