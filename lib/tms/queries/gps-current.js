const { pool, query, queryOne } = require("../lib/db");
const { getFixedYearSqlFilter } = require("../lib/fixed-year");
const { getGpsRealtimeAll } = require("./tracking");
const { FLEET_CARS_SQL } = require("./gps-usage");

// ຊື່ລົດ/ລະຫັດລົດເທິງແຜນທີ່ ໃຊ້ທະບຽນອັນດຽວກັນກັບລາຍງານ GPS (app_car_vehicles)
// ແທນ odg_tms_car — ເບິ່ງເຫດຜົນເຕັມທີ່ FLEET_CARS_SQL ໃນ gps-usage.js. ຜົນທີ່ໄດ້
// ນຳ: ບຄ-3487 ທີ່ IMEI ຢູ່ TMS ຄ້າງເກົ່າ ເມື່ອກ່ອນ v ເປັນ NULL ຈຶ່ງຫາວຽກທີ່
// ກຳລັງແລ່ນ (odg_tms.car = v.code) ບໍ່ພົບ — ດຽວນີ້ໄດ້ code '3487' ຖືກຕ້ອງ.
const FLEET_JOIN = `LEFT JOIN (${FLEET_CARS_SQL}) v ON v.imei = c.imei`;

const cache = globalThis;

// ==================== Schema ====================

async function safeDdl(sql) {
  try {
    await pool.query(sql);
  } catch (err) {
    const msg = String(err?.message ?? "");
    if (
      err?.code === "23505" ||
      /already exists/i.test(msg)
    ) {
      return;
    }
    throw err;
  }
}

async function ensureSchemaInternal() {
  await safeDdl(`
    CREATE TABLE IF NOT EXISTS public.odg_tms_gps_current (
      imei character varying PRIMARY KEY,
      car_code character varying,
      car_name character varying,
      lat character varying,
      lng character varying,
      speed character varying,
      heading character varying,
      recorded_at character varying,
      address character varying,
      fetched_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  // Additive columns for engine/state — safe on existing tables
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_current ADD COLUMN IF NOT EXISTS engine_state character varying`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_current ADD COLUMN IF NOT EXISTS state_detail text`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_current ADD COLUMN IF NOT EXISTS mileage character varying`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_current ADD COLUMN IF NOT EXISTS sat character varying`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_current ADD COLUMN IF NOT EXISTS gsm character varying`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_current ADD COLUMN IF NOT EXISTS hdop character varying`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_current ADD COLUMN IF NOT EXISTS oil character varying`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_current ADD COLUMN IF NOT EXISTS ad_data text`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_current ADD COLUMN IF NOT EXISTS input_state text`
  );
  // Tracks when current engine_state began (set when state transitions)
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_current ADD COLUMN IF NOT EXISTS engine_state_since character varying`
  );
}

async function ensureSchema() {
  if (cache.__tmsGpsCurrentSchemaReady) return;
  if (!cache.__tmsGpsCurrentSchemaPromise) {
    cache.__tmsGpsCurrentSchemaPromise = ensureSchemaInternal()
      .then(() => {
        cache.__tmsGpsCurrentSchemaReady = true;
      })
      .catch((err) => {
        cache.__tmsGpsCurrentSchemaPromise = null;
        throw err;
      });
  }
  await cache.__tmsGpsCurrentSchemaPromise;
}

// ==================== Upsert ====================

async function upsertCurrentRow(row) {
  await pool.query(
    `INSERT INTO public.odg_tms_gps_current
       (imei, car_code, car_name, lat, lng, speed, heading, recorded_at, address,
        engine_state, state_detail, mileage, sat, gsm, hdop, oil, ad_data, input_state, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,LOCALTIMESTAMP(0))
     ON CONFLICT (imei) DO UPDATE SET
       car_code = EXCLUDED.car_code,
       car_name = EXCLUDED.car_name,
       lat = EXCLUDED.lat,
       lng = EXCLUDED.lng,
       speed = EXCLUDED.speed,
       heading = EXCLUDED.heading,
       recorded_at = EXCLUDED.recorded_at,
       address = EXCLUDED.address,
       engine_state = EXCLUDED.engine_state,
       state_detail = EXCLUDED.state_detail,
       mileage = EXCLUDED.mileage,
       sat = EXCLUDED.sat,
       gsm = EXCLUDED.gsm,
       hdop = EXCLUDED.hdop,
       oil = EXCLUDED.oil,
       ad_data = EXCLUDED.ad_data,
       input_state = EXCLUDED.input_state,
       engine_state_since = CASE
         WHEN COALESCE(odg_tms_gps_current.engine_state, '') <> COALESCE(EXCLUDED.engine_state, '')
           THEN COALESCE(NULLIF(EXCLUDED.recorded_at, ''), to_char(LOCALTIMESTAMP(0), 'YYYY-MM-DD HH24:MI:SS'))
         ELSE COALESCE(odg_tms_gps_current.engine_state_since, EXCLUDED.recorded_at)
       END,
       fetched_at = LOCALTIMESTAMP(0)`,
    [
      row.imei,
      row.car_code ?? "",
      row.car_name ?? "",
      row.lat ?? "",
      row.lng ?? "",
      row.speed ?? "",
      row.heading ?? "",
      row.recorded_at ?? "",
      row.address ?? "",
      row.engine_state ?? "",
      row.state_detail ?? "",
      row.mileage ?? "",
      row.sat ?? "",
      row.gsm ?? "",
      row.hdop ?? "",
      row.oil ?? "",
      row.ad_data ?? "",
      row.input_state ?? "",
    ]
  );
}

// ==================== Read ====================

// Age is computed in SQL (EXTRACT EPOCH) to avoid JS/PG timezone mismatch.
const STALE_SEC = 120; // 2 minutes

async function readAllFromDb() {
  return query(
    `SELECT
       c.imei,
       COALESCE(NULLIF(TRIM(v.code), ''), c.car_code, '') AS car_code,
       COALESCE(NULLIF(TRIM(v.name_1), ''), c.car_name, '') AS car_name,
       COALESCE(c.lat, '') AS lat,
       COALESCE(c.lng, '') AS lng,
       COALESCE(c.speed, '') AS speed,
       COALESCE(c.heading, '') AS heading,
       COALESCE(c.recorded_at, '') AS recorded_at,
       COALESCE(c.address, '') AS address,
       COALESCE(c.engine_state, '') AS engine_state,
       COALESCE(c.state_detail, '') AS state_detail,
       COALESCE(c.mileage, '') AS mileage,
       COALESCE(c.sat, '') AS sat,
       COALESCE(c.gsm, '') AS gsm,
       COALESCE(c.hdop, '') AS hdop,
       COALESCE(c.oil, '') AS oil,
       COALESCE(c.ad_data, '') AS ad_data,
       COALESCE(c.input_state, '') AS input_state,
       COALESCE(c.engine_state_since, '') AS engine_state_since,
       COALESCE(active_job.doc_no, '') AS current_doc_no,
       COALESCE(active_job.driver, '') AS current_driver,
       COALESCE(active_job.bills, '[]'::jsonb) AS current_bills,
       to_char(c.fetched_at, 'YYYY-MM-DD HH24:MI:SS') AS fetched_at,
       GREATEST(0, EXTRACT(EPOCH FROM (LOCALTIMESTAMP - c.fetched_at)))::int AS age_seconds
     FROM public.odg_tms_gps_current c
     ${FLEET_JOIN}
     LEFT JOIN LATERAL (
       SELECT
         a.doc_no,
         COALESCE(NULLIF(TRIM(d.name_1), ''), a.driver, '-') AS driver,
         COALESCE((
           SELECT jsonb_agg(
             jsonb_build_object(
               'bill_no', det.bill_no,
               'customer', COALESCE(NULLIF(TRIM(cust.name_1), ''), det.cust_code, '-'),
               'status',
                 CASE
                   WHEN det.sent_start IS NULL AND det.sent_end IS NULL THEN 'ລໍຖ້າຈັດສົ່ງ'
                   WHEN det.sent_start IS NOT NULL AND det.sent_end IS NULL THEN 'ກຳລັງຈັດສົ່ງ'
                   WHEN COALESCE(det.status, 0) = 1 AND det.forward_transport_code IS NOT NULL THEN 'ສົ່ງຕໍ່ສາຂາແລ້ວ'
                   WHEN COALESCE(det.status, 0) = 1 THEN 'ຄົບຈຳນວນ'
                   WHEN COALESCE(det.status, 0) = 2 THEN 'ຍົກເລີກຈັດສົ່ງ'
                   ELSE 'ລໍຖ້າຈັດສົ່ງ'
                 END,
               'phase',
                 CASE
                   WHEN det.sent_start IS NULL AND det.sent_end IS NULL THEN 'waiting'
                   WHEN det.sent_start IS NOT NULL AND det.sent_end IS NULL THEN 'inprogress'
                   WHEN COALESCE(det.status, 0) = 1 AND det.forward_transport_code IS NOT NULL THEN 'forwarded'
                   WHEN COALESCE(det.status, 0) = 1 THEN 'done'
                   WHEN COALESCE(det.status, 0) = 2 THEN 'cancel'
                   ELSE 'waiting'
                 END
             )
             ORDER BY det.roworder
           )
           FROM public.odg_tms_detail det
           LEFT JOIN public.ar_customer cust ON cust.code = det.cust_code
           WHERE det.doc_no = a.doc_no
             AND ${getFixedYearSqlFilter("det.doc_date")}
         ), '[]'::jsonb) AS bills
       FROM public.odg_tms a
       LEFT JOIN public.odg_tms_driver d ON d.code = a.driver
       WHERE a.car = COALESCE(NULLIF(TRIM(v.code), ''), c.car_code)
         AND COALESCE(a.approve_status, 0) = 1
         AND COALESCE(a.job_status, 0) IN (1, 2)
         AND ${getFixedYearSqlFilter("a.doc_date")}
       ORDER BY
         CASE WHEN COALESCE(a.job_status, 0) = 2 THEN 0 ELSE 1 END,
         a.date_logistic DESC NULLS LAST,
         a.create_date_time_now DESC NULLS LAST,
         a.doc_no DESC
       LIMIT 1
     ) active_job ON true
     ORDER BY car_name ASC, c.imei ASC`
  );
}

async function readOneFromDb(imei) {
  return queryOne(
    `SELECT
       c.imei,
       COALESCE(NULLIF(TRIM(v.code), ''), c.car_code, '') AS car_code,
       COALESCE(NULLIF(TRIM(v.name_1), ''), c.car_name, '') AS car_name,
       COALESCE(c.lat, '') AS lat,
       COALESCE(c.lng, '') AS lng,
       COALESCE(c.speed, '') AS speed,
       COALESCE(c.heading, '') AS heading,
       COALESCE(c.recorded_at, '') AS recorded_at,
       COALESCE(c.address, '') AS address,
       COALESCE(c.engine_state, '') AS engine_state,
       COALESCE(c.state_detail, '') AS state_detail,
       COALESCE(c.mileage, '') AS mileage,
       COALESCE(c.sat, '') AS sat,
       COALESCE(c.gsm, '') AS gsm,
       COALESCE(c.hdop, '') AS hdop,
       COALESCE(c.oil, '') AS oil,
       COALESCE(c.ad_data, '') AS ad_data,
       COALESCE(c.input_state, '') AS input_state,
       COALESCE(c.engine_state_since, '') AS engine_state_since,
       COALESCE(active_job.doc_no, '') AS current_doc_no,
       COALESCE(active_job.driver, '') AS current_driver,
       COALESCE(active_job.bills, '[]'::jsonb) AS current_bills,
       to_char(c.fetched_at, 'YYYY-MM-DD HH24:MI:SS') AS fetched_at,
       GREATEST(0, EXTRACT(EPOCH FROM (LOCALTIMESTAMP - c.fetched_at)))::int AS age_seconds
     FROM public.odg_tms_gps_current c
     ${FLEET_JOIN}
     LEFT JOIN LATERAL (
       SELECT
         a.doc_no,
         COALESCE(NULLIF(TRIM(d.name_1), ''), a.driver, '-') AS driver,
         COALESCE((
           SELECT jsonb_agg(
             jsonb_build_object(
               'bill_no', det.bill_no,
               'customer', COALESCE(NULLIF(TRIM(cust.name_1), ''), det.cust_code, '-'),
               'status',
                 CASE
                   WHEN det.sent_start IS NULL AND det.sent_end IS NULL THEN 'ລໍຖ້າຈັດສົ່ງ'
                   WHEN det.sent_start IS NOT NULL AND det.sent_end IS NULL THEN 'ກຳລັງຈັດສົ່ງ'
                   WHEN COALESCE(det.status, 0) = 1 AND det.forward_transport_code IS NOT NULL THEN 'ສົ່ງຕໍ່ສາຂາແລ້ວ'
                   WHEN COALESCE(det.status, 0) = 1 THEN 'ຄົບຈຳນວນ'
                   WHEN COALESCE(det.status, 0) = 2 THEN 'ຍົກເລີກຈັດສົ່ງ'
                   ELSE 'ລໍຖ້າຈັດສົ່ງ'
                 END,
               'phase',
                 CASE
                   WHEN det.sent_start IS NULL AND det.sent_end IS NULL THEN 'waiting'
                   WHEN det.sent_start IS NOT NULL AND det.sent_end IS NULL THEN 'inprogress'
                   WHEN COALESCE(det.status, 0) = 1 AND det.forward_transport_code IS NOT NULL THEN 'forwarded'
                   WHEN COALESCE(det.status, 0) = 1 THEN 'done'
                   WHEN COALESCE(det.status, 0) = 2 THEN 'cancel'
                   ELSE 'waiting'
                 END
             )
             ORDER BY det.roworder
           )
           FROM public.odg_tms_detail det
           LEFT JOIN public.ar_customer cust ON cust.code = det.cust_code
           WHERE det.doc_no = a.doc_no
             AND ${getFixedYearSqlFilter("det.doc_date")}
         ), '[]'::jsonb) AS bills
       FROM public.odg_tms a
       LEFT JOIN public.odg_tms_driver d ON d.code = a.driver
       WHERE a.car = COALESCE(NULLIF(TRIM(v.code), ''), c.car_code)
         AND COALESCE(a.approve_status, 0) = 1
         AND COALESCE(a.job_status, 0) IN (1, 2)
         AND ${getFixedYearSqlFilter("a.doc_date")}
       ORDER BY
         CASE WHEN COALESCE(a.job_status, 0) = 2 THEN 0 ELSE 1 END,
         a.date_logistic DESC NULLS LAST,
         a.create_date_time_now DESC NULLS LAST,
         a.doc_no DESC
       LIMIT 1
     ) active_job ON true
     WHERE c.imei = $1
     LIMIT 1`,
    [imei]
  );
}

function isStale(rows) {
  if (!rows || rows.length === 0) return true;
  const minAge = rows.reduce(
    (min, r) => Math.min(min, Number(r.age_seconds ?? 999_999)),
    999_999
  );
  return minAge > STALE_SEC;
}

function stripInternal(row) {
  if (!row) return row;
  const { age_seconds: _age, ...rest } = row;
  return rest;
}

// Daily distance per IMEI (today, by haversine across consecutive log points)
async function getDailyDistanceByImei() {
  try {
    const rows = await query(
      `SELECT imei,
              COALESCE(SUM(seg_m), 0)::int AS meters_today
       FROM (
         SELECT imei,
                CASE WHEN prev_lat IS NULL OR prev_lng IS NULL THEN 0
                     ELSE 2 * 6371000 * asin(
                       LEAST(1, sqrt(
                         power(sin(radians((lat - prev_lat) / 2)), 2) +
                         cos(radians(prev_lat)) * cos(radians(lat)) *
                         power(sin(radians((lng - prev_lng) / 2)), 2)
                       ))
                     )
                END AS seg_m
         FROM (
           SELECT imei,
                  lat::float AS lat,
                  lng::float AS lng,
                  LAG(lat::float) OVER (PARTITION BY imei ORDER BY recorded_at) AS prev_lat,
                  LAG(lng::float) OVER (PARTITION BY imei ORDER BY recorded_at) AS prev_lng
           FROM public.odg_tms_gps_realtime_log
           WHERE recorded_at >= CURRENT_DATE
             AND recorded_at <  CURRENT_DATE + INTERVAL '1 day'
             AND lat IS NOT NULL AND lng IS NOT NULL
         ) sub
       ) seg
       GROUP BY imei`
    );
    const map = new Map();
    for (const r of rows) map.set(String(r.imei).trim(), Number(r.meters_today) || 0);
    return map;
  } catch (err) {
    console.warn("[gps-current] daily distance failed:", err?.message ?? err);
    return new Map();
  }
}

function attachDailyDistance(rows, distMap) {
  return rows.map((r) => ({
    ...r,
    distance_today_m: distMap.get(String(r.imei).trim()) ?? 0,
  }));
}

async function getCurrentAll() {
  await ensureSchema();
  const rows = await readAllFromDb();
  if (isStale(rows)) {
    try {
      console.log(
        `[gps-current] cache stale/empty (rows=${rows.length}) — live fetching now`
      );
      await runTick();
      const refreshed = await readAllFromDb();
      const dist = await getDailyDistanceByImei();
      return attachDailyDistance(refreshed.map(stripInternal), dist);
    } catch (err) {
      console.warn(
        `[gps-current] on-demand fetch failed, returning stale rows:`,
        err?.message ?? err
      );
    }
  }
  const dist = await getDailyDistanceByImei();
  return attachDailyDistance(rows.map(stripInternal), dist);
}

// Lean variant: drops the active_job LATERAL join and daily distance query.
// Used by pages that only need lat/lng/speed/recorded_at (e.g. gps-usage).
async function getCurrentAllLean() {
  await ensureSchema();
  const started = Date.now();
  const rows = await query(
    `SELECT
       c.imei,
       COALESCE(NULLIF(TRIM(v.code), ''), c.car_code, '') AS car_code,
       COALESCE(NULLIF(TRIM(v.name_1), ''), c.car_name, '') AS car_name,
       COALESCE(c.lat, '') AS lat,
       COALESCE(c.lng, '') AS lng,
       COALESCE(c.speed, '') AS speed,
       COALESCE(c.heading, '') AS heading,
       COALESCE(c.recorded_at, '') AS recorded_at,
       COALESCE(c.address, '') AS address,
       to_char(c.fetched_at, 'YYYY-MM-DD HH24:MI:SS') AS fetched_at
     FROM public.odg_tms_gps_current c
     ${FLEET_JOIN}
     ORDER BY car_name ASC, c.imei ASC`
  );
  const elapsed = Date.now() - started;
  if (elapsed > 200) {
    console.log(`[gps-current] lean read rows=${rows.length} elapsed=${elapsed}ms`);
  }
  return rows;
}

async function getCurrentOne(imei) {
  await ensureSchema();
  const cleanImei = String(imei ?? "").trim();
  if (!cleanImei) return null;
  const row = await readOneFromDb(cleanImei);
  if (isStale(row ? [row] : [])) {
    try {
      await runTick();
      const refreshed = await readOneFromDb(cleanImei);
      return refreshed ? stripInternal(refreshed) : null;
    } catch (err) {
      console.warn(`[gps-current] on-demand fetch failed:`, err?.message ?? err);
    }
  }
  return row ? stripInternal(row) : null;
}

// ==================== Worker ====================

let workerTimer = null;
let running = false;

async function runTick() {
  if (running) return; // skip if previous tick still in-flight
  running = true;
  const started = Date.now();
  try {
    const rows = await getGpsRealtimeAll();
    if (!Array.isArray(rows) || rows.length === 0) {
      console.warn("[gps-current] worker: provider returned no rows");
      return;
    }
    let ok = 0;
    let fail = 0;
    for (const r of rows) {
      try {
        await upsertCurrentRow(r);
        ok++;
      } catch (err) {
        fail++;
        console.error(`[gps-current] upsert failed imei=${r?.imei}:`, err?.message ?? err);
      }
    }
    const elapsed = Date.now() - started;
    console.log(
      `[gps-current] tick ok=${ok} fail=${fail} elapsed=${elapsed}ms`
    );
  } catch (err) {
    console.error("[gps-current] tick failed:", err?.message ?? err);
  } finally {
    running = false;
  }
}

function startWorker(intervalMs = 20_000) {
  if (workerTimer) return;
  ensureSchema()
    .then(() => {
      console.log(`[gps-current] worker starting, interval=${intervalMs}ms`);
      // Initial tick shortly after boot so the server can finish startup
      setTimeout(() => void runTick(), 2_000);
      workerTimer = setInterval(() => void runTick(), intervalMs);
    })
    .catch((err) => {
      console.error("[gps-current] worker init failed:", err?.message ?? err);
    });
}

function stopWorker() {
  if (!workerTimer) return;
  clearInterval(workerTimer);
  workerTimer = null;
}

module.exports = {
  startWorker,
  stopWorker,
  runTick,
  getCurrentAll,
  getCurrentAllLean,
  getCurrentOne,
  ensureSchema,
  upsertCurrentRow,
};
