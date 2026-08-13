const { pool, query } = require("../lib/db");
const { clampFuelPercent } = require("../lib/fuel-sanity");
const { getGpsRealtimeAll } = require("./tracking");
const {
  ensureSchema: ensureCurrentSchema,
  upsertCurrentRow,
} = require("./gps-current");

const cache = globalThis;

// ==================== Schema ====================

async function safeDdl(sql) {
  try {
    await pool.query(sql);
  } catch (err) {
    const msg = String(err?.message ?? "");
    if (err?.code === "23505" || /already exists/i.test(msg)) return;
    throw err;
  }
}

async function ensureSchemaInternal() {
  await safeDdl(`
    CREATE TABLE IF NOT EXISTS public.odg_tms_gps_realtime_log (
      roworder BIGSERIAL PRIMARY KEY,
      imei character varying NOT NULL,
      car_code character varying,
      car_name character varying,
      lat numeric,
      lng numeric,
      speed numeric,
      heading numeric,
      recorded_at timestamp without time zone,
      address text,
      fetched_at timestamp without time zone NOT NULL DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  // Fuel level (%) as reported by the tracker. `odg_tms_gps_current.oil` only
  // ever holds the latest reading — it is overwritten every tick — so without
  // this column there is no fuel history to detect siphoning, unlogged refills
  // or idle burn from. Costs one more value on an INSERT we already make.
  await safeDdl(`
    ALTER TABLE public.odg_tms_gps_realtime_log
    ADD COLUMN IF NOT EXISTS fuel_percent numeric
  `);
  await safeDdl(`
    CREATE INDEX IF NOT EXISTS idx_odg_tms_gps_realtime_log_imei_ts
    ON public.odg_tms_gps_realtime_log (imei, recorded_at DESC)
  `);
  await safeDdl(`
    CREATE INDEX IF NOT EXISTS idx_odg_tms_gps_realtime_log_recorded_at
    ON public.odg_tms_gps_realtime_log (recorded_at DESC)
  `);
  // Unique per (imei, recorded_at) so backfill can use ON CONFLICT DO NOTHING
  // and the realtime worker no longer inserts duplicates for the same ping.
  // (NULL recorded_at slots are still allowed because PG treats NULL as distinct.)
  await safeDdl(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_odg_tms_gps_realtime_log_imei_ts
    ON public.odg_tms_gps_realtime_log (imei, recorded_at)
  `);
}

async function ensureSchema() {
  if (cache.__tmsGpsRealtimeLogSchemaReady) return;
  if (!cache.__tmsGpsRealtimeLogSchemaPromise) {
    cache.__tmsGpsRealtimeLogSchemaPromise = ensureSchemaInternal()
      .then(() => {
        cache.__tmsGpsRealtimeLogSchemaReady = true;
      })
      .catch((err) => {
        cache.__tmsGpsRealtimeLogSchemaPromise = null;
        throw err;
      });
  }
  await cache.__tmsGpsRealtimeLogSchemaPromise;
}

// ==================== Helpers ====================

function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const LOG_COLUMNS =
  "imei, car_code, car_name, lat, lng, speed, heading, recorded_at, address, fuel_percent";
const LOG_COLUMN_COUNT = 10;

function logRowParams(r) {
  return [
    String(r.imei ?? "").trim(),
    String(r.car_code ?? "").trim(),
    String(r.car_name ?? "").trim(),
    numOrNull(r.lat),
    numOrNull(r.lng),
    numOrNull(r.speed),
    numOrNull(r.heading),
    String(r.recorded_at ?? "").trim() || null,
    String(r.address ?? "").trim() || null,
    clampFuelPercent(r.fuel_percent ?? r.oil),
  ];
}

/**
 * One INSERT for every row, duplicates dropped by the (imei, recorded_at)
 * unique index. Returns how many rows were actually new.
 *
 * The unique index is what makes this safe — callers do NOT need to check
 * "has this ping already been stored?" first. A pre-check SELECT per car was
 * how this used to work and it cost one round trip per car per tick.
 */
async function insertLogRowsBatch(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  await ensureSchema();
  const BATCH = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values = [];
    const params = [];
    for (const r of batch) {
      const b = params.length;
      const slots = Array.from(
        { length: LOG_COLUMN_COUNT },
        (_, k) => `$${b + k + 1}`
      );
      values.push(`(${slots.join(",")})`);
      params.push(...logRowParams(r));
    }
    const res = await pool.query(
      `INSERT INTO public.odg_tms_gps_realtime_log (${LOG_COLUMNS})
       VALUES ${values.join(",")}
       ON CONFLICT (imei, recorded_at) DO NOTHING`,
      params
    );
    inserted += res.rowCount || 0;
  }
  return inserted;
}

// ==================== Worker ====================

let timer = null;
let running = false;

async function runTick() {
  if (running) return;
  running = true;
  const started = Date.now();
  try {
    await ensureSchema();
    await ensureCurrentSchema();
    const rows = await getGpsRealtimeAll();
    if (!Array.isArray(rows) || rows.length === 0) {
      console.log("[gps-realtime-log] no rows from provider");
      return;
    }
    let inserted = 0;
    let skipped = 0;
    let errors = 0;
    let currentOk = 0;
    let currentFail = 0;
    let currentStale = 0;

    const toLog = [];
    for (const r of rows) {
      const imei = String(r.imei ?? "").trim();
      if (!imei) continue;

      // Skip overwriting "current" if provider returned no fix (e.g. 403 / network).
      // Preserves last known good lat/lng/state so the UI doesn't go offline.
      const hasFreshFix =
        String(r.lat ?? "").trim() !== "" && String(r.lng ?? "").trim() !== "";
      if (!hasFreshFix) {
        currentStale++;
      } else {
        try {
          await upsertCurrentRow(r);
          currentOk++;
        } catch (err) {
          currentFail++;
          console.error(
            `[gps-current] upsert failed imei=${imei}:`,
            err?.message ?? err
          );
        }
      }

      // A ping with no timestamp can't be deduped or ordered — drop it.
      if (!String(r.recorded_at ?? "").trim()) {
        skipped++;
        continue;
      }
      toLog.push(r);
    }

    // One INSERT for the whole fleet instead of a SELECT + INSERT per car.
    // Re-sent pings collide on (imei, recorded_at) and are skipped by the
    // unique index, so `rowCount` is exactly the number of new pings.
    try {
      inserted = await insertLogRowsBatch(toLog);
      skipped += toLog.length - inserted;
    } catch (err) {
      errors++;
      console.error(
        "[gps-realtime-log] batch insert failed:",
        err?.message ?? err
      );
    }
    // ຕື່ມຊື່ບ່ອນໃຫ້ຄັນທີ່ຍັງບໍ່ມີ — ຈຳກັດຕໍ່ຮອບ ເພື່ອບໍ່ໃຫ້ຍິງບໍລິການ
    // ພາຍນອກເກີນ 1 ຄັ້ງ/ວິນາທີ ຕາມກົດການໃຊ້ງານ
    try {
      const { reverseGeocode } = require("./geocode");
      const stale = await query(
        `SELECT imei, NULLIF(TRIM(lat), '')::numeric AS lat,
                NULLIF(TRIM(lng), '')::numeric AS lng
         FROM public.odg_tms_gps_current
         WHERE COALESCE(NULLIF(TRIM(address), ''), '') = ''
           AND NULLIF(TRIM(lat), '') IS NOT NULL
         LIMIT 3`
      );
      for (const row of stale) {
        const place = await reverseGeocode(row.lat, row.lng);
        if (place) {
          await query(
            `UPDATE public.odg_tms_gps_current SET address = $2 WHERE imei = $1`,
            [row.imei, place]
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 1100));
      }
    } catch (err) {
      console.error("[geocode] tick failed:", err?.message ?? err);
    }

    const elapsed = Date.now() - started;
    console.log(
      `[gps-realtime-log] tick log_inserted=${inserted} log_skipped=${skipped} log_errors=${errors} current_ok=${currentOk} current_fail=${currentFail} current_stale=${currentStale} elapsed=${elapsed}ms`
    );
  } catch (err) {
    console.error("[gps-realtime-log] tick failed:", err?.message ?? err);
  } finally {
    running = false;
  }
}

function startWorker(options = {}) {
  if (timer) return;
  const intervalMs = Number(
    options.intervalMs ?? process.env.GPS_REALTIME_LOG_INTERVAL_MS ?? 20_000
  );
  const initialDelayMs = Number(
    options.initialDelayMs ??
      process.env.GPS_REALTIME_LOG_INITIAL_DELAY_MS ??
      5_000
  );
  console.log(
    `[gps-realtime-log] worker starting interval=${intervalMs}ms initial_delay=${initialDelayMs}ms`
  );
  setTimeout(() => void runTick(), initialDelayMs);
  timer = setInterval(() => void runTick(), intervalMs);
}

function stopWorker() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

// ==================== Read ====================

async function getLogRange(imei, fromDate, toDate) {
  await ensureSchema();
  return query(
    `SELECT
       imei,
       COALESCE(car_code, '') AS car_code,
       COALESCE(car_name, '') AS car_name,
       lat::float AS lat,
       lng::float AS lng,
       COALESCE(speed, 0)::float AS speed,
       COALESCE(heading, 0)::float AS heading,
       to_char(recorded_at, 'YYYY-MM-DD HH24:MI:SS') AS recorded_at,
       COALESCE(address, '') AS address,
       fuel_percent::float AS fuel_percent,
       to_char(fetched_at, 'YYYY-MM-DD HH24:MI:SS') AS fetched_at
     FROM public.odg_tms_gps_realtime_log
     WHERE imei = $1
       AND recorded_at >= $2::timestamp
       AND recorded_at <  ($3::date + INTERVAL '1 day')
     ORDER BY recorded_at ASC`,
    [imei, fromDate, toDate]
  );
}

module.exports = {
  startWorker,
  stopWorker,
  runTick,
  getLogRange,
  insertLogRowsBatch,
  ensureSchema,
};
