const { pool, query, queryOne } = require("../lib/db");
const { getFixedYearSqlFilter } = require("../lib/fixed-year");
const {
  getBranchScope,
  customerAreaJoins,
  customerAreaFields,
  getRemainingBillProductsMap,
} = require("./helpers");
const { ensurePendingBillSchema } = require("./pending-bill");

// ຮ່າງຖ້ຽວ — the planning stage that comes BEFORE a real trip exists.
//
// The dispatcher's day is ວັນ × ຮອບ × ສາຍ: one draft per combination, bills
// dragged into it as orders come in, and only when it is time to leave does
// anyone pick a car, a driver and workers. odg_tms cannot model that — it
// requires a driver, and every approval / driver-app / dashboard query reads
// it — so drafts live in their own two tables and are converted into a real
// trip (via the untouched createJob) at the moment they are dispatched.
//
// Draft → ພ້ອມອອກ = createJob(...) + delete the draft. Nothing downstream needs
// to know drafts exist.

const draftCache = globalThis;

async function safeDdl(db, sql) {
  try {
    await db.query(sql);
  } catch (err) {
    const msg = String(err?.message ?? "");
    if (err?.code === "23505" || /already exists/i.test(msg)) return;
    throw err;
  }
}

async function ensureTripDraftSchemaInternal(db) {
  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_trip_draft (
      draft_id BIGSERIAL PRIMARY KEY,
      doc_date date NOT NULL,
      date_logistic date NOT NULL,
      origin_transport_code character varying,
      delivery_route_code character varying,
      delivery_round_code character varying,
      remark text,
      -- Crew is optional until "ພ້ອມອອກ"; kept here so a dispatcher can
      -- pencil in a driver early without committing the trip.
      car character varying,
      driver character varying,
      workers text,
      created_by character varying,
      created_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0),
      updated_by character varying,
      updated_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_trip_draft_day
    ON public.odg_tms_trip_draft (date_logistic, origin_transport_code)
  `);
  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_trip_draft_bill (
      draft_id bigint NOT NULL REFERENCES public.odg_tms_trip_draft(draft_id) ON DELETE CASCADE,
      bill_no character varying NOT NULL,
      -- Per-bill choices the dispatcher makes while planning; passed straight
      -- to createJob when the draft goes out.
      delivery_condition character varying,
      forward_transport_code character varying,
      pickup_transport_code character varying,
      -- What the dispatcher picked in the item modal: [{item_code, item_name,
      -- qty, unit_code}]. Empty array = "whole bill", which createJob resolves
      -- to every remaining item at dispatch time.
      items jsonb NOT NULL DEFAULT '[]'::jsonb,
      added_by character varying,
      added_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0),
      PRIMARY KEY (draft_id, bill_no)
    )
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_trip_draft_bill
    ADD COLUMN IF NOT EXISTS items jsonb NOT NULL DEFAULT '[]'::jsonb
  `);
  // A bill may only sit in one draft at a time — otherwise two drafts would
  // both "own" it and the second dispatch would fail on remaining qty.
  await safeDdl(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_odg_tms_trip_draft_bill_unique
    ON public.odg_tms_trip_draft_bill (bill_no)
  `);
}

const TRIP_DRAFT_SCHEMA_VERSION = "v2_items";

async function ensureTripDraftSchema() {
  const key = `__tmsTripDraftSchema_${TRIP_DRAFT_SCHEMA_VERSION}`;
  if (draftCache[key]) return;
  if (!draftCache[`${key}_p`]) {
    draftCache[`${key}_p`] = ensureTripDraftSchemaInternal(pool)
      .then(() => {
        draftCache[key] = true;
      })
      .catch((err) => {
        draftCache[`${key}_p`] = null;
        throw err;
      });
  }
  await draftCache[`${key}_p`];
}

function branchFilterDraft(scope) {
  if (!scope.scoped) return "";
  return `AND COALESCE(NULLIF(TRIM(d.origin_transport_code), ''), '') IN (${scope.branchListSql})`;
}

// Drafts, ordered the way the work runs: ວັນ → ຮອບ → ສາຍ.
//
// A draft exists only until it goes out (ພ້ອມອອກ deletes it), so every row
// here is outstanding work. Calling with NO dates returns all of them — that
// is the default view, because a draft left behind on an earlier day is
// exactly what must not disappear from sight. Passing dates narrows to a
// range; passing one date lists that single day.
async function listTripDrafts(session, dateFrom, dateTo) {
  await ensureTripDraftSchema();
  const scope = getBranchScope(session);
  const from = String(dateFrom ?? "").trim();
  const to = String(dateTo ?? "").trim() || from;
  const dayClause = from ? "AND d.date_logistic BETWEEN $1::date AND $2::date" : "";
  const params = from ? [from, to] : [];
  const rows = await query(
    `SELECT d.draft_id,
            to_char(d.date_logistic,'YYYY-MM-DD') AS date_logistic,
            to_char(d.date_logistic,'DD-MM-YYYY') AS date_logistic_display,
            COALESCE(d.origin_transport_code, '') AS origin_transport_code,
            COALESCE(NULLIF(TRIM(tt.name_1), ''), d.origin_transport_code, '') AS origin_transport_name,
            COALESCE(d.delivery_route_code, '') AS delivery_route_code,
            COALESCE(NULLIF(TRIM(rt.name), ''), d.delivery_route_code, '') AS delivery_route_name,
            COALESCE(d.delivery_round_code, '') AS delivery_round_code,
            COALESCE(NULLIF(TRIM(dr.name), ''), d.delivery_round_code, '') AS delivery_round_name,
            COALESCE(dr.time_label, '') AS delivery_round_time,
            COALESCE(d.car, '') AS car,
            COALESCE(NULLIF(TRIM(carT.name_1), ''), d.car, '') AS car_name,
            COALESCE(d.driver, '') AS driver,
            COALESCE(NULLIF(TRIM(drvT.name_1), ''), d.driver, '') AS driver_name,
            COALESCE(d.workers, '') AS workers,
            COALESCE(d.remark, '') AS remark,
            COALESCE(NULLIF(TRIM(u.name_1), ''), d.created_by, '') AS created_by_name,
            to_char(d.created_at,'DD-MM-YYYY HH24:MI') AS created_at,
            (SELECT COUNT(*) FROM public.odg_tms_trip_draft_bill b
             WHERE b.draft_id = d.draft_id)::int AS bill_count
     FROM public.odg_tms_trip_draft d
     LEFT JOIN transport_type tt ON tt.code = d.origin_transport_code
     LEFT JOIN public.odg_tms_delivery_route rt ON rt.code = d.delivery_route_code
     LEFT JOIN public.odg_tms_delivery_round dr ON dr.code = d.delivery_round_code
     LEFT JOIN public.odg_tms_car carT ON carT.code = d.car
     LEFT JOIN public.odg_tms_driver drvT ON drvT.code = d.driver
     LEFT JOIN erp_user u ON u.code = d.created_by
     WHERE 1=1
       ${dayClause}
       ${branchFilterDraft(scope)}
     ORDER BY d.date_logistic, dr.time_label NULLS LAST,
              d.delivery_round_code, d.delivery_route_code, d.draft_id`,
    params
  );
  return rows;
}

// The bills sitting in one draft, with what the trip page needs to show them.
async function getTripDraftBills(draftId) {
  await ensureTripDraftSchema();
  await ensurePendingBillSchema();
  const id = Number(draftId);
  if (!Number.isFinite(id)) return [];
  return query(
    `SELECT b.bill_no AS doc_no,
            to_char(t.doc_date,'DD-MM-YYYY') AS doc_date,
            a.cust_code,
            COALESCE(NULLIF(TRIM(c.name_1), ''), a.cust_code, '') AS cust_name,
            COALESCE(c.telephone, '') AS telephone,
            ${customerAreaFields()},
            COALESCE(b.delivery_condition, 'to_customer') AS delivery_condition,
            COALESCE(b.forward_transport_code, '') AS forward_transport_code,
            COALESCE(b.pickup_transport_code, '') AS pickup_transport_code,
            COALESCE(b.items, '[]'::jsonb) AS items,
            (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(b.items, '[]'::jsonb)))::int AS picked_item_count,
            COALESCE((SELECT SUM((e->>'qty')::numeric)
                      FROM jsonb_array_elements(COALESCE(b.items, '[]'::jsonb)) e), 0)::numeric AS picked_qty,
            (SELECT COUNT(item_code) FROM ic_trans_detail x
             WHERE x.doc_no = b.bill_no AND x.item_code NOT LIKE '97%')::int AS count_item
     FROM public.odg_tms_trip_draft_bill b
     LEFT JOIN ic_trans_shipment a ON a.doc_no = b.bill_no
     LEFT JOIN ic_trans t ON t.doc_no = b.bill_no
     LEFT JOIN ar_customer c ON c.code = a.cust_code${customerAreaJoins('c')}
     WHERE b.draft_id = $1
     ORDER BY b.added_at, b.bill_no`,
    [id]
  );
}

async function createTripDraft(session, input) {
  await ensureTripDraftSchema();
  const {
    dateLogistic,
    originTransportCode,
    deliveryRouteCode,
    deliveryRoundCode,
    car,
    remark,
  } = input || {};
  const day = String(dateLogistic ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("ກະລຸນາເລືອກວັນທີຈັດສົ່ງ");
  const round = String(deliveryRoundCode ?? "").trim();
  const route = String(deliveryRouteCode ?? "").trim();
  const branch = String(originTransportCode ?? "").trim();
  const carCode = String(car ?? "").trim();
  if (!round) throw new Error("ກະລຸນາເລືອກຮອບຈັດສົ່ງ");
  if (!route) throw new Error("ກະລຸນາເລືອກສາຍຈັດສົ່ງ");
  // Required up front: the branch owns the trip, and leaving it blank pushed
  // the problem to dispatch time where createJob simply refused.
  if (!branch) throw new Error("ກະລຸນາເລືອກສາຂາຂົນສົ່ງ");
  // ລົດຕ້ອງມີແຕ່ຕົ້ນ: ບໍ່ມີລົດ = ບໍ່ຮູ້ຄວາມຈຸ = ບອກບໍ່ໄດ້ວ່າຖ້ຽວເຕັມຫຼືຍັງ
  // ເຊິ່ງເປັນເຫດຜົນຫຼັກຂອງການວາງແຜນລ່ວງໜ້າ. ປ່ຽນລົດພາຍຫຼັງໄດ້.
  if (!carCode) throw new Error("ກະລຸນາເລືອກລົດ — ຕ້ອງມີຈຶ່ງຄິດພື້ນທີ່ບັນທຸກໄດ້");

  const row = await queryOne(
    `INSERT INTO public.odg_tms_trip_draft
       (doc_date, date_logistic, origin_transport_code, delivery_route_code,
        delivery_round_code, car, remark, created_by, updated_by)
     VALUES ($1::date, $1::date, $2, $3, $4, $5, $6, $7, $7)
     RETURNING draft_id`,
    [
      day,
      branch,
      route,
      round,
      carCode,
      String(remark ?? "").trim() || null,
      session?.usercode ?? null,
    ]
  );
  return { success: true, draft_id: Number(row?.draft_id) };
}

// Crew + remark can be filled in at any point; nothing here commits the trip.
async function updateTripDraft(session, draftId, patch) {
  await ensureTripDraftSchema();
  const id = Number(draftId);
  if (!Number.isFinite(id)) throw new Error("draft_id is required");
  const sets = [];
  const params = [];
  const put = (col, value) => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };
  if ("car" in (patch || {})) put("car", String(patch.car ?? "").trim() || null);
  if ("driver" in (patch || {})) put("driver", String(patch.driver ?? "").trim() || null);
  if ("workers" in (patch || {})) {
    const list = Array.isArray(patch.workers) ? patch.workers : [];
    put("workers", list.filter(Boolean).join(",") || null);
  }
  if ("remark" in (patch || {})) put("remark", String(patch.remark ?? "").trim() || null);
  if ("deliveryRouteCode" in (patch || {})) {
    put("delivery_route_code", String(patch.deliveryRouteCode ?? "").trim() || null);
  }
  if ("deliveryRoundCode" in (patch || {})) {
    put("delivery_round_code", String(patch.deliveryRoundCode ?? "").trim() || null);
  }
  if ("originTransportCode" in (patch || {})) {
    put("origin_transport_code", String(patch.originTransportCode ?? "").trim() || null);
  }
  if (sets.length === 0) return { success: true, updated: 0 };
  put("updated_by", session?.usercode ?? null);
  sets.push("updated_at = LOCALTIMESTAMP(0)");
  params.push(id);
  const result = await pool.query(
    `UPDATE public.odg_tms_trip_draft SET ${sets.join(", ")} WHERE draft_id = $${params.length}`,
    params
  );
  return { success: true, updated: result.rowCount ?? 0 };
}

async function deleteTripDraft(session, draftId) {
  await ensureTripDraftSchema();
  const id = Number(draftId);
  if (!Number.isFinite(id)) throw new Error("draft_id is required");
  const result = await pool.query(
    `DELETE FROM public.odg_tms_trip_draft WHERE draft_id = $1`,
    [id]
  );
  return { success: true, deleted: result.rowCount ?? 0 };
}

// Drag a bill into a draft. The unique index on bill_no is what stops the same
// bill being planned into two drafts; surface that as a readable message.
// items (optional) = the per-bill selection from the modal. Passing a single
// bill with items is the drag-and-drop path; passing several with none is the
// bulk path, and those default to the whole bill.
async function addBillsToTripDraft(session, draftId, billNos, items) {
  await ensureTripDraftSchema();
  const id = Number(draftId);
  if (!Number.isFinite(id)) throw new Error("draft_id is required");
  const codes = (Array.isArray(billNos) ? billNos : [billNos])
    .map((b) => String(b ?? "").trim())
    .filter(Boolean);
  if (codes.length === 0) return { success: true, added: 0 };

  const clash = await query(
    `SELECT b.bill_no, b.draft_id FROM public.odg_tms_trip_draft_bill b
     WHERE b.bill_no = ANY($1::varchar[]) AND b.draft_id <> $2`,
    [codes, id]
  );
  if (clash.length > 0) {
    throw new Error(
      `ບິນ ${clash.map((c) => c.bill_no).join(", ")} ຢູ່ໃນຮ່າງຖ້ຽວອື່ນແລ້ວ`
    );
  }
  const picked = Array.isArray(items)
    ? items
        .map((it) => ({
          item_code: String(it?.item_code ?? "").trim(),
          item_name: String(it?.item_name ?? "").trim(),
          qty: Number(it?.qty ?? 0),
          unit_code: String(it?.unit_code ?? "").trim(),
        }))
        .filter((it) => it.item_code && it.qty > 0)
    : [];
  const result = await pool.query(
    `INSERT INTO public.odg_tms_trip_draft_bill (draft_id, bill_no, items, added_by)
     SELECT $1, b.bill_no, $4::jsonb, $3 FROM unnest($2::varchar[]) AS b(bill_no)
     ON CONFLICT (draft_id, bill_no) DO UPDATE SET items = EXCLUDED.items`,
    [id, codes, session?.usercode ?? null, JSON.stringify(picked)]
  );
  return { success: true, added: result.rowCount ?? 0 };
}

async function removeBillFromTripDraft(draftId, billNo) {
  await ensureTripDraftSchema();
  const id = Number(draftId);
  const code = String(billNo ?? "").trim();
  if (!Number.isFinite(id) || !code) throw new Error("draft_id ແລະ bill_no ຈຳເປັນ");
  const result = await pool.query(
    `DELETE FROM public.odg_tms_trip_draft_bill WHERE draft_id = $1 AND bill_no = $2`,
    [id, code]
  );
  return { success: true, removed: result.rowCount ?? 0 };
}

async function setTripDraftBillOptions(draftId, billNo, options) {
  await ensureTripDraftSchema();
  const id = Number(draftId);
  const code = String(billNo ?? "").trim();
  if (!Number.isFinite(id) || !code) throw new Error("draft_id ແລະ bill_no ຈຳເປັນ");
  await pool.query(
    `UPDATE public.odg_tms_trip_draft_bill
     SET delivery_condition = COALESCE($3, delivery_condition),
         forward_transport_code = $4,
         pickup_transport_code = $5
     WHERE draft_id = $1 AND bill_no = $2`,
    [
      id,
      code,
      String(options?.deliveryCondition ?? "").trim() || null,
      String(options?.forwardTransportCode ?? "").trim() || null,
      String(options?.pickupTransportCode ?? "").trim() || null,
    ]
  );
  return { success: true };
}

// ພ້ອມອອກ — hand the draft to the existing createJob and drop it. Everything
// downstream (approval, driver app, reports) sees a perfectly ordinary trip;
// the draft stage leaves no trace in odg_tms.
async function dispatchTripDraft(session, draftId, crew) {
  await ensureTripDraftSchema();
  const { createJob } = require("./jobs");
  const id = Number(draftId);
  if (!Number.isFinite(id)) throw new Error("draft_id is required");

  const draft = await queryOne(
    `SELECT draft_id, to_char(date_logistic,'YYYY-MM-DD') AS date_logistic,
            COALESCE(origin_transport_code, '') AS origin_transport_code,
            COALESCE(delivery_route_code, '') AS delivery_route_code,
            COALESCE(delivery_round_code, '') AS delivery_round_code,
            COALESCE(car, '') AS car, COALESCE(driver, '') AS driver,
            COALESCE(workers, '') AS workers
     FROM public.odg_tms_trip_draft WHERE draft_id = $1`,
    [id]
  );
  if (!draft) throw new Error("ບໍ່ພົບຮ່າງຖ້ຽວນີ້");

  // A draft can be started before anyone decides which branch runs it ("ທຸກສາຂາ"
  // at creation time), but createJob requires one. Derive it from the bills
  // themselves — their assigned branch, else the branch that holds the goods —
  // and only complain when even that is unknown.
  let originBranch = String(draft.origin_transport_code ?? "").trim();
  if (!originBranch) {
    const guess = await queryOne(
      `SELECT COALESCE(NULLIF(TRIM(pb.transport_code), ''), NULLIF(TRIM(s.transport_code), '')) AS code,
              COUNT(*)::int AS n
       FROM public.odg_tms_trip_draft_bill b
       LEFT JOIN public.odg_tms_pending_bill pb ON pb.bill_no = b.bill_no
       LEFT JOIN ic_trans_shipment s ON s.doc_no = b.bill_no
       WHERE b.draft_id = $1
         AND COALESCE(NULLIF(TRIM(pb.transport_code), ''), NULLIF(TRIM(s.transport_code), '')) IS NOT NULL
       GROUP BY 1
       ORDER BY n DESC
       LIMIT 1`,
      [id]
    );
    originBranch = String(guess?.code ?? "").trim();
    if (originBranch) {
      // Remember it so the card stops showing a blank branch.
      await pool.query(
        `UPDATE public.odg_tms_trip_draft SET origin_transport_code = $2 WHERE draft_id = $1`,
        [id, originBranch]
      );
    }
  }
  if (!originBranch) {
    throw new Error("ຮ່າງນີ້ຍັງບໍ່ມີສາຂາຂົນສົ່ງ — ເລືອກສາຂາໃນຮ່າງກ່ອນ");
  }
  // Trips may only belong to a real delivery branch; a pseudo-branch such as
  // 02-0004 (ລູກຄ້າຮັບເອງ) would be rejected deeper in createJob with a much
  // vaguer message.
  const DELIVERY_BRANCHES = ["02-0001", "02-0002", "02-0003"];
  if (!DELIVERY_BRANCHES.includes(originBranch)) {
    const name = await queryOne(
      `SELECT COALESCE(NULLIF(TRIM(name_1), ''), code) AS name FROM transport_type WHERE code = $1`,
      [originBranch]
    ).catch(() => null);
    throw new Error(
      `ສາຂາ "${name?.name ?? originBranch}" ບໍ່ແມ່ນສາຂາຂົນສົ່ງທີ່ອອກຖ້ຽວໄດ້ — ເລືອກສາຂາໃນຮ່າງໃໝ່`
    );
  }

  const car = String(crew?.car ?? draft.car ?? "").trim();
  const driver = String(crew?.driver ?? draft.driver ?? "").trim();
  const workers = Array.isArray(crew?.workers)
    ? crew.workers.filter(Boolean)
    : String(draft.workers ?? "").split(",").map((w) => w.trim()).filter(Boolean);
  if (!car) throw new Error("ກະລຸນາເລືອກລົດກ່ອນປ່ຽນເປັນພ້ອມອອກ");
  if (!driver) throw new Error("ກະລຸນາເລືອກຄົນຂັບກ່ອນປ່ຽນເປັນພ້ອມອອກ");

  const draftBills = await query(
    `SELECT b.bill_no,
            COALESCE(b.delivery_condition, 'to_customer') AS delivery_condition,
            NULLIF(TRIM(b.forward_transport_code), '') AS forward_transport_code,
            NULLIF(TRIM(b.pickup_transport_code), '') AS pickup_transport_code,
            COALESCE(b.items, '[]'::jsonb) AS items,
            -- createJob copies these onto odg_tms_detail verbatim; sending only
            -- the bill number left the customer blank on every downstream
            -- screen (tracking, driver app, ໃບງານ).
            COALESCE(s.cust_code, t.cust_code, '') AS cust_code,
            to_char(COALESCE(t.doc_date, s.doc_date),'YYYY-MM-DD') AS bill_date,
            COALESCE(NULLIF(TRIM(c.telephone), ''), '') AS telephone,
            (SELECT COUNT(item_code) FROM ic_trans_detail x
             WHERE x.doc_no = b.bill_no AND x.item_code NOT LIKE '97%')::int AS count_item,
            COALESCE(NULLIF(TRIM(d2.parent_bill_no), ''), NULL) AS parent_bill_no
     FROM public.odg_tms_trip_draft_bill b
     LEFT JOIN ic_trans_shipment s ON s.doc_no = b.bill_no
     LEFT JOIN ic_trans t ON t.doc_no = b.bill_no
     LEFT JOIN ar_customer c ON c.code = COALESCE(s.cust_code, t.cust_code)
     LEFT JOIN LATERAL (
       SELECT parent_bill_no FROM public.odg_tms_detail
       WHERE bill_no = b.bill_no AND parent_bill_no IS NOT NULL LIMIT 1
     ) d2 ON true
     WHERE b.draft_id = $1 ORDER BY b.added_at, b.bill_no`,
    [id]
  );
  if (draftBills.length === 0) throw new Error("ຮ່າງຖ້ຽວນີ້ຍັງບໍ່ມີບິນ");

  // createJob validates each bill's remaining quantity itself, so pass the
  // bills through and let it own that logic (and the ic_trans_shipment /
  // pending-bill bookkeeping).
  const result = await createJob(session, {
    doc_date: draft.date_logistic,
    date_log: draft.date_logistic,
    car,
    driver,
    workers,
    // createJob reads the trip's branch from forward_transport_code (at JOB
    // level that field means "which branch runs this trip"; only at BILL level
    // does it mean forward-to-branch). Sending origin_transport_code left it
    // blank and the save failed with "ກະລຸນາເລືອກສາຂາຂົນສົ່ງ".
    forward_transport_code: originBranch,
    origin_transport_code: originBranch,
    delivery_route_code: draft.delivery_route_code || undefined,
    delivery_round_code: draft.delivery_round_code || undefined,
    bills: draftBills.map((b) => ({
      bill_no: b.bill_no,
      cust_code: b.cust_code,
      bill_date: b.bill_date,
      telephone: b.telephone,
      count_item: b.count_item,
      parent_bill_no: b.parent_bill_no,
      delivery_condition: b.delivery_condition,
      forward_transport_code: b.forward_transport_code,
      pickup_transport_code: b.pickup_transport_code,
      // [] means "everything still owed" — createJob fills that in from the
      // bill's remaining products.
      items: Array.isArray(b.items) ? b.items : [],
    })),
  });

  await pool.query(`DELETE FROM public.odg_tms_trip_draft WHERE draft_id = $1`, [id]);
  return { success: true, ...result };
}

// Bills waiting to be put on a trip — the SAME pool as the ລໍຖ້າຈັດຖ້ຽວ page:
// sale bills not yet on a trip (trans_flag 44, check_status 0), due on or
// before the draft's day by the salesperson's ວັນສົ່ງ (falling back to the
// document date, exactly as bills-pending does). Requiring a scheduled_date
// here would have hidden most of them, since scheduling is what the draft is
// for.
//
// has_send_date splits the two tabs the dispatcher works from: bills the
// salesperson gave a delivery date for, and bills they did not — the latter
// need a decision before they can be planned.
async function getTripDraftCandidates(session, dateLogistic, transportCode) {
  await ensureTripDraftSchema();
  await ensurePendingBillSchema();
  const scope = getBranchScope(session);
  const branch = String(transportCode ?? "").trim();
  const day = String(dateLogistic ?? "").trim();
  const params = [day];
  let branchClause = "";
  if (branch) {
    params.push(branch);
    branchClause = `AND COALESCE(NULLIF(TRIM(pb.transport_code), ''), a.transport_code, '') = $${params.length}`;
  } else if (scope.scoped) {
    branchClause = `AND COALESCE(NULLIF(TRIM(pb.transport_code), ''), a.transport_code, '') IN (${scope.branchListSql})`;
  }
  return query(
    `SELECT a.doc_no,
            to_char(t.doc_date,'DD-MM-YYYY') AS doc_date,
            a.cust_code,
            COALESCE(NULLIF(TRIM(c.name_1), ''), a.cust_code, '') AS cust_name,
            COALESCE(c.telephone, '') AS telephone,
            ${customerAreaFields()},
            COALESCE(pb.delivery_route_code, '') AS delivery_route_code,
            COALESCE(pb.delivery_round_code, '') AS delivery_round_code,
            (t.send_date IS NOT NULL) AS has_send_date,
            to_char(COALESCE(t.send_date, pb.scheduled_date),'DD-MM-YYYY') AS send_date_display,
            to_char(pb.scheduled_date,'DD-MM-YYYY') AS scheduled_date_display,
            (COALESCE(t.send_date::date, t.doc_date::date) < $1::date) AS overdue,
            COALESCE(NULLIF(TRIM(oe.fullname_lo), ''), NULLIF(TRIM(oe.nickname), ''), t.sale_code, '') AS sale,
            (SELECT COUNT(item_code) FROM ic_trans_detail x
             WHERE x.doc_no = a.doc_no AND x.item_code NOT LIKE '97%')::int AS count_item
     FROM ic_trans_shipment a
     JOIN ic_trans t ON t.doc_no = a.doc_no
     LEFT JOIN ar_customer c ON c.code = a.cust_code${customerAreaJoins('c')}
     LEFT JOIN public.odg_tms_pending_bill pb ON pb.bill_no = a.doc_no
     LEFT JOIN public.odg_employee oe ON oe.employee_code = t.sale_code
     WHERE a.trans_flag = 44
       AND a.check_status = 0
       AND ${getFixedYearSqlFilter("a.doc_date")}
       AND COALESCE(t.send_date::date, t.doc_date::date) <= $1::date
       ${branchClause}
       AND NOT EXISTS (SELECT 1 FROM public.odg_tms_trip_draft_bill db WHERE db.bill_no = a.doc_no)
       AND NOT EXISTS (
         SELECT 1 FROM public.odg_tms_detail d
         WHERE d.bill_no = a.doc_no AND COALESCE(d.status, 0) NOT IN (1, 2)
       )
     ORDER BY COALESCE(t.send_date, t.doc_date), a.doc_no
     LIMIT 400`,
    params
  );
}

// Bill numbers already sitting in some draft — the pool must not offer them
// again. Cheap enough to send whole; the unique index keeps it one row per bill.
async function listDraftedBillNos() {
  await ensureTripDraftSchema();
  const rows = await query(`SELECT bill_no FROM public.odg_tms_trip_draft_bill`);
  return rows.map((r) => r.bill_no);
}

/**
 * ທຸກລາຍການສິນຄ້າທີ່ຖ້ຽວນີ້ຈະບັນທຸກ ພ້ອມລົດທີ່ຈະໃຊ້ — ໃຫ້ຊັ້ນຄິດພື້ນທີ່ໄປລວມຕໍ່.
 *
 * ບິນທີ່ dispatcher ເລືອກລາຍການໄວ້ແລ້ວ ໃຊ້ລາຍການນັ້ນ; ບິນທີ່ items ວ່າງ
 * ໝາຍ "ທັງບິນ" ເຊິ່ງ createJob ຈະແກ້ເປັນລາຍການທີ່ຍັງເຫຼືອຕອນສົ່ງອອກ — ຢູ່ນີ້
 * ຈຶ່ງຕ້ອງໃຊ້ getRemainingBillProductsMap ໃຫ້ຕົງກັນ ບໍ່ດັ່ງນັ້ນຕົວເລກທີ່
 * dispatcher ເຫັນຈະບໍ່ຕົງກັບຂອງທີ່ຂຶ້ນລົດຈິງ.
 */
async function getTripDraftLoad(draftId) {
  await ensureTripDraftSchema();
  const id = Number(draftId);
  if (!Number.isFinite(id)) return { car: "", items: [] };

  const draft = await queryOne(
    `SELECT COALESCE(car, '') AS car FROM public.odg_tms_trip_draft WHERE draft_id = $1`,
    [id]
  );
  const bills = await query(
    `SELECT bill_no, COALESCE(items, '[]'::jsonb) AS items
       FROM public.odg_tms_trip_draft_bill
      WHERE draft_id = $1
      ORDER BY added_at, bill_no`,
    [id]
  );

  const items = [];
  const wholeBills = [];
  for (const bill of bills) {
    const picked = Array.isArray(bill.items) ? bill.items : [];
    if (picked.length === 0) {
      wholeBills.push(bill.bill_no);
      continue;
    }
    for (const line of picked) {
      items.push({
        bill_no: bill.bill_no,
        item_code: String(line?.item_code ?? ""),
        item_name: line?.item_name ?? null,
        unit_code: line?.unit_code ?? null,
        qty: Number(line?.qty ?? 0),
      });
    }
  }

  if (wholeBills.length > 0) {
    const remaining = await getRemainingBillProductsMap(wholeBills);
    for (const billNo of wholeBills) {
      for (const line of remaining.get(billNo) ?? []) {
        items.push({
          bill_no: billNo,
          item_code: String(line?.item_code ?? ""),
          item_name: line?.item_name ?? null,
          unit_code: line?.unit_code ?? null,
          qty: Number(line?.qty ?? 0),
        });
      }
    }
  }

  return { car: draft?.car ?? "", items };
}

/**
 * ສິນຄ້າ + ລົດ ຂອງຫຼາຍຮ່າງພ້ອມກັນ — ໃຫ້ໜ້າຮ່າງຖ້ຽວໄດ້ພື້ນທີ່ບັນທຸກມາພ້ອມ
 * ລາຍການຮ່າງ ໂດຍບໍ່ຕ້ອງຍິງ action ຮອບສອງ (ບໍ່ມີສະຖານະ "ກຳລັງໂຫຼດ").
 */
/**
 * ຊື່ລູກຄ້າຕໍ່ບິນ ຂອງຫຼາຍຮ່າງພ້ອມກັນ — ໃຫ້ການແຈກແຈງ "ຕາມບິນ" ຕິດປ້າຍຊື່ໄດ້
 * ໂດຍບໍ່ຍິງ query ຕໍ່ຮ່າງ (N+1).
 */
async function getTripDraftBillNamesBulk(draftIds) {
  await ensureTripDraftSchema();
  const ids = Array.from(
    new Set((draftIds ?? []).map((n) => Number(n)).filter(Number.isFinite))
  );
  if (ids.length === 0) return new Map();
  const rows = await query(
    `SELECT b.draft_id, b.bill_no,
            COALESCE(NULLIF(TRIM(c.name_1), ''), a.cust_code, '') AS cust_name
       FROM public.odg_tms_trip_draft_bill b
       LEFT JOIN ic_trans_shipment a ON a.doc_no = b.bill_no
       LEFT JOIN ar_customer c ON c.code = a.cust_code
      WHERE b.draft_id = ANY($1::bigint[])`,
    [ids]
  );
  const byDraft = new Map();
  for (const row of rows) {
    const id = Number(row.draft_id);
    if (!byDraft.has(id)) byDraft.set(id, new Map());
    byDraft.get(id).set(String(row.bill_no), String(row.cust_name ?? ""));
  }
  return byDraft;
}

async function getTripDraftLoadsBulk(draftIds) {
  await ensureTripDraftSchema();
  const ids = Array.from(
    new Set((draftIds ?? []).map((n) => Number(n)).filter(Number.isFinite))
  );
  if (ids.length === 0) return { cars: new Map(), itemsByDraft: new Map() };

  const [heads, billRows] = await Promise.all([
    query(
      `SELECT draft_id, COALESCE(car, '') AS car
         FROM public.odg_tms_trip_draft WHERE draft_id = ANY($1::bigint[])`,
      [ids]
    ),
    query(
      `SELECT draft_id, bill_no, COALESCE(items, '[]'::jsonb) AS items
         FROM public.odg_tms_trip_draft_bill
        WHERE draft_id = ANY($1::bigint[])
        ORDER BY added_at, bill_no`,
      [ids]
    ),
  ]);

  const itemsByDraft = new Map(ids.map((id) => [id, []]));
  const wholeBills = [];
  const wholeOwner = new Map(); // bill_no → draft_id

  for (const row of billRows) {
    const draftId = Number(row.draft_id);
    const picked = Array.isArray(row.items) ? row.items : [];
    if (picked.length === 0) {
      wholeBills.push(row.bill_no);
      wholeOwner.set(row.bill_no, draftId);
      continue;
    }
    for (const line of picked) {
      itemsByDraft.get(draftId)?.push({
        bill_no: row.bill_no,
        item_code: String(line?.item_code ?? ""),
        item_name: line?.item_name ?? null,
        unit_code: line?.unit_code ?? null,
        qty: Number(line?.qty ?? 0),
      });
    }
  }

  // "ທັງບິນ" ຂອງທຸກຮ່າງ ດຶງເທື່ອດຽວ ບໍ່ແມ່ນຕໍ່ຮ່າງ
  if (wholeBills.length > 0) {
    const remaining = await getRemainingBillProductsMap(wholeBills);
    for (const [billNo, lines] of remaining) {
      const draftId = wholeOwner.get(billNo);
      if (draftId === undefined) continue;
      for (const line of lines ?? []) {
        itemsByDraft.get(draftId)?.push({
          bill_no: billNo,
          item_code: String(line?.item_code ?? ""),
          item_name: line?.item_name ?? null,
          unit_code: line?.unit_code ?? null,
          qty: Number(line?.qty ?? 0),
        });
      }
    }
  }

  return {
    cars: new Map(heads.map((h) => [Number(h.draft_id), String(h.car ?? "")])),
    itemsByDraft,
  };
}

module.exports = {
  ensureTripDraftSchema,
  listDraftedBillNos,
  listTripDrafts,
  getTripDraftBills,
  getTripDraftLoad,
  getTripDraftLoadsBulk,
  getTripDraftBillNamesBulk,
  getTripDraftCandidates,
  createTripDraft,
  updateTripDraft,
  deleteTripDraft,
  addBillsToTripDraft,
  removeBillFromTripDraft,
  setTripDraftBillOptions,
  dispatchTripDraft,
};
