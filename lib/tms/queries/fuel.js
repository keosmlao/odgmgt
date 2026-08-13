const { pool, query, queryOne } = require("../lib/db");
const { getBranchScope } = require("./helpers");
const {
  MIN_PLAUSIBLE_LITERS,
  MAX_PLAUSIBLE_LITERS,
  describeFuelEntryProblem,
} = require("../lib/fuel-sanity");

const fuelCache = globalThis;

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

async function ensureFuelSchemaInternal(db) {
  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_fuel_log (
      id BIGSERIAL PRIMARY KEY,
      fuel_date date NOT NULL DEFAULT CURRENT_DATE,
      user_code character varying,
      driver_name character varying,
      car character varying,
      doc_no character varying,
      liters numeric DEFAULT 0,
      amount numeric DEFAULT 0,
      odometer numeric,
      station character varying,
      note text,
      image_data text,
      lat character varying,
      lng character varying,
      created_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  // Per-row branch tag so the dashboard can scope to the user's logistic
  // branch. NULL = legacy row (saved before this column existed) — those
  // rows are still surfaced when the viewer has no branch.
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_fuel_log
    ADD COLUMN IF NOT EXISTS transport_code character varying
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_fuel_log_date
    ON public.odg_tms_fuel_log (fuel_date)
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_fuel_log_user
    ON public.odg_tms_fuel_log (user_code)
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_fuel_log_transport
    ON public.odg_tms_fuel_log (transport_code)
  `);
}

async function ensureFuelSchema(client) {
  const db = client ?? pool;
  if (client && client !== pool) {
    await ensureFuelSchemaInternal(client);
    return;
  }
  if (fuelCache.__tmsFuelSchemaReady) return;
  if (!fuelCache.__tmsFuelSchemaPromise) {
    fuelCache.__tmsFuelSchemaPromise = ensureFuelSchemaInternal(db)
      .then(() => {
        fuelCache.__tmsFuelSchemaReady = true;
      })
      .catch((err) => {
        fuelCache.__tmsFuelSchemaPromise = null;
        throw err;
      });
  }
  await fuelCache.__tmsFuelSchemaPromise;
}

function asText(v) {
  return typeof v === "string" ? v.trim() : "";
}

function asNullableText(v) {
  const t = asText(v);
  return t || null;
}

function asNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function saveFuelRefill(payload, client) {
  const db = client ?? pool;
  await ensureFuelSchema(db);

  const liters = asNumber(payload?.liters);
  const amount = asNumber(payload?.amount);
  if (liters === null && amount === null) {
    throw new Error("ກະລຸນາໃສ່ຈຳນວນລິດ ຫຼື ຈຳນວນເງິນ");
  }
  // Last line of defence — the dialog and the mobile schema check this too, but
  // this is the only path every refill goes through.
  const problem = describeFuelEntryProblem(liters, amount);
  if (problem) throw new Error(problem);

  const fuelDate = asNullableText(payload?.fuel_date);
  const sql = `
    INSERT INTO public.odg_tms_fuel_log
      (fuel_date, user_code, driver_name, car, doc_no, liters, amount, odometer,
       station, note, image_data, lat, lng, transport_code)
    VALUES (
      COALESCE($1::date, CURRENT_DATE),
      $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
    )
    RETURNING id
  `;
  const params = [
    fuelDate,
    asNullableText(payload?.user_code),
    asNullableText(payload?.driver_name),
    asNullableText(payload?.car),
    asNullableText(payload?.doc_no),
    liters ?? 0,
    amount ?? 0,
    asNumber(payload?.odometer),
    asNullableText(payload?.station),
    asNullableText(payload?.note),
    asNullableText(payload?.image_data),
    asNullableText(payload?.lat),
    asNullableText(payload?.lng),
    asNullableText(payload?.transport_code),
  ];
  const result = await db.query(sql, params);
  return { success: true, id: result.rows[0]?.id ?? null };
}

async function getFuelLogs({ fromDate, toDate, search, userCode, session } = {}) {
  await ensureFuelSchema();

  const params = [];
  const where = [];

  if (fromDate) {
    params.push(fromDate);
    where.push(`fuel_date >= $${params.length}::date`);
  }
  if (toDate) {
    params.push(toDate);
    where.push(`fuel_date <= $${params.length}::date`);
  }
  if (userCode) {
    params.push(userCode);
    where.push(`user_code = $${params.length}`);
  }
  // Branch scope: when the viewer has a logistic_code, only show their
  // branch's refills. Legacy rows (transport_code IS NULL) stay visible so
  // history isn't lost. Viewers with no branch see everything.
  const scope = getBranchScope(session);
  if (scope.scoped) {
    params.push(scope.branches);
    where.push(`(transport_code = ANY($${params.length}) OR transport_code IS NULL)`);
  }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(
      COALESCE(driver_name, '') ILIKE $${params.length}
      OR COALESCE(user_code, '') ILIKE $${params.length}
      OR COALESCE(car, '') ILIKE $${params.length}
      OR COALESCE(station, '') ILIKE $${params.length}
      OR COALESCE(doc_no, '') ILIKE $${params.length}
    )`);
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await query(
    `SELECT
       id,
       to_char(fuel_date, 'YYYY-MM-DD') AS fuel_date,
       user_code,
       driver_name,
       car,
       doc_no,
       liters,
       amount,
       odometer,
       station,
       note,
       lat,
       lng,
       (image_data IS NOT NULL AND image_data <> '') AS has_image,
       to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created_at
     FROM public.odg_tms_fuel_log
     ${whereClause}
     ORDER BY fuel_date DESC, created_at DESC, id DESC`,
    params
  );
  return rows;
}

async function getFuelSummary({ fromDate, toDate, userCode, session } = {}) {
  await ensureFuelSchema();
  const params = [];
  const where = [];
  if (fromDate) {
    params.push(fromDate);
    where.push(`fuel_date >= $${params.length}::date`);
  }
  if (toDate) {
    params.push(toDate);
    where.push(`fuel_date <= $${params.length}::date`);
  }
  if (userCode) {
    params.push(userCode);
    where.push(`user_code = $${params.length}`);
  }
  const scope = getBranchScope(session);
  if (scope.scoped) {
    params.push(scope.branches);
    where.push(`(transport_code = ANY($${params.length}) OR transport_code IS NULL)`);
  }
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const row = await queryOne(
    `SELECT
       COUNT(*)::int AS entry_count,
       COALESCE(SUM(liters), 0)::numeric AS total_liters,
       COALESCE(SUM(amount), 0)::numeric AS total_amount
     FROM public.odg_tms_fuel_log
     ${whereClause}`,
    params
  );
  return row ?? { entry_count: 0, total_liters: 0, total_amount: 0 };
}

// Liters/amount rolled up per car, so the GPS summary can divide its own
// distance by them and get km/L. `odg_tms_fuel_log.car` is the car code when
// the refill came from the web dialog, but the mobile app posts whatever the
// job carried — sometimes the plate (name_1). The lateral resolves both to a
// canonical code, preferring an exact code match.
async function getFuelByCar({ fromDate, toDate, session } = {}) {
  await ensureFuelSchema();
  const params = [];
  const where = [`f.car IS NOT NULL`, `btrim(f.car::text) <> ''`];
  if (fromDate) {
    params.push(fromDate);
    where.push(`f.fuel_date >= $${params.length}::date`);
  }
  if (toDate) {
    params.push(toDate);
    where.push(`f.fuel_date <= $${params.length}::date`);
  }
  const scope = getBranchScope(session);
  if (scope.scoped) {
    params.push(scope.branches);
    where.push(`(f.transport_code = ANY($${params.length}) OR f.transport_code IS NULL)`);
  }

  // Rows whose "liters" is really a kip amount are counted separately rather
  // than summed — see lib/fuel-sanity.js. They still show in the fuel page's
  // own list (nothing is hidden), they just can't be divided into a km/L.
  params.push(MIN_PLAUSIBLE_LITERS, MAX_PLAUSIBLE_LITERS);
  const minParam = `$${params.length - 1}`;
  const maxParam = `$${params.length}`;
  const plausible = `f.liters BETWEEN ${minParam} AND ${maxParam}`;

  return query(
    `SELECT
       COALESCE(m.code::text, btrim(f.car::text)) AS car_code,
       COALESCE(SUM(f.liters) FILTER (WHERE ${plausible}), 0)::float AS liters,
       COALESCE(SUM(f.amount) FILTER (WHERE ${plausible}), 0)::float AS amount,
       COUNT(*) FILTER (WHERE ${plausible})::int AS refills,
       COUNT(*) FILTER (WHERE f.liters > ${maxParam})::int AS ignored_refills
     FROM public.odg_tms_fuel_log f
     LEFT JOIN LATERAL (
       SELECT c.code
       FROM public.odg_tms_car c
       WHERE btrim(c.code::text) = btrim(f.car::text)
          OR upper(btrim(c.name_1::text)) = upper(btrim(f.car::text))
       ORDER BY (btrim(c.code::text) = btrim(f.car::text)) DESC
       LIMIT 1
     ) m ON TRUE
     WHERE ${where.join(" AND ")}
     GROUP BY 1
     ORDER BY 2 DESC`,
    params
  );
}

async function getFuelImage(id) {
  await ensureFuelSchema();
  const row = await queryOne(
    `SELECT image_data FROM public.odg_tms_fuel_log WHERE id = $1`,
    [id]
  );
  return row?.image_data ?? null;
}

async function deleteFuelLog(id) {
  await ensureFuelSchema();
  await pool.query(`DELETE FROM public.odg_tms_fuel_log WHERE id = $1`, [id]);
  return { success: true };
}

module.exports = {
  ensureFuelSchema,
  saveFuelRefill,
  getFuelLogs,
  getFuelSummary,
  getFuelByCar,
  getFuelImage,
  deleteFuelLog,
};
