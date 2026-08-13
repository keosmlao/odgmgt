const { pool, query, queryOne } = require("../lib/db");
const { getLaoToday, addDays } = require("../lib/lao-date");

const gpsUsageCache = globalThis;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const PROVIDER_MIN_GAP_MS = Math.max(
  0,
  Number.parseInt(process.env.GPS_TRACKER_MIN_GAP_MS ?? "1200", 10) || 1200
);
const RANGE_SYNC_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.GPS_USAGE_RANGE_CONCURRENCY ?? "1", 10) || 1
);
// Cap auto-fallback fetches (past days missing from DB cache) to avoid running
// past Next.js's server-action timeout. Each fetch ~1.2s due to provider gap.
const LIVE_FALLBACK_MAX_FETCHES = Math.max(
  1,
  Number.parseInt(process.env.GPS_USAGE_FALLBACK_MAX_FETCHES ?? "60", 10) || 60
);

// ==================== ທະບຽນລົດ (ຕົວຕັ້ງ) ====================

/**
 * ທະບຽນລົດຫຼັກຂອງລາຍງານ GPS ແມ່ນ public.app_car_vehicles — ບໍ່ແມ່ນ odg_tms_car.
 *
 * ວັດເມື່ອ 2026-08-13: odg_tms_car ຂາດ ຫຼື ຄ້າງເກົ່າ ຈົນລາຍງານຜິດ 3 ແບບ —
 *  1. ຂາດລົດ 5 ຄັນທີ່ລົງທະບຽນ GPS ແລ້ວ (7ขฉ-9780, ກຜ-8432, ກສ-4400,
 *     ຣຮ-9191, ລຣ-9977) ຈຶ່ງບໍ່ເຄີຍປາກົດໃນລາຍງານເລີຍ.
 *  2. ບຄ 3487 ຢູ່ TMS ຍັງເປັນ IMEI 864022088423016 ທີ່ບໍ່ມີຈຸດແມ່ນແຕ່ຈຸດດຽວ
 *     ໃນຂະນະທີ່ເຄື່ອງຈິງ 867869060331931 ສົ່ງມາ 43,224 ຈຸດ/30 ວັນ.
 *  3. ກຍ4899 ຢູ່ TMS ຖືກໃສ່ IMEI ຂອງ ກບ-2608 (867869060226974) ຈຶ່ງນັບໄລຍະ
 *     ທາງຂອງອີກຄັນໜຶ່ງ.
 * ໃນທາງກັບກັນ ທຸກ IMEI ທີ່ມີໃນ odg_tms_gps_current ຢູ່ໃນ app_car_vehicles ໝົດ.
 *
 * ຍັງ LEFT JOIN odg_tms_car ຢູ່ ແຕ່ **ຈັບຄູ່ດ້ວຍປ້າຍທະບຽນ ບໍ່ແມ່ນ IMEI** (ຍ້ອນ
 * ຂໍ້ 2–3 ຂ້າງເທິງ) — ເອົາມາແຕ່ code ຂອງ TMS ເພື່ອໃຫ້ຈັບຄູ່ກັບບັນທຶກນ້ຳມັນ
 * (odg_tms_fuel_log.car → getFuelByCar) ໄດ້ຄືເກົ່າ. ຄັນທີ່ TMS ບໍ່ມີ ໃຊ້ປ້າຍ
 * ທະບຽນເປັນ code ແທນ.
 *
 * ປ້າຍທະບຽນສອງບ່ອນຂຽນຄົນລະແບບ (app: "ກນ-7855", TMS: "ກນ 7855" ຫຼື "ກນ7855")
 * ຈຶ່ງຕັດຍະຫວ່າງ/ຂີດ/ຈຸດອອກກ່ອນທຽບ. TMS ຫຼາຍແຖວ plate_no ວ່າງ ຈຶ່ງທຽບ name_1 ນຳ.
 */
const plateKey = (expr) =>
  `upper(replace(replace(replace(COALESCE(${expr}, ''), ' ', ''), '-', ''), '.', ''))`;

const FLEET_CARS_SQL = `
  SELECT COALESCE(NULLIF(btrim(t.code), ''), v.plate_no) AS code,
         v.plate_no AS name_1,
         btrim(v.gps_imei) AS imei
  FROM public.app_car_vehicles v
  -- LATERAL ... LIMIT 1: ຢູ່ TMS ມີປ້າຍຊ້ຳກັນໄດ້, ຢາກໄດ້ແຖວດຽວຕໍ່ຄັນ.
  LEFT JOIN LATERAL (
    SELECT c.code
    FROM public.odg_tms_car c
    WHERE ${plateKey("NULLIF(btrim(c.plate_no), '')")} = ${plateKey("v.plate_no")}
       OR ${plateKey("c.name_1")} = ${plateKey("v.plate_no")}
    ORDER BY c.code
    LIMIT 1
  ) t ON TRUE
  WHERE COALESCE(btrim(v.gps_imei), '') <> ''
`;

// ==================== Schema ====================

async function safeDdl(sql) {
  try {
    await pool.query(sql);
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

async function ensureSchemaInternal() {
  await safeDdl(
    `ALTER TABLE public.odg_tms_car ADD COLUMN IF NOT EXISTS imei character varying`
  );
  // ⚠️ ໜຶ່ງອຸປະກອນ = ໜຶ່ງຄັນ. ບໍ່ມີຕົວກັນມາກ່ອນ ແລະ imei 867869060226974
  // ຖືກຜູກໃສ່ທັງ ກບ 2608 ແລະ ກຍ4899 — ໜ້າສະຫຼຸບຈຶ່ງນັບໄລຍະທາງຂອງລົດຄັນນັ້ນ
  // ສອງເທື່ອ (ວັດເມື່ອ 2026-08-12: ເກີນຈິງ 470 km ໃນເດືອນດຽວ).
  // ຍົກເວັ້ນຄ່າຫວ່າງ/NULL ເພາະລົດທີ່ບໍ່ມີ tracker ມີໄດ້ຫຼາຍຄັນ.
  await safeDdl(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_odg_tms_car_imei
    ON public.odg_tms_car (imei)
    WHERE imei IS NOT NULL AND btrim(imei) <> ''
  `);
  await safeDdl(`
    CREATE TABLE IF NOT EXISTS public.odg_tms_gps_daily (
      roworder BIGSERIAL PRIMARY KEY,
      imei character varying NOT NULL,
      car_code character varying,
      car_name character varying,
      usage_date date NOT NULL,
      first_time timestamp without time zone,
      last_time timestamp without time zone,
      distance_km numeric DEFAULT 0,
      max_speed numeric DEFAULT 0,
      avg_speed numeric DEFAULT 0,
      moving_seconds integer DEFAULT 0,
      stopped_seconds integer DEFAULT 0,
      points_count integer DEFAULT 0,
      synced_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'odg_tms_gps_daily'
          AND column_name = 'date'
      ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'odg_tms_gps_daily'
          AND column_name = 'usage_date'
      ) THEN
        ALTER TABLE public.odg_tms_gps_daily RENAME COLUMN date TO usage_date;
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'odg_tms_gps_daily'
          AND column_name = 'distance'
      ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'odg_tms_gps_daily'
          AND column_name = 'distance_km'
      ) THEN
        ALTER TABLE public.odg_tms_gps_daily RENAME COLUMN distance TO distance_km;
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'odg_tms_gps_daily'
          AND column_name = 'create_date_time_now'
      ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'odg_tms_gps_daily'
          AND column_name = 'synced_at'
      ) THEN
        ALTER TABLE public.odg_tms_gps_daily RENAME COLUMN create_date_time_now TO synced_at;
      END IF;
    END $$;
  `);
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_daily ADD COLUMN IF NOT EXISTS car_code character varying`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_daily ADD COLUMN IF NOT EXISTS car_name character varying`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_daily ADD COLUMN IF NOT EXISTS usage_date date`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_daily ADD COLUMN IF NOT EXISTS first_time timestamp without time zone`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_daily ADD COLUMN IF NOT EXISTS last_time timestamp without time zone`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_daily ADD COLUMN IF NOT EXISTS distance_km numeric DEFAULT 0`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_daily ADD COLUMN IF NOT EXISTS max_speed numeric DEFAULT 0`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_daily ADD COLUMN IF NOT EXISTS avg_speed numeric DEFAULT 0`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_daily ADD COLUMN IF NOT EXISTS moving_seconds integer DEFAULT 0`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_daily ADD COLUMN IF NOT EXISTS stopped_seconds integer DEFAULT 0`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_daily ADD COLUMN IF NOT EXISTS points_count integer DEFAULT 0`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_daily ADD COLUMN IF NOT EXISTS synced_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)`
  );
  await query(`
    UPDATE public.odg_tms_gps_daily
    SET
      distance_km = COALESCE(distance_km, 0),
      max_speed = COALESCE(max_speed, 0),
      avg_speed = COALESCE(avg_speed, 0),
      moving_seconds = COALESCE(moving_seconds, 0),
      stopped_seconds = COALESCE(stopped_seconds, 0),
      points_count = COALESCE(points_count, 0),
      synced_at = COALESCE(synced_at, LOCALTIMESTAMP(0))
    WHERE
      distance_km IS NULL
      OR max_speed IS NULL
      OR avg_speed IS NULL
      OR moving_seconds IS NULL
      OR stopped_seconds IS NULL
      OR points_count IS NULL
      OR synced_at IS NULL
  `);
  await query(`
    DELETE FROM public.odg_tms_gps_daily older
    USING public.odg_tms_gps_daily newer
    WHERE older.roworder < newer.roworder
      AND older.imei = newer.imei
      AND older.usage_date = newer.usage_date
      AND older.usage_date IS NOT NULL
  `);
  await safeDdl(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_odg_tms_gps_daily_imei_date
    ON public.odg_tms_gps_daily (imei, usage_date)
  `);
  await safeDdl(`
    CREATE INDEX IF NOT EXISTS idx_odg_tms_gps_daily_date
    ON public.odg_tms_gps_daily (usage_date)
  `);

  await safeDdl(`
    CREATE TABLE IF NOT EXISTS public.odg_tms_gps_points (
      roworder BIGSERIAL PRIMARY KEY,
      imei character varying NOT NULL,
      usage_date date NOT NULL,
      recorded_at timestamp without time zone NOT NULL,
      lat numeric NOT NULL,
      lng numeric NOT NULL,
      speed numeric DEFAULT 0,
      heading numeric DEFAULT 0
    )
  `);
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_points ADD COLUMN IF NOT EXISTS imei character varying`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_points ADD COLUMN IF NOT EXISTS usage_date date`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_points ADD COLUMN IF NOT EXISTS recorded_at timestamp without time zone`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_points ADD COLUMN IF NOT EXISTS lat numeric`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_points ADD COLUMN IF NOT EXISTS lng numeric`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_points ADD COLUMN IF NOT EXISTS speed numeric DEFAULT 0`
  );
  await safeDdl(
    `ALTER TABLE public.odg_tms_gps_points ADD COLUMN IF NOT EXISTS heading numeric DEFAULT 0`
  );
  await safeDdl(`
    CREATE INDEX IF NOT EXISTS idx_odg_tms_gps_points_imei_date
    ON public.odg_tms_gps_points (imei, usage_date)
  `);
}

async function ensureSchema() {
  if (gpsUsageCache.__tmsGpsUsageSchemaReady) return;
  if (!gpsUsageCache.__tmsGpsUsageSchemaPromise) {
    gpsUsageCache.__tmsGpsUsageSchemaPromise = ensureSchemaInternal()
      .then(() => {
        gpsUsageCache.__tmsGpsUsageSchemaReady = true;
      })
      .catch((err) => {
        gpsUsageCache.__tmsGpsUsageSchemaPromise = null;
        throw err;
      });
  }
  await gpsUsageCache.__tmsGpsUsageSchemaPromise;
}

async function ensureRealtimeLogSchemaForUsage() {
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
  await safeDdl(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_odg_tms_gps_realtime_log_imei_ts
    ON public.odg_tms_gps_realtime_log (imei, recorded_at)
  `);
}

async function insertRealtimeLogRowsFromUsage(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  await ensureRealtimeLogSchemaForUsage();
  const batchSize = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values = [];
    const params = [];
    for (const row of batch) {
      const base = params.length;
      values.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9})`
      );
      params.push(
        String(row.imei ?? "").trim(),
        String(row.car_code ?? "").trim(),
        String(row.car_name ?? "").trim(),
        Number.isFinite(Number(row.lat)) ? Number(row.lat) : null,
        Number.isFinite(Number(row.lng)) ? Number(row.lng) : null,
        Number.isFinite(Number(row.speed)) ? Number(row.speed) : null,
        Number.isFinite(Number(row.heading)) ? Number(row.heading) : null,
        String(row.recorded_at ?? "").trim() || null,
        String(row.address ?? "").trim() || null
      );
    }
    const result = await pool.query(
      `INSERT INTO public.odg_tms_gps_realtime_log
         (imei, car_code, car_name, lat, lng, speed, heading, recorded_at, address)
       VALUES ${values.join(",")}
       ON CONFLICT (imei, recorded_at) DO NOTHING`,
      params
    );
    inserted += result.rowCount || 0;
  }
  return inserted;
}

// ==================== Provider config ====================

const gpsOpenApi = require("./gps-openapi");

function getGpsTrackerConfig() {
  const baseUrl = process.env.GPS_TRACKER_API_URL || "https://apis.thaigpstracker.co.th";
  const user = process.env.GPS_TRACKER_USER || "";
  const pass = process.env.GPS_TRACKER_PASS || "";
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  return { baseUrl, auth };
}

async function fetchProviderJson(config, path) {
  let res;
  try {
    res = await runProviderRequest(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30_000);
      try {
        return await fetch(`${config.baseUrl}${path}`, {
          headers: { Authorization: `Basic ${config.auth}` },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
    });
  } catch (err) {
    console.warn(`[gps-usage] ${path} fetch failed: ${err?.message ?? err}`);
    return null;
  }
  if (!res.ok) {
    console.warn(`[gps-usage] ${path} returned ${res.status}`);
    return null;
  }
  try {
    return await res.json();
  } catch (err) {
    console.warn(`[gps-usage] ${path} non-JSON: ${err?.message ?? err}`);
    return null;
  }
}

function rowHasGpsIdentity(row) {
  if (!row || typeof row !== "object") return false;
  const keys = Object.keys(row).map((key) => key.toLowerCase());
  return keys.some((key) => key.includes("imei") || key.includes("object"));
}

function extractGpsObjectRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const candidates = [
    payload.data,
    payload.objects,
    payload.rows,
    payload.list,
    payload.result,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === "object") {
      if (Array.isArray(candidate.list)) return candidate.list;
      if (Array.isArray(candidate.data)) return candidate.data;
      if (rowHasGpsIdentity(candidate)) return [candidate];
    }
  }

  if (rowHasGpsIdentity(payload)) return [payload];
  return [];
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function normalizeGpsObjectRow(row) {
  const imei = firstNonEmpty(
    row.imei,
    row.IMEI,
    row.device_imei,
    row.deviceImei,
    row.object_imei,
    row.objectImei
  );
  return {
    imei,
    // ⚠️ /exporter/object/getList ໃຊ້ຊື່ຊ່ອງແບບ snake_case (license_plate_number,
    // model) ເຊິ່ງບໍ່ໄດ້ຢູ່ໃນລາຍການເດີມ — ຜົນຄື ທຸກຄັນຄືນ name/plate ເປັນຄ່າຫວ່າງ
    // ທັງທີ່ provider ສົ່ງມາຄົບ (ວັດເມື່ອ 2026-08-12: 28/28 ຄັນ ຫວ່າງໝົດ).
    name: firstNonEmpty(
      row.name,
      row.objectName,
      row.carName,
      row.alias,
      row.model
    ),
    plate: firstNonEmpty(
      row.plate,
      row.licensePlate,
      row.carLicensePlate,
      row.plateNo,
      row.license_plate_number
    ),
    province: firstNonEmpty(row.license_plate_province),
    model: firstNonEmpty(row.model),
    chassis: firstNonEmpty(row.chassis),
    status: firstNonEmpty(row.status),
  };
}

function validateYmd(value, label) {
  const dateStr = String(value ?? "").trim();
  if (!YMD_RE.test(dateStr)) {
    throw new Error(`Invalid ${label} (expected YYYY-MM-DD)`);
  }
  const parsed = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${label} (expected YYYY-MM-DD)`);
  }
  return dateStr;
}

function validateDateRange(fromDate, toDate) {
  const from = validateYmd(fromDate, "fromDate");
  const to = validateYmd(toDate, "toDate");
  if (from > to) {
    throw new Error("Invalid date range: fromDate must be before or equal to toDate");
  }
  return { fromDate: from, toDate: to };
}

async function runProviderRequest(task) {
  const previous = gpsUsageCache.__tmsGpsProviderQueue ?? Promise.resolve();
  const scheduled = previous
    .catch(() => undefined)
    .then(async () => {
      const lastAt = gpsUsageCache.__tmsGpsProviderLastAt ?? 0;
      const waitMs = Math.max(0, PROVIDER_MIN_GAP_MS - (Date.now() - lastAt));
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      const result = await task();
      gpsUsageCache.__tmsGpsProviderLastAt = Date.now();
      return result;
    });
  gpsUsageCache.__tmsGpsProviderQueue = scheduled.catch(() => undefined);
  return scheduled;
}

// ==================== Provider fetchers ====================

async function fetchGpsObjectList() {
  const config = getGpsTrackerConfig();
  for (const path of ["/exporter/object/get", "/exporter/object/getList"]) {
    const json = await fetchProviderJson(config, path);
    const rows = extractGpsObjectRows(json)
      .map((row) => normalizeGpsObjectRow(row))
      .filter((row) => row.imei);

    if (rows.length > 0) {
      const unique = new Map();
      for (const row of rows) {
        if (!unique.has(row.imei)) unique.set(row.imei, row);
      }
      return Array.from(unique.values());
    }
  }
  return [];
}

function toYmd(dateStr) {
  // "YYYY-MM-DD" -> "YYYYMMDD"
  return String(dateStr).replaceAll("-", "");
}

function extractHistoryRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const candidates = [
    payload.log_list,
    payload.data,
    payload.rows,
    payload.list,
    payload.result,
    payload.history,
    payload.logs,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
    if (c && typeof c === "object") {
      if (Array.isArray(c.data)) return c.data;
      if (Array.isArray(c.list)) return c.list;
      if (Array.isArray(c.rows)) return c.rows;
    }
  }
  return [];
}

function parseLatLng(row) {
  const latlng = String(row.latlng ?? row.latLng ?? row.location ?? "").trim();
  if (latlng.includes(",")) {
    const [latStr = "", lngStr = ""] = latlng.split(",").map((s) => s.trim());
    const lat = Number(latStr);
    const lng = Number(lngStr);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  const lat = Number(row.lat ?? row.latitude ?? row.Lat ?? NaN);
  const lng = Number(row.lng ?? row.lon ?? row.long ?? row.longitude ?? NaN);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  return null;
}

function mapHistoryRow(row) {
  const coords = parseLatLng(row);
  if (!coords) return null;
  const recordedAt = normalizeTimestamp(
    row.gpsDateTime ??
      row.dateTime ??
      row.datetime ??
      row.date_time_log ??
      row.date_time_recv ??
      row.dateTimeGps ??
      row.time ??
      ""
  );
  if (!recordedAt) return null;
  return {
    recordedAt,
    date: recordedAt.slice(0, 10),
    lat: coords.lat,
    lng: coords.lng,
    speed: Number(row.speed ?? row.velocity ?? row.spd ?? 0) || 0,
    heading: Number(row.heading ?? row.direction ?? row.course ?? 0) || 0,
    // ລະດັບນ້ຳມັນ % — provider ສົ່ງມາໃນປະຫວັດຍ້ອນຫຼັງນຳ ຈຶ່ງດຶງເກັບໄດ້
    // ໂດຍບໍ່ຕ້ອງລໍໃຫ້ worker ສະສົມເອງເປັນອາທິດ.
    oil: row.oil ?? row.fuel ?? row.fuelLevel ?? null,
  };
}

async function fetchProviderHistoryUrl(url, imei) {
  const config = getGpsTrackerConfig();
  let res;
  try {
    res = await runProviderRequest(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60_000);
      try {
        return await fetch(url, {
          headers: { Authorization: `Basic ${config.auth}` },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
    });
  } catch (err) {
    console.warn(`[gps-usage] fetch failed imei=${imei} url=${url}: ${err?.message ?? err}`);
    return { rawRows: [], logTag: "fetch-error" };
  }
  if (!res.ok) {
    console.warn(`[gps-usage] HTTP ${res.status} imei=${imei} url=${url}`);
    return { rawRows: [], logTag: `http-${res.status}` };
  }
  let json;
  try {
    json = await res.json();
  } catch (err) {
    console.warn(`[gps-usage] non-JSON imei=${imei}: ${err?.message ?? err}`);
    return { rawRows: [], logTag: "non-json" };
  }
  const rawRows = extractHistoryRows(json);
  if (rawRows.length === 0) {
    const preview = JSON.stringify(json).slice(0, 300);
    console.warn(`[gps-usage] empty imei=${imei} keys=${Object.keys(json ?? {}).join(",")} preview=${preview}`);
  }
  return { rawRows, json };
}

async function fetchWithRetry(url, imei, label) {
  // Retry on transient errors (network / 5xx / 429 / non-JSON).
  // Do not retry on 200 with empty rows — that is a legit "no data" result.
  const MAX_ATTEMPTS = 3;
  let lastTag = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { rawRows, logTag } = await fetchProviderHistoryUrl(url, imei);
    const retryable =
      logTag === "fetch-error" ||
      logTag === "non-json" ||
      (typeof logTag === "string" && /^http-5\d\d$/.test(logTag)) ||
      logTag === "http-429";

    if (!retryable) {
      if (attempt > 1) {
        console.log(
          `[gps-usage] retry ok imei=${imei} ${label} attempt=${attempt} raw=${rawRows.length}`
        );
      }
      return { rawRows, failed: false, tag: logTag ?? null };
    }

    lastTag = logTag;
    if (attempt < MAX_ATTEMPTS) {
      const backoffMs = 2000 * attempt; // 2s, 4s
      console.warn(
        `[gps-usage] retry imei=${imei} ${label} attempt=${attempt}/${MAX_ATTEMPTS} tag=${logTag} wait=${backoffMs}ms`
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  console.warn(
    `[gps-usage] give up imei=${imei} ${label} after ${MAX_ATTEMPTS} attempts last=${lastTag}`
  );
  const message =
    lastTag === "http-429"
      ? `GPS provider rate limit for imei=${imei}. Please retry later.`
      : `GPS provider request failed for imei=${imei} (${lastTag ?? "unknown"})`;
  const error = new Error(message);
  error.code =
    lastTag === "http-429"
      ? "GPS_PROVIDER_RATE_LIMIT"
      : "GPS_PROVIDER_FETCH_FAILED";
  error.meta = { imei, label, tag: lastTag };
  throw error;
}

async function fetchGpsHistoryOneDay(imei, dateStr) {
  // Open API ກ່ອນ: 1 ຄຳຂໍໄດ້ເຖິງ 20000 ຈຸດ ແລະ ບອກເມື່ອຕັດ (next_from)
  // ຂອງເກົ່າຕ້ອງແບ່ງໜ້າເອງເທື່ອລະ 2000 ຈຶ່ງຍິງຫຼາຍຮອບຕໍ່ 1 ຄັນ/1 ວັນ
  // ແລ້ວເປັນຕົ້ນເຫດຫຼັກຂອງ HTTP 429 ຕອນ sync ຍ້ອນຫຼັງ.
  if (gpsOpenApi.isOpenApiConfigured()) {
    try {
      const { points, raw } = await gpsOpenApi.fetchHistoryPoints(imei, dateStr);
      return { raw, points };
    } catch (error) {
      console.warn(
        `[gps-usage] openapi history imei=${imei} ${dateStr} ລົ້ມ (${error?.code ?? ""}) — ໃຊ້ provider ເກົ່າແທນ`
      );
    }
  }
  const config = getGpsTrackerConfig();
  const cleanImei = String(imei).trim();
  const baseUrl = `${config.baseUrl}/exporter/log/getHistory/${encodeURIComponent(cleanImei)}/${toYmd(dateStr)}`;
  const PAGE_LIMIT = 2000;
  const MAX_PAGES = 25; // safety cap (50,000 points/day)
  const allRaw = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${baseUrl}?page=${page}&limit=${PAGE_LIMIT}`;
    const { rawRows } = await fetchWithRetry(
      url,
      cleanImei,
      `date=${dateStr} page=${page}`
    );
    if (!rawRows || rawRows.length === 0) break;
    for (const r of rawRows) allRaw.push(r);
    if (rawRows.length < PAGE_LIMIT) break; // last page
  }
  const mapped = allRaw.map(mapHistoryRow).filter(Boolean);
  return { raw: allRaw.length, points: mapped };
}

async function fetchGpsHistoryRange(imei, fromDate, toDate) {
  // Provider supports only the single-day URL: /getHistory/{imei}/{YYYYMMDD}.
  // Loop day-by-day and concatenate.
  const cleanImei = String(imei).trim();
  if (!cleanImei) return [];
  const days = enumerateDays(fromDate, toDate);
  const all = [];
  let rawTotal = 0;
  for (const day of days) {
    const { raw, points } = await fetchGpsHistoryOneDay(cleanImei, day);
    rawTotal += raw;
    for (const p of points) all.push(p);
  }
  all.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  console.log(
    `[gps-usage] range fetched imei=${cleanImei} ${fromDate}..${toDate} days=${days.length} raw=${rawTotal} points=${all.length}`
  );
  return all;
}

async function fetchGpsHistory(imei, dateStr) {
  const { points } = await fetchGpsHistoryOneDay(imei, dateStr);
  return points;
}

// Convert "YYYY-MM-DD HH:MM:SS" or ISO to a format PG can accept.
// Returns null if unparseable.
function normalizeTimestamp(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  // Already looks like "YYYY-MM-DD HH:MM:SS" or ISO — keep as-is.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.test(raw)) return raw;
  // Try "DD-MM-YYYY HH:MM:SS" fallback.
  const m = raw.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}:\d{2}(:\d{2})?)/);
  if (m) return `${m[3]}-${m[2]}-${m[1]} ${m[4]}`;
  // Try generic Date parse.
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
  }
  return null;
}

// ==================== Aggregation ====================

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // km
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function summarize(points) {
  const summary = {
    distance_km: 0,
    max_speed: 0,
    avg_speed: 0,
    moving_seconds: 0,
    stopped_seconds: 0,
    points_count: points.length,
    first_time: null,
    last_time: null,
  };
  if (points.length === 0) return summary;

  summary.first_time = points[0].recordedAt;
  summary.last_time = points[points.length - 1].recordedAt;

  let speedSum = 0;
  for (const p of points) {
    if (p.speed > summary.max_speed) summary.max_speed = p.speed;
    speedSum += p.speed;
  }
  summary.avg_speed = speedSum / points.length;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const seg = haversineKm(prev.lat, prev.lng, curr.lat, curr.lng);
    summary.distance_km += seg;
    const dtSec = Math.max(
      0,
      Math.floor(
        (new Date(curr.recordedAt).getTime() -
          new Date(prev.recordedAt).getTime()) /
          1000
      )
    );
    // Treat >15 min gap as not driving
    if (dtSec > 900) continue;
    const midSpeed = (prev.speed + curr.speed) / 2;
    if (midSpeed > 3) summary.moving_seconds += dtSec;
    else summary.stopped_seconds += dtSec;
  }

  return summary;
}

// ==================== Sync ====================

async function syncGpsDay(dateStr) {
  await ensureSchema();
  const usageDate = validateYmd(dateStr, "date");

  // Source of vehicles: provider list (every device that has GPS).
  const providerList = await fetchGpsObjectList();

  // Cross-reference with the fleet register by imei for nicer names.
  const fleetCars = await query(FLEET_CARS_SQL);
  const fleetByImei = new Map();
  for (const c of fleetCars) {
    fleetByImei.set(String(c.imei).trim(), c);
  }

  // Build the target list. If provider returned nothing (e.g. endpoint blocked),
  // fall back to the registered fleet so we at least sync our own cars.
  let targets;
  if (providerList.length > 0) {
    targets = providerList.map((p) => {
      const match = fleetByImei.get(p.imei);
      return {
        imei: p.imei,
        code: match?.code ?? "",
        name_1: match?.name_1 || p.name || p.plate || p.imei,
      };
    });
  } else {
    targets = fleetCars.map((c) => ({
      imei: String(c.imei).trim(),
      code: c.code,
      name_1: c.name_1,
    }));
  }

  if (targets.length === 0) {
    return { date: usageDate, synced: 0, skipped: 0, errors: 0, cars: [] };
  }

  const results = [];
  let synced = 0;
  let skipped = 0;
  let errors = 0;

  for (const car of targets) {
    try {
      const imei = String(car.imei).trim();
      if (!imei) {
        skipped++;
        continue;
      }
      const points = await fetchGpsHistory(imei, usageDate);

      if (points.length === 0) {
        await pool.query(
          `INSERT INTO public.odg_tms_gps_daily (
             imei, car_code, car_name, usage_date,
             first_time, last_time,
             distance_km, max_speed, avg_speed,
             moving_seconds, stopped_seconds, points_count, synced_at
           ) VALUES ($1,$2,$3,$4,NULL,NULL,0,0,0,0,0,0,LOCALTIMESTAMP(0))
           ON CONFLICT (imei, usage_date) DO UPDATE SET
             car_code = EXCLUDED.car_code,
             car_name = EXCLUDED.car_name,
             first_time = NULL, last_time = NULL,
             distance_km = 0, max_speed = 0, avg_speed = 0,
             moving_seconds = 0, stopped_seconds = 0, points_count = 0,
             synced_at = LOCALTIMESTAMP(0)`,
          [imei, car.code, car.name_1, usageDate]
        );
        skipped++;
        results.push({
          imei,
          car_code: car.code,
          car_name: car.name_1,
          points_count: 0,
          distance_km: 0,
        });
        continue;
      }

      const s = summarize(points);

      await pool.query(
        `INSERT INTO public.odg_tms_gps_daily (
           imei, car_code, car_name, usage_date,
           first_time, last_time,
           distance_km, max_speed, avg_speed,
           moving_seconds, stopped_seconds, points_count, synced_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,LOCALTIMESTAMP(0))
         ON CONFLICT (imei, usage_date) DO UPDATE SET
           car_code = EXCLUDED.car_code,
           car_name = EXCLUDED.car_name,
           first_time = EXCLUDED.first_time,
           last_time = EXCLUDED.last_time,
           distance_km = EXCLUDED.distance_km,
           max_speed = EXCLUDED.max_speed,
           avg_speed = EXCLUDED.avg_speed,
           moving_seconds = EXCLUDED.moving_seconds,
           stopped_seconds = EXCLUDED.stopped_seconds,
           points_count = EXCLUDED.points_count,
           synced_at = LOCALTIMESTAMP(0)`,
        [
          imei,
          car.code,
          car.name_1,
          usageDate,
          s.first_time,
          s.last_time,
          s.distance_km.toFixed(3),
          s.max_speed,
          s.avg_speed,
          s.moving_seconds,
          s.stopped_seconds,
          s.points_count,
        ]
      );

      // Replace points for this imei/date
      await pool.query(
        `DELETE FROM public.odg_tms_gps_points WHERE imei = $1 AND usage_date = $2`,
          [imei, usageDate]
        );

      // Downsample: keep every 5th point to reduce storage, plus first & last.
      // Also cap max stored points per day.
      const MAX_POINTS = 2000;
      const stride = Math.max(1, Math.ceil(points.length / MAX_POINTS));
      const keep = [];
      for (let i = 0; i < points.length; i++) {
        if (i === 0 || i === points.length - 1 || i % stride === 0) {
          keep.push(points[i]);
        }
      }

      // Bulk insert in batches
      const BATCH = 500;
      for (let i = 0; i < keep.length; i += BATCH) {
        const batch = keep.slice(i, i + BATCH);
        const values = [];
        const params = [];
        batch.forEach((p, idx) => {
          const base = idx * 7;
          values.push(
            `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`
          );
          params.push(
            imei,
            usageDate,
            p.recordedAt,
            p.lat,
            p.lng,
            p.speed,
            p.heading
          );
        });
        await pool.query(
          `INSERT INTO public.odg_tms_gps_points
             (imei, usage_date, recorded_at, lat, lng, speed, heading)
           VALUES ${values.join(",")}`,
          params
        );
      }

      synced++;
      results.push({
        imei,
        car_code: car.code,
        car_name: car.name_1,
        points_count: s.points_count,
        distance_km: Number(s.distance_km.toFixed(3)),
      });
    } catch (err) {
      errors++;
      console.error(`syncGpsDay imei=${car.imei}`, err);
      results.push({
        imei: car.imei,
        car_code: car.code,
        car_name: car.name_1,
        error: err?.message ?? "unknown error",
      });
    }
  }

  return { date: usageDate, synced, skipped, errors, cars: results };
}

// ==================== Live aggregation ====================

function bucketPointsByDay(points) {
  const map = new Map();
  for (const p of points) {
    const day = p.date || p.recordedAt.slice(0, 10);
    if (!map.has(day)) map.set(day, []);
    map.get(day).push(p);
  }
  return map;
}

function formatDdMmYyyy(ymd) {
  const [y, m, d] = ymd.split("-");
  return `${d}-${m}-${y}`;
}

function formatHhMm(timestamp) {
  if (!timestamp) return null;
  const m = String(timestamp).match(/(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

function buildDailyRow(car, day, summary) {
  return {
    usage_date: day,
    usage_date_display: formatDdMmYyyy(day),
    imei: car.imei,
    car_code: car.code,
    car_name: car.name_1,
    first_time: formatHhMm(summary.first_time),
    last_time: formatHhMm(summary.last_time),
    distance_km: Number(summary.distance_km.toFixed(3)),
    max_speed: Number(summary.max_speed.toFixed(1)),
    avg_speed: Number(summary.avg_speed.toFixed(1)),
    moving_seconds: summary.moving_seconds,
    stopped_seconds: summary.stopped_seconds,
    points_count: summary.points_count,
    synced_at: null,
  };
}

function enumerateDays(from, to) {
  const out = [];
  if (!YMD_RE.test(String(from ?? "")) || !YMD_RE.test(String(to ?? ""))) return out;
  // ບວກມື້ເປັນຂໍ້ຄວາມລ້ວນໆ — ບໍ່ຜ່ານ Date ຂອງເຄື່ອງ ຈຶ່ງບໍ່ມີວັນເລື່ອນຕາມ TZ
  for (let day = from; day <= to; day = addDays(day, 1)) out.push(day);
  return out;
}

// Compute daily breakdown live from provider for a single car
async function computeLiveBreakdown(car, fromDate, toDate) {
  const points = await fetchGpsHistoryRange(car.imei, fromDate, toDate);
  const buckets = bucketPointsByDay(points);
  const daily = [];
  for (const day of enumerateDays(fromDate, toDate)) {
    const dayPoints = buckets.get(day) ?? [];
    const summary = summarize(dayPoints);
    daily.push(buildDailyRow(car, day, summary));
  }

  // Totals across the range
  let distance_km = 0;
  let moving_seconds = 0;
  let stopped_seconds = 0;
  let max_speed = 0;
  let points_count = 0;
  let active_days = 0;
  let speedSumForAvg = 0;
  let speedCountForAvg = 0;
  for (const row of daily) {
    distance_km += row.distance_km;
    moving_seconds += row.moving_seconds;
    stopped_seconds += row.stopped_seconds;
    max_speed = Math.max(max_speed, row.max_speed);
    points_count += row.points_count;
    if (row.points_count > 0) {
      active_days += 1;
      if (row.avg_speed > 0) {
        speedSumForAvg += row.avg_speed;
        speedCountForAvg += 1;
      }
    }
  }
  return {
    daily,
    totals: {
      imei: car.imei,
      car_code: car.code,
      car_name: car.name_1,
      days_count: daily.length,
      active_days,
      distance_km: Number(distance_km.toFixed(3)),
      max_speed: Number(max_speed.toFixed(1)),
      avg_speed: Number(
        (speedCountForAvg > 0 ? speedSumForAvg / speedCountForAvg : 0).toFixed(1)
      ),
      moving_seconds,
      stopped_seconds,
      points_count,
      last_synced: "",
    },
  };
}

async function withConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        console.warn(`[gps-usage] worker failed at ${i}: ${err?.message ?? err}`);
        results[i] = null;
      }
    }
  }
  const runners = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(next());
  await Promise.all(runners);
  return results;
}

async function resolveTargetCars(carCode) {
  // ຕົວຕັ້ງ: app_car_vehicles ທີ່ມີ gps_imei — ເບິ່ງ FLEET_CARS_SQL.
  const params = [];
  let codeClause = "";
  const cleanCarCode = String(carCode ?? "").trim();
  if (cleanCarCode) {
    // ຮັບໄດ້ທັງ code ຂອງ TMS ແລະ ປ້າຍທະບຽນ ເພາະຄັນທີ່ TMS ບໍ່ມີໃຊ້ປ້າຍເປັນ code.
    params.push(cleanCarCode);
    codeClause = `WHERE code = $${params.length} OR ${plateKey("name_1")} = ${plateKey(`$${params.length}::text`)}`;
  }
  const rows = await query(
    `SELECT code, name_1, imei FROM (${FLEET_CARS_SQL}) f
     ${codeClause}
     ORDER BY name_1 ASC, code ASC`,
    params
  );
  return rows.map((r) => ({
    code: r.code,
    name_1: r.name_1,
    imei: String(r.imei).trim(),
  }));
}

// ==================== Range sync (persist to DB) ====================

async function upsertCarDay(car, usageDate, dayPoints) {
  const imei = car.imei;
  const summary = summarize(dayPoints);

  await pool.query(
    `INSERT INTO public.odg_tms_gps_daily (
       imei, car_code, car_name, usage_date,
       first_time, last_time,
       distance_km, max_speed, avg_speed,
       moving_seconds, stopped_seconds, points_count, synced_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,LOCALTIMESTAMP(0))
     ON CONFLICT (imei, usage_date) DO UPDATE SET
       car_code = EXCLUDED.car_code,
       car_name = EXCLUDED.car_name,
       first_time = EXCLUDED.first_time,
       last_time = EXCLUDED.last_time,
       distance_km = EXCLUDED.distance_km,
       max_speed = EXCLUDED.max_speed,
       avg_speed = EXCLUDED.avg_speed,
       moving_seconds = EXCLUDED.moving_seconds,
       stopped_seconds = EXCLUDED.stopped_seconds,
       points_count = EXCLUDED.points_count,
       synced_at = LOCALTIMESTAMP(0)`,
    [
      imei,
      car.code,
      car.name_1,
      usageDate,
      summary.first_time,
      summary.last_time,
      Number(summary.distance_km.toFixed(3)),
      summary.max_speed,
      summary.avg_speed,
      summary.moving_seconds,
      summary.stopped_seconds,
      summary.points_count,
    ]
  );

  // Replace points for that day
  await pool.query(
    `DELETE FROM public.odg_tms_gps_points WHERE imei = $1 AND usage_date = $2`,
    [imei, usageDate]
  );
  if (dayPoints.length === 0) return summary;

  // Downsample (cap ~2000 stored points / day)
  const MAX_POINTS = 2000;
  const stride = Math.max(1, Math.ceil(dayPoints.length / MAX_POINTS));
  const keep = [];
  for (let i = 0; i < dayPoints.length; i++) {
    if (i === 0 || i === dayPoints.length - 1 || i % stride === 0) {
      keep.push(dayPoints[i]);
    }
  }
  const BATCH = 500;
  for (let i = 0; i < keep.length; i += BATCH) {
    const batch = keep.slice(i, i + BATCH);
    const values = [];
    const params = [];
    batch.forEach((p, idx) => {
      const b = idx * 7;
      values.push(
        `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`
      );
      params.push(imei, usageDate, p.recordedAt, p.lat, p.lng, p.speed, p.heading);
    });
    await pool.query(
      `INSERT INTO public.odg_tms_gps_points
         (imei, usage_date, recorded_at, lat, lng, speed, heading)
       VALUES ${values.join(",")}`,
      params
    );
  }
  return summary;
}

async function deleteDayForImei(imei, day) {
  await pool.query(
    `DELETE FROM public.odg_tms_gps_daily
     WHERE imei = $1 AND usage_date = $2`,
    [imei, day]
  );
  await pool.query(
    `DELETE FROM public.odg_tms_gps_points
     WHERE imei = $1 AND usage_date = $2`,
    [imei, day]
  );
}

async function getSyncedDaysForImei(imei, fromDate, toDate) {
  const rows = await query(
    `SELECT to_char(usage_date, 'YYYY-MM-DD') AS d
     FROM public.odg_tms_gps_daily
     WHERE imei = $1 AND usage_date BETWEEN $2 AND $3`,
    [imei, fromDate, toDate]
  );
  return new Set(rows.map((r) => r.d));
}

// ວັນທີລາວ — ບໍ່ເອົາເວລາເຄື່ອງ ເພາະ server ອາດຕັ້ງເປັນ UTC ແລ້ວ sync GPS
// ຂອງມື້ນີ້ຈະໄປດຶງຂອງມື້ວານ ຕະຫຼອດ 00:00–07:00
function todayYmd() {
  return getLaoToday();
}

async function syncGpsRange(fromDate, toDate, carCode) {
  await ensureSchema();
  const range = validateDateRange(fromDate, toDate);
  const cars = await resolveTargetCars(carCode);
  if (cars.length === 0) {
    return {
      fromDate: range.fromDate,
      toDate: range.toDate,
      total_cars: 0,
      synced_cars: 0,
      total_days: 0,
      total_points: 0,
      fetched_days: 0,
      skipped_days: 0,
      errors: 0,
      cars: [],
    };
  }

  const allDays = enumerateDays(range.fromDate, range.toDate);
  const today = todayYmd();
  const results = [];
  let syncedCars = 0;
  let totalDays = 0;
  let totalPoints = 0;
  let fetchedDays = 0;
  let skippedDays = 0;
  let errors = 0;

  console.log(
    `[gps-usage] syncGpsRange start ${range.fromDate}..${range.toDate} cars=${cars.length} (incremental mode: skip already-inserted days; always refresh today=${today})`
  );

  await withConcurrency(cars, RANGE_SYNC_CONCURRENCY, async (car) => {
    try {
      const already = await getSyncedDaysForImei(
        car.imei,
        range.fromDate,
        range.toDate
      );
      // Days to fetch: missing days + today (today always refreshed to pick up new data)
      const daysToFetch = allDays.filter(
        (d) => !already.has(d) || d === today
      );
      const carSkipped = allDays.length - daysToFetch.length;

      let carPoints = 0;
      let activeDays = 0;

      for (const day of daysToFetch) {
        // If today is being refreshed, wipe prior row first so points replace cleanly.
        if (day === today && already.has(day)) {
          await deleteDayForImei(car.imei, day);
        }
        const { points } = await fetchGpsHistoryOneDay(car.imei, day);
        await upsertCarDay(car, day, points);
        if (points.length > 0) activeDays += 1;
        carPoints += points.length;
      }

      fetchedDays += daysToFetch.length;
      skippedDays += carSkipped;
      syncedCars += 1;
      totalDays += activeDays;
      totalPoints += carPoints;
      console.log(
        `[gps-usage] car imei=${car.imei} code=${car.code} fetched=${daysToFetch.length} skipped=${carSkipped} active=${activeDays} points=${carPoints}`
      );
      results.push({
        imei: car.imei,
        car_code: car.code,
        car_name: car.name_1,
        fetched_days: daysToFetch.length,
        skipped_days: carSkipped,
        active_days: activeDays,
        points_count: carPoints,
      });
    } catch (err) {
      errors += 1;
      console.error(`[gps-usage] syncGpsRange imei=${car.imei}`, err);
      results.push({
        imei: car.imei,
        car_code: car.code,
        car_name: car.name_1,
        error: err?.message ?? "unknown error",
      });
    }
  });

  return {
    fromDate: range.fromDate,
    toDate: range.toDate,
    total_cars: cars.length,
    synced_cars: syncedCars,
    total_days: totalDays,
    total_points: totalPoints,
    fetched_days: fetchedDays,
    skipped_days: skippedDays,
    errors,
    cars: results,
  };
}

// ==================== Query (live fetch from provider) ====================

function fmtTimeHHmm(recordedAt) {
  if (!recordedAt) return null;
  const m = String(recordedAt).match(/(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

function fmtDateDdMmYyyy(ymd) {
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// Per-(car, day) stats straight from odg_tms_gps_realtime_log. Mirrors
// summarize()'s logic: 15-min gap cap, midSpeed > 3 threshold, haversine.
//
// Exported as a string because gps-daily-rollup.js writes the very same
// aggregation into odg_tms_gps_daily. Two copies of this SQL would drift, and
// a rollup that disagrees with the live path is worse than no rollup.
// Params: $1 imei[], $2 fromDate, $3 toDate.
const DAILY_AGG_SQL = `
    WITH segs AS (
      SELECT
        imei,
        DATE(recorded_at) AS usage_date,
        recorded_at,
        lat::float  AS lat,
        lng::float  AS lng,
        COALESCE(speed, 0)::float AS speed,
        LAG(lat::float)  OVER w AS prev_lat,
        LAG(lng::float)  OVER w AS prev_lng,
        LAG(COALESCE(speed, 0)::float) OVER w AS prev_speed,
        LAG(recorded_at) OVER w AS prev_ts
      FROM public.odg_tms_gps_realtime_log
      WHERE imei = ANY($1)
        AND recorded_at >= $2::date
        AND recorded_at <  ($3::date + INTERVAL '1 day')
        AND lat IS NOT NULL AND lng IS NOT NULL
      WINDOW w AS (PARTITION BY imei, DATE(recorded_at) ORDER BY recorded_at)
    )
    SELECT
      imei,
      to_char(usage_date, 'YYYY-MM-DD') AS usage_date,
      COUNT(*)::int AS points_count,
      to_char(MIN(recorded_at), 'HH24:MI:SS') AS first_time,
      to_char(MAX(recorded_at), 'HH24:MI:SS') AS last_time,
      COALESCE(MAX(speed), 0)::float AS max_speed,
      COALESCE(AVG(speed), 0)::float AS avg_speed,
      COALESCE(SUM(CASE
        WHEN prev_lat IS NULL OR prev_lng IS NULL THEN 0
        ELSE 2 * 6371 * asin(LEAST(1, sqrt(
          power(sin(radians((lat - prev_lat) / 2)), 2) +
          cos(radians(prev_lat)) * cos(radians(lat)) *
          power(sin(radians((lng - prev_lng) / 2)), 2)
        )))
      END), 0)::float AS distance_km,
      COALESCE(SUM(CASE
        WHEN prev_ts IS NULL THEN 0
        WHEN EXTRACT(EPOCH FROM (recorded_at - prev_ts)) > 900 THEN 0
        WHEN (speed + COALESCE(prev_speed, 0)) / 2 > 3
          THEN EXTRACT(EPOCH FROM (recorded_at - prev_ts))
        ELSE 0
      END), 0)::int AS moving_seconds,
      COALESCE(SUM(CASE
        WHEN prev_ts IS NULL THEN 0
        WHEN EXTRACT(EPOCH FROM (recorded_at - prev_ts)) > 900 THEN 0
        WHEN (speed + COALESCE(prev_speed, 0)) / 2 <= 3
          THEN EXTRACT(EPOCH FROM (recorded_at - prev_ts))
        ELSE 0
      END), 0)::int AS stopped_seconds
    FROM segs
    GROUP BY imei, usage_date
    ORDER BY imei ASC, usage_date ASC`;

async function aggregateDailyFromLogs(imeis, fromDate, toDate) {
  if (!Array.isArray(imeis) || imeis.length === 0) return [];
  return query(DAILY_AGG_SQL, [imeis, fromDate, toDate]);
}

/**
 * ຄືກັນກັບ aggregateDailyFromLogs ແຕ່ອ່ານຈາກ odg_tms_gps_daily ທີ່ຄິດໄວ້ແລ້ວ.
 *
 * ການສະແກນຈຸດດິບ 1 ເດືອນ ໃຊ້ 5.6 ວິນາທີ ທຸກຄັ້ງທີ່ເປີດໜ້າ (ວັດ 2026-08-12)
 * ທັງທີ່ຄຳຕອບບໍ່ປ່ຽນ. ຄືນຮູບແບບແຖວດຽວກັນ ຈຶ່ງສະຫຼັບແທນກັນໄດ້.
 * first_time/last_time ບໍ່ໄດ້ເກັບໃນ rollup — ໜ້າສະຫຼຸບບໍ່ໄດ້ໃຊ້.
 */
async function aggregateDailyFromRollup(imeis, fromDate, toDate) {
  if (!Array.isArray(imeis) || imeis.length === 0) return [];
  return query(
    `SELECT
       imei,
       to_char(usage_date, 'YYYY-MM-DD') AS usage_date,
       COALESCE(points_count, 0)::int      AS points_count,
       NULL::text                          AS first_time,
       NULL::text                          AS last_time,
       COALESCE(max_speed, 0)::float       AS max_speed,
       COALESCE(avg_speed, 0)::float       AS avg_speed,
       COALESCE(distance_km, 0)::float     AS distance_km,
       COALESCE(moving_seconds, 0)::int    AS moving_seconds,
       COALESCE(stopped_seconds, 0)::int   AS stopped_seconds
     FROM public.odg_tms_gps_daily
     WHERE imei = ANY($1)
       AND usage_date >= $2::date
       AND usage_date <= $3::date
     ORDER BY imei ASC, usage_date ASC`,
    [imeis, fromDate, toDate]
  );
}

function daysFromRange(fromDate, toDate) {
  return enumerateDays(fromDate, toDate);
}

function buildDailyFromAggRow(car, day, aggRow) {
  const points = Number(aggRow?.points_count) || 0;
  const distanceKm = Number(aggRow?.distance_km) || 0;
  const movingSec = Number(aggRow?.moving_seconds) || 0;
  const stoppedSec = Number(aggRow?.stopped_seconds) || 0;
  const maxSpeed = Number(aggRow?.max_speed) || 0;
  const avgSpeed = Number(aggRow?.avg_speed) || 0;
  return {
    imei: car.imei,
    car_code: car.code,
    car_name: car.name_1,
    usage_date: day,
    usage_date_display: fmtDateDdMmYyyy(day),
    first_time: aggRow?.first_time ?? null,
    last_time: aggRow?.last_time ?? null,
    distance_km: Number(distanceKm.toFixed(3)),
    max_speed: Number(maxSpeed.toFixed(1)),
    avg_speed: Number(avgSpeed.toFixed(1)),
    moving_seconds: movingSec,
    stopped_seconds: stoppedSec,
    points_count: points,
    synced_at: null,
  };
}

// Hybrid aggregator: past days come from the realtime_log DB cache (fast SQL),
// today's row is fetched live from the provider (always fresh). Optionally,
// for past days missing from the DB cache, falls back to live provider fetch
// (capped to LIVE_FALLBACK_MAX_FETCHES) — opt in via opts.fillMissing.
// Returns a Map keyed by `${imei}|${YYYY-MM-DD}`.
async function buildHybridDailyAgg(cars, fromDate, toDate, opts = {}) {
  const fillMissing = Boolean(opts.fillMissing);
  const days = daysFromRange(fromDate, toDate);
  const today = todayYmd();
  const pastDays = days.filter((d) => d < today);
  const includeToday = days.includes(today);

  const byImeiDate = new Map();

  const liveFetchOne = async (car, day) => {
    const { points } = await fetchGpsHistoryOneDay(car.imei, day);
    const s = summarize(points);
    const firstHms = s.first_time
      ? String(s.first_time).match(/\d{2}:\d{2}:\d{2}/)?.[0] ?? null
      : null;
    const lastHms = s.last_time
      ? String(s.last_time).match(/\d{2}:\d{2}:\d{2}/)?.[0] ?? null
      : null;
    return {
      row: {
        imei: car.imei,
        usage_date: day,
        points_count: s.points_count,
        first_time: firstHms,
        last_time: lastHms,
        distance_km: s.distance_km,
        max_speed: s.max_speed,
        avg_speed: s.avg_speed,
        moving_seconds: s.moving_seconds,
        stopped_seconds: s.stopped_seconds,
      },
      points,
    };
  };

  if (pastDays.length > 0) {
    const dbAgg = await aggregateDailyFromLogs(
      cars.map((c) => c.imei),
      pastDays[0],
      pastDays[pastDays.length - 1]
    );
    for (const a of dbAgg) {
      byImeiDate.set(`${a.imei}|${a.usage_date}`, a);
    }
  }

  // Auto-fallback (opt-in via fillMissing): any (car, past_day) without a DB
  // row → fetch live + persist. Prioritize most recent days when capped.
  const missingPairs = [];
  if (fillMissing) {
    // ⚠️ ນັບແຕ່ຕົວຕັ້ງເປັນ app_car_vehicles ລາຍຊື່ລວມລົດທີ່ລົງທະບຽນ IMEI ໄວ້ແຕ່
    // ເຄື່ອງຍັງບໍ່ເຄີຍສົ່ງເຂົ້າມາຈັກຄັ້ງ (ວັດ 2026-08-13: 6 ຄັນ). ຖ້າບໍ່ກັນໄວ້
    // ມັນຈະກິນໂຄຕາ LIVE_FALLBACK_MAX_FETCHES ໝົດ (6 ຄັນ × 31 ວັນ = 186 ຄູ່)
    // ແລ້ວຄັນທີ່ມີຂໍ້ມູນຈິງບໍ່ໄດ້ຖືກຕື່ມ. odg_tms_gps_current ມີທຸກເຄື່ອງທີ່
    // provider ping ມາ ຈຶ່ງໃຊ້ເປັນຕົວກັ່ນຕອງ — ພໍເຄື່ອງໃໝ່ເລີ່ມສົ່ງ ແຖວກໍ່ເກີດ
    // ເອງພາຍໃນ tick ດຽວ ແລ້ວການຕື່ມຍ້ອນຫຼັງກໍ່ກັບມາເຮັດວຽກເອງ.
    const reporting = new Set(
      (
        await query(`SELECT imei FROM public.odg_tms_gps_current WHERE COALESCE(btrim(imei), '') <> ''`)
      ).map((r) => String(r.imei).trim())
    );
    for (const car of cars) {
      if (reporting.size > 0 && !reporting.has(car.imei)) continue;
      for (const day of pastDays) {
        if (!byImeiDate.has(`${car.imei}|${day}`)) {
          missingPairs.push({ car, day });
        }
      }
    }
    missingPairs.sort((a, b) => b.day.localeCompare(a.day));
  }
  const fallbackPairs = missingPairs.slice(0, LIVE_FALLBACK_MAX_FETCHES);
  const droppedFallback = missingPairs.length - fallbackPairs.length;

  if (fallbackPairs.length > 0) {
    const results = await withConcurrency(fallbackPairs, 4, async ({ car, day }) => {
      try {
        const { row, points } = await liveFetchOne(car, day);
        if (points.length > 0) {
          try {
            await insertRealtimeLogRowsFromUsage(
              points.map((p) => ({
                imei: car.imei,
                car_code: car.code,
                car_name: car.name_1,
                lat: p.lat,
                lng: p.lng,
                speed: p.speed,
                heading: p.heading,
                recorded_at: p.recordedAt,
                address: "",
              }))
            );
          } catch (err) {
            console.warn(
              `[gps-usage] fallback persist failed imei=${car.imei} day=${day}: ${err?.message ?? err}`
            );
          }
        }
        return row;
      } catch (err) {
        console.warn(
          `[gps-usage] fallback fetch failed imei=${car.imei} day=${day}: ${err?.message ?? err}`
        );
        return null;
      }
    });
    for (const r of results) {
      if (r) byImeiDate.set(`${r.imei}|${r.usage_date}`, r);
    }
  }

  if (includeToday) {
    const liveResults = await withConcurrency(cars, 4, async (car) => {
      try {
        const { row } = await liveFetchOne(car, today);
        return row;
      } catch (err) {
        console.warn(
          `[gps-usage] live today fetch failed imei=${car.imei}: ${err?.message ?? err}`
        );
        return null;
      }
    });
    for (const r of liveResults) {
      if (r) byImeiDate.set(`${r.imei}|${r.usage_date}`, r);
    }
  }

  return {
    byImeiDate,
    days,
    pastDaysCount: pastDays.length,
    liveDay: includeToday ? today : null,
    fallbackFetched: fallbackPairs.length,
    fallbackDropped: droppedFallback,
  };
}

async function getGpsUsageSummary(fromDate, toDate, carCode, opts = {}) {
  const range = validateDateRange(fromDate, toDate);
  const cars = await resolveTargetCars(carCode);
  if (cars.length === 0) return [];

  const started = Date.now();
  const {
    byImeiDate,
    days,
    pastDaysCount,
    liveDay,
    fallbackFetched,
    fallbackDropped,
  } = await buildHybridDailyAgg(cars, range.fromDate, range.toDate, opts);

  // Days with distance below this threshold are GPS jitter / parked, not real
  // movement. We exclude them from "active days" and from min/max/avg.
  const MOVEMENT_THRESHOLD_KM = 5;

  const totals = cars.map((car) => {
    let distance_km = 0;
    let moving_seconds = 0;
    let stopped_seconds = 0;
    let max_speed = 0;
    let points_count = 0;
    let active_days = 0;
    let active_distance_km = 0;
    let avgSum = 0;
    let avgDays = 0;
    let max_daily_km = 0;
    let min_daily_km = null;
    let max_daily_km_date = null;
    let min_daily_km_date = null;
    for (const day of days) {
      const a = byImeiDate.get(`${car.imei}|${day}`);
      if (!a) continue;
      const dkm = Number(a.distance_km) || 0;
      distance_km += dkm;
      moving_seconds += Number(a.moving_seconds) || 0;
      stopped_seconds += Number(a.stopped_seconds) || 0;
      max_speed = Math.max(max_speed, Number(a.max_speed) || 0);
      points_count += Number(a.points_count) || 0;

      if (dkm > MOVEMENT_THRESHOLD_KM) {
        active_days += 1;
        active_distance_km += dkm;
        if ((Number(a.avg_speed) || 0) > 0) {
          avgSum += Number(a.avg_speed);
          avgDays += 1;
        }
        if (dkm > max_daily_km) {
          max_daily_km = dkm;
          max_daily_km_date = day;
        }
        if (min_daily_km === null || dkm < min_daily_km) {
          min_daily_km = dkm;
          min_daily_km_date = day;
        }
      }
    }
    return {
      imei: car.imei,
      car_code: car.code,
      car_name: car.name_1,
      days_count: days.length,
      active_days,
      distance_km: Number(distance_km.toFixed(3)),
      max_speed: Number(max_speed.toFixed(1)),
      avg_speed: Number((avgDays > 0 ? avgSum / avgDays : 0).toFixed(1)),
      moving_seconds,
      stopped_seconds,
      points_count,
      max_daily_km: Number(max_daily_km.toFixed(3)),
      min_daily_km:
        min_daily_km === null ? 0 : Number(min_daily_km.toFixed(3)),
      max_daily_km_date: max_daily_km_date ?? "",
      min_daily_km_date: min_daily_km_date ?? "",
      avg_daily_km:
        active_days > 0
          ? Number((active_distance_km / active_days).toFixed(3))
          : 0,
      movement_threshold_km: MOVEMENT_THRESHOLD_KM,
      last_synced: "",
    };
  });

  const elapsed = Date.now() - started;
  console.log(
    `[gps-usage] summary cars=${cars.length} days=${days.length} past=${pastDaysCount} live=${liveDay ?? "-"} fallback=${fallbackFetched}/${fallbackFetched + fallbackDropped} elapsed=${elapsed}ms (hybrid)`
  );

  return totals.sort((a, b) =>
    (a.car_name ?? "").localeCompare(b.car_name ?? "")
  );
}

async function getGpsUsageDaily(fromDate, toDate, imei, opts = {}) {
  const range = validateDateRange(fromDate, toDate);
  const cleanImei = String(imei ?? "").trim();
  if (!cleanImei) throw new Error("Missing imei");

  const car = await queryOne(
    `SELECT code, name_1, imei FROM (${FLEET_CARS_SQL}) f WHERE imei = $1 LIMIT 1`,
    [cleanImei]
  );
  const target = {
    imei: cleanImei,
    code: car?.code ?? "",
    name_1: car?.name_1 ?? "",
  };

  const { byImeiDate, days } = await buildHybridDailyAgg(
    [target],
    range.fromDate,
    range.toDate,
    opts
  );

  return days.map((day) =>
    buildDailyFromAggRow(target, day, byImeiDate.get(`${cleanImei}|${day}`))
  );
}

// Fast path used for initial page render: reads aggregated stats entirely from
// the realtime_log DB cache (no provider calls). Background workers keep the
// cache fresh; the page can fire getGpsUsageSummary in the background to refresh
// today and fill in missing past days.
async function getGpsUsageSummaryCached(fromDate, toDate, carCode) {
  const range = validateDateRange(fromDate, toDate);
  const cars = await resolveTargetCars(carCode);
  if (cars.length === 0) return [];

  const started = Date.now();
  const days = daysFromRange(range.fromDate, range.toDate);
  const imeis = cars.map((c) => c.imei);
  // ອ່ານຈາກ rollup ກ່ອນ. ຖ້າຊ່ວງນັ້ນຍັງບໍ່ໄດ້ສະຫຼຸບ (ເຊັ່ນ ເດືອນເກົ່າກ່ອນ
  // backfill) ຈຶ່ງຕົກລົງໄປສະແກນຈຸດດິບແບບເດີມ — ຊ້າແຕ່ບໍ່ໃຫ້ໜ້າວ່າງ.
  let agg = await aggregateDailyFromRollup(imeis, range.fromDate, range.toDate);
  let source = "rollup";
  if (agg.length === 0) {
    agg = await aggregateDailyFromLogs(imeis, range.fromDate, range.toDate);
    source = "raw";
  }
  const byImeiDate = new Map();
  for (const a of agg) byImeiDate.set(`${a.imei}|${a.usage_date}`, a);

  const MOVEMENT_THRESHOLD_KM = 5;
  const totals = cars.map((car) => {
    let distance_km = 0;
    let moving_seconds = 0;
    let stopped_seconds = 0;
    let max_speed = 0;
    let points_count = 0;
    let active_days = 0;
    let active_distance_km = 0;
    let avgSum = 0;
    let avgDays = 0;
    let max_daily_km = 0;
    let min_daily_km = null;
    let max_daily_km_date = null;
    let min_daily_km_date = null;
    for (const day of days) {
      const a = byImeiDate.get(`${car.imei}|${day}`);
      if (!a) continue;
      const dkm = Number(a.distance_km) || 0;
      distance_km += dkm;
      moving_seconds += Number(a.moving_seconds) || 0;
      stopped_seconds += Number(a.stopped_seconds) || 0;
      max_speed = Math.max(max_speed, Number(a.max_speed) || 0);
      points_count += Number(a.points_count) || 0;
      if (dkm > MOVEMENT_THRESHOLD_KM) {
        active_days += 1;
        active_distance_km += dkm;
        if ((Number(a.avg_speed) || 0) > 0) {
          avgSum += Number(a.avg_speed);
          avgDays += 1;
        }
        if (dkm > max_daily_km) {
          max_daily_km = dkm;
          max_daily_km_date = day;
        }
        if (min_daily_km === null || dkm < min_daily_km) {
          min_daily_km = dkm;
          min_daily_km_date = day;
        }
      }
    }
    return {
      imei: car.imei,
      car_code: car.code,
      car_name: car.name_1,
      days_count: days.length,
      active_days,
      distance_km: Number(distance_km.toFixed(3)),
      max_speed: Number(max_speed.toFixed(1)),
      avg_speed: Number((avgDays > 0 ? avgSum / avgDays : 0).toFixed(1)),
      moving_seconds,
      stopped_seconds,
      points_count,
      max_daily_km: Number(max_daily_km.toFixed(3)),
      min_daily_km:
        min_daily_km === null ? 0 : Number(min_daily_km.toFixed(3)),
      max_daily_km_date: max_daily_km_date ?? "",
      min_daily_km_date: min_daily_km_date ?? "",
      avg_daily_km:
        active_days > 0
          ? Number((active_distance_km / active_days).toFixed(3))
          : 0,
      movement_threshold_km: MOVEMENT_THRESHOLD_KM,
      last_synced: "",
    };
  });

  const elapsed = Date.now() - started;
  console.log(
    `[gps-usage] summary-cached cars=${cars.length} days=${days.length} src=${source} elapsed=${elapsed}ms (DB only)`
  );
  return totals.sort((a, b) =>
    (a.car_name ?? "").localeCompare(b.car_name ?? "")
  );
}

async function getGpsUsageDailyCached(fromDate, toDate, imei) {
  const range = validateDateRange(fromDate, toDate);
  const cleanImei = String(imei ?? "").trim();
  if (!cleanImei) throw new Error("Missing imei");

  const car = await queryOne(
    `SELECT code, name_1, imei FROM (${FLEET_CARS_SQL}) f WHERE imei = $1 LIMIT 1`,
    [cleanImei]
  );
  const target = {
    imei: cleanImei,
    code: car?.code ?? "",
    name_1: car?.name_1 ?? "",
  };
  const agg = await aggregateDailyFromLogs(
    [cleanImei],
    range.fromDate,
    range.toDate
  );
  const byDate = new Map();
  for (const a of agg) byDate.set(a.usage_date, a);
  return daysFromRange(range.fromDate, range.toDate).map((day) =>
    buildDailyFromAggRow(target, day, byDate.get(day))
  );
}

async function getGpsUsageTrack(imei, dateStr) {
  const cleanImei = String(imei ?? "").trim();
  if (!cleanImei) throw new Error("Missing imei");
  const usageDate = validateYmd(dateStr, "date");

  const started = Date.now();
  const car = await queryOne(
    `SELECT code, name_1, imei FROM (${FLEET_CARS_SQL}) f WHERE imei = $1 LIMIT 1`,
    [cleanImei]
  );

  // Read points directly from the logged history (populated by realtime worker).
  const logRows = await query(
    `SELECT
       to_char(recorded_at, 'YYYY-MM-DD HH24:MI:SS') AS "recordedAt",
       lat::float  AS lat,
       lng::float  AS lng,
       COALESCE(speed, 0)::float   AS speed,
       COALESCE(heading, 0)::float AS heading
     FROM public.odg_tms_gps_realtime_log
     WHERE imei = $1
       AND recorded_at >= $2::date
       AND recorded_at <  ($2::date + INTERVAL '1 day')
       AND lat IS NOT NULL AND lng IS NOT NULL
     ORDER BY recorded_at ASC`,
    [cleanImei, usageDate]
  );
  let points = logRows;
  let source = "logs";

  if (points.length === 0) {
    try {
      const fetched = await fetchGpsHistoryOneDay(cleanImei, usageDate);
      points = fetched.points;
      source = "provider";

      if (points.length > 0) {
        try {
          await insertRealtimeLogRowsFromUsage(
            points.map((p) => ({
              imei: cleanImei,
              car_code: car?.code ?? "",
              car_name: car?.name_1 ?? "",
              lat: p.lat,
              lng: p.lng,
              speed: p.speed,
              heading: p.heading,
              recorded_at: p.recordedAt,
              address: "",
            }))
          );
        } catch (err) {
          console.warn(
            `[gps-usage] track cache persist failed imei=${cleanImei} date=${usageDate}: ${err?.message ?? err}`
          );
        }
      }
    } catch (err) {
      console.warn(
        `[gps-usage] track provider fallback failed imei=${cleanImei} date=${usageDate}: ${err?.message ?? err}`
      );
    }
  }
  const summary = summarize(points);

  const header = {
    imei: cleanImei,
    car_code: car?.code ?? "",
    car_name: car?.name_1 ?? "",
    usage_date: fmtDateDdMmYyyy(usageDate),
    first_time: fmtTimeHHmm(summary.first_time),
    last_time: fmtTimeHHmm(summary.last_time),
    distance_km: Number(summary.distance_km.toFixed(3)),
    max_speed: Number(summary.max_speed.toFixed(1)),
    avg_speed: Number(summary.avg_speed.toFixed(1)),
    moving_seconds: summary.moving_seconds,
    stopped_seconds: summary.stopped_seconds,
    points_count: summary.points_count,
    synced_at: null,
  };

  // Downsample for map rendering (cap ~2000 points)
  const MAX_POINTS = 2000;
  const stride = Math.max(1, Math.ceil(points.length / MAX_POINTS));
  const out = [];
  for (let i = 0; i < points.length; i++) {
    if (i === 0 || i === points.length - 1 || i % stride === 0) {
      const p = points[i];
      const tm = String(p.recordedAt).match(/\d{2}:\d{2}:\d{2}/);
      out.push({
        t: tm ? tm[0] : "",
        lat: p.lat,
        lng: p.lng,
        speed: p.speed,
        heading: p.heading,
      });
    }
  }

  const elapsed = Date.now() - started;
  console.log(
    `[gps-usage] track imei=${cleanImei} date=${usageDate} raw=${points.length} out=${out.length} elapsed=${elapsed}ms (from ${source})`
  );

  return { header, points: out };
}

// ==================== Backfill: provider history → realtime_log ====================
// Fills public.odg_tms_gps_realtime_log from the provider's /getHistory endpoint
// day-by-day. Skips duplicates via the (imei, recorded_at) unique index.
// Serial by day × car to respect provider rate limit.
async function backfillGpsLog(fromDate, toDate, carCode, opts = {}) {
  const {
    ensureSchema: ensureLogSchema,
    insertLogRowsBatch,
  } = require("./gps-realtime-log");
  const range = validateDateRange(fromDate, toDate);
  const cars = await resolveTargetCars(carCode);
  if (cars.length === 0) {
    return {
      fromDate: range.fromDate,
      toDate: range.toDate,
      total_cars: 0,
      total_days: 0,
      fetched_days: 0,
      inserted_points: 0,
      skipped_days: 0,
      errors: 0,
      cars: [],
    };
  }
  await ensureLogSchema();

  const allDays = enumerateDays(range.fromDate, range.toDate);
  const results = [];
  let totalInserted = 0;
  let fetchedDays = 0;
  let skippedDays = 0;
  let errors = 0;
  const concurrency = Math.max(1, Number(opts.concurrency) || RANGE_SYNC_CONCURRENCY);
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;

  console.log(
    `[gps-backfill] start ${range.fromDate}..${range.toDate} cars=${cars.length} days=${allDays.length} concurrency=${concurrency}`
  );

  await withConcurrency(cars, concurrency, async (car) => {
    let carInserted = 0;
    let carFetched = 0;
    let carSkipped = 0;
    let carErrors = 0;
    for (const day of allDays) {
      try {
        // Skip if this day already has points for this imei
        const existing = await queryOne(
          `SELECT 1 AS ok FROM public.odg_tms_gps_realtime_log
           WHERE imei = $1
             AND recorded_at >= $2::date
             AND recorded_at <  ($2::date + INTERVAL '1 day')
           LIMIT 1`,
          [car.imei, day]
        );
        if (existing) {
          carSkipped++;
          skippedDays++;
          continue;
        }
        const { points } = await fetchGpsHistoryOneDay(car.imei, day);
        carFetched++;
        fetchedDays++;
        if (points.length === 0) continue;
        const rows = points.map((p) => ({
          imei: car.imei,
          car_code: car.code,
          car_name: car.name_1,
          lat: p.lat,
          lng: p.lng,
          speed: p.speed,
          heading: p.heading,
          recorded_at: p.recordedAt,
          address: "",
          oil: p.oil,
        }));
        const ins = await insertLogRowsBatch(rows);
        carInserted += ins;
        totalInserted += ins;
        if (onProgress) onProgress({ car, day, inserted: ins, totalInserted });
      } catch (err) {
        carErrors++;
        errors++;
        console.error(
          `[gps-backfill] car=${car.code} day=${day} failed:`,
          err?.message ?? err
        );
      }
    }
    console.log(
      `[gps-backfill] car=${car.code} imei=${car.imei} fetched=${carFetched} skipped=${carSkipped} inserted=${carInserted} errors=${carErrors}`
    );
    results.push({
      imei: car.imei,
      car_code: car.code,
      car_name: car.name_1,
      fetched_days: carFetched,
      skipped_days: carSkipped,
      inserted_points: carInserted,
      errors: carErrors,
    });
  });

  console.log(
    `[gps-backfill] done total_inserted=${totalInserted} fetched_days=${fetchedDays} skipped_days=${skippedDays} errors=${errors}`
  );
  return {
    fromDate: range.fromDate,
    toDate: range.toDate,
    total_cars: cars.length,
    total_days: allDays.length,
    fetched_days: fetchedDays,
    skipped_days: skippedDays,
    inserted_points: totalInserted,
    errors,
    cars: results,
  };
}

async function getCarsWithGps() {
  return query(
    `SELECT code, name_1, imei FROM (${FLEET_CARS_SQL}) f
     ORDER BY name_1 ASC, code ASC`
  );
}

// ==================== Debug probe ====================
// Calls the provider history endpoint directly and returns the raw response
// so we can inspect what the API actually sends back.
async function probeGpsHistory(imei, dateStr) {
  const config = getGpsTrackerConfig();
  const cleanImei = String(imei ?? "").trim();
  const date = validateYmd(dateStr, "date");
  if (!cleanImei) throw new Error("Missing imei");
  const url = `${config.baseUrl}/exporter/log/getHistory/${encodeURIComponent(cleanImei)}/${toYmd(date)}`;
  let status = 0;
  let statusText = "";
  let bodyText = "";
  let json = null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${config.auth}` },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    status = res.status;
    statusText = res.statusText;
    bodyText = await res.text();
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = null;
    }
  } catch (err) {
    return {
      url,
      imei: cleanImei,
      date,
      status,
      statusText,
      error: err?.message ?? String(err),
    };
  }

  const rawRows = json != null ? extractHistoryRows(json) : [];
  const sample = rawRows.slice(0, 2);
  const mapped = rawRows.map(mapHistoryRow).filter(Boolean).slice(0, 3);

  return {
    url,
    imei: cleanImei,
    date,
    status,
    statusText,
    envUser: process.env.GPS_TRACKER_USER ? "set" : "missing",
    envPass: process.env.GPS_TRACKER_PASS ? "set" : "missing",
    baseUrl: config.baseUrl,
    bodyLength: bodyText.length,
    bodyPreview: bodyText.slice(0, 500),
    jsonTopKeys: json && typeof json === "object" ? Object.keys(json) : null,
    rawRowCount: rawRows.length,
    rawSample: sample,
    mappedSample: mapped,
  };
}

module.exports = {
  fetchGpsObjectList,
  fetchGpsHistoryOneDay,
  syncGpsDay,
  syncGpsRange,
  getGpsUsageSummary,
  getGpsUsageSummaryCached,
  getGpsUsageDaily,
  getGpsUsageDailyCached,
  getGpsUsageTrack,
  backfillGpsLog,
  getCarsWithGps,
  probeGpsHistory,
  DAILY_AGG_SQL,
  FLEET_CARS_SQL,
  ensureSchema,
};
