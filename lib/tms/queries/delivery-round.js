// Delivery rounds (ຮອບການຈັດສົ່ງ) — admin-managed list of shipping shifts
// such as ຮອບເຊົ້າ / ຮອບບ່າຍ that admins pick when creating a job.
const { pool, query, queryOne } = require("../lib/db");

const drCache = globalThis;

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

async function ensureDeliveryRoundSchemaInternal(db) {
  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_delivery_round (
      code character varying PRIMARY KEY,
      name character varying NOT NULL,
      time_label character varying,
      sort_order int DEFAULT 0,
      active boolean DEFAULT true,
      created_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0),
      updated_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  // Job-level reference to the round.
  await safeDdl(db, `
    ALTER TABLE public.odg_tms
    ADD COLUMN IF NOT EXISTS delivery_round_code character varying
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_delivery_round_code
    ON public.odg_tms (delivery_round_code)
  `);
}

async function ensureDeliveryRoundSchema() {
  if (drCache.__tmsDeliveryRoundSchemaReady) return;
  if (!drCache.__tmsDeliveryRoundSchemaPromise) {
    drCache.__tmsDeliveryRoundSchemaPromise = ensureDeliveryRoundSchemaInternal(pool)
      .then(() => {
        drCache.__tmsDeliveryRoundSchemaReady = true;
      })
      .catch((err) => {
        drCache.__tmsDeliveryRoundSchemaPromise = null;
        throw err;
      });
  }
  await drCache.__tmsDeliveryRoundSchemaPromise;
}

async function listDeliveryRounds({ activeOnly = false } = {}) {
  await ensureDeliveryRoundSchema();
  const where = activeOnly ? "WHERE active = true" : "";
  return query(
    `SELECT code, name, COALESCE(time_label, '') as time_label,
            COALESCE(sort_order, 0) as sort_order, active
     FROM public.odg_tms_delivery_round
     ${where}
     ORDER BY COALESCE(sort_order, 0) ASC, name ASC`
  );
}

async function getDeliveryRound(code) {
  await ensureDeliveryRoundSchema();
  return queryOne(
    `SELECT code, name, COALESCE(time_label, '') as time_label,
            COALESCE(sort_order, 0) as sort_order, active
     FROM public.odg_tms_delivery_round WHERE code = $1`,
    [String(code ?? "").trim()]
  );
}

async function nextDeliveryRoundCode() {
  await ensureDeliveryRoundSchema();
  // Codes are R001, R002, ... — generated server-side so admins don't have
  // to invent identifiers when adding a round.
  const row = await queryOne(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(code FROM 2) AS INT)), 0) AS max_n
     FROM public.odg_tms_delivery_round
     WHERE code ~ '^R[0-9]+$'`
  );
  const next = Number(row?.max_n ?? 0) + 1;
  return "R" + String(next).padStart(3, "0");
}

async function upsertDeliveryRound(input) {
  await ensureDeliveryRoundSchema();
  let code = String(input?.code ?? "").trim();
  const name = String(input?.name ?? "").trim();
  if (!code) {
    code = await nextDeliveryRoundCode();
  }
  if (!name) throw new Error("name is required");
  const timeLabel =
    input?.time_label == null ? null : String(input.time_label).trim() || null;
  const sortOrder = Number.isFinite(Number(input?.sort_order))
    ? Number(input.sort_order)
    : 0;
  const active = input?.active === false ? false : true;

  await pool.query(
    `INSERT INTO public.odg_tms_delivery_round
       (code, name, time_label, sort_order, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, LOCALTIMESTAMP(0), LOCALTIMESTAMP(0))
     ON CONFLICT (code) DO UPDATE
       SET name = EXCLUDED.name,
           time_label = EXCLUDED.time_label,
           sort_order = EXCLUDED.sort_order,
           active = EXCLUDED.active,
           updated_at = LOCALTIMESTAMP(0)`,
    [code, name, timeLabel, sortOrder, active]
  );
  return { success: true };
}

async function deleteDeliveryRound(code) {
  await ensureDeliveryRoundSchema();
  await pool.query(
    `DELETE FROM public.odg_tms_delivery_round WHERE code = $1`,
    [String(code ?? "").trim()]
  );
  return { success: true };
}

module.exports = {
  ensureDeliveryRoundSchema,
  listDeliveryRounds,
  getDeliveryRound,
  upsertDeliveryRound,
  deleteDeliveryRound,
  nextDeliveryRoundCode,
};
