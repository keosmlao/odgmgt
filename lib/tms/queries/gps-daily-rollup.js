// ສະຫຼຸບໄລຍະທາງ GPS ລາຍວັນ/ລາຍຄັນ ລົງຕາຕະລາງ odg_tms_gps_daily.
//
// ບັນຫາທີ່ມັນແກ້: ການຄິດໄລ່ໄລຍະທາງຈາກຈຸດ GPS ດິບ (odg_tms_gps_realtime_log)
// ຕ້ອງອ່ານຫຼາຍແສນຈຸດ — ວັດເມື່ອ 2026-08-12: ຊ່ວງ 30 ວັນ ຂອງ 21 ຄັນ
// (1 ລ້ານກວ່າຈຸດ) ໃຊ້ເວລາ 4.8–11.5 ວິນາທີ. ຊ້າເກີນກວ່າຈະເຮັດຕອນເປີດໜ້າ.
//
// ຕາຕະລາງ odg_tms_gps_daily ມີຢູ່ໃນ schema ມາດົນແລ້ວ ແຕ່ບໍ່ເຄີຍມີໃຜຂຽນລົງ
// (ວັດເມື່ອ 2026-08-12: 0 ແຖວ). ໄຟລ໌ນີ້ຄືຕົວຂຽນນັ້ນ. ພໍມີສະຫຼຸບລາຍວັນແລ້ວ
// ການລວມຊ່ວງໃດກໍ່ຕາມ ເຫຼືອພຽງການບວກ ~22 ຄັນ × ຈຳນວນວັນ = ຫຼັກມິນລິວິນາທີ.
//
// ຢູ່ນີ້ຍັງສະຫຼຸບ "ຄ່າກາງລະດັບນ້ຳມັນລາຍຊົ່ວໂມງ" ໄວ້ນຳ (odg_tms_gps_fuel_hourly).
// ⚠️ ຫຍໍ້ເປັນລາຍຊົ່ວໂມງ ບໍ່ແມ່ນລາຍວັນ ໂດຍເຈດຕະນາ: ການຄິດ km/L ຕ້ອງເດີນເສັ້ນ
// ຫາຈຸດເຕີມ ເຊິ່ງລາຍວັນຫຍາບເກີນໄປ (ວັດແລ້ວ ໃຫ້ຄ່າຜິດເຄິ່ງໜຶ່ງ).
//
// ⚠️ ໃຊ້ DAILY_AGG_SQL ອັນດຽວກັນກັບເສັ້ນທາງສົດ ຈຶ່ງບໍ່ມີທາງທີ່ຕົວເລກສອງບ່ອນຈະຕ່າງກັນ.
"use strict";

const { pool, query } = require("../lib/db");
const { DAILY_AGG_SQL, FLEET_CARS_SQL, ensureSchema } = require("./gps-usage.js");
const { addDays, getLaoToday } = require("../lib/lao-date");

const cache = globalThis;

async function safeDdl(sql) {
  try {
    await pool.query(sql);
  } catch (err) {
    const msg = String(err?.message ?? "");
    if (err?.code === "23505" || /already exists/i.test(msg)) return;
    throw err;
  }
}

/**
 * ແລ່ນ query ອ່ານ ໂດຍ **ບໍ່** ຜ່ານ ensureRollupSchema ກ່ອນ.
 *
 * ⚠️ ເປັນຫຍັງບໍ່ ensure ກ່ອນ: ensureSchema() ຂອງ gps-usage ແລ່ນ DDL ຫຼາຍສິບຄຳສັ່ງ
 * ບວກ DO block — ວັດເມື່ອ 2026-08-12 ໃຊ້ເວລາ 6,146ms ໃນການເອີ້ນຄັ້ງທຳອິດຂອງ
 * ແຕ່ລະ process (ຄັ້ງຕໍ່ໄປ 5ms). ໃນ next dev ທີ່ compile ໃໝ່ເລື້ອຍໆ ຜູ້ໃຊ້ຈຶ່ງ
 * ພົບ 6 ວິນາທີຊ້ຳແລ້ວຊ້ຳອີກ. ການອ່ານບໍ່ຄວນຈ່າຍຄ່າ migration.
 *
 * ຖ້າຕາຕະລາງຍັງບໍ່ມີ (42P01) ຈຶ່ງຄ່ອຍສ້າງ ແລ້ວລອງໃໝ່ເທື່ອດຽວ.
 */
async function readWithSchemaFallback(run) {
  try {
    return await run();
  } catch (err) {
    if (err?.code !== "42P01") throw err;
    await ensureRollupSchema();
    return run();
  }
}

// UPSERT ຕ້ອງມີກະແຈ — ຕາຕະລາງເດີມມີແຕ່ roworder ເປັນ primary key.
async function ensureRollupSchema() {
  if (cache.__tmsGpsDailyRollupReady) return;
  await ensureSchema();
  await safeDdl(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_odg_tms_gps_daily_imei_date
    ON public.odg_tms_gps_daily (imei, usage_date)
  `);
  await safeDdl(`
    CREATE INDEX IF NOT EXISTS idx_odg_tms_gps_daily_date
    ON public.odg_tms_gps_daily (usage_date)
  `);
  await safeDdl(`
    CREATE TABLE IF NOT EXISTS public.odg_tms_gps_fuel_hourly (
      imei character varying NOT NULL,
      hour_at timestamp without time zone NOT NULL,
      fuel_pct numeric NOT NULL,
      synced_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0),
      PRIMARY KEY (imei, hour_at)
    )
  `);
  await safeDdl(`
    CREATE INDEX IF NOT EXISTS idx_odg_tms_gps_fuel_hourly_at
    ON public.odg_tms_gps_fuel_hourly (hour_at)
  `);
  cache.__tmsGpsDailyRollupReady = true;
}

// ຕົວຕັ້ງອັນດຽວກັນກັບລາຍງານ (app_car_vehicles) — ຖ້າສະຫຼຸບຕາມ odg_tms_car
// ລົດທີ່ TMS ຍັງບໍ່ມີ ຫຼື IMEI ຄ້າງເກົ່າ ຈະບໍ່ມີແຖວໃນ odg_tms_gps_daily ເລີຍ
// ແລ້ວລາຍງານກໍ່ຂຶ້ນ 0 ທັງທີ່ຈຸດດິບມີຢູ່. ເບິ່ງ FLEET_CARS_SQL ໃນ gps-usage.js.
async function targetImeis() {
  const rows = await query(`SELECT imei FROM (${FLEET_CARS_SQL}) f`);
  return rows.map((r) => r.imei);
}

/**
 * ຄິດໄລ່ຄືນ ແລ້ວຂຽນທັບຊ່ວງວັນທີທີ່ໃຫ້ມາ. ບໍ່ດຶງຂໍ້ມູນອອກມາຝັ່ງ Node ເລີຍ —
 * INSERT ... SELECT ແລ່ນຢູ່ໃນ Postgres ໝົດ.
 *
 * @param {string} fromDate YYYY-MM-DD
 * @param {string} toDate   YYYY-MM-DD
 * @returns {Promise<number>} ຈຳນວນແຖວທີ່ຂຽນ
 */
async function rebuildDailyRange(fromDate, toDate) {
  await ensureRollupSchema();
  const imeis = await targetImeis();
  if (imeis.length === 0) return 0;

  const res = await pool.query(
    `INSERT INTO public.odg_tms_gps_daily (
       imei, car_code, car_name, usage_date,
       distance_km, max_speed, avg_speed,
       moving_seconds, stopped_seconds, points_count, synced_at
     )
     SELECT
       a.imei,
       c.code,
       c.name_1,
       a.usage_date::date,
       a.distance_km,
       a.max_speed,
       a.avg_speed,
       a.moving_seconds,
       a.stopped_seconds,
       a.points_count,
       LOCALTIMESTAMP(0)
     FROM (${DAILY_AGG_SQL}) a
     -- ⚠️ LATERAL ... LIMIT 1, ບໍ່ແມ່ນ JOIN ທຳມະດາ: ອາດມີຫຼາຍຄັນໃຊ້ imei ຊ້ຳກັນ.
     -- JOIN ທຳມະດາຈະຄູນແຖວ ແລ້ວ ON CONFLICT ຈະລົ້ມດ້ວຍ
     -- "cannot affect row a second time".
     LEFT JOIN LATERAL (
       SELECT c2.code, c2.name_1
       FROM (${FLEET_CARS_SQL}) c2
       WHERE c2.imei = a.imei
       ORDER BY c2.code
       LIMIT 1
     ) c ON TRUE
     ON CONFLICT (imei, usage_date) DO UPDATE SET
       car_code        = EXCLUDED.car_code,
       car_name        = EXCLUDED.car_name,
       distance_km     = EXCLUDED.distance_km,
       max_speed       = EXCLUDED.max_speed,
       avg_speed       = EXCLUDED.avg_speed,
       moving_seconds  = EXCLUDED.moving_seconds,
       stopped_seconds = EXCLUDED.stopped_seconds,
       points_count    = EXCLUDED.points_count,
       synced_at       = EXCLUDED.synced_at`,
    [imeis, fromDate, toDate]
  );
  return res.rowCount || 0;
}

/**
 * ຄ່າກາງລະດັບນ້ຳມັນລາຍຊົ່ວໂມງ ຂອງຊ່ວງທີ່ໃຫ້ມາ.
 * percentile_cont ເທິງຈຸດດິບ ~500,000 ຈຸດ ໃຊ້ 8.8 ວິນາທີ (ວັດ 2026-08-12)
 * ຈຶ່ງຄິດໄວ້ລ່ວງໜ້າ ແລ້ວໜ້າເວັບອ່ານແຕ່ຜົນ.
 */
async function rebuildFuelHourlyRange(fromDate, toDate) {
  await ensureRollupSchema();
  const res = await pool.query(
    `INSERT INTO public.odg_tms_gps_fuel_hourly (imei, hour_at, fuel_pct, synced_at)
     SELECT l.imei,
            date_trunc('hour', l.recorded_at),
            percentile_cont(0.5) WITHIN GROUP (ORDER BY l.fuel_percent),
            LOCALTIMESTAMP(0)
     FROM public.odg_tms_gps_realtime_log l
     WHERE l.fuel_percent IS NOT NULL
       AND l.recorded_at >= $1::date
       AND l.recorded_at <  ($2::date + INTERVAL '1 day')
     GROUP BY 1, 2
     ON CONFLICT (imei, hour_at) DO UPDATE SET
       fuel_pct  = EXCLUDED.fuel_pct,
       synced_at = EXCLUDED.synced_at`,
    [fromDate, toDate]
  );
  return res.rowCount || 0;
}

/**
 * ໄລຍະທາງລວມຕໍ່ຄັນ ໃນຊ່ວງທີ່ໃຫ້ມາ — ອ່ານຈາກສະຫຼຸບລາຍວັນ ຈຶ່ງໄວ.
 * ຄືນ car_code ເປັນກະແຈ ເພື່ອໃຫ້ຈັບຄູ່ກັບຂໍ້ມູນນ້ຳມັນໄດ້ໂດຍກົງ.
 *
 * @param {string} fromDate
 * @param {string} toDate
 */
async function getDistanceByCar(fromDate, toDate) {
  return readWithSchemaFallback(() =>
    query(
    `SELECT
       imei,
       COALESCE(car_code, '') AS car_code,
       COALESCE(car_name, '') AS car_name,
       COALESCE(SUM(distance_km), 0)::float AS distance_km,
       COUNT(*) FILTER (WHERE distance_km > 5)::int AS active_days,
       to_char(MAX(synced_at), 'YYYY-MM-DD HH24:MI') AS synced_at
     FROM public.odg_tms_gps_daily
     WHERE usage_date >= $1::date AND usage_date <= $2::date
     GROUP BY imei, car_code, car_name
     ORDER BY 4 DESC`,
      [fromDate, toDate]
    )
  );
}

/** ວັນທີສະຫຼຸບເກົ່າສຸດ/ໃໝ່ສຸດທີ່ມີ — ໃຊ້ບອກຜູ້ໃຊ້ວ່າຂໍ້ມູນກວມເຖິງໃສ. */
async function getRollupCoverage() {
  const rows = await readWithSchemaFallback(() =>
    query(
    `SELECT to_char(MIN(usage_date), 'YYYY-MM-DD') AS from_date,
            to_char(MAX(usage_date), 'YYYY-MM-DD') AS to_date,
            COUNT(*)::int AS rows
     FROM public.odg_tms_gps_daily`
    )
  );
  return rows[0] ?? { from_date: null, to_date: null, rows: 0 };
}

// ==================== Worker ====================

let timer = null;
let running = false;

// ມື້ນີ້ຍັງບໍ່ຈົບ ແລະ ຈຸດຂອງມື້ວານອາດມາຊ້າ — ຈຶ່ງຄິດຄືນ 2 ມື້ຫຼ້າສຸດທຸກຮອບ.
const REFRESH_DAYS = 2;

async function runTick() {
  if (running) return;
  running = true;
  const started = Date.now();
  try {
    const today = getLaoToday();
    const from = addDays(today, -(REFRESH_DAYS - 1));
    const rows = await rebuildDailyRange(from, today);
    const fuelRows = await rebuildFuelHourlyRange(from, today);
    console.log(
      `[gps-daily-rollup] tick ${from}..${today} days=${rows} fuel_hours=${fuelRows} elapsed=${Date.now() - started}ms`
    );
  } catch (err) {
    console.error("[gps-daily-rollup] tick failed:", err?.message ?? err);
  } finally {
    running = false;
  }
}

function startWorker(options = {}) {
  if (timer) return;
  const intervalMs = Number(
    options.intervalMs ?? process.env.GPS_DAILY_ROLLUP_INTERVAL_MS ?? 900_000
  );
  const initialDelayMs = Number(
    options.initialDelayMs ??
      process.env.GPS_DAILY_ROLLUP_INITIAL_DELAY_MS ??
      60_000
  );
  console.log(
    `[gps-daily-rollup] worker starting interval=${intervalMs}ms initial_delay=${initialDelayMs}ms`
  );
  setTimeout(() => void runTick(), initialDelayMs);
  timer = setInterval(() => void runTick(), intervalMs);
}

function stopWorker() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

module.exports = {
  ensureRollupSchema,
  rebuildDailyRange,
  rebuildFuelHourlyRange,
  getDistanceByCar,
  getRollupCoverage,
  runTick,
  startWorker,
  stopWorker,
};
