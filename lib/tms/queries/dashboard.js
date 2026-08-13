const { query, queryOne } = require("../lib/db");
const {
  getFixedTodayDate,
  FIXED_YEAR_START,
  FIXED_YEAR_END,
  getFixedYearSqlFilter,
} = require("../lib/fixed-year");
const { addDays } = require("../lib/lao-date");
const {
  formatInterval,
  getNextMonthStart,
  toDisplayDate,
  toDisplayMonth,
  getBranchScope,
} = require("./helpers");

// ── Short-TTL cache (per slice, per branch) ──
// The dashboard is a read-only overview reloaded on every visit. Each slice
// runs against the REMOTE database; cache for a few seconds and coalesce
// concurrent callers onto one in-flight computation. The page passes force=true
// (manual refresh) to bypass.
const CACHE_TTL_MS = 15_000;
const caches = new Map(); // `${kind}:${branch}` -> { expires:number, promise:Promise }

function branchKey(session) {
  const b = session?.logistic_code?.trim();
  return b && b !== "02-0004" ? b : "all";
}

function cached(kind, session, force, fn) {
  const key = `${kind}:${branchKey(session)}`;
  const now = Date.now();
  if (!force) {
    const hit = caches.get(key);
    if (hit && hit.expires > now) return hit.promise;
  }
  const promise = fn().catch((err) => {
    if (caches.get(key)?.promise === promise) caches.delete(key);
    throw err;
  });
  caches.set(key, { expires: now + CACHE_TTL_MS, promise });
  return promise;
}

// Common per-request context (dates + branch scope) shared by every slice.
function ctx(session) {
  const fixedToday = getFixedTodayDate();
  const fixedMonth = fixedToday.slice(0, 7);
  const monthStart = `${fixedMonth}-01`;
  const nextMonthStart = getNextMonthStart(fixedMonth);
  const scope = getBranchScope(session);
  const branchAnd = (alias = "") =>
    scope.scoped ? `AND ${alias ? alias + "." : ""}transport_code IN (${scope.branchListSql})` : "";
  return {
    fixedToday, fixedMonth, monthStart, nextMonthStart,
    userBranch: scope.branch, scoped: scope.scoped, branches: scope.branches,
    branchAnd, scope,
  };
}

const BRANCH_NAMES_SQL = `SELECT code, COALESCE(NULLIF(TRIM(name_1), ''), code) AS name
   FROM transport_type
   WHERE code IN ('02-0001','02-0002','02-0003')`;

// ════════════════════════════════════════════════════════════════════════
// Slice 1 — SUMMARY (fast: shipment counts, teams, completes, rating, thunjai)
// Everything that does NOT need the heavy pending-bills scan, so it returns in
// ~250ms and the page can paint the hero / teams / carrier mix immediately.
// ════════════════════════════════════════════════════════════════════════
function getDashboardSummary(session, force = false) {
  return cached("summary", session, force, () => computeSummary(session));
}

async function computeSummary(session) {
  const c = ctx(session);
  const { getCustomerRatingSummary } = require("./customer-rating");

  // "complete" = the bill is on a non-cancelled delivery trip (a TMS-owned fact
  // in odg_tms_detail), NOT ic_trans_shipment.check_status — that column belongs
  // to SML and can be reset 1→0 outside our control, which would otherwise
  // under-count completes / inflate "still". Trip membership is the same thing
  // check_status=1 was meant to record, but SML can't tamper with it.
  const teamSql = (code) =>
    `SELECT count(s.doc_no) AS bill_count,
       count(*) FILTER (WHERE disp.bill_no IS NULL) as still,
       count(*) FILTER (WHERE disp.bill_no IS NOT NULL) as complete
     FROM ic_trans_shipment s
     LEFT JOIN (
       SELECT DISTINCT bill_no FROM public.odg_tms_detail
       WHERE COALESCE(status, 0) <> 2 AND ${getFixedYearSqlFilter("doc_date")}
     ) disp ON disp.bill_no = s.doc_no
     WHERE ${getFixedYearSqlFilter("s.doc_date")} AND s.transport_code='${code}'`;
  const emptyTeam = { bill_count: 0, still: 0, complete: 0 };

  const [data, thunjai, kl, dt, ps, completeSummary, branchNameRows, ratingSummary] =
    await Promise.all([
      queryOne(`
        SELECT count(doc_no) AS bill_count,
          sum(case when transport_code='02-0004' then 1 else 0 end) as pickup,
          sum(case when transport_code !='02-0004' then 1 else 0 end) as logistic,
          sum(case when transport_code ='02-0001' then 1 else 0 end) as logistic_od,
          sum(case when transport_code ='02-0002' then 1 else 0 end) as logistic_dt,
          sum(case when transport_code ='02-0003' then 1 else 0 end) as logistic_ps
        FROM ic_trans_shipment
        WHERE ${getFixedYearSqlFilter("doc_date")} AND transport_code IS NOT NULL ${c.branchAnd()}
      `),
      // ThunJai express (transport 02-0005) — bills + products via the ThunJai
      // integration (company-wide; separate from the internal fleet).
      queryOne(`
        SELECT
          count(DISTINCT s.doc_no)::int AS bill_count,
          COALESCE(count(det.item_code), 0)::int AS item_count,
          COALESCE(sum(det.qty), 0)::numeric AS item_qty
        FROM ic_trans_shipment s
        LEFT JOIN ic_trans_detail det
          ON det.doc_no = s.doc_no AND det.item_code NOT LIKE '97%'
        WHERE s.transport_code = '02-0005' AND ${getFixedYearSqlFilter("s.doc_date")}
      `),
      !c.scoped || c.branches.includes("02-0001")
        ? queryOne(teamSql("02-0001"))
        : Promise.resolve(emptyTeam),
      !c.scoped || c.branches.includes("02-0002")
        ? queryOne(teamSql("02-0002"))
        : Promise.resolve(emptyTeam),
      !c.scoped || c.branches.includes("02-0003")
        ? queryOne(teamSql("02-0003"))
        : Promise.resolve(emptyTeam),
      queryOne(
        // complete = on a non-cancelled trip (TMS-owned), not check_status=1 — see
        // the teamSql note: SML can reset check_status and skew these counts.
        `SELECT
          count(*) FILTER (WHERE a.doc_date = $3::date AND disp.bill_no IS NOT NULL) AS today_complete,
          count(*) FILTER (WHERE a.doc_date >= $1::date AND a.doc_date < $2::date AND disp.bill_no IS NOT NULL) AS month_complete,
          count(*) FILTER (WHERE disp.bill_no IS NOT NULL) AS year_complete
        FROM ic_trans_shipment a
        LEFT JOIN (
          SELECT DISTINCT bill_no FROM public.odg_tms_detail
          WHERE COALESCE(status, 0) <> 2 AND ${getFixedYearSqlFilter("doc_date")}
        ) disp ON disp.bill_no = a.doc_no
        WHERE a.transport_code NOT IN ('02-0004')
          ${c.branchAnd("a")}
          AND ${getFixedYearSqlFilter("a.doc_date")}`,
        [c.monthStart, c.nextMonthStart, c.fixedToday]
      ),
      query(BRANCH_NAMES_SQL),
      getCustomerRatingSummary().catch(() => ({
        total: 0,
        avg_stars: null,
        positive: 0,
        negative: 0,
      })),
    ]);

  const branch_names = Object.fromEntries(branchNameRows.map((r) => [r.code, r.name]));
  return {
    data,
    thunjai,
    // `still` is owned by the pending slice (it reflects remaining-count bills);
    // start at 0 so the team cards render their `complete` half immediately and
    // fill `still` in when the pending slice lands.
    kl: { ...kl, still: 0 },
    dt: { ...dt, still: 0 },
    ps: { ...ps, still: 0 },
    user_branch: c.scoped ? c.userBranch : null,
    branch_names,
    customer_rating: ratingSummary,
    // Only the completed-side counts here; the pending slice supplies the rest.
    pending_summary: {
      today_complete: completeSummary?.today_complete ?? 0,
      month_complete: completeSummary?.month_complete ?? 0,
      year_complete: completeSummary?.year_complete ?? 0,
      current_date: toDisplayDate(c.fixedToday),
      current_month: toDisplayMonth(c.fixedMonth),
    },
  };
}

// ════════════════════════════════════════════════════════════════════════
// Slice 2 — DELIVERY KPI (medium: completed-bill metrics + 30-day trend)
// ════════════════════════════════════════════════════════════════════════
function getDashboardKpi(session, force = false) {
  return cached("kpi", session, force, () => computeKpi(session));
}

async function computeKpi(session) {
  const c = ctx(session);
  const { getSettings } = require("./settings");
  const kpiBranchClause = c.scope.scoped
    ? `AND EXISTS (SELECT 1 FROM ic_trans_shipment __ts WHERE __ts.doc_no = d.bill_no AND __ts.transport_code IN (${c.scope.branchListSql}))`
    : "";

  const [branchNameRows, kpiRows, trendRows, kpiSettings] = await Promise.all([
    query(BRANCH_NAMES_SQL),
    query(
      `WITH delivered AS (
         SELECT
           COALESCE(s.transport_code, '') AS branch_code,
           d.sent_end::date AS delivered_date,
           EXTRACT(EPOCH FROM (d.sent_end - d.sent_start))::float8 AS delivery_seconds,
           CASE WHEN a.job_close IS NOT NULL
                THEN EXTRACT(EPOCH FROM (a.job_close - d.sent_end))::float8
           END AS close_seconds,
           CASE
             WHEN COALESCE(pb.scheduled_date::date, t.send_date::date, d.bill_date::date) IS NULL THEN NULL
             WHEN d.sent_end::date <= COALESCE(pb.scheduled_date::date, t.send_date::date, d.bill_date::date) THEN true
             ELSE false
           END AS is_on_time
         FROM public.odg_tms_detail d
         INNER JOIN public.odg_tms a ON a.doc_no = d.doc_no
         LEFT JOIN public.odg_tms_pending_bill pb ON pb.bill_no = d.bill_no
         LEFT JOIN ic_trans t ON t.doc_no = d.bill_no
         LEFT JOIN ic_trans_shipment s ON s.doc_no = d.bill_no
         WHERE d.status = 1
           AND d.sent_end IS NOT NULL
           AND COALESCE(a.approve_status, 0) = 1
           AND ${getFixedYearSqlFilter("d.doc_date")}
           ${kpiBranchClause}
       ),
       bucket AS (
         SELECT branch_code, period, delivery_seconds, close_seconds, is_on_time
         FROM delivered
         CROSS JOIN LATERAL (
           VALUES
             ('today', delivered_date = $3::date),
             ('month', delivered_date >= $1::date AND delivered_date < $2::date),
             ('year', true)
         ) AS p(period, matches)
         WHERE p.matches
       )
       SELECT
         branch_code,
         period,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE is_on_time = true) AS on_time,
         COUNT(*) FILTER (WHERE is_on_time = false) AS breach,
         AVG(delivery_seconds) AS avg_delivery,
         AVG(close_seconds) AS avg_close
       FROM bucket
       GROUP BY GROUPING SETS ((period), (branch_code, period))`,
      [c.monthStart, c.nextMonthStart, c.fixedToday]
    ),
    query(
      `WITH delivered AS (
         SELECT
           d.sent_end::date AS delivered_date,
           EXTRACT(EPOCH FROM (d.sent_end - d.sent_start))::float8 AS delivery_seconds,
           CASE WHEN a.job_close IS NOT NULL
                THEN EXTRACT(EPOCH FROM (a.job_close - d.sent_end))::float8
           END AS close_seconds,
           CASE
             WHEN COALESCE(pb.scheduled_date::date, t.send_date::date, d.bill_date::date) IS NULL THEN NULL
             WHEN d.sent_end::date <= COALESCE(pb.scheduled_date::date, t.send_date::date, d.bill_date::date) THEN true
             ELSE false
           END AS is_on_time
         FROM public.odg_tms_detail d
         INNER JOIN public.odg_tms a ON a.doc_no = d.doc_no
         LEFT JOIN public.odg_tms_pending_bill pb ON pb.bill_no = d.bill_no
         LEFT JOIN ic_trans t ON t.doc_no = d.bill_no
         WHERE d.status = 1
           AND d.sent_end IS NOT NULL
           AND COALESCE(a.approve_status, 0) = 1
           AND d.sent_end::date >= ($1::date - INTERVAL '29 days')
           AND d.sent_end::date <= $1::date
           ${kpiBranchClause}
       )
       SELECT
         to_char(delivered_date, 'YYYY-MM-DD') AS day,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE is_on_time = true) AS on_time,
         COUNT(*) FILTER (WHERE is_on_time = false) AS breach,
         AVG(delivery_seconds) AS avg_delivery,
         AVG(close_seconds) AS avg_close
       FROM delivered
       GROUP BY delivered_date
       ORDER BY delivered_date ASC`,
      [c.fixedToday]
    ),
    getSettings([
      "kpi.target_on_time_rate",
      "kpi.target_avg_delivery_minutes",
      "kpi.target_avg_close_minutes",
    ]),
  ]);

  const branchNames = Object.fromEntries(branchNameRows.map((r) => [r.code, r.name]));

  const overallByPeriod = new Map();
  const perBranchByPeriod = new Map();
  for (const row of kpiRows) {
    const period = row.period;
    const entry = {
      total: Number(row.total ?? 0),
      on_time: Number(row.on_time ?? 0),
      breach: Number(row.breach ?? 0),
      avg_delivery_seconds: row.avg_delivery == null ? null : Number(row.avg_delivery),
      avg_close_seconds: row.avg_close == null ? null : Number(row.avg_close),
    };
    if (row.branch_code === null) {
      overallByPeriod.set(period, entry);
    } else {
      const code = String(row.branch_code || "").trim() || "unknown";
      if (!perBranchByPeriod.has(period)) perBranchByPeriod.set(period, []);
      perBranchByPeriod.get(period).push({ branch_code: code, ...entry });
    }
  }
  const emptyKpi = {
    total: 0,
    on_time: 0,
    breach: 0,
    avg_delivery_seconds: null,
    avg_close_seconds: null,
  };
  const kpiBuild = (period) => overallByPeriod.get(period) ?? emptyKpi;
  const kpiBranchesBuild = (period) => {
    const list = perBranchByPeriod.get(period) ?? [];
    return list
      .map((row) => ({
        ...row,
        branch_name: branchNames[row.branch_code]?.trim() || row.branch_code,
      }))
      .sort((a, b) => a.branch_code.localeCompare(b.branch_code));
  };

  const trendMap = new Map(trendRows.map((row) => [row.day, row]));
  const deliveryKpiTrend = [];
  for (let i = 29; i >= 0; i--) {
    // ຄີຫຼັກຂອງກຣາຟຕ້ອງກົງກັບວັນທີທີ່ SQL ຄືນມາ — ຖ້າຄິດດ້ວຍ
    // new Date(...T00:00:00).toISOString() ຢູ່ເຄື່ອງ +07 ຄີຈະເລື່ອນໄປ 1 ມື້
    // ແລ້ວ trendMap.get() ບໍ່ຕິດຈັກແຖວ ກຣາຟຈຶ່ງເປັນສູນທັງ 30 ມື້
    const key = addDays(c.fixedToday, -i);
    const row = trendMap.get(key);
    deliveryKpiTrend.push({
      day: key,
      total: Number(row?.total ?? 0),
      on_time: Number(row?.on_time ?? 0),
      breach: Number(row?.breach ?? 0),
      avg_delivery_seconds: row?.avg_delivery == null ? null : Number(row.avg_delivery),
      avg_close_seconds: row?.avg_close == null ? null : Number(row.avg_close),
    });
  }

  const parseTarget = (raw) => {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  };

  return {
    delivery_kpi: {
      today: kpiBuild("today"),
      month: kpiBuild("month"),
      year: kpiBuild("year"),
      by_branch: {
        today: kpiBranchesBuild("today"),
        month: kpiBranchesBuild("month"),
        year: kpiBranchesBuild("year"),
      },
      trend_30d: deliveryKpiTrend,
      targets: {
        on_time_rate: parseTarget(kpiSettings["kpi.target_on_time_rate"]),
        avg_delivery_minutes: parseTarget(kpiSettings["kpi.target_avg_delivery_minutes"]),
        avg_close_minutes: parseTarget(kpiSettings["kpi.target_avg_close_minutes"]),
      },
    },
  };
}

// ════════════════════════════════════════════════════════════════════════
// Slice 2b — DELIVERY PERFORMANCE (ຍອດຍົກມາ/ຍົກໄປ + ຊັ້ນເວລານຳສົ່ງ ຂອງເດືອນນີ້)
// ຄິດຈາກ getDeliveryPerformance ໂດຍກົງ ຈຶ່ງບໍ່ມີທາງທີ່ໜ້າ Dashboard ກັບໜ້າ
// /reports/delivery-performance ຈະສະແດງຕົວເລກຄົນລະຢ່າງໃນເດືອນດຽວກັນ.
// ════════════════════════════════════════════════════════════════════════
function getDashboardDeliveryPerformance(session, force = false) {
  return cached("delivery_performance", session, force, async () => {
    const { getDeliveryPerformance } = require("./reports");
    const c = ctx(session);
    return { delivery_performance: await getDeliveryPerformance(session, c.fixedMonth) };
  });
}

// ════════════════════════════════════════════════════════════════════════
// Slice 3 — PENDING (slow: whole-year pending bills + remaining counts)
// The single heaviest part (~0.9s). Isolated so it streams in last while the
// rest of the dashboard is already on screen.
// ════════════════════════════════════════════════════════════════════════
function getDashboardPending(session, force = false) {
  return cached("pending", session, force, () => computePending(session));
}

async function computePending(session) {
  const c = ctx(session);
  const { getBillsPending } = require("./bills");
  const branchScopeClause = c.scope.scoped
    ? `AND EXISTS (SELECT 1 FROM public.ic_trans_shipment __s
                    WHERE __s.doc_no = d.bill_no
                      AND __s.transport_code IN (${c.scope.branchListSql}))`
    : "";
  const [{ trans: pendingWithRemaining }, onTripRows] = await Promise.all([
    getBillsPending(session, FIXED_YEAR_START, FIXED_YEAR_END, "all"),
    // ບິນທີ່ຢູ່ເທິງຖ້ຽວທີ່ຍັງບໍ່ຈົບ (ຮັບຖ້ຽວແລ້ວ / ກຳລັງສົ່ງ) — ຍັງບໍ່ຮອດມືລູກຄ້າ
    // ແຕ່ບໍ່ຂຶ້ນໜ້າ "ບິນລໍຈັດຖ້ຽວ" ອີກແລ້ວເພາະຖືກຈັດຖ້ຽວໄປແລ້ວ
    query(
      `SELECT DISTINCT d.bill_no
         FROM public.odg_tms_detail d
         JOIN public.odg_tms j ON j.doc_no = d.doc_no
        WHERE COALESCE(d.status, 0) NOT IN (1, 2)
          AND COALESCE(j.approve_status, 0) = 1
          AND COALESCE(j.job_status, 0) <> 4
          AND ${getFixedYearSqlFilter("d.doc_date")}
          ${branchScopeClause}`
    ),
  ]);
  // ນັບບໍ່ຊ້ຳ: ບິນທະຍອຍສົ່ງອາດຢູ່ທັງ 2 ລາຍການ
  const pendingDocNos = new Set(pendingWithRemaining.map((b) => b.doc_no));
  const inProgressBills = onTripRows.filter((r) => !pendingDocNos.has(r.bill_no)).length;

  const inMonth = (bill) =>
    bill.send_date >= c.monthStart && bill.send_date < c.nextMonthStart;
  const isToday = (bill) => bill.send_date === c.fixedToday;

  const trans = pendingWithRemaining.slice(0, 10);
  const transMonth = pendingWithRemaining.filter(inMonth).slice(0, 10);
  const transToday = pendingWithRemaining.filter(isToday).slice(0, 10);
  const branchPendingCount = (code) =>
    pendingWithRemaining.filter((bill) => bill.transport_code === code).length;

  const monthCount = pendingWithRemaining.filter(inMonth).length;
  const todayCount = pendingWithRemaining.filter(isToday).length;

  const pendingBreakdown = {
    total: pendingWithRemaining.length,
    overdue: pendingWithRemaining.filter(
      (bill) => bill.scheduled_date && bill.scheduled_date < c.fixedToday
    ).length,
    past_send_date: pendingWithRemaining.filter(
      (bill) =>
        bill.action_status === "contacted_ready" &&
        bill.scheduled_date &&
        bill.scheduled_date < c.fixedToday
    ).length,
    contacted: pendingWithRemaining.filter((bill) => bill.action_status).length,
    uncontacted: pendingWithRemaining.filter((bill) => !bill.action_status).length,
    ready: pendingWithRemaining.filter((bill) => bill.action_status === "contacted_ready").length,
  };

  const normalize = (items) =>
    items.map((item) => ({ ...item, time_use: formatInterval(item.time_use) }));

  return {
    trans: normalize(trans),
    trans_month: normalize(transMonth),
    trans_today: normalize(transToday),
    pending_summary: {
      month_count: monthCount,
      today_count: todayCount,
      today_pending: todayCount,
      month_pending: monthCount,
      // ບິນລໍຈັດຖ້ຽວຢ່າງດຽວ — ໜ້າ /bills-pending ອີງຄ່ານີ້
      year_pending: pendingWithRemaining.length,
      // ບິນທີ່ຈັດຖ້ຽວແລ້ວແຕ່ຍັງບໍ່ຮອດມືລູກຄ້າ — tile "ຄ້າງສົ່ງ" ບວກສອງອັນນີ້
      year_in_progress: inProgressBills,
    },
    pending_breakdown: pendingBreakdown,
    still: {
      "02-0001": branchPendingCount("02-0001"),
      "02-0002": branchPendingCount("02-0002"),
      "02-0003": branchPendingCount("02-0003"),
    },
  };
}

// Combined payload (back-compat for any caller that wants it all at once).
// The dashboard page itself fetches the three slices separately for progressive
// rendering; this just stitches them back into the original shape.
async function getDashboardData(session, force = false) {
  const [s, k, p] = await Promise.all([
    getDashboardSummary(session, force),
    getDashboardKpi(session, force),
    getDashboardPending(session, force),
  ]);
  return {
    data: s.data,
    thunjai: s.thunjai,
    kl: { ...s.kl, still: p.still["02-0001"] },
    dt: { ...s.dt, still: p.still["02-0002"] },
    ps: { ...s.ps, still: p.still["02-0003"] },
    user_branch: s.user_branch,
    branch_names: s.branch_names,
    trans: p.trans,
    trans_month: p.trans_month,
    trans_today: p.trans_today,
    pending_summary: { ...s.pending_summary, ...p.pending_summary },
    pending_breakdown: p.pending_breakdown,
    delivery_kpi: k.delivery_kpi,
    customer_rating: s.customer_rating,
  };
}

// Activity lists (in-progress / waiting-dispatch / delivered-pending-close) —
// loaded separately so the page can stream them in. The three queries run
// concurrently.
async function getDashboardActivity(session) {
  const scope = getBranchScope(session);
  const listBranchClause = scope.scoped
    ? `AND EXISTS (SELECT 1 FROM ic_trans_shipment __ts WHERE __ts.doc_no = d.bill_no AND __ts.transport_code IN (${scope.branchListSql}))`
    : "";

  const inProgressRowsP = query(
    `SELECT
      d.bill_no,
      d.doc_no,
      to_char(d.doc_date,'DD-MM-YYYY') as doc_date,
      to_char(d.bill_date,'DD-MM-YYYY') as bill_date,
      COALESCE(NULLIF(TRIM(cust.name_1), ''), d.cust_code, '-') as customer,
      COALESCE(d.telephone, '') as telephone,
      COALESCE(to_char(d.sent_start,'DD-MM-YYYY HH24:MI'), '-') as active_sent_start,
      greatest(floor(extract(epoch from now() - d.sent_start)), 0)::bigint AS active_seconds,
      COALESCE(NULLIF(TRIM(carT.name_1), ''), a.car, '-') as car,
      COALESCE(NULLIF(TRIM(drvT.name_1), ''), a.driver, '-') as driver,
      COALESCE(tt.name_1, '-') as transport_name,
      COUNT(*) OVER() AS total_in_progress_bills
    FROM public.odg_tms_detail d
    INNER JOIN odg_tms a ON a.doc_no = d.doc_no
    LEFT JOIN ar_customer cust ON cust.code = d.cust_code
    LEFT JOIN public.odg_tms_car carT ON carT.code = a.car
    LEFT JOIN public.odg_tms_driver drvT ON drvT.code = a.driver
    LEFT JOIN ic_trans_shipment s ON s.doc_no = d.bill_no
    LEFT JOIN transport_type tt ON tt.code = s.transport_code
    WHERE d.sent_start IS NOT NULL
      AND d.sent_end IS NULL
      AND COALESCE(d.status, 0) NOT IN (1, 2)
      AND ${getFixedYearSqlFilter("d.doc_date")}
      AND COALESCE(a.approve_status, 0) = 1
      AND COALESCE(a.job_status, 0) <> 4
      ${listBranchClause}
    ORDER BY d.sent_start ASC
    LIMIT 8`
  );

  const waitingDispatchRowsP = query(
    `SELECT
      d.bill_no,
      d.doc_no,
      to_char(d.doc_date,'DD-MM-YYYY') as doc_date,
      to_char(d.bill_date,'DD-MM-YYYY') as bill_date,
      COALESCE(NULLIF(TRIM(cust.name_1), ''), d.cust_code, '-') as customer,
      COALESCE(d.telephone, '') as telephone,
      COALESCE(to_char(COALESCE(d.recipt_job, a.create_date_time_now),'DD-MM-YYYY HH24:MI'), '-') as waiting_since,
      greatest(floor(extract(epoch from now() - COALESCE(d.recipt_job, a.create_date_time_now))), 0)::bigint AS waiting_seconds,
      COALESCE(NULLIF(TRIM(carT.name_1), ''), a.car, '-') as car,
      COALESCE(NULLIF(TRIM(drvT.name_1), ''), a.driver, '-') as driver,
      COALESCE(tt.name_1, '-') as transport_name,
      CASE WHEN d.recipt_job IS NOT NULL THEN true ELSE false END as picked_up,
      COUNT(*) OVER() AS total_waiting_dispatch_bills
    FROM public.odg_tms_detail d
    INNER JOIN odg_tms a ON a.doc_no = d.doc_no
    LEFT JOIN ar_customer cust ON cust.code = d.cust_code
    LEFT JOIN public.odg_tms_car carT ON carT.code = a.car
    LEFT JOIN public.odg_tms_driver drvT ON drvT.code = a.driver
    LEFT JOIN ic_trans_shipment s ON s.doc_no = d.bill_no
    LEFT JOIN transport_type tt ON tt.code = s.transport_code
    WHERE d.sent_start IS NULL
      AND d.sent_end IS NULL
      AND COALESCE(d.status, 0) NOT IN (1, 2)
      AND ${getFixedYearSqlFilter("d.doc_date")}
      AND COALESCE(a.approve_status, 0) = 1
      AND COALESCE(a.job_status, 0) <> 4
      ${listBranchClause}
    ORDER BY COALESCE(d.recipt_job, a.create_date_time_now) ASC
    LIMIT 8`
  );

  const deliveredPendingCloseRowsP = query(
    `SELECT
      d.bill_no,
      d.doc_no,
      to_char(d.doc_date,'DD-MM-YYYY') as doc_date,
      to_char(d.bill_date,'DD-MM-YYYY') as bill_date,
      COALESCE(NULLIF(TRIM(cust.name_1), ''), d.cust_code, '-') as customer,
      COALESCE(d.telephone, '') as telephone,
      COALESCE(to_char(d.sent_end,'DD-MM-YYYY HH24:MI'), '-') as delivered_at,
      greatest(floor(extract(epoch from now() - d.sent_end)), 0)::bigint AS pending_close_seconds,
      COALESCE(NULLIF(TRIM(carT.name_1), ''), a.car, '-') as car,
      COALESCE(NULLIF(TRIM(drvT.name_1), ''), a.driver, '-') as driver,
      COALESCE(tt.name_1, '-') as transport_name,
      COALESCE(a.job_status, 0) as job_status,
      CASE
        WHEN COALESCE(a.job_status, 0) = 3 THEN 'ຄົນຂັບປິດງານແລ້ວ'
        WHEN COALESCE(a.job_status, 0) = 2 THEN 'ກຳລັງຈັດສົ່ງ'
        WHEN COALESCE(a.job_status, 0) = 1 THEN 'ຮັບຖ້ຽວແລ້ວ'
        ELSE 'ລໍຖ້າ'
      END as job_status_text,
      COALESCE(d.url_img, '') as url_img,
      COALESCE(d.sight_img, '') as sight_img,
      COALESCE(img.delivery_images, ARRAY[]::text[]) as delivery_images,
      (
        CASE WHEN COALESCE(d.url_img, '') <> '' THEN 1 ELSE 0 END
        + CASE WHEN COALESCE(d.sight_img, '') <> '' THEN 1 ELSE 0 END
        + COALESCE(img.delivery_image_count, 0)
      )::int as image_count,
      COALESCE(d.remark, '') as remark,
      COUNT(*) OVER() AS total_delivered_pending_close
    FROM public.odg_tms_detail d
    INNER JOIN odg_tms a ON a.doc_no = d.doc_no
    LEFT JOIN ar_customer cust ON cust.code = d.cust_code
    LEFT JOIN public.odg_tms_car carT ON carT.code = a.car
    LEFT JOIN public.odg_tms_driver drvT ON drvT.code = a.driver
    LEFT JOIN ic_trans_shipment s ON s.doc_no = d.bill_no
    LEFT JOIN transport_type tt ON tt.code = s.transport_code
    LEFT JOIN LATERAL (
      SELECT array_agg(di.image_data ORDER BY di.created_at ASC, di.roworder ASC) as delivery_images,
             COUNT(*)::int as delivery_image_count
      FROM public.odg_tms_delivery_images di
      WHERE di.bill_no = d.bill_no
    ) img ON true
    WHERE COALESCE(d.status, 0) = 1
      AND d.sent_end IS NOT NULL
      AND ${getFixedYearSqlFilter("d.doc_date")}
      AND COALESCE(a.approve_status, 0) = 1
      AND COALESCE(a.job_status, 0) <> 4
      ${listBranchClause}
    ORDER BY d.sent_end DESC
    LIMIT 8`
  );

  const [inProgressRows, waitingDispatchRows, deliveredPendingCloseRows] =
    await Promise.all([inProgressRowsP, waitingDispatchRowsP, deliveredPendingCloseRowsP]);

  return {
    in_progress: inProgressRows.map(({ total_in_progress_bills, ...bill }) => bill),
    in_progress_count: inProgressRows[0]?.total_in_progress_bills ?? 0,
    waiting_dispatch: waitingDispatchRows.map(({ total_waiting_dispatch_bills, ...bill }) => bill),
    waiting_dispatch_count: waitingDispatchRows[0]?.total_waiting_dispatch_bills ?? 0,
    delivered_pending_close: deliveredPendingCloseRows.map(({ total_delivered_pending_close, ...bill }) => bill),
    delivered_pending_close_count: deliveredPendingCloseRows[0]?.total_delivered_pending_close ?? 0,
  };
}

module.exports = {
  getDashboardData,
  getDashboardSummary,
  getDashboardKpi,
  getDashboardDeliveryPerformance,
  getDashboardPending,
  getDashboardActivity,
};
