const { pool, query, queryOne } = require("../lib/db");

const routeCache = globalThis;
const DELIVERY_ROUTE_SCHEMA_VERSION = "v3_job_route";

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

async function ensureDeliveryRouteSchemaInternal(db) {
  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_delivery_route (
      code character varying PRIMARY KEY,
      name character varying NOT NULL,
      origin character varying,
      origin_lat numeric,
      origin_lng numeric,
      destination character varying,
      destination_lat numeric,
      destination_lng numeric,
      waypoints jsonb DEFAULT '[]'::jsonb,
      distance_km numeric,
      sort_order int DEFAULT 0,
      active boolean DEFAULT true,
      created_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0),
      updated_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_delivery_route
    ADD COLUMN IF NOT EXISTS origin_lat numeric
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_delivery_route
    ADD COLUMN IF NOT EXISTS origin_lng numeric
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_delivery_route
    ADD COLUMN IF NOT EXISTS destination_lat numeric
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_delivery_route
    ADD COLUMN IF NOT EXISTS destination_lng numeric
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_delivery_route
    ADD COLUMN IF NOT EXISTS waypoints jsonb DEFAULT '[]'::jsonb
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms
    ADD COLUMN IF NOT EXISTS delivery_route_code character varying
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_delivery_route_code
    ON public.odg_tms (delivery_route_code)
  `);
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeWaypoints(value) {
  const source = Array.isArray(value) ? value : [];
  return source
    .map((item) => {
      if (item && typeof item === "object") {
        return {
          name: String(item.name ?? "").trim(),
          lat: nullableNumber(item.lat),
          lng: nullableNumber(item.lng),
        };
      }
      return {
        name: String(item ?? "").trim(),
        lat: null,
        lng: null,
      };
    })
    .filter((item) => item.name || item.lat !== null || item.lng !== null);
}

async function ensureDeliveryRouteSchema() {
  const readyKey = `__tmsDeliveryRouteSchemaReady_${DELIVERY_ROUTE_SCHEMA_VERSION}`;
  const promiseKey = `__tmsDeliveryRouteSchemaPromise_${DELIVERY_ROUTE_SCHEMA_VERSION}`;
  if (routeCache[readyKey]) return;
  if (!routeCache[promiseKey]) {
    routeCache[promiseKey] = ensureDeliveryRouteSchemaInternal(pool)
      .then(() => {
        routeCache[readyKey] = true;
      })
      .catch((err) => {
        routeCache[promiseKey] = null;
        throw err;
      });
  }
  await routeCache[promiseKey];
}

async function listDeliveryRoutes({ activeOnly = false } = {}) {
  await ensureDeliveryRouteSchema();
  const where = activeOnly ? "WHERE active = true" : "";
  return query(
    `SELECT code, name, COALESCE(origin, '') as origin,
            origin_lat, origin_lng,
            COALESCE(destination, '') as destination,
            destination_lat, destination_lng,
            COALESCE(waypoints, '[]'::jsonb) as waypoints,
            COALESCE(distance_km, 0)::numeric as distance_km,
            COALESCE(sort_order, 0) as sort_order, active
     FROM public.odg_tms_delivery_route
     ${where}
     ORDER BY COALESCE(sort_order, 0) ASC, name ASC`
  );
}

async function getDeliveryRoute(code) {
  await ensureDeliveryRouteSchema();
  return queryOne(
    `SELECT code, name, COALESCE(origin, '') as origin,
            origin_lat, origin_lng,
            COALESCE(destination, '') as destination,
            destination_lat, destination_lng,
            COALESCE(waypoints, '[]'::jsonb) as waypoints,
            COALESCE(distance_km, 0)::numeric as distance_km,
            COALESCE(sort_order, 0) as sort_order, active
     FROM public.odg_tms_delivery_route WHERE code = $1`,
    [String(code ?? "").trim()]
  );
}

async function nextDeliveryRouteCode() {
  await ensureDeliveryRouteSchema();
  const row = await queryOne(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(code FROM 3) AS INT)), 0) AS max_n
     FROM public.odg_tms_delivery_route
     WHERE code ~ '^RT[0-9]+$'`
  );
  const next = Number(row?.max_n ?? 0) + 1;
  return "RT" + String(next).padStart(3, "0");
}

async function upsertDeliveryRoute(input) {
  await ensureDeliveryRouteSchema();
  let code = String(input?.code ?? "").trim();
  const name = String(input?.name ?? "").trim();
  if (!code) code = await nextDeliveryRouteCode();
  if (!name) throw new Error("name is required");
  const origin = input?.origin == null ? null : String(input.origin).trim() || null;
  const originLat = nullableNumber(input?.origin_lat);
  const originLng = nullableNumber(input?.origin_lng);
  const destination = input?.destination == null ? null : String(input.destination).trim() || null;
  const destinationLat = nullableNumber(input?.destination_lat);
  const destinationLng = nullableNumber(input?.destination_lng);
  const waypoints = normalizeWaypoints(input?.waypoints);
  const distanceKm = Number.isFinite(Number(input?.distance_km))
    ? Number(input.distance_km)
    : 0;
  const sortOrder = Number.isFinite(Number(input?.sort_order))
    ? Number(input.sort_order)
    : 0;
  const active = input?.active === false ? false : true;

  await pool.query(
    `INSERT INTO public.odg_tms_delivery_route
       (code, name, origin, origin_lat, origin_lng, destination, destination_lat, destination_lng, waypoints, distance_km, sort_order, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, LOCALTIMESTAMP(0), LOCALTIMESTAMP(0))
     ON CONFLICT (code) DO UPDATE
       SET name = EXCLUDED.name,
           origin = EXCLUDED.origin,
           origin_lat = EXCLUDED.origin_lat,
           origin_lng = EXCLUDED.origin_lng,
           destination = EXCLUDED.destination,
           destination_lat = EXCLUDED.destination_lat,
           destination_lng = EXCLUDED.destination_lng,
           waypoints = EXCLUDED.waypoints,
           distance_km = EXCLUDED.distance_km,
           sort_order = EXCLUDED.sort_order,
           active = EXCLUDED.active,
           updated_at = LOCALTIMESTAMP(0)`,
    [
      code,
      name,
      origin,
      originLat,
      originLng,
      destination,
      destinationLat,
      destinationLng,
      JSON.stringify(waypoints),
      distanceKm,
      sortOrder,
      active,
    ]
  );
  return { success: true, code };
}

async function deleteDeliveryRoute(code) {
  await ensureDeliveryRouteSchema();
  await pool.query(
    `DELETE FROM public.odg_tms_delivery_route WHERE code = $1`,
    [String(code ?? "").trim()]
  );
  return { success: true };
}

/**
 * ສາຂາທີ່ໃຊ້ແນະນຳຈຸດປັກໝຸດໃນໜ້າຕັ້ງຄ່າເສັ້ນທາງ.
 *
 * ດຶງ **ສະເພາະສາຂາທີ່ມີລົດຂົນສົ່ງຢູ່** — ບໍ່ແມ່ນທຸກສາຂາໃນ transport_type.
 * "ລົດຂົນສົ່ງ" = ລົດທີ່ຕັ້ງ car_type ກົງກັບປະເພດລົດໃນ odg_tms_car_type
 * (join ດ້ວຍຊື່ ຕາມແບບດຽວກັບ getCarProfiles). ອຸປະກອນທີ່ບໍ່ແມ່ນລົດຂົນສົ່ງ
 * ເຊັ່ນ Forklift ບໍ່ມີ car_type ໃນລາຍການນັ້ນ ຈຶ່ງບໍ່ຖືກນັບ.
 *
 * ພິກັດມາຈາກຈຸດເລີ່ມຂອງ geofence ສາຂາ (ບ່ອນລົດຈອດ). ສາຂາທີ່ຍັງບໍ່ໄດ້ຕັ້ງ
 * geofence ຍັງຄືນມາຢູ່ (lat/lng ວ່າງ) ເພື່ອໃຫ້ເລືອກຊື່ໄດ້ ແລ້ວປັກໝຸດເອງ.
 */
async function listRouteStopSuggestions() {
  return query(
    `SELECT
       tt.code AS code,
       COALESCE(NULLIF(TRIM(tt.name_1), ''), tt.code) AS name,
       COALESCE(g.start_lat, '') AS lat,
       COALESCE(g.start_lng, '') AS lng,
       COUNT(c.code)::int AS car_count
     FROM public.transport_type tt
     JOIN public.odg_tms_car c
       ON NULLIF(TRIM(c.transport_code), '') = tt.code
     JOIN public.odg_tms_car_type ct
       ON ct.name = NULLIF(TRIM(c.car_type), '')
     LEFT JOIN public.odg_tms_geofence g ON g.transport_code = tt.code
     GROUP BY tt.code, tt.name_1, g.start_lat, g.start_lng
     ORDER BY name`
  );
}

/**
 * ຮ້ານທີ່ **ເຄີຍສົ່ງຈິງ** ພ້ອມພິກັດ — ໃຊ້ແນະນຳຈຸດຈອດຂອງເສັ້ນທາງ.
 *
 * ພິກັດມາຈາກຈຸດທີ່ຄົນຂັບກົດປິດບິນ (`odg_tms_detail.lat_end/lng_end`) ບໍ່ແມ່ນ
 * ທີ່ຢູ່ໃນທະບຽນລູກຄ້າ ຈຶ່ງເປັນຈຸດທີ່ລົດໄປຮອດແທ້.
 *
 * ສາມເລື່ອງທີ່ຕັ້ງໃຈ:
 *
 * 1. **ຈຳກັດ 90 ວັນ** — ບິນເກົ່າກວ່ານັ້ນສ່ວນຫຼາຍບໍ່ມີພິກັດ (ເລີ່ມເກັບ GPS
 *    ພາຍຫຼັງ: ທັງໝົດ 72,933 ໃບມີພິກັດພຽງ 8,419 ແຕ່ 90 ວັນຫຼ້າສຸດມີເຖິງ 96.8%).
 *    ດຶງທັງໝົດຈະໄດ້ພາບທີ່ຮ້ານປະຈຳຫາຍໄປ ໂດຍບໍ່ມີອາການບອກ.
 *
 * 2. **ໃຊ້ຄ່າມັດທະຍົມ (median) ບໍ່ແມ່ນຄ່າສະເລ່ຍ** — ຮ້ານໜຶ່ງມີຫຼາຍຈຸດຈາກຫຼາຍ
 *    ຄັ້ງ ແລະ ບາງຄັ້ງຄົນຂັບກົດປິດບິນຕອນຂັບອອກໄປໄກແລ້ວ. ຄ່າສະເລ່ຍຖືກຈຸດຫຼົງ
 *    ດຶງອອກນອກ ແຕ່ median ບໍ່ຫວັ່ນໄຫວ.
 *
 * 3. **lat/lng ເປັນ varchar ໃນ DB** — ຕ້ອງ cast ແລະ ກັນຄ່າ '' / '0' ອອກ
 *    ບໍ່ດັ່ງນັ້ນຈະໄດ້ຈຸດ (0,0) ກາງມະຫາສະໝຸດປົນມາ.
 */
async function listCustomerStopSuggestions({ days = 90, limit = 2000 } = {}) {
  const windowDays = Math.min(Math.max(Number(days) || 90, 1), 365);
  const max = Math.min(Math.max(Number(limit) || 2000, 1), 5000);
  const usable = (col) =>
    `NULLIF(TRIM(d.${col}), '') IS NOT NULL
     AND TRIM(d.${col}) ~ '^-?[0-9]+(\\.[0-9]+)?$'
     AND TRIM(d.${col})::numeric <> 0`;

  return query(
    `WITH points AS (
       SELECT
         d.cust_code,
         TRIM(d.lat_end)::numeric AS lat,
         TRIM(d.lng_end)::numeric AS lng,
         d.sent_end
       FROM public.odg_tms_detail d
       WHERE d.status = 1
         AND d.sent_end > LOCALTIMESTAMP - ($1 || ' days')::interval
         AND NULLIF(TRIM(d.cust_code), '') IS NOT NULL
         AND ${usable("lat_end")}
         AND ${usable("lng_end")}
     )
     SELECT
       p.cust_code                                   AS code,
       COALESCE(NULLIF(TRIM(c.name_1), ''), p.cust_code) AS name,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY p.lat)::numeric, 6)::text AS lat,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY p.lng)::numeric, 6)::text AS lng,
       COUNT(*)::int                                 AS delivery_count,
       to_char(MAX(p.sent_end), 'YYYY-MM-DD')        AS last_delivered
     FROM points p
     LEFT JOIN public.ar_customer c ON c.code = p.cust_code
     GROUP BY p.cust_code, c.name_1
     ORDER BY COUNT(*) DESC, name
     LIMIT ${max + 1}`,
    [String(windowDays)]
  ).then((rows) => {
    // ດຶງເກີນມາ 1 ແຖວເພື່ອຮູ້ວ່າຖືກຕັດບໍ — ຕັດງຽບໆແລ້ວໜ້າຈໍຈະເບິ່ງຄື
    // "ມີເທົ່ານີ້" ທັງທີ່ຍັງມີຮ້ານອື່ນອີກ.
    const truncated = (rows ?? []).length > max;
    return {
      days: windowDays,
      truncated,
      stops: (rows ?? []).slice(0, max).map((r) => ({
        code: String(r.code ?? ""),
        name: String(r.name ?? "").trim(),
        lat: String(r.lat ?? ""),
        lng: String(r.lng ?? ""),
        delivery_count: Number(r.delivery_count ?? 0),
        last_delivered: String(r.last_delivered ?? ""),
      })),
    };
  });
}

module.exports = {
  ensureDeliveryRouteSchema,
  listDeliveryRoutes,
  getDeliveryRoute,
  upsertDeliveryRoute,
  deleteDeliveryRoute,
  listRouteStopSuggestions,
  listCustomerStopSuggestions,
};
