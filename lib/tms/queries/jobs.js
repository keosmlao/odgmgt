const { pool, query, queryOne } = require("../lib/db");
const { ensureDeliveryWorkflowSchema } = require("./delivery");
const {
  coerceDateToFixedYear,
  getFixedTodayDate,
  getFixedYearSqlFilter,
} = require("../lib/fixed-year");
const {
  invalidateRemainingSummary,
  getBranchScope,
  branchFilterShipment,
  branchFilterJob,
  ensureForwardBranchColumn,
  ensureTmsWorkerTable,
  ensurePendingJobListIndex,
  ensureTmsDetailItemTable,
  getRemainingBillProductsMap,
  getBillsWithErpDetail,
  getRemainingSummaryMap,
  customerAreaSql,
} = require("./helpers");
const { pushToTopic } = require("./push");
const { notifyJobCreated, notifyJobCreatedToSales, notifyBillForwardedToBranch } = require("./notifications");
const { recordAudit } = require("./audit-log");
const { ensurePendingBillSchema } = require("./pending-bill");

// The three internal delivery branches a trip can belong to (origin_transport_code).
const DELIVERY_BRANCH_CODES = ["02-0001", "02-0002", "02-0003"];

function nextJobDocNoFromMax(maxDocNo, fixedMonth) {
  const pfx = fixedMonth.replace("-", "");
  if (!maxDocNo) return pfx + "00001";

  const current = String(maxDocNo);
  const suffix = Number.parseInt(current.slice(pfx.length), 10);
  if (!Number.isFinite(suffix)) return pfx + "00001";
  return pfx + String(suffix + 1).padStart(5, "0");
}

async function getNextJobDocNo(client, fixedDocDate) {
  const fixedMonth = fixedDocDate.slice(0, 7);
  const pfx = fixedMonth.replace("-", "");

  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`odg_tms_doc_no:${pfx}`]);
  const result = await client.query(
    `SELECT doc_no
     FROM public.odg_tms
     WHERE to_char(doc_date,'YYYY-MM')=$1
       AND doc_no ~ $2
     ORDER BY doc_no DESC
     LIMIT 1`,
    [fixedMonth, `^${pfx}[0-9]+$`]
  );

  return nextJobDocNoFromMax(result.rows[0]?.doc_no, fixedMonth);
}

async function getJobs(session) {
  await ensureTmsWorkerTable();
  await ensurePendingJobListIndex();
  await ensureForwardBranchColumn();
  const { ensureDeliveryRouteSchema } = require("./delivery-route");
  await ensureDeliveryRouteSchema();
  return query(
    `WITH worker_summary AS (
      SELECT doc_no, COUNT(*)::int AS worker_count,
        string_agg(worker_name, ', ' ORDER BY worker_name) AS workers
      FROM public.odg_tms_worker
      GROUP BY doc_no
    ),
    forward_summary AS (
      SELECT doc_no, MAX(forward_transport_code) AS forward_transport_code
      FROM public.odg_tms_detail
      WHERE forward_transport_code IS NOT NULL
        AND ${getFixedYearSqlFilter("doc_date")}
      GROUP BY doc_no
    ),
    bill_summary AS (
      SELECT doc_no,
        string_agg(DISTINCT bill_no, ', ' ORDER BY bill_no) AS bill_nos
      FROM public.odg_tms_detail
      WHERE ${getFixedYearSqlFilter("doc_date")}
      GROUP BY doc_no
    )
    SELECT
      to_char(a.doc_date,'DD-MM-YYYY') as doc_date, a.doc_no,
      to_char(a.date_logistic,'DD-MM-YYYY') as date_logistic,
      to_char(a.create_date_time_now,'DD-MM-YYYY HH24:MI') as created_at,
      b.name_1 as car, c.name_1 as driver, a.item_bill, d.name_1 as user_created,
      a.approve_status,
      case when a.approve_status=0 then 'ລໍຖ້າອະນຸມັດ'
        else case when a.job_status=0 then 'ລໍຖ້າຈັດສົ່ງ'
          when a.job_status=1 then 'ຮັບຖ້ຽວ / ເບີກເຄື່ອງ'
          when a.job_status=2 then 'ກຳລັງຈັດສົ່ງ'
          when a.job_status=3 then 'ຄົນຂັບປິດງານ'
          else 'admin ປິດຖ້ຽວ' end
      end as status,
      a.job_status,
      COALESCE(w.worker_count, 0) as worker_count,
      COALESCE(w.workers, '') as workers,
      COALESCE(fs.forward_transport_code, '') as forward_transport_code,
      COALESCE(ftt.name_1, '') as forward_transport_name,
      COALESCE(bs.bill_nos, '') as bill_nos,
      COALESCE(a.delivery_route_code, '') as delivery_route_code,
      COALESCE(rt.name, '') as delivery_route_name,
      COALESCE(a.delivery_round_code, '') as delivery_round_code,
      COALESCE(dr.name, '') as delivery_round_name,
      COALESCE(dr.time_label, '') as delivery_round_time_label
    FROM odg_tms a
    LEFT JOIN public.odg_tms_car b ON b.code=a.car
    LEFT JOIN public.odg_tms_driver c ON c.code=a.driver
    LEFT JOIN erp_user d ON d.code=a.user_created
    LEFT JOIN worker_summary w ON w.doc_no = a.doc_no
    LEFT JOIN forward_summary fs ON fs.doc_no = a.doc_no
    LEFT JOIN public.transport_type ftt ON ftt.code = fs.forward_transport_code
    LEFT JOIN bill_summary bs ON bs.doc_no = a.doc_no
    LEFT JOIN public.odg_tms_delivery_route rt ON rt.code = a.delivery_route_code
    LEFT JOIN public.odg_tms_delivery_round dr ON dr.code = a.delivery_round_code
    WHERE a.user_created=$1
      AND (a.approve_status = 0 OR a.approve_status IS NULL)
      AND ${getFixedYearSqlFilter("a.doc_date")}
    ORDER BY a.doc_no DESC
    LIMIT 20`,
    [session.usercode]
  );
}

async function createJob(session, data) {
  // Lazy-require to avoid circular dependencies
  const { getDispatchDriverByCode } = require("./master-data");

  const fixedDocDate = coerceDateToFixedYear(data.doc_date);
  const fixedDateLog = coerceDateToFixedYear(data.date_log);
  const uniqueWorkers = Array.from(
    new Set((data.workers ?? []).filter(Boolean).filter((workerCode) => workerCode !== data.driver))
  );
  const selectedDriver = await getDispatchDriverByCode(data.driver);
  if (!selectedDriver) {
    throw new Error("Selected driver was not found in odg_employee transport department");
  }
  const existingDriver = await queryOne("SELECT code FROM public.odg_tms_driver WHERE code=$1", [selectedDriver.code]);
  if (existingDriver) {
    await queryOne("UPDATE public.odg_tms_driver SET name_1=$1 WHERE code=$2", [selectedDriver.name_1, selectedDriver.code]);
  } else {
    await queryOne("INSERT INTO public.odg_tms_driver(code, name_1) VALUES ($1, $2)", [selectedDriver.code, selectedDriver.name_1]);
  }
  await ensureTmsWorkerTable();
  await ensureTmsDetailItemTable();
  await ensureForwardBranchColumn();
  // parent_bill_no lives on both odg_tms_detail (write target) and
  // odg_tms_listbill_draft (read source below). Ensure the schema before
  // the SELECT references it.
  await ensureDeliveryWorkflowSchema(pool);

  const billsList = data.bills && data.bills.length > 0
    ? data.bills
    : await query(`SELECT bill_date, bill_no, cust_code, count_item, telephone, parent_bill_no FROM odg_tms_listbill_draft WHERE user_create=$1 AND ${getFixedYearSqlFilter("bill_date")}`, [session.usercode]);

  // Build + validate one bill's items against its remaining (re-dispatchable)
  // quantity. Runs INSIDE the transaction, after the bill is advisory-locked, so
  // the remaining count reflects every committed reservation and can't be raced
  // by a concurrent dispatch of the same bill.
  const normalizeBill = (bill, rawRemainingProducts, billHasErpDetail) => {
    // ບິນ ERP ທີ່ຈັດຄົບແລ້ວ ກັບ ບິນໂອນ/ບິນມືທີ່ບໍ່ມີແຖວໃນ ERP ຄືນ [] ຄືກັນ
    // ແຕ່ຄວາມໝາຍຄົນລະຢ່າງ. ຕົກໄປເຊື່ອລາຍການທີ່ຜູ້ໃຊ້ສົ່ງມາ ໄດ້ສະເພາະບິນມື —
    // ບໍ່ດັ່ງນັ້ນບິນທີ່ສົ່ງຄົບແລ້ວຈະຖືກຈັດຖ້ຽວຄືນໄດ້ບໍ່ຈຳກັດ (ພົບຈິງ: ບິນ
    // ດຽວຖືກຜູກ 9 ຖ້ຽວ ລວມ 1,440 ໜ່ວຍ ທັງທີ່ຍອດບິນມີ 160).
    const remainingProducts = rawRemainingProducts.length > 0
      ? rawRemainingProducts
      : billHasErpDetail
      ? []
      : (bill.items ?? []).map((item) => ({
          item_code: item.item_code,
          item_name: item.item_name,
          qty: Number(item.qty ?? item.selectedQty ?? 0),
          unit_code: item.unit_code,
        }));
    const remainingByItem = new Map(remainingProducts.map((item) => [item.item_code, item]));
    const billItems = bill.items;

    const itemsToSave =
      billItems && billItems.length > 0
        ? billItems.map((item) => {
            const remainingItem = remainingByItem.get(item.item_code);
            const selectedQty = Number(item.selectedQty ?? 0);
            if (!remainingItem) {
              throw new Error(`ບິນ ${bill.bill_no} ລາຍການ ${item.item_code} ຖືກຈັດຄົບແລ້ວ`);
            }
            if (!Number.isFinite(selectedQty) || selectedQty <= 0) {
              throw new Error(`ຈໍານວນຈັດສົ່ງຂອງ ${item.item_code} ບໍ່ຖືກຕ້ອງ`);
            }
            if (selectedQty > remainingItem.qty) {
              throw new Error(`ບິນ ${bill.bill_no} ລາຍການ ${item.item_code} ເຫຼືອຈັດໄດ້ພຽງ ${remainingItem.qty}`);
            }
            return {
              item_code: item.item_code,
              item_name: item.item_name || remainingItem.item_name,
              qty: remainingItem.qty,
              selectedQty,
              unit_code: item.unit_code || remainingItem.unit_code,
            };
          })
        : remainingProducts.map((item) => ({
            item_code: item.item_code,
            item_name: item.item_name,
            qty: item.qty,
            selectedQty: item.qty,
            unit_code: item.unit_code,
          }));

    if (itemsToSave.length === 0) {
      throw new Error(`ບິນ ${bill.bill_no} ບໍ່ມີລາຍການຄົງເຫຼືອໃຫ້ຈັດຖ້ຽວ`);
    }
    return { ...bill, count_item: itemsToSave.length, items: itemsToSave };
  };

  // origin_transport_code = which delivery branch this trip belongs to.
  //  - One assigned branch  → locked to it.
  //  - Many assigned branches (multi-branch dispatcher) → must pick one of THEIR
  //    branches; sent in the form as forward_transport_code.
  //  - No branch scope (manager / head office) → may pick any delivery branch.
  // Persist that choice so the trip shows under the right branch in scoped views.
  const scope = getBranchScope(session);
  const selectedBranch = String(data.forward_transport_code ?? "").trim();
  let originBranch;
  if (scope.branches.length === 1) {
    originBranch = scope.branches[0];
  } else if (scope.branches.length > 1) {
    originBranch = scope.branches.includes(selectedBranch) ? selectedBranch : null;
  } else {
    originBranch = DELIVERY_BRANCH_CODES.includes(selectedBranch) ? selectedBranch : null;
  }
  if (!originBranch) {
    throw new Error("ກະລຸນາເລືອກສາຂາຂົນສົ່ງ");
  }
  // Optional route/round; auto-DDL creates the columns on first run.
  const { ensureDeliveryRouteSchema } = require("./delivery-route");
  const { ensureDeliveryRoundSchema } = require("./delivery-round");
  await ensureDeliveryRouteSchema();
  await ensureDeliveryRoundSchema();
  const deliveryRouteCode = data.delivery_route_code
    ? String(data.delivery_route_code).trim() || null
    : null;
  const deliveryRoundCode = data.delivery_round_code
    ? String(data.delivery_round_code).trim() || null
    : null;

  // Server-side guards — the add-job page enforces these client-side, but the
  // action is directly callable so it must not trust the client.
  if (!data.car || !String(data.car).trim()) {
    throw new Error("ກະລຸນາເລືອກລົດກ່ອນຈັດຖ້ຽວ");
  }
  if (!deliveryRouteCode) {
    throw new Error("ກະລຸນາເລືອກສາຍຈັດສົ່ງ");
  }
  if (!deliveryRoundCode) {
    throw new Error("ກະລຸນາເລືອກຮອບຈັດສົ່ງ");
  }
  if (!Array.isArray(billsList) || billsList.length === 0) {
    throw new Error("ກະລຸນາເລືອກບິນຢ່າງໜ້ອຍ 1 ບິນ");
  }

  // Distinct bill numbers, sorted so concurrent createJob calls take the
  // per-bill locks in the same order (deadlock-free).
  const billNos = Array.from(new Set(billsList.map((b) => String(b.bill_no)))).sort();

  const client = await pool.connect();
  let docNo = null;
  // Declared out here so the post-commit notification block can read the count.
  let normalizedBills = [];
  try {
    await client.query("BEGIN");
    // Serialize dispatch of the SAME bill across concurrent trips. The xact lock
    // is held until COMMIT/ROLLBACK, so a second dispatcher blocks here until the
    // first finishes, then re-reads the (now-reduced) remaining qty below — this
    // closes the over-allocation race where two trips claimed the same units.
    for (const billNo of billNos) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tms_bill:${billNo}`]);
    }
    // Authoritative validation, under the lock. Remaining qty for every bill is
    // fetched in ONE batched query (not N) to keep the locked section short.
    const remainingMap = await getRemainingBillProductsMap(billNos);
    const erpBills = await getBillsWithErpDetail(billNos);
    normalizedBills = [];
    for (const bill of billsList) {
      normalizedBills.push(
        normalizeBill(
          bill,
          remainingMap.get(String(bill.bill_no)) ?? [],
          erpBills.has(String(bill.bill_no))
        )
      );
    }

    docNo = await getNextJobDocNo(client, fixedDocDate);

    await client.query(
      `INSERT INTO public.odg_tms(doc_no, doc_date, date_logistic, car, driver, item_bill, user_created, create_date_time_now, approve_status, job_status, origin_transport_code, delivery_route_code, delivery_round_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,LOCALTIMESTAMP(0),0,0,$8,$9,$10)`,
      [docNo, fixedDocDate, fixedDateLog, data.car, data.driver, normalizedBills.length, session.usercode, originBranch, deliveryRouteCode, deliveryRoundCode]
    );

    for (const bill of normalizedBills) {
      const forwardCode = bill.forward_transport_code && String(bill.forward_transport_code).trim()
        ? String(bill.forward_transport_code).trim()
        : null;
      const pickupCode = bill.pickup_transport_code && String(bill.pickup_transport_code).trim()
        ? String(bill.pickup_transport_code).trim()
        : null;
      const parentBillNo = bill.parent_bill_no && String(bill.parent_bill_no).trim()
        ? String(bill.parent_bill_no).trim()
        : null;
      const deliveryCondition = bill.delivery_condition && String(bill.delivery_condition).trim()
        ? String(bill.delivery_condition).trim()
        : null;
      await client.query(
        `INSERT INTO public.odg_tms_detail(doc_no, doc_date, car, bill_no, bill_date, cust_code, create_date_time_now, date_logistic, count_item, telephone, forward_transport_code, pickup_transport_code, parent_bill_no, delivery_condition)
         VALUES ($1,$2,$3,$4,$5,$6,LOCALTIMESTAMP(0),$7,$8,$9,$10,$11,$12,$13)`,
        [docNo, fixedDocDate, data.car, bill.bill_no, coerceDateToFixedYear(bill.bill_date), bill.cust_code, fixedDateLog, bill.count_item, bill.telephone, forwardCode, pickupCode, parentBillNo, deliveryCondition]
      );
      if (bill.items && bill.items.length > 0) {
        for (const item of bill.items) {
          await client.query(
            `INSERT INTO public.odg_tms_detail_item(doc_no, bill_no, item_code, item_name, qty, selected_qty, unit_code)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [docNo, bill.bill_no, item.item_code, item.item_name, item.qty, item.selectedQty, item.unit_code]
          );
        }
      }
    }

    if (uniqueWorkers.length > 0) {
      const workerResult = await client.query(
        `SELECT e.employee_code AS code,
          COALESCE(NULLIF(TRIM(e.fullname_lo), ''), NULLIF(TRIM(e.nickname), ''), e.employee_code) AS name_1
        FROM public.odg_employee e
        LEFT JOIN public.odg_department d ON d.department_code = e.department_code
        WHERE e.employee_code = ANY($1::varchar[])
          AND e.employment_status = 'ACTIVE'
          AND d.department_name_lo ILIKE '%ຂົນສົ່ງ%'
        ORDER BY name_1 ASC, e.employee_code ASC`,
        [uniqueWorkers]
      );

      for (const worker of workerResult.rows) {
        await client.query(
          `INSERT INTO public.odg_tms_worker(doc_no, doc_date, worker_code, worker_name, user_create, create_date_time_now)
          VALUES ($1, $2, $3, $4, $5, LOCALTIMESTAMP(0))
          ON CONFLICT (doc_no, worker_code)
          DO UPDATE SET doc_date = EXCLUDED.doc_date, worker_name = EXCLUDED.worker_name, user_create = EXCLUDED.user_create`,
          [docNo, fixedDocDate, worker.code, worker.name_1, session.usercode]
        );
      }
    }

    // Remove the dispatched bills from the available / pending pool so they
    // don't reappear in the bill search / job-init lists. createJob previously
    // relied only on the selected_qty reservation, which getJobInit/searchBills
    // don't look at (they filter check_status=0) — matching addBillsToJob &
    // updateJob here keeps the state machine consistent.
    if (billNos.length > 0) {
      await client.query(
        `UPDATE ic_trans_shipment SET check_status=1
         WHERE doc_no = ANY($1::varchar[]) AND ${getFixedYearSqlFilter("doc_date")}`,
        [billNos]
      );

      // ຮ່າງຖ້ຽວ = ວັນ × ຮອບ × ສາຍ. The trip already holds all three (plus the
      // branch), so a bill that was never scheduled inherits them simply by
      // being put on the trip — the dispatcher no longer has to schedule each
      // bill on a separate screen before a trip can be built. Bills that were
      // already scheduled keep their own values: only the blanks are filled.
      await client.query(
        `INSERT INTO public.odg_tms_pending_bill
           (bill_no, scheduled_date, delivery_route_code, delivery_round_code, transport_code, updated_by, updated_at)
         SELECT b.bill_no, $2::date, $3, $4, $5, $6, LOCALTIMESTAMP(0)
         FROM unnest($1::varchar[]) AS b(bill_no)
         ON CONFLICT (bill_no) DO UPDATE SET
           scheduled_date = COALESCE(public.odg_tms_pending_bill.scheduled_date, EXCLUDED.scheduled_date),
           delivery_route_code = COALESCE(NULLIF(TRIM(public.odg_tms_pending_bill.delivery_route_code), ''), EXCLUDED.delivery_route_code),
           delivery_round_code = COALESCE(NULLIF(TRIM(public.odg_tms_pending_bill.delivery_round_code), ''), EXCLUDED.delivery_round_code),
           transport_code = COALESCE(NULLIF(TRIM(public.odg_tms_pending_bill.transport_code), ''), EXCLUDED.transport_code),
           updated_by = EXCLUDED.updated_by,
           updated_at = LOCALTIMESTAMP(0)`,
        [
          billNos,
          fixedDateLog,
          deliveryRouteCode,
          deliveryRoundCode,
          originBranch || null,
          session.usercode,
        ]
      );
    }
    await client.query("DELETE FROM public.odg_tms_listbill_draft WHERE user_create=$1", [session.usercode]);
    await client.query("COMMIT");
    // These bills' remaining quantities just changed — drop them from the
    // short-lived cache so the next screen reads the truth, not a 30-second-old
    // snapshot that still shows them as available.
    invalidateRemainingSummary(billNos);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  // Notify driver about the new dispatch
  if (data.driver) {
    const carRow = data.car
      ? await queryOne(
          "SELECT name_1 FROM public.odg_tms_car WHERE code = $1",
          [data.car]
        )
      : null;
    const carName = carRow?.name_1 ?? data.car ?? "";
    const logisticDate = data.date_log
      ? new Date(coerceDateToFixedYear(data.date_log)).toLocaleDateString("lo-LA")
      : "";
    const billCount = normalizedBills.length;
    const lines = [
      `📋 ຖ້ຽວ ${docNo}`,
      logisticDate ? `📅 ສົ່ງວັນທີ ${logisticDate}` : null,
      carName ? `🚚 ລົດ ${carName}` : null,
      `📦 ${billCount} ບິນ`,
    ].filter(Boolean);
    void pushToTopic({
      candidates: [data.driver],
      title: "🚚 ມີຖ້ຽວໃໝ່ໃຫ້ທ່ານ",
      body: lines.join("\n"),
      data: { type: "job_created", doc_no: docNo },
      // "ໃຫ້ທ່ານ" ຖືກສະເພາະຄົນຂັບ — ຄົນທີ່ຕິກເປີດ "ຈັດຖ້ຽວໃຫ້ / ປ່ຽນຖ້ຽວ"
      // ເປັນຜູ້ເຝົ້າເບິ່ງ ຈຶ່ງໃຊ້ຫົວຂໍ້ເປັນກາງ.
      observerTitle: "🚚 ຈັດຖ້ຽວໃໝ່ແລ້ວ",
      sales: false,
    });
  }

  // Fire-and-forget: WhatsApp customers + LINE sales for every bill on the job.
  void notifyJobCreated(docNo);
  // Fire-and-forget: FCM push to the bill's salesperson + their head + manager
  // (app_sale_order Flutter app). Failures are swallowed inside the helper so
  // a push outage can't roll back a committed job.
  void notifyJobCreatedToSales(docNo);
  return { doc_no: docNo };
}

async function addBillsToJob(docNo, bills) {
  if (!docNo) throw new Error("doc_no is required");

  // Accept either a list of bill_no strings (legacy) or the full
  // create-job shape: [{ bill_no, items: [{item_code, item_name, qty, selectedQty, unit_code}] }].
  const normalizedInput = (Array.isArray(bills) ? bills : [])
    .map((entry) => {
      if (!entry) return null;
      if (typeof entry === "string") {
        return { bill_no: entry.trim(), items: null };
      }
      const billNo = String(entry.bill_no ?? "").trim();
      if (!billNo) return null;
      return { bill_no: billNo, items: Array.isArray(entry.items) ? entry.items : null };
    })
    .filter(Boolean);
  if (normalizedInput.length === 0) {
    throw new Error("ກະລຸນາເລືອກບິນຢ່າງໜ້ອຍ 1 ບິນ");
  }

  await ensureTmsWorkerTable();
  await ensureTmsDetailItemTable();
  await ensureForwardBranchColumn();

  const job = await queryOne(
    `SELECT doc_no, to_char(doc_date,'YYYY-MM-DD') as doc_date,
            to_char(date_logistic,'YYYY-MM-DD') as date_logistic,
            car, driver,
            COALESCE(approve_status, 0) as approve_status,
            COALESCE(job_status, 0) as job_status
     FROM odg_tms
     WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")}`,
    [docNo]
  );
  if (!job) throw new Error("ບໍ່ພົບຖ້ຽວ");
  if (Number(job.approve_status) !== 1) {
    throw new Error("ຖ້ຽວນີ້ຍັງບໍ່ຖືກອະນຸມັດ");
  }
  if (Number(job.job_status) >= 2) {
    throw new Error("ຖ້ຽວນີ້ເລີ່ມຈັດສົ່ງແລ້ວ ບໍ່ສາມາດເພີ່ມບິນໄດ້");
  }

  // De-dupe against bills already on this job so the same bill can't be
  // attached twice.
  const existing = await query(
    `SELECT bill_no FROM public.odg_tms_detail
     WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")}`,
    [docNo]
  );
  const existingSet = new Set(existing.map((r) => String(r.bill_no)));
  const billsToAdd = normalizedInput.filter((b) => !existingSet.has(b.bill_no));
  if (billsToAdd.length === 0) {
    throw new Error("ບິນທີ່ເລືອກມີຢູ່ໃນຖ້ຽວແລ້ວ");
  }

  // Distinct bill numbers, sorted so concurrent writers take the per-bill locks
  // in the same order (deadlock-free) — same key space as createJob/updateJob.
  const billNos = Array.from(new Set(billsToAdd.map((b) => String(b.bill_no)))).sort();

  let added = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize dispatch of the SAME bill across concurrent trips so the
    // remaining-qty re-check below can't be raced into over-allocation. Held
    // until COMMIT/ROLLBACK.
    for (const lockBillNo of billNos) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tms_bill:${lockBillNo}`]);
    }
    // Remaining qty for every bill in ONE batched query (not N) under the lock.
    const remainingMap = await getRemainingBillProductsMap(billNos);
    const erpBills = await getBillsWithErpDetail(billNos);
    for (const entry of billsToAdd) {
      const billNo = entry.bill_no;
      const meta = await queryOne(
      `SELECT to_char(t.doc_date,'YYYY-MM-DD') as bill_date, a.cust_code, b.telephone
       FROM ic_trans_shipment a
       LEFT JOIN ic_trans t ON t.doc_no=a.doc_no
       LEFT JOIN ar_customer b ON b.code=a.cust_code
       WHERE a.doc_no=$1 AND ${getFixedYearSqlFilter("a.doc_date")}`,
      [billNo]
    );
    const effectiveMeta = meta ?? {
      bill_date: job.date_logistic,
      cust_code: entry.cust_code ?? "",
      telephone: entry.telephone ?? "",
    };

    // Match createJob's normalization: validate the caller's selected items
    // against the remaining quantities, falling back to "all remaining" when
    // the caller didn't pick specific items.
    const rawRemainingProducts = remainingMap.get(String(billNo)) ?? [];
    // ບິນ ERP ທີ່ຈັດຄົບແລ້ວ ກັບ ບິນໂອນ/ບິນມືທີ່ບໍ່ມີແຖວໃນ ERP ຄືນ [] ຄືກັນ
    // ແຕ່ຄວາມໝາຍຄົນລະຢ່າງ. ຕົກໄປເຊື່ອລາຍການທີ່ຜູ້ໃຊ້ສົ່ງມາ ໄດ້ສະເພາະບິນມື —
    // ບໍ່ດັ່ງນັ້ນບິນທີ່ສົ່ງຄົບແລ້ວຈະຖືກຈັດຖ້ຽວຄືນໄດ້ບໍ່ຈຳກັດ (ພົບຈິງ: ບິນ
    // ດຽວຖືກຜູກ 9 ຖ້ຽວ ລວມ 1,440 ໜ່ວຍ ທັງທີ່ຍອດບິນມີ 160).
    const remainingProducts = rawRemainingProducts.length > 0
      ? rawRemainingProducts
      : erpBills.has(String(billNo))
      ? []
      : (entry.items ?? []).map((item) => ({
          item_code: item.item_code,
          item_name: item.item_name,
          qty: Number(item.qty ?? item.selectedQty ?? 0),
          unit_code: item.unit_code,
        }));
    const remainingByItem = new Map(remainingProducts.map((it) => [it.item_code, it]));

    const itemsToSave =
      entry.items && entry.items.length > 0
        ? entry.items.map((item) => {
            const remainingItem = remainingByItem.get(item.item_code);
            const selectedQty = Number(item.selectedQty ?? item.qty ?? 0);
            if (!remainingItem) {
              throw new Error(`ບິນ ${billNo} ລາຍການ ${item.item_code} ຖືກຈັດຄົບແລ້ວ`);
            }
            if (!Number.isFinite(selectedQty) || selectedQty <= 0) {
              throw new Error(`ຈໍານວນຈັດສົ່ງຂອງ ${item.item_code} ບໍ່ຖືກຕ້ອງ`);
            }
            if (selectedQty > Number(remainingItem.qty)) {
              throw new Error(
                `ບິນ ${billNo} ລາຍການ ${item.item_code} ເຫຼືອຈັດໄດ້ພຽງ ${remainingItem.qty}`
              );
            }
            return {
              item_code: item.item_code,
              item_name: item.item_name || remainingItem.item_name,
              qty: Number(remainingItem.qty),
              selectedQty,
              unit_code: item.unit_code || remainingItem.unit_code,
            };
          })
        : remainingProducts.map((it) => ({
            item_code: it.item_code,
            item_name: it.item_name,
            qty: Number(it.qty),
            selectedQty: Number(it.qty),
            unit_code: it.unit_code,
          }));

    if (itemsToSave.length === 0) {
      throw new Error(`ບິນ ${billNo} ບໍ່ມີລາຍການຄົງເຫຼືອໃຫ້ຈັດຖ້ຽວ`);
    }

    await client.query(
      `INSERT INTO public.odg_tms_detail
        (doc_no, doc_date, car, bill_no, bill_date, cust_code,
         create_date_time_now, date_logistic, count_item, telephone)
       VALUES ($1,$2,$3,$4,$5,$6,LOCALTIMESTAMP(0),$7,$8,$9)`,
      [
        docNo,
        job.doc_date,
        job.car,
        billNo,
        coerceDateToFixedYear(effectiveMeta.bill_date),
        effectiveMeta.cust_code,
        job.date_logistic,
        itemsToSave.length,
        effectiveMeta.telephone,
      ]
    );

    for (const item of itemsToSave) {
      await client.query(
        `INSERT INTO public.odg_tms_detail_item
          (doc_no, bill_no, item_code, item_name, qty, selected_qty, unit_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          docNo,
          billNo,
          item.item_code,
          item.item_name,
          item.qty,
          item.selectedQty,
          item.unit_code,
        ]
      );
    }

      await client.query(
        `UPDATE ic_trans_shipment SET check_status=1
         WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")}`,
        [billNo]
      );
      added += 1;
    }

    // Refresh the bill count cached on the job header so list pages show it.
    await client.query(
      `UPDATE public.odg_tms
       SET item_bill = (
         SELECT COUNT(*) FROM public.odg_tms_detail
         WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")}
       )
       WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")}`,
      [docNo]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  if (added > 0 && job.driver) {
    void pushToTopic({
      candidates: [job.driver],
      title: "📦 ມີບິນເພີ່ມໃນຖ້ຽວ",
      body: `📋 ຖ້ຽວ ${docNo}\n➕ ເພີ່ມ ${added} ບິນ`,
      data: { type: "bills_added", doc_no: docNo },
      sales: false,
    });
  }

  return { success: true, added };
}

async function deleteJob(docNo) {
  await ensureTmsWorkerTable();
  await ensureTmsDetailItemTable();
  // Grab the driver before delete so we can notify
  const job = await queryOne(
    `SELECT driver FROM odg_tms WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")}`,
    [docNo]
  );

  // All deletes run in one transaction so a mid-sequence failure can't leave a
  // half-deleted trip (header gone but details orphaned, or vice-versa). The
  // detail-dependent statements (check_status release, delivery-image cleanup)
  // must run BEFORE the detail rows are removed.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Bills return to the pending pool.
    await client.query(
      `UPDATE ic_trans_shipment SET check_status=0
       WHERE doc_no IN (SELECT bill_no FROM odg_tms_detail WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")})`,
      [docNo]
    );
    // Delivery proof images are keyed by bill_no, not doc_no — delete them up
    // front (while the detail rows still resolve the bill list) so they don't
    // become unreachable orphans after the trip is gone.
    await client.query(
      `DELETE FROM public.odg_tms_delivery_images
       WHERE bill_no IN (SELECT bill_no FROM odg_tms_detail WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")})`,
      [docNo]
    );
    await client.query("DELETE FROM public.odg_tms_worker WHERE doc_no=$1", [docNo]);
    await client.query("DELETE FROM public.odg_tms_detail_item WHERE doc_no=$1", [docNo]);
    await client.query("DELETE FROM public.odg_tms_travel_history WHERE doc_no=$1", [docNo]);
    await client.query(`DELETE FROM public.odg_tms WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")}`, [docNo]);
    await client.query(`DELETE FROM public.odg_tms_detail WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")}`, [docNo]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  // ບໍ່ມີເງື່ອນໄຂ `if (job?.driver)` ອີກ: ຖ້ຽວທີ່ຍັງບໍ່ມີຄົນຂັບກໍ່ຖືກລຶບໄດ້
  // ແລະ ຄົນທີ່ຕິກເປີດ "ອະນຸມັດ / ຍົກເລີກ / ປິດຖ້ຽວ" ຄວນຮູ້ຄືກັນ.
  void pushToTopic({
    candidates: [job?.driver],
    title: "🗑️ ຖ້ຽວຖືກລຶບ",
    body: `📋 ຖ້ຽວ ${docNo}\n⚠️ admin ໄດ້ລຶບຖ້ຽວນີ້ ບິນຈະກັບໄປຄິວ`,
    data: { type: "job_deleted", doc_no: docNo },
    sales: false,
  });
}

// Fetches the editable payload for an existing job. Throws if the job is no
// longer editable (driver has already received it). Mirrors the shape that
// AddJobClient consumes so the same component can drive create + edit.
async function getJobForEdit(docNo) {
  await ensureTmsWorkerTable();
  await ensureTmsDetailItemTable();
  await ensureForwardBranchColumn();
  const { ensureDeliveryRouteSchema } = require("./delivery-route");
  await ensureDeliveryRouteSchema();

  const job = await queryOne(
    `SELECT
       doc_no,
       to_char(doc_date,'YYYY-MM-DD') as doc_date,
       to_char(date_logistic,'YYYY-MM-DD') as date_logistic,
       car, driver,
       COALESCE(delivery_route_code, '') as delivery_route_code,
       delivery_round_code,
       COALESCE(approve_status,0) AS approve_status,
       COALESCE(job_status,0) AS job_status,
       origin_transport_code
     FROM odg_tms
     WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")}`,
    [docNo]
  );
  if (!job) throw new Error("ບໍ່ພົບຖ້ຽວ");
  if (Number(job.job_status) !== 0) {
    throw new Error("ສາມາດແກ້ໄຂໄດ້ສະເພາະຖ້ຽວທີ່ຄົນຂັບຍັງບໍ່ກົດຮັບ");
  }

  const billsRows = await query(
    `SELECT a.bill_no, to_char(a.bill_date,'YYYY-MM-DD') as bill_date,
            a.cust_code, b.name_1 as cust_name, a.count_item, a.telephone,
            a.forward_transport_code, a.pickup_transport_code, a.delivery_condition
     FROM public.odg_tms_detail a
     LEFT JOIN ar_customer b ON b.code=a.cust_code
     WHERE a.doc_no=$1 AND ${getFixedYearSqlFilter("a.doc_date")}
     ORDER BY a.roworder`,
    [docNo]
  );

  const itemRows = await query(
    `SELECT bill_no, item_code, item_name, qty, selected_qty, unit_code
     FROM public.odg_tms_detail_item
     WHERE doc_no=$1
     ORDER BY bill_no, roworder`,
    [docNo]
  );

  const itemsByBill = new Map();
  for (const it of itemRows) {
    const list = itemsByBill.get(it.bill_no) ?? [];
    list.push({
      item_code: it.item_code,
      item_name: it.item_name,
      qty: Number(it.qty ?? 0),
      selectedQty: Number(it.selected_qty ?? 0),
      unit_code: it.unit_code,
    });
    itemsByBill.set(it.bill_no, list);
  }

  // Pull every product (aggregated across rows) for each bill — the kanban
  // needs the full master product list to drive the checkbox grid.
  const productsByBill = new Map();
  if (billsRows.length > 0) {
    const productRows = await query(
      `SELECT doc_no AS bill_no,
              item_code,
              MAX(item_name) AS item_name,
              SUM(COALESCE(qty, 0))::numeric AS qty,
              MAX(unit_code) AS unit_code
       FROM ic_trans_detail
       WHERE doc_no = ANY($1::varchar[]) AND item_code NOT LIKE '97%'
       GROUP BY doc_no, item_code
       ORDER BY doc_no, item_code`,
      [billsRows.map((b) => b.bill_no)]
    ).catch(() => []);
    for (const p of productRows) {
      const list = productsByBill.get(p.bill_no) ?? [];
      list.push({
        item_code: p.item_code,
        item_name: p.item_name,
        qty: Number(p.qty ?? 0),
        unit_code: p.unit_code,
      });
      productsByBill.set(p.bill_no, list);
    }
  }

  const bills = billsRows.map((b) => {
    const products = productsByBill.get(b.bill_no) ?? [];
    return {
      doc_no: b.bill_no,
      doc_date: b.bill_date,
      cust_code: b.cust_code,
      cust_name: b.cust_name || "",
      telephone: b.telephone || "",
      count_item: products.length || Number(b.count_item ?? 0),
      forward_transport_code: b.forward_transport_code || null,
      pickup_transport_code: b.pickup_transport_code || null,
      delivery_condition: b.delivery_condition || null,
      items: itemsByBill.get(b.bill_no) ?? [],
      products,
    };
  });

  const workerRows = await query(
    `SELECT worker_code FROM public.odg_tms_worker WHERE doc_no=$1`,
    [docNo]
  );

  // Job-level forward — bills currently share one value, so first non-null wins.
  const forward_transport_code =
    bills.find((b) => b.forward_transport_code)?.forward_transport_code || null;

  return {
    doc_no: job.doc_no,
    doc_date: job.doc_date,
    date_logistic: job.date_logistic,
    car: job.car || "",
    driver: job.driver || "",
    delivery_route_code: job.delivery_route_code || "",
    delivery_round_code: job.delivery_round_code || "",
    forward_transport_code,
    approve_status: Number(job.approve_status),
    job_status: Number(job.job_status),
    workers: workerRows.map((w) => w.worker_code),
    bills,
  };
}

// Batched _getRemainingBillProductsExcludingJob — per-item remaining for many
// bills in ONE query on the supplied client (sees the txn's uncommitted state),
// excluding the given doc_no from the active-lock subtraction. Returns
// Map<bill_no, items[]>. Mirrors the single-bill version exactly (like it, it
// does NOT subtract returns).
async function _getRemainingBillProductsMapExcludingJob(client, billNos, excludeDocNo) {
  const map = new Map();
  if (!Array.isArray(billNos) || billNos.length === 0) return map;
  const result = await client.query(
    `WITH bill_items AS (
       SELECT d.doc_no AS bill_no, d.item_code,
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
         AND item.doc_no <> $2
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
     )
     SELECT bi.bill_no, bi.item_code, bi.item_name, bi.unit_code,
            GREATEST(bi.total_qty - COALESCE(al.locked_qty, 0) - COALESCE(dl.delivered_qty, 0), 0)::numeric AS qty
     FROM bill_items bi
     LEFT JOIN active_locked al ON al.bill_no = bi.bill_no AND al.item_code = bi.item_code
     LEFT JOIN delivered dl ON dl.bill_no = bi.bill_no AND dl.item_code = bi.item_code
     WHERE GREATEST(bi.total_qty - COALESCE(al.locked_qty, 0) - COALESCE(dl.delivered_qty, 0), 0) > 0
     ORDER BY bi.bill_no, bi.item_code`,
    [billNos, excludeDocNo]
  );
  for (const r of result.rows) {
    const list = map.get(r.bill_no) ?? [];
    list.push({
      item_code: r.item_code,
      item_name: r.item_name,
      qty: Number(r.qty ?? 0),
      unit_code: r.unit_code,
    });
    map.set(r.bill_no, list);
  }
  return map;
}

// Atomically replaces the bill list, items, and workers of a job.
// Allowed only while job_status = 0.
async function updateJob(session, docNo, data) {
  const { getDispatchDriverByCode } = require("./master-data");

  await ensureTmsWorkerTable();
  await ensureTmsDetailItemTable();
  await ensureForwardBranchColumn();

  const fixedDocDate = coerceDateToFixedYear(data.doc_date);
  const fixedDateLog = coerceDateToFixedYear(data.date_log);
  const uniqueWorkers = Array.from(
    new Set((data.workers ?? []).filter(Boolean).filter((w) => w !== data.driver))
  );

  const selectedDriver = await getDispatchDriverByCode(data.driver);
  if (!selectedDriver) throw new Error("ບໍ່ພົບຄົນຂັບ");

  const existing = await queryOne(
    `SELECT job_status FROM odg_tms WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")}`,
    [docNo]
  );
  if (!existing) throw new Error("ບໍ່ພົບຖ້ຽວ");
  if (Number(existing.job_status ?? 0) !== 0) {
    throw new Error("ສາມາດແກ້ໄຂໄດ້ສະເພາະຖ້ຽວທີ່ຄົນຂັບຍັງບໍ່ກົດຮັບ");
  }

  // Ensure driver row exists (createJob does the same)
  const existingDriver = await queryOne(
    "SELECT code FROM public.odg_tms_driver WHERE code=$1",
    [selectedDriver.code]
  );
  if (existingDriver) {
    await queryOne(
      "UPDATE public.odg_tms_driver SET name_1=$1 WHERE code=$2",
      [selectedDriver.name_1, selectedDriver.code]
    );
  } else {
    await queryOne(
      "INSERT INTO public.odg_tms_driver(code, name_1) VALUES ($1, $2)",
      [selectedDriver.code, selectedDriver.name_1]
    );
  }

  const { ensureDeliveryRouteSchema } = require("./delivery-route");
  const { ensureDeliveryRoundSchema } = require("./delivery-round");
  await ensureDeliveryRouteSchema();
  await ensureDeliveryRoundSchema();
  const deliveryRouteCode = data.delivery_route_code
    ? String(data.delivery_route_code).trim() || null
    : null;
  const deliveryRoundCode = data.delivery_round_code
    ? String(data.delivery_round_code).trim() || null
    : null;

  const inputBills = Array.isArray(data.bills) ? data.bills : [];
  if (inputBills.length === 0) {
    throw new Error("ກະລຸນາເລືອກບິນຢ່າງໜ້ອຍ 1 ບິນ");
  }
  const newBillNos = new Set(inputBills.map((b) => String(b.bill_no)));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the bills being (re)reserved on this trip in the same key space as
    // createJob / addBillsToJob, sorted for deadlock-free ordering, so a
    // concurrent dispatch of the same bill can't race the remaining-qty
    // re-check below into over-allocation.
    const lockBillNos = Array.from(newBillNos).sort();
    for (const lockBillNo of lockBillNos) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tms_bill:${lockBillNo}`]);
    }

    // Validate every bill's items against fresh remaining (excluding this job).
    // One batched query (not N) under the lock.
    const remainingMap = await _getRemainingBillProductsMapExcludingJob(client, lockBillNos, docNo);
    const normalizedBills = [];
    for (const bill of inputBills) {
      const billNo = String(bill.bill_no);
      const rawRemaining = remainingMap.get(billNo) ?? [];
      const remaining = rawRemaining.length > 0
        ? rawRemaining
        : (bill.items ?? []).map((item) => ({
            item_code: item.item_code,
            item_name: item.item_name,
            qty: Number(item.qty ?? item.selectedQty ?? 0),
            unit_code: item.unit_code,
          }));
      const remByCode = new Map(remaining.map((r) => [r.item_code, r]));

      const items = Array.isArray(bill.items) ? bill.items : [];
      if (items.length === 0) {
        throw new Error(`ບິນ ${billNo} ບໍ່ມີລາຍການ`);
      }
      const itemsToSave = items.map((it) => {
        const r = remByCode.get(it.item_code);
        const sel = Number(it.selectedQty ?? 0);
        if (!r) throw new Error(`ບິນ ${billNo} ລາຍການ ${it.item_code} ບໍ່ມີໃນຕົ້ນສະບັບ`);
        if (!Number.isFinite(sel) || sel <= 0) {
          throw new Error(`ຈຳນວນຂອງ ${it.item_code} ບໍ່ຖືກຕ້ອງ`);
        }
        if (sel > r.qty) {
          throw new Error(`ບິນ ${billNo} ລາຍການ ${it.item_code} ເຫຼືອໃຫ້ຈັດໄດ້ພຽງ ${r.qty}`);
        }
        return {
          item_code: it.item_code,
          item_name: it.item_name || r.item_name,
          qty: r.qty,
          selectedQty: sel,
          unit_code: it.unit_code || r.unit_code,
        };
      });

      normalizedBills.push({
        bill_no: billNo,
        bill_date: bill.bill_date,
        cust_code: bill.cust_code,
        telephone: bill.telephone,
        forward_transport_code: bill.forward_transport_code ?? null,
        pickup_transport_code: bill.pickup_transport_code ?? null,
        items: itemsToSave,
      });
    }

    // Release reservations on bills being removed
    const currentBillsRes = await client.query(
      `SELECT bill_no FROM public.odg_tms_detail
       WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")}`,
      [docNo]
    );
    const currentBillNos = currentBillsRes.rows.map((r) => r.bill_no);
    const removedBills = currentBillNos.filter((b) => !newBillNos.has(b));
    for (const billNo of removedBills) {
      await client.query(
        `UPDATE ic_trans_shipment SET check_status=0
         WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")}`,
        [billNo]
      );
    }

    // Wipe the job's bills, items, and workers — we re-insert below.
    await client.query(
      `DELETE FROM public.odg_tms_detail_item WHERE doc_no=$1`,
      [docNo]
    );
    await client.query(
      `DELETE FROM public.odg_tms_detail
       WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")}`,
      [docNo]
    );
    await client.query(
      `DELETE FROM public.odg_tms_worker WHERE doc_no=$1`,
      [docNo]
    );

    // Update job header
    await client.query(
      `UPDATE odg_tms
       SET doc_date=$2,
           date_logistic=$3,
           car=$4,
           driver=$5,
           item_bill=$6,
           delivery_route_code=$7,
           delivery_round_code=$8
       WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")}`,
      [
        docNo,
        fixedDocDate,
        fixedDateLog,
        data.car,
        data.driver,
        normalizedBills.length,
        deliveryRouteCode,
        deliveryRoundCode,
      ]
    );

    // Re-insert bills + items, and ensure check_status=1 on each
    for (const bill of normalizedBills) {
      const forwardCode =
        bill.forward_transport_code && String(bill.forward_transport_code).trim()
          ? String(bill.forward_transport_code).trim()
          : null;
      const pickupCode =
        bill.pickup_transport_code && String(bill.pickup_transport_code).trim()
          ? String(bill.pickup_transport_code).trim()
          : null;
      const parentBillNo =
        bill.parent_bill_no && String(bill.parent_bill_no).trim()
          ? String(bill.parent_bill_no).trim()
          : null;
      const deliveryCondition =
        bill.delivery_condition && String(bill.delivery_condition).trim()
          ? String(bill.delivery_condition).trim()
          : null;
      await client.query(
        `INSERT INTO public.odg_tms_detail
         (doc_no, doc_date, car, bill_no, bill_date, cust_code,
          create_date_time_now, date_logistic, count_item, telephone,
          forward_transport_code, pickup_transport_code, parent_bill_no, delivery_condition)
         VALUES ($1,$2,$3,$4,$5,$6,LOCALTIMESTAMP(0),$7,$8,$9,$10,$11,$12,$13)`,
        [
          docNo,
          fixedDocDate,
          data.car,
          bill.bill_no,
          coerceDateToFixedYear(bill.bill_date),
          bill.cust_code,
          fixedDateLog,
          bill.items.length,
          bill.telephone,
          forwardCode,
          pickupCode,
          parentBillNo,
          deliveryCondition,
        ]
      );
      for (const item of bill.items) {
        await client.query(
          `INSERT INTO public.odg_tms_detail_item
           (doc_no, bill_no, item_code, item_name, qty, selected_qty, unit_code)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            docNo,
            bill.bill_no,
            item.item_code,
            item.item_name,
            item.qty,
            item.selectedQty,
            item.unit_code,
          ]
        );
      }
      await client.query(
        `UPDATE ic_trans_shipment SET check_status=1
         WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")}`,
        [bill.bill_no]
      );
    }

    // Workers
    if (uniqueWorkers.length > 0) {
      const workerResult = await client.query(
        `SELECT e.employee_code AS code,
          COALESCE(NULLIF(TRIM(e.fullname_lo), ''), NULLIF(TRIM(e.nickname), ''), e.employee_code) AS name_1
        FROM public.odg_employee e
        LEFT JOIN public.odg_department d ON d.department_code = e.department_code
        WHERE e.employee_code = ANY($1::varchar[])
          AND e.employment_status = 'ACTIVE'
          AND d.department_name_lo ILIKE '%ຂົນສົ່ງ%'`,
        [uniqueWorkers]
      );
      for (const w of workerResult.rows) {
        await client.query(
          `INSERT INTO public.odg_tms_worker(doc_no, doc_date, worker_code, worker_name, user_create, create_date_time_now)
           VALUES ($1, $2, $3, $4, $5, LOCALTIMESTAMP(0))
           ON CONFLICT (doc_no, worker_code) DO UPDATE
           SET doc_date = EXCLUDED.doc_date,
               worker_name = EXCLUDED.worker_name,
               user_create = EXCLUDED.user_create`,
          [docNo, fixedDocDate, w.code, w.name_1, session.usercode]
        );
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  // Notify driver about the update
  void pushToTopic({
    candidates: [data.driver],
    title: "📝 ຖ້ຽວຖືກປັບປຸງ",
    body: `📋 ຖ້ຽວ ${docNo}\n♻️ admin ໄດ້ແກ້ໄຂຂໍ້ມູນຖ້ຽວ`,
    data: { type: "job_updated", doc_no: docNo },
    sales: false,
  });

  return { doc_no: docNo };
}

async function closeJob(session, docNo) {
  await ensureDeliveryWorkflowSchema();
  const currentJob = await queryOne(
    `SELECT job_status, driver FROM odg_tms WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")}`,
    [docNo]
  );
  if (!currentJob) throw new Error("Job not found");
  if (Number(currentJob.job_status ?? 0) !== 3) {
    throw new Error("ສາມາດປິດຖ້ຽວໄດ້ເມື່ອຄົນຂັບປິດງານແລ້ວເທົ່ານັ້ນ");
  }
  await queryOne(
    `UPDATE odg_tms
     SET job_status=4, admin_close_at=LOCALTIMESTAMP(0), admin_close_user=$2
     WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")}`,
    [docNo, session.usercode]
  );
  void pushToTopic({
    candidates: [currentJob.driver],
    title: "✅ ຖ້ຽວຖືກປິດແລ້ວ",
    body: `📋 ຖ້ຽວ ${docNo}\n🏁 admin ປິດຖ້ຽວສຳເລັດ`,
    data: { type: "job_closed", doc_no: docNo },
    sales: false,
  });
}

async function getJobInit(session) {
  await ensurePendingBillSchema();
  await ensureDeliveryWorkflowSchema(pool);
  const fixedToday = getFixedTodayDate();
  const fixedMonth = fixedToday.slice(0, 7);
  const result = await queryOne("SELECT max(doc_no) as doc_no FROM public.odg_tms WHERE to_char(doc_date,'YYYY-MM')=$1", [fixedMonth]);
  const doc_no = nextJobDocNoFromMax(result?.doc_no, fixedMonth);
  const drafts = await query(`SELECT bill_date, to_char(bill_date,'DD-MM-YYYY') as bill_date_display, bill_no, cust_code, telephone, count_item, COALESCE(parent_bill_no, '') as parent_bill_no FROM odg_tms_listbill_draft WHERE user_create=$1 AND ${getFixedYearSqlFilter("bill_date")}`, [session.usercode]);
  const scope = getBranchScope(session);
  const bills = await query(`SELECT a.doc_no, t.doc_date, to_char(t.doc_date,'DD-MM-YYYY') as doc_date_display, a.cust_code, b.telephone, (SELECT count(item_code) FROM ic_trans_detail WHERE doc_no=a.doc_no) as count_item FROM ic_trans_shipment a LEFT JOIN ic_trans t ON t.doc_no=a.doc_no LEFT JOIN ar_customer b ON b.code=a.cust_code INNER JOIN public.odg_tms_pending_bill pb ON pb.bill_no = a.doc_no AND pb.scheduled_date IS NOT NULL AND COALESCE(NULLIF(TRIM(pb.delivery_round_code), ''), NULL) IS NOT NULL WHERE a.trans_flag=44 AND a.check_status=0 AND NOT EXISTS (SELECT 1 FROM public.odg_tms_detail d WHERE d.bill_no = a.doc_no AND COALESCE(d.status, 0) NOT IN (1, 2)) AND a.doc_no NOT IN (SELECT bill_no FROM odg_tms_listbill_draft) ${branchFilterShipment(scope, "a")} AND ${getFixedYearSqlFilter("a.doc_date")}`);
  return { doc_no, drafts, bills };
}

async function getJobAddPageData(session) {
  const { getAvailableBills } = require("./bills");
  const { getTransportDepartmentEmployees, getCars } = require("./master-data");

  const fixedToday = getFixedTodayDate();
  const fixedMonth = fixedToday.slice(0, 7);

  const [result, cars, employees, bills] = await Promise.allSettled([
    queryOne(
      "SELECT max(doc_no) as doc_no FROM public.odg_tms WHERE to_char(doc_date,'YYYY-MM')=$1",
      [fixedMonth]
    ),
    // ຜ່ານ getCars() ບໍ່ແມ່ນ SELECT ຂອງຕົນເອງ — ຈໍສ້າງຖ້ຽວຕ້ອງໄດ້ car_type /
    // transport_code / is_delivery ນຳ ຈຶ່ງກັ່ນເອົາສະເພາະລົດຂົນສົ່ງຂອງສາຂາໄດ້.
    getCars(),
    getTransportDepartmentEmployees(session),
    getAvailableBills(session),
  ]);

  const maxDocNo = result.status === "fulfilled" ? result.value?.doc_no : null;
  const doc_no = nextJobDocNoFromMax(maxDocNo, fixedMonth);

  if (result.status === "rejected") console.error("getJobAddPageData/docNo", result.reason);
  if (cars.status === "rejected") console.error("getJobAddPageData/cars", cars.reason);
  if (employees.status === "rejected") console.error("getJobAddPageData/employees", employees.reason);
  if (bills.status === "rejected") console.error("getJobAddPageData/bills", bills.reason);

  const carList = cars.status === "fulfilled" ? cars.value : [];
  const employeeList = employees.status === "fulfilled" ? employees.value : [];
  const billList = bills.status === "fulfilled" ? bills.value : [];

  // The user's live assigned branch set, so the trip page's branch picker is
  // always current (independent of the cached client session). This is the
  // admin's assignment verbatim — NOT filtered to the hardcoded three internal
  // branches, since a branch like 02-0007 (ໂພນສະອາດ) is a real delivery branch a
  // worker can be assigned to. Empty = unscoped manager (picks a delivery branch).
  const scope = getBranchScope(session);
  const myBranches = scope.branches;

  return { doc_no, cars: carList, drivers: employeeList, workers: employeeList, bills: billList, my_branches: myBranches };
}

async function getJobPrintData(docNo) {
  const { ensureDeliveryRouteSchema } = require("./delivery-route");
  await ensureDeliveryRouteSchema();
  // The bill list below joins odg_tms_custom_bill (hand-typed "ອື່ນໆ" bills).
  const { ensurePendingBillSchema } = require("./pending-bill");
  await ensurePendingBillSchema();
  const header = await queryOne(
    `SELECT
       a.doc_no,
       to_char(a.doc_date,'DD-MM-YYYY') as doc_date,
       to_char(a.date_logistic,'DD-MM-YYYY') as date_logistic,
       to_char(a.create_date_time_now,'DD-MM-YYYY HH24:MI') as created_at,
       COALESCE(NULLIF(TRIM(b.name_1), ''), a.car, '-') as car,
       COALESCE(NULLIF(TRIM(c.name_1), ''), a.driver, '-') as driver,
      COALESCE(NULLIF(TRIM(u.name_1), ''), a.user_created, '-') as user_created,
      COALESCE(NULLIF(TRIM(ap.name_1), ''), a.approve_user, '-') as approve_user,
       COALESCE(a.delivery_route_code, '') as delivery_route_code,
       COALESCE(rt.name, '') as delivery_route_name,
      COALESCE(a.delivery_round_code, '') as delivery_round_code,
       COALESCE(dr.name, '') as delivery_round_name,
       COALESCE(dr.time_label, '') as delivery_round_time_label,
       COALESCE(a.job_status, 0) as job_status
     FROM public.odg_tms a
     LEFT JOIN public.odg_tms_car b ON b.code = a.car
     LEFT JOIN public.odg_tms_driver c ON c.code = a.driver
     LEFT JOIN erp_user u ON u.code = a.user_created
     LEFT JOIN erp_user ap ON ap.code = a.approve_user
     LEFT JOIN public.odg_tms_delivery_route rt ON rt.code = a.delivery_route_code
     LEFT JOIN public.odg_tms_delivery_round dr ON dr.code = a.delivery_round_code
     WHERE a.doc_no = $1 AND ${getFixedYearSqlFilter("a.doc_date")}`,
    [docNo]
  );
  if (!header) throw new Error("ບໍ່ພົບຖ້ຽວ");

  const bills = await query(
    `SELECT
       d.bill_no,
       to_char(d.bill_date,'DD-MM-YYYY') as bill_date,
       d.cust_code,
       COALESCE(NULLIF(TRIM(c.name_1), ''), NULLIF(TRIM(cb.cust_name), ''), d.cust_code, '-') as cust_name,
       COALESCE(NULLIF(TRIM(d.telephone), ''), NULLIF(TRIM(c.telephone), ''), NULLIF(TRIM(cb.telephone), ''), '') as telephone,
       -- ປາຍທາງ: ໃບພິມແບບ "ສະເພາະບິນ" ບໍ່ມີລາຍການສິນຄ້າໃຫ້ອ່ານ ຈຶ່ງຕ້ອງມີ
       -- ບ່ອນສົ່ງໃຫ້ຄົນຂັບແທນ. ໃຊ້ ບ້ານ · ເມືອງ · ແຂວງ ຂອງລູກຄ້າ ບໍ່ແມ່ນ
       -- ic_trans_shipment.destination — ວັດແລ້ວຄໍລຳນັ້ນຫວ່າງທັງໝົດ
       -- (5,135/5,135 ບິນເດືອນຫຼ້າສຸດ)
       ${customerAreaSql("d.cust_code")} as destination,
       COALESCE(cnt.n, 0)::int as item_count,
       COALESCE(cnt.qty, 0)::numeric as total_qty,
       d.roworder
     FROM public.odg_tms_detail d
     LEFT JOIN ar_customer c ON c.code = d.cust_code
     LEFT JOIN public.odg_tms_custom_bill cb ON cb.bill_no = d.bill_no
     LEFT JOIN LATERAL (
       SELECT count(*)::int as n, SUM(COALESCE(i.selected_qty, 0)) as qty
         FROM public.odg_tms_detail_item i
        WHERE i.doc_no = d.doc_no AND i.bill_no = d.bill_no
     ) cnt ON true
     WHERE d.doc_no = $1 AND ${getFixedYearSqlFilter("d.doc_date")}
     ORDER BY d.roworder`,
    [docNo]
  );

  const itemRows = await query(
    `SELECT bill_no, item_code, item_name, qty, selected_qty, unit_code, roworder
     FROM public.odg_tms_detail_item
     WHERE doc_no = $1
     ORDER BY bill_no, roworder`,
    [docNo]
  );

  const itemsByBill = new Map();
  for (const r of itemRows) {
    const list = itemsByBill.get(r.bill_no) ?? [];
    list.push({
      item_code: r.item_code,
      item_name: r.item_name,
      qty: Number(r.qty ?? 0),
      selected_qty: Number(r.selected_qty ?? 0),
      unit_code: r.unit_code ?? "",
    });
    itemsByBill.set(r.bill_no, list);
  }

  return {
    header,
    bills: bills.map((b) => ({
      bill_no: b.bill_no,
      bill_date: b.bill_date,
      cust_code: b.cust_code,
      cust_name: b.cust_name,
      telephone: b.telephone,
      destination: b.destination ?? "",
      item_count: Number(b.item_count ?? 0),
      total_qty: Number(b.total_qty ?? 0),
      items: itemsByBill.get(b.bill_no) ?? [],
    })),
  };
}

async function getJobBillsWithProducts(docNo) {
  const bills = await query(
    `SELECT a.bill_no, to_char(a.bill_date,'DD-MM-YYYY') as bill_date, a.cust_code, b.name_1 as cust_name, a.count_item, a.telephone,
            CASE WHEN a.recipt_job IS NULL THEN false ELSE true END AS picked_up
     FROM public.odg_tms_detail a
     LEFT JOIN ar_customer b ON b.code=a.cust_code
     WHERE a.doc_no=$1 ORDER BY a.roworder`,
    [docNo]
  );
  if (bills.length === 0) return [];

  const selectedProducts = await query(
    `SELECT bill_no, item_code, item_name, selected_qty as qty, unit_code
     FROM public.odg_tms_detail_item
     WHERE doc_no=$1
     ORDER BY bill_no, roworder`,
    [docNo]
  ).catch(() => []);

  const selectedByBill = new Map();
  for (const product of selectedProducts) {
    const list = selectedByBill.get(product.bill_no) ?? [];
    list.push(product);
    selectedByBill.set(product.bill_no, list);
  }

  const missingBillNos = bills
    .map((bill) => bill.bill_no)
    .filter((billNo) => !selectedByBill.has(billNo));

  const fallbackProducts = missingBillNos.length
    ? await query(
        `SELECT doc_no as bill_no, item_code, item_name, qty, unit_code
         FROM ic_trans_detail
         WHERE doc_no = ANY($1::varchar[])
         ORDER BY doc_no, item_code`,
        [missingBillNos]
      )
    : [];

  const fallbackByBill = new Map();
  for (const product of fallbackProducts) {
    const list = fallbackByBill.get(product.bill_no) ?? [];
    list.push(product);
    fallbackByBill.set(product.bill_no, list);
  }

  return bills.map((bill) => ({
    ...bill,
    products: (selectedByBill.get(bill.bill_no) ?? fallbackByBill.get(bill.bill_no) ?? []).map(
      (product) => ({ ...product, qty: Number(product.qty ?? 0) })
    ),
  }));
}

async function addBillToDraft(session, data) {
  await ensurePendingBillSchema();
  // ensureDeliveryWorkflowSchema owns the parent_bill_no column on
  // odg_tms_listbill_draft. Call it so a fresh DB has the column before the
  // INSERT below references it. Idempotent + process-cached.
  await ensureDeliveryWorkflowSchema(pool);
  const fixedDocDate = coerceDateToFixedYear(data.ref_doc_date);
  const parentBillNo = data.parent_bill_no && String(data.parent_bill_no).trim()
    ? String(data.parent_bill_no).trim()
    : null;
  await queryOne(
    "INSERT INTO odg_tms_listbill_draft(bill_date, bill_no, cust_code, user_create, count_item, telephone, parent_bill_no) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [fixedDocDate, data.ref_doc_no, data.ref_cust_code, session.usercode, data.count_item, data.telephone, parentBillNo]
  );
  await queryOne(`UPDATE ic_trans_shipment SET check_status=1 WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")}`, [data.ref_doc_no]);
  const scope = getBranchScope(session);
  const drafts = await query(`SELECT bill_date, to_char(bill_date,'DD-MM-YYYY') as bill_date_display, bill_no, cust_code, telephone, count_item, COALESCE(parent_bill_no, '') as parent_bill_no FROM odg_tms_listbill_draft WHERE user_create=$1 AND ${getFixedYearSqlFilter("bill_date")}`, [session.usercode]);
  const bills = await query(`SELECT a.doc_no, t.doc_date, to_char(t.doc_date,'DD-MM-YYYY') as doc_date_display, a.cust_code, b.telephone, (SELECT count(item_code) FROM ic_trans_detail WHERE doc_no=a.doc_no) as count_item FROM ic_trans_shipment a LEFT JOIN ic_trans t ON t.doc_no=a.doc_no LEFT JOIN ar_customer b ON b.code=a.cust_code INNER JOIN public.odg_tms_pending_bill pb ON pb.bill_no = a.doc_no AND pb.scheduled_date IS NOT NULL AND COALESCE(NULLIF(TRIM(pb.delivery_round_code), ''), NULL) IS NOT NULL WHERE a.trans_flag=44 AND a.check_status=0 AND NOT EXISTS (SELECT 1 FROM public.odg_tms_detail d WHERE d.bill_no = a.doc_no AND COALESCE(d.status, 0) NOT IN (1, 2)) AND a.doc_no NOT IN (SELECT bill_no FROM odg_tms_listbill_draft) ${branchFilterShipment(scope, "a")} AND ${getFixedYearSqlFilter("a.doc_date")}`);
  return { drafts, bills };
}

async function removeBillFromDraft(session, billNo) {
  await ensurePendingBillSchema();
  await ensureDeliveryWorkflowSchema(pool);
  await queryOne(`DELETE FROM odg_tms_listbill_draft WHERE bill_no=$1 AND ${getFixedYearSqlFilter("bill_date")}`, [billNo]);
  await queryOne(`UPDATE ic_trans_shipment SET check_status=0 WHERE doc_no=$1 AND ${getFixedYearSqlFilter("doc_date")}`, [billNo]);
  const scope = getBranchScope(session);
  const drafts = await query(`SELECT bill_date, to_char(bill_date,'DD-MM-YYYY') as bill_date_display, bill_no, cust_code, telephone, count_item, COALESCE(parent_bill_no, '') as parent_bill_no FROM odg_tms_listbill_draft WHERE user_create=$1 AND ${getFixedYearSqlFilter("bill_date")}`, [session.usercode]);
  const bills = await query(`SELECT a.doc_no, t.doc_date, to_char(t.doc_date,'DD-MM-YYYY') as doc_date_display, a.cust_code, b.telephone, (SELECT count(item_code) FROM ic_trans_detail WHERE doc_no=a.doc_no) as count_item FROM ic_trans_shipment a LEFT JOIN ic_trans t ON t.doc_no=a.doc_no LEFT JOIN ar_customer b ON b.code=a.cust_code INNER JOIN public.odg_tms_pending_bill pb ON pb.bill_no = a.doc_no AND pb.scheduled_date IS NOT NULL AND COALESCE(NULLIF(TRIM(pb.delivery_round_code), ''), NULL) IS NOT NULL WHERE a.trans_flag=44 AND a.check_status=0 AND NOT EXISTS (SELECT 1 FROM public.odg_tms_detail d WHERE d.bill_no = a.doc_no AND COALESCE(d.status, 0) NOT IN (1, 2)) AND a.doc_no NOT IN (SELECT bill_no FROM odg_tms_listbill_draft) ${branchFilterShipment(scope, "a")} AND ${getFixedYearSqlFilter("a.doc_date")}`);
  return { drafts, bills };
}

// Bill search for the trip builder. Scheduling is NOT required: a bill that
// nobody has scheduled yet is still findable here and can be dropped straight
// into a ຮ່າງຖ້ຽວ — the trip's own ວັນ / ຮອບ / ສາຍ then become the bill's
// schedule when the trip is saved (see scheduleBillsFromJob in createJob).
// `unscheduled` lets the UI mark those so the dispatcher knows what they are.
async function searchBills(session, q) {
  await ensurePendingBillSchema();
  const scope = getBranchScope(session);
  return query(`SELECT a.doc_no, t.doc_date, to_char(t.doc_date,'DD-MM-YYYY') as doc_date_display, a.cust_code, b.telephone, (SELECT count(item_code) FROM ic_trans_detail WHERE doc_no=a.doc_no) as count_item, (pb.bill_no IS NULL OR pb.scheduled_date IS NULL OR NULLIF(TRIM(pb.delivery_round_code), '') IS NULL) as unscheduled FROM ic_trans_shipment a LEFT JOIN ic_trans t ON t.doc_no=a.doc_no LEFT JOIN ar_customer b ON b.code=a.cust_code LEFT JOIN public.odg_tms_pending_bill pb ON pb.bill_no = a.doc_no WHERE a.trans_flag=44 AND a.check_status=0 AND NOT EXISTS (SELECT 1 FROM public.odg_tms_detail d WHERE d.bill_no = a.doc_no AND COALESCE(d.status, 0) NOT IN (1, 2)) AND a.doc_no NOT IN (SELECT bill_no FROM odg_tms_listbill_draft) ${branchFilterShipment(scope, "a")} AND ${getFixedYearSqlFilter("a.doc_date")} AND (a.doc_no LIKE $1 OR a.cust_code LIKE $1) LIMIT 10`, [`%${q}%`]);
}

// Free-text search across ic_trans master so admins can attach bills that
// aren't surfaced by the default available-bills list — e.g. bills from
// another branch or ones not yet registered in ic_trans_shipment.
async function searchBillsForJob(q, excludeDocNo) {
  const text = String(q ?? "").trim();
  if (text.length < 2) return [];

  const params = [`%${text}%`];
  let excludeClause = "";
  if (excludeDocNo) {
    params.push(excludeDocNo);
    excludeClause = `AND a.doc_no NOT IN (
      SELECT bill_no FROM public.odg_tms_detail
      WHERE doc_no=$${params.length} AND ${getFixedYearSqlFilter("doc_date")}
    )`;
  }

  // Exclude any bill already routed via ic_trans_shipment so the master-search
  // surface only adds genuinely new bills (the shipment-linked ones already
  // appear in the default available-bills list).
  const rows = await query(
    `SELECT a.doc_no,
            to_char(a.doc_date,'DD-MM-YYYY') as doc_date,
            a.cust_code,
            b.name_1 as cust_name,
            b.telephone
     FROM ic_trans a
     LEFT JOIN ar_customer b ON b.code = a.cust_code
     WHERE ${getFixedYearSqlFilter("a.doc_date")}
       AND (a.doc_no ILIKE $1 OR a.cust_code ILIKE $1 OR COALESCE(b.name_1, '') ILIKE $1)
       AND a.doc_no NOT IN (
         SELECT s.doc_no FROM ic_trans_shipment s
         WHERE ${getFixedYearSqlFilter("s.doc_date")}
       )
       ${excludeClause}
     ORDER BY a.doc_date DESC
     LIMIT 30`,
    params
  );
  if (rows.length === 0) return [];

  // Only surface bills that still have remaining items to dispatch.
  const summaries = await getRemainingSummaryMap(rows.map((r) => r.doc_no));
  return rows
    .map((r) => ({
      ...r,
      count_item: summaries.get(r.doc_no)?.remaining_count ?? 0,
    }))
    .filter((r) => r.count_item > 0);
}

// ============ Jobs by status ============

async function getJobsByStatus(session, fromDate, toDate, jobStatus) {
  const { getBranchScope, branchFilterJob } = require("./helpers");
  const scope = getBranchScope(session);
  const from = coerceDateToFixedYear(fromDate ?? getFixedTodayDate());
  const to = coerceDateToFixedYear(toDate ?? getFixedTodayDate());
  return query(
    `WITH bill_summary AS (
      SELECT d.doc_no,
        COUNT(*)::int AS total_bills,
        COUNT(*) FILTER (WHERE d.recipt_job IS NULL AND COALESCE(d.status, 0) NOT IN (1, 2))::int AS pending_pickup_count,
        COUNT(*) FILTER (WHERE d.recipt_job IS NOT NULL)::int AS picked_count,
        COUNT(*) FILTER (WHERE COALESCE(d.status, 0) = 1)::int AS completed_count,
        COUNT(*) FILTER (WHERE COALESCE(d.status, 0) = 2)::int AS cancelled_count
      FROM public.odg_tms_detail d
      WHERE ${getFixedYearSqlFilter("d.doc_date")}
      GROUP BY d.doc_no
    )
    SELECT
      to_char(a.doc_date,'DD-MM-YYYY') as doc_date,
      a.doc_no,
      to_char(a.date_logistic,'DD-MM-YYYY') as date_logistic,
      to_char(a.create_date_time_now,'DD-MM-YYYY HH24:MI') as created_at,
      to_char(a.job_close,'DD-MM-YYYY HH24:MI') as driver_closed_at,
      to_char(a.admin_close_at,'DD-MM-YYYY HH24:MI') as admin_closed_at,
      COALESCE(NULLIF(TRIM(b.name_1), ''), a.car, '-') as car,
      COALESCE(NULLIF(TRIM(c.name_1), ''), a.driver, '-') as driver,
      COALESCE(NULLIF(TRIM(uc.name_1), ''), a.user_created, '-') as user_created,
      COALESCE(NULLIF(TRIM(ap.name_1), ''), a.approve_user, '-') as approve_user,
      COALESCE(NULLIF(TRIM(adc.name_1), ''), a.admin_close_user, '-') as admin_close_user,
      a.item_bill,
      COALESCE(bs.pending_pickup_count, 0) as pending_pickup_count,
      COALESCE(bs.picked_count, 0) as picked_count,
      COALESCE(bs.completed_count, 0) as completed_count,
      COALESCE(bs.cancelled_count, 0) as cancelled_count,
      -- Aliases used by the waiting-receive page
      COALESCE(bs.picked_count, 0) as received_count,
      COALESCE(bs.pending_pickup_count, 0) as pending_receive_count,
      COALESCE(a.miles_start, '') as miles_start,
      COALESCE(a.miles_end, '') as miles_end,
      COALESCE(a.job_status, 0) as job_status
    FROM odg_tms a
    LEFT JOIN public.odg_tms_car b ON b.code = a.car
    LEFT JOIN public.odg_tms_driver c ON c.code = a.driver
    LEFT JOIN erp_user uc ON uc.code = a.user_created
    LEFT JOIN erp_user ap ON ap.code = a.approve_user
    LEFT JOIN erp_user adc ON adc.code = a.admin_close_user
    LEFT JOIN bill_summary bs ON bs.doc_no = a.doc_no
    WHERE COALESCE(a.approve_status, 0) = 1
      AND COALESCE(a.job_status, 0) = $3
      AND a.date_logistic BETWEEN $1 AND $2
      AND ${getFixedYearSqlFilter("a.doc_date")}
      ${branchFilterJob(scope, "a")}
    ORDER BY a.date_logistic DESC, a.doc_no DESC`,
    [from, to, jobStatus]
  );
}

// Jobs ready for admin closing — surfaces both:
//   1. job_status = 3 (driver tapped ປິດງານ — original case)
//   2. job_status = 2 (driver still in transit) BUT every bill is finalised
//      (sent_end set OR status IN 1/2). Trips like 20260500131 land here
//      when the driver finished delivering everything yet forgot to close
//      the trip — admin needs to be able to close it for them.
async function getJobsClosedByDriver(session, fromDate, toDate) {
  const { getBranchScope, branchFilterJob } = require("./helpers");
  const scope = getBranchScope(session);
  const from = coerceDateToFixedYear(fromDate ?? getFixedTodayDate());
  const to = coerceDateToFixedYear(toDate ?? getFixedTodayDate());
  return query(
    `WITH bill_summary AS (
      SELECT d.doc_no,
        COUNT(*)::int AS total_bills,
        COUNT(*) FILTER (WHERE d.recipt_job IS NULL AND COALESCE(d.status, 0) NOT IN (1, 2))::int AS pending_pickup_count,
        COUNT(*) FILTER (WHERE d.recipt_job IS NOT NULL)::int AS picked_count,
        COUNT(*) FILTER (WHERE COALESCE(d.status, 0) = 1)::int AS completed_count,
        COUNT(*) FILTER (WHERE COALESCE(d.status, 0) = 2)::int AS cancelled_count,
        COUNT(*) FILTER (
          WHERE COALESCE(d.status, 0) NOT IN (1, 2) AND d.sent_end IS NULL
        )::int AS open_count
      FROM public.odg_tms_detail d
      WHERE ${getFixedYearSqlFilter("d.doc_date")}
      GROUP BY d.doc_no
    )
    SELECT
      to_char(a.doc_date,'DD-MM-YYYY') as doc_date,
      a.doc_no,
      to_char(a.date_logistic,'DD-MM-YYYY') as date_logistic,
      to_char(a.create_date_time_now,'DD-MM-YYYY HH24:MI') as created_at,
      to_char(a.job_close,'DD-MM-YYYY HH24:MI') as driver_closed_at,
      to_char(a.admin_close_at,'DD-MM-YYYY HH24:MI') as admin_closed_at,
      COALESCE(NULLIF(TRIM(b.name_1), ''), a.car, '-') as car,
      COALESCE(NULLIF(TRIM(c.name_1), ''), a.driver, '-') as driver,
      COALESCE(NULLIF(TRIM(uc.name_1), ''), a.user_created, '-') as user_created,
      COALESCE(NULLIF(TRIM(ap.name_1), ''), a.approve_user, '-') as approve_user,
      COALESCE(NULLIF(TRIM(adc.name_1), ''), a.admin_close_user, '-') as admin_close_user,
      a.item_bill,
      COALESCE(bs.pending_pickup_count, 0) as pending_pickup_count,
      COALESCE(bs.picked_count, 0) as picked_count,
      COALESCE(bs.completed_count, 0) as completed_count,
      COALESCE(bs.cancelled_count, 0) as cancelled_count,
      COALESCE(bs.picked_count, 0) as received_count,
      COALESCE(bs.pending_pickup_count, 0) as pending_receive_count,
      COALESCE(a.miles_start, '') as miles_start,
      COALESCE(a.miles_end, '') as miles_end,
      COALESCE(a.job_status, 0) as job_status
    FROM odg_tms a
    LEFT JOIN public.odg_tms_car b ON b.code = a.car
    LEFT JOIN public.odg_tms_driver c ON c.code = a.driver
    LEFT JOIN erp_user uc ON uc.code = a.user_created
    LEFT JOIN erp_user ap ON ap.code = a.approve_user
    LEFT JOIN erp_user adc ON adc.code = a.admin_close_user
    LEFT JOIN bill_summary bs ON bs.doc_no = a.doc_no
    WHERE COALESCE(a.approve_status, 0) = 1
      AND a.date_logistic BETWEEN $1 AND $2
      AND ${getFixedYearSqlFilter("a.doc_date")}
      AND (
        COALESCE(a.job_status, 0) = 3
        OR (
          COALESCE(a.job_status, 0) = 2
          AND COALESCE(bs.total_bills, 0) > 0
          AND COALESCE(bs.open_count, 0) = 0
        )
      )
      ${branchFilterJob(scope, "a")}
    ORDER BY a.date_logistic DESC, a.doc_no DESC`,
    [from, to]
  );
}

async function getJobsClosed(session, fromDate, toDate) {
  return getJobsByStatus(session, fromDate, toDate, 4);
}

// Approved jobs that the driver hasn't received yet (job_status=0).
async function getJobsWaitingReceive(session, fromDate, toDate) {
  const { getBranchScope, branchFilterJob } = require("./helpers");
  const scope = getBranchScope(session);
  const from = coerceDateToFixedYear(fromDate ?? getFixedTodayDate());
  const to = coerceDateToFixedYear(toDate ?? getFixedTodayDate());
  return query(
    `WITH bill_summary AS (
      SELECT d.doc_no,
        COUNT(*)::int AS total_bills,
        COUNT(*) FILTER (WHERE d.recipt_job IS NULL AND COALESCE(d.status, 0) NOT IN (1, 2))::int AS pending_receive_count,
        COUNT(*) FILTER (WHERE d.recipt_job IS NOT NULL)::int AS received_count
      FROM public.odg_tms_detail d
      WHERE ${getFixedYearSqlFilter("d.doc_date")}
      GROUP BY d.doc_no
    )
    SELECT
      to_char(a.doc_date,'DD-MM-YYYY') as doc_date,
      a.doc_no,
      to_char(a.date_logistic,'DD-MM-YYYY') as date_logistic,
      to_char(a.create_date_time_now,'DD-MM-YYYY HH24:MI') as created_at,
      COALESCE(NULLIF(TRIM(b.name_1), ''), a.car, '-') as car,
      COALESCE(NULLIF(TRIM(c.name_1), ''), a.driver, '-') as driver,
      COALESCE(NULLIF(TRIM(uc.name_1), ''), a.user_created, '-') as user_created,
      COALESCE(NULLIF(TRIM(ap.name_1), ''), a.approve_user, '-') as approve_user,
      a.item_bill,
      COALESCE(bs.pending_receive_count, 0) as pending_receive_count,
      COALESCE(bs.received_count, 0) as received_count,
      COALESCE(a.job_status, 0) as job_status
    FROM odg_tms a
    LEFT JOIN public.odg_tms_car b ON b.code = a.car
    LEFT JOIN public.odg_tms_driver c ON c.code = a.driver
    LEFT JOIN erp_user uc ON uc.code = a.user_created
    LEFT JOIN erp_user ap ON ap.code = a.approve_user
    LEFT JOIN bill_summary bs ON bs.doc_no = a.doc_no
    WHERE COALESCE(a.approve_status, 0) = 1
      AND COALESCE(a.job_status, 0) = 0
      AND a.date_logistic BETWEEN $1 AND $2
      AND ${getFixedYearSqlFilter("a.doc_date")}
      ${branchFilterJob(scope, "a")}
    ORDER BY a.date_logistic DESC, a.doc_no DESC`,
    [from, to]
  );
}

// Jobs the driver has received (job_status=1). The driver still needs to
// pick up the bills before they can start dispatching. We surface the count
// of unpicked bills so the UI can show progress.
async function getJobsWaitingPickup(session, fromDate, toDate) {
  const { getBranchScope, branchFilterJob } = require("./helpers");
  const scope = getBranchScope(session);
  const from = coerceDateToFixedYear(fromDate ?? getFixedTodayDate());
  const to = coerceDateToFixedYear(toDate ?? getFixedTodayDate());
  return query(
    `WITH bill_summary AS (
      SELECT d.doc_no,
        COUNT(*)::int AS total_bills,
        COUNT(*) FILTER (WHERE d.recipt_job IS NULL AND COALESCE(d.status, 0) NOT IN (1, 2))::int AS pending_pickup_count,
        COUNT(*) FILTER (WHERE d.recipt_job IS NOT NULL)::int AS picked_count,
        COUNT(*) FILTER (WHERE COALESCE(d.status, 0) = 1)::int AS completed_count,
        COUNT(*) FILTER (WHERE COALESCE(d.status, 0) = 2)::int AS cancelled_count
      FROM public.odg_tms_detail d
      WHERE ${getFixedYearSqlFilter("d.doc_date")}
      GROUP BY d.doc_no
    )
    SELECT
      to_char(a.doc_date,'DD-MM-YYYY') as doc_date,
      a.doc_no,
      to_char(a.date_logistic,'DD-MM-YYYY') as date_logistic,
      to_char(a.create_date_time_now,'DD-MM-YYYY HH24:MI') as created_at,
      COALESCE(NULLIF(TRIM(b.name_1), ''), a.car, '-') as car,
      COALESCE(NULLIF(TRIM(c.name_1), ''), a.driver, '-') as driver,
      COALESCE(NULLIF(TRIM(uc.name_1), ''), a.user_created, '-') as user_created,
      COALESCE(NULLIF(TRIM(ap.name_1), ''), a.approve_user, '-') as approve_user,
      a.item_bill,
      COALESCE(bs.pending_pickup_count, 0) as pending_pickup_count,
      COALESCE(bs.picked_count, 0) as picked_count,
      COALESCE(a.job_status, 0) as job_status
    FROM odg_tms a
    LEFT JOIN public.odg_tms_car b ON b.code = a.car
    LEFT JOIN public.odg_tms_driver c ON c.code = a.driver
    LEFT JOIN erp_user uc ON uc.code = a.user_created
    LEFT JOIN erp_user ap ON ap.code = a.approve_user
    LEFT JOIN bill_summary bs ON bs.doc_no = a.doc_no
    WHERE COALESCE(a.approve_status, 0) = 1
      AND COALESCE(a.job_status, 0) = 1
      AND a.date_logistic BETWEEN $1 AND $2
      AND ${getFixedYearSqlFilter("a.doc_date")}
      AND COALESCE(bs.pending_pickup_count, 0) > 0
      ${branchFilterJob(scope, "a")}
    ORDER BY a.date_logistic DESC, a.doc_no DESC`,
    [from, to]
  );
}

// Jobs that haven't started pickup yet — valid destinations for moveBillToJob.
async function listPickupReadyJobs(session, excludeDocNo) {
  const scope = getBranchScope(session);
  const params = [];
  let exclude = "";
  if (excludeDocNo) {
    params.push(String(excludeDocNo));
    exclude = `AND a.doc_no <> $${params.length}`;
  }
  return query(
    `SELECT a.doc_no,
            to_char(a.doc_date,'DD-MM-YYYY') as doc_date,
            to_char(a.date_logistic,'DD-MM-YYYY') as date_logistic,
            COALESCE(NULLIF(TRIM(c.name_1), ''), a.car, '-') as car,
            COALESCE(NULLIF(TRIM(d.name_1), ''), a.driver, '-') as driver,
            (SELECT COUNT(*)::int FROM public.odg_tms_detail dd WHERE dd.doc_no = a.doc_no) as bill_count
     FROM public.odg_tms a
     LEFT JOIN public.odg_tms_car c ON c.code = a.car
     LEFT JOIN public.odg_tms_driver d ON d.code = a.driver
     WHERE COALESCE(a.approve_status, 0) = 1
       AND COALESCE(a.job_status, 0) = 0
       AND ${getFixedYearSqlFilter("a.doc_date")}
       ${exclude}
       ${branchFilterJob(scope, "a")}
     ORDER BY a.date_logistic ASC, a.doc_no ASC`,
    params
  );
}

// Move a single bill from one pre-pickup job to another. Both jobs must
// have job_status=0 and the bill must not yet have been picked up.
async function moveBillToJob(sourceDocNo, billNo, destDocNo) {
  const source = String(sourceDocNo ?? "").trim();
  const dest = String(destDocNo ?? "").trim();
  const bill = String(billNo ?? "").trim();
  if (!source || !dest || !bill) {
    throw new Error("Missing source/destination doc_no or bill_no");
  }
  if (source === dest) {
    throw new Error("Source and destination jobs must differ");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lockSource = await client.query(
      `SELECT job_status, doc_date, date_logistic, car FROM public.odg_tms WHERE doc_no = $1 FOR UPDATE`,
      [source]
    );
    const lockDest = await client.query(
      `SELECT job_status, doc_date, date_logistic, car FROM public.odg_tms WHERE doc_no = $1 FOR UPDATE`,
      [dest]
    );
    if (lockSource.rows.length === 0) throw new Error("ບໍ່ພົບຖ້ຽວຕົ້ນທາງ");
    if (lockDest.rows.length === 0) throw new Error("ບໍ່ພົບຖ້ຽວປາຍທາງ");
    if (Number(lockSource.rows[0].job_status ?? 0) !== 0) {
      throw new Error("ຖ້ຽວຕົ້ນທາງເລີ່ມຮັບແລ້ວ — ຍ້າຍບໍ່ໄດ້");
    }
    if (Number(lockDest.rows[0].job_status ?? 0) !== 0) {
      throw new Error("ຖ້ຽວປາຍທາງເລີ່ມຮັບແລ້ວ — ຍ້າຍບໍ່ໄດ້");
    }
    const billLock = await client.query(
      `SELECT recipt_job, status FROM public.odg_tms_detail WHERE doc_no = $1 AND bill_no = $2 FOR UPDATE`,
      [source, bill]
    );
    if (billLock.rows.length === 0) {
      throw new Error("ບໍ່ພົບບິນໃນຖ້ຽວຕົ້ນທາງ");
    }
    if (billLock.rows[0].recipt_job != null) {
      throw new Error("ບິນຮັບແລ້ວ — ຍ້າຍບໍ່ໄດ້");
    }
    if ([1, 2].includes(Number(billLock.rows[0].status ?? 0))) {
      throw new Error("ບິນສະຖານະປິດແລ້ວ — ຍ້າຍບໍ່ໄດ້");
    }
    const conflict = await client.query(
      `SELECT 1 FROM public.odg_tms_detail WHERE doc_no = $1 AND bill_no = $2 LIMIT 1`,
      [dest, bill]
    );
    if (conflict.rowCount > 0) {
      throw new Error("ບິນນີ້ຢູ່ຖ້ຽວປາຍທາງແລ້ວ — ຍ້າຍບໍ່ໄດ້");
    }
    const { doc_date: destDocDate, date_logistic: destDateLog, car: destCar } = lockDest.rows[0];
    // Defensive: drop any orphan items lingering on dest for this bill_no
    // (would otherwise duplicate after the UPDATE pulls source's items in).
    await client.query(
      `DELETE FROM public.odg_tms_detail_item WHERE doc_no = $1 AND bill_no = $2`,
      [dest, bill]
    );
    await client.query(
      `UPDATE public.odg_tms_detail
         SET doc_no = $1,
             doc_date = $2,
             date_logistic = $3,
             car = $4
       WHERE doc_no = $5 AND bill_no = $6`,
      [dest, destDocDate, destDateLog, destCar, source, bill]
    );
    await client.query(
      `UPDATE public.odg_tms_detail_item
         SET doc_no = $1
       WHERE doc_no = $2 AND bill_no = $3`,
      [dest, source, bill]
    );
    await client.query("COMMIT");
    return { success: true };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Re-classify a "ສົ່ງລູກຄ້າ" (to_customer) stop as "ສົ່ງສາຂາ" (to_branch)
// without re-keying anything — the dispatcher picked the wrong destination.
// Works for a stop that is still in delivery (ກຳລັງຈັດສົ່ງ) / waiting just as
// it does for one the driver already closed: in both cases this reproduces the
// exact end-state the native to_branch completion path leaves behind
// (mobile complete_bill → forwardToBranch). The detail row is flagged forwarded
// + relabelled and force-finalised (status=1, sent_start/sent_end stamped if the
// stop hadn't started/finished yet), the per-item delivered_qty is zeroed
// (nothing actually reached the customer on this mis-classified leg), and the
// shipment is moved to the receiving branch and released (check_status=0) so that
// branch's available-bills queue can dispatch it onward to the customer.
// Allowed on any stop that isn't already a forward and wasn't cancelled.
async function reclassifyDeliveredBillToBranch(session, docNo, billNo, forwardTransportCode) {
  await ensureForwardBranchColumn();
  // delivery_condition lives on the delivery-workflow schema.
  await ensureDeliveryWorkflowSchema(pool);
  // We re-home the bill onto the receiving branch's pending queue below.
  await ensurePendingBillSchema();

  const doc = String(docNo ?? "").trim();
  const bill = String(billNo ?? "").trim();
  const branch = String(forwardTransportCode ?? "").trim();
  if (!doc || !bill) throw new Error("ຕ້ອງລະບຸ doc_no ແລະ bill_no");
  if (!branch) throw new Error("ກະລຸນາເລືອກສາຂາປາຍທາງ");

  // Forward target must be a real internal delivery branch (transport_type
  // 02-xxxx) — never the customer self-pickup pseudo-branch 02-0004.
  const branchRow = await queryOne(
    `SELECT code, name_1 FROM public.transport_type
     WHERE code = $1 AND code LIKE '02-%' AND code <> '02-0004'`,
    [branch]
  );
  if (!branchRow) throw new Error("ສາຂາປາຍທາງບໍ່ຖືກຕ້ອງ");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query(
      `SELECT COALESCE(status, 0) AS status,
              NULLIF(TRIM(forward_transport_code), '') AS forward_transport_code
       FROM public.odg_tms_detail
       WHERE doc_no = $1 AND bill_no = $2 AND ${getFixedYearSqlFilter("doc_date")}
       FOR UPDATE`,
      [doc, bill]
    );
    if (lock.rows.length === 0) throw new Error("ບໍ່ພົບບິນໃນຖ້ຽວນີ້");
    const detail = lock.rows[0];
    if (Number(detail.status) === 2) {
      throw new Error("ບິນທີ່ຍົກເລີກແລ້ວ ບໍ່ສາມາດແກ້ເປັນສົ່ງສາຂາ");
    }
    if (detail.forward_transport_code) {
      throw new Error("ບິນນີ້ເປັນ 'ສົ່ງສາຂາ' ຢູ່ແລ້ວ");
    }
    // An in-delivery (ກຳລັງຈັດສົ່ງ) / waiting stop hasn't been finalised yet, so
    // we also stamp its completion below + dispatch the trip (matching the native
    // forward path). A driver-closed stop (status=1) keeps its real timestamps.
    const wasCompleted = Number(detail.status) === 1;

    // Can't forward to the very branch that just delivered it.
    const trip = await client.query(
      `SELECT COALESCE(origin_transport_code, '') AS origin_transport_code
       FROM public.odg_tms WHERE doc_no = $1`,
      [doc]
    );
    const origin = trip.rows[0]?.origin_transport_code ?? "";
    if (origin && origin === branch) {
      throw new Error("ສາຂາປາຍທາງຊ້ຳກັບສາຂາທີ່ຈັດສົ່ງ");
    }
    // Legacy trips can have no origin_transport_code anchor — they show in a
    // branch's scoped lists only via the bill's CURRENT shipment branch
    // (branchFilterJob). Capture that branch now, BEFORE we move the shipment to
    // the destination below, so we can backfill the anchor and stop the trip
    // (and this forwarded row) from vanishing out of the source branch's views.
    const shipBefore = await client.query(
      `SELECT NULLIF(TRIM(transport_code), '') AS transport_code
       FROM ic_trans_shipment WHERE doc_no = $1`,
      [bill]
    );
    const sourceBranch = shipBefore.rows[0]?.transport_code ?? "";

    await client.query(
      `UPDATE public.odg_tms_detail
       SET forward_transport_code = $3,
           delivery_condition = 'to_branch',
           status = 1,
           sent_start = COALESCE(sent_start, LOCALTIMESTAMP(0)),
           sent_end = COALESCE(sent_end, LOCALTIMESTAMP(0))
       WHERE doc_no = $1 AND bill_no = $2 AND ${getFixedYearSqlFilter("doc_date")}`,
      [doc, bill, branch]
    );
    // Nothing reached the customer on this mis-classified leg — reset the
    // per-item delivered_qty so the forwarded bill carries its full quantity to
    // the receiving branch, matching a native to_branch completion (which never
    // records per-item customer delivery on the forward leg).
    await client.query(
      `UPDATE public.odg_tms_detail_item
       SET delivered_qty = 0
       WHERE doc_no = $1 AND bill_no = $2`,
      [doc, bill]
    );
    // Move the shipment to the receiving branch and release it — the same
    // UPDATE the native forward-completion path runs (mobile.js complete_bill).
    await client.query(
      `UPDATE ic_trans_shipment SET transport_code = $2, check_status = 0 WHERE doc_no = $1`,
      [bill, branch]
    );
    // Re-home the bill onto the receiving branch's pending queue: pin its
    // transport to that branch and clear the originating branch's stale schedule
    // so it surfaces in "ລໍຖ້າຈັດຖ້ຽວ" as a fresh, to-be-scheduled stop (flagged
    // incoming-forwarded) instead of carrying the old branch's date/round.
    await client.query(
      `INSERT INTO public.odg_tms_pending_bill (bill_no, transport_code, scheduled_date, delivery_round_code, delivery_route_code, updated_at)
       VALUES ($1, $2, NULL, NULL, NULL, LOCALTIMESTAMP(0))
       ON CONFLICT (bill_no) DO UPDATE
         SET transport_code = EXCLUDED.transport_code,
             scheduled_date = NULL,
             delivery_round_code = NULL,
             delivery_route_code = NULL,
             updated_at = LOCALTIMESTAMP(0)`,
      [bill, branch]
    );
    // Anchor a legacy NULL-origin trip to the branch that operated it, so it
    // stays in that branch's scoped lists (ກຳລັງຈັດສົ່ງ / ຈັດສົ່ງສຳເລັດ) as a
    // 'ສົ່ງຕໍ່ → ສາຂາ' record now that the shipment has moved away.
    if (!origin && sourceBranch && sourceBranch !== branch) {
      await client.query(
        `UPDATE public.odg_tms
            SET origin_transport_code = $2
          WHERE doc_no = $1
            AND NULLIF(TRIM(origin_transport_code), '') IS NULL
            AND ${getFixedYearSqlFilter("doc_date")}`,
        [doc, sourceBranch]
      );
    }

    // Forwarding an in-delivery / waiting stop finalises it mid-trip, so make
    // sure the trip itself is marked dispatched — the same job_status bump the
    // native forward-completion path runs. No-op for an already-dispatched or
    // closed trip (job_status >= 2), so a completed-bill correction is untouched.
    if (!wasCompleted) {
      await client.query(
        `UPDATE odg_tms
         SET job_status = CASE WHEN COALESCE(job_status, 0) < 2 THEN 2 ELSE job_status END,
             dispatch_started_at = COALESCE(dispatch_started_at, LOCALTIMESTAMP(0))
         WHERE doc_no = $1 AND ${getFixedYearSqlFilter("doc_date")}`,
        [doc]
      );
    }

    await client.query("COMMIT");

    // Best-effort, post-commit side effects (neither can roll back the change).
    void recordAudit({
      action: "reclassify_to_branch",
      entityType: "bill",
      entityId: bill,
      userCode: session?.usercode ?? null,
      changes: {
        doc_no: doc,
        from: "to_customer",
        to: "to_branch",
        forward_transport_code: branchRow.code,
        forward_transport_name: branchRow.name_1,
      },
    });
    // Heads-up to the receiving branch (the bill also appears in their queue).
    void notifyBillForwardedToBranch(bill, branchRow.code, branchRow.name_1);

    return {
      success: true,
      doc_no: doc,
      bill_no: bill,
      forward_transport_code: branchRow.code,
      forward_transport_name: branchRow.name_1,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getJobs,
  createJob,
  updateJob,
  getJobForEdit,
  deleteJob,
  closeJob,
  getJobInit,
  getJobAddPageData,
  getJobBillsWithProducts,
  getJobPrintData,
  addBillToDraft,
  removeBillFromDraft,
  searchBills,
  searchBillsForJob,
  addBillsToJob,
  getJobsClosedByDriver,
  getJobsClosed,
  getJobsWaitingReceive,
  getJobsWaitingPickup,
  listPickupReadyJobs,
  moveBillToJob,
  reclassifyDeliveredBillToBranch,
};
