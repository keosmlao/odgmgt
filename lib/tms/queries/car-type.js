// Car types (ປະເພດລົດ) — admin-managed list used by the car form's type
// dropdown. odg_tms_car.car_type stores the type NAME, so these rows ARE the
// option values; the legacy hard-coded list is seeded once on first use.
const { pool, query, queryOne } = require("../lib/db");

const ctCache = globalThis;

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

// Same list the cars page used to hard-code — seeded once so existing cars
// (whose car_type holds one of these names) keep matching a dropdown option.
const DEFAULT_CAR_TYPES = [
  "ລົດກະບະ",
  "ລົດຕູ້",
  "ລົດ 4 ລໍ້",
  "ລົດ 6 ລໍ້",
  "ລົດ 10 ລໍ້",
  "ລົດແຊ່ເຢັນ",
  "ລົດພ່ວງ",
  "ລົດຈັກ",
];

// Starting cargo-space figures per type, keyed by name. These are ESTIMATES of a
// typical truck of each class — enough to make load-utilisation useful on day
// one, but every seeded row is stamped capacity_source='default' so the UI can
// tell admins to go measure the real trucks and confirm. Once someone edits a
// row it becomes 'measured' and is never overwritten here again.
// [length_cm, width_cm, height_cm, payload_kg, pallet_slots, stowage_pct]
const DEFAULT_CAPACITY = {
  "ລົດຈັກ": [50, 40, 40, 50, 0, 70],
  "ລົດກະບະ": [180, 140, 50, 1000, 0, 75],
  "ລົດຕູ້": [240, 150, 130, 1000, 0, 75],
  "ລົດ 4 ລໍ້": [300, 170, 180, 2000, 2, 80],
  "ລົດ 6 ລໍ້": [500, 210, 210, 6000, 6, 80],
  "ລົດ 10 ລໍ້": [720, 230, 230, 15000, 10, 80],
  "ລົດ 12 ລໍ້": [800, 230, 240, 18000, 12, 80],
  "ລົດແຊ່ເຢັນ": [400, 190, 190, 3000, 4, 75],
  "ລົດພ່ວງ": [1200, 240, 250, 25000, 20, 85],
};

// Cargo box in cm → m³. Kept as one expression so the type list, the per-car
// resolver and any report all agree on the arithmetic.
const CAPACITY_M3_SQL = `
  ROUND(
    (COALESCE(%L, 0)::numeric * COALESCE(%W, 0)::numeric * COALESCE(%H, 0)::numeric)
    / 1000000, 3)`;

function capacityM3Sql(lengthCol, widthCol, heightCol) {
  return CAPACITY_M3_SQL.replace("%L", lengthCol)
    .replace("%W", widthCol)
    .replace("%H", heightCol);
}

// Blank / non-numeric input means "ບໍ່ໄດ້ກຳນົດ" (NULL), which for a car-level
// field means "inherit the type default" — NOT zero. Coercing to 0 here would
// silently claim the truck holds nothing.
function numOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function ensureCarTypeSchemaInternal(db) {
  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_car_type (
      code character varying PRIMARY KEY,
      name character varying NOT NULL,
      sort_order int DEFAULT 0,
      active boolean DEFAULT true,
      created_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0),
      updated_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  // Seed the legacy types only when the table is empty (first install).
  const existing = await db.query(`SELECT COUNT(*)::int AS n FROM public.odg_tms_car_type`);
  if (Number(existing.rows?.[0]?.n ?? 0) === 0) {
    for (let i = 0; i < DEFAULT_CAR_TYPES.length; i++) {
      await db.query(
        `INSERT INTO public.odg_tms_car_type (code, name, sort_order)
         VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING`,
        ["T" + String(i + 1).padStart(3, "0"), DEFAULT_CAR_TYPES[i], i]
      );
    }
  }

  // ຄວາມຈຸບັນທຸກ — ບໍ່ເຄີຍມີບ່ອນເກັບ ຈຶ່ງຄິດໄລ່ບໍ່ໄດ້ວ່າຖ້ຽວໜຶ່ງເຕັມລົດປານໃດ.
  // ເກັບເປັນ cm (ຄົນວັດເປັນ cm) ແລ້ວແປງເປັນ m³ ຕອນອ່ານ.
  for (const col of [
    "cargo_length_cm numeric",
    "cargo_width_cm numeric",
    "cargo_height_cm numeric",
    "payload_kg numeric",
    "pallet_slots int",
    // ບັນທຸກຈິງບໍ່ເຄີຍເຕັມ 100% ເພາະຊ່ອງຫວ່າງລະຫວ່າງກ່ອງ — ຄູນຄ່ານີ້ກ່ອນ
    // ປຽບທຽບກັບປະລິມານສິນຄ້າ.
    "stowage_pct numeric DEFAULT 80",
    // 'default' = ຄ່າຄາດຄະເນທີ່ລະບົບໃສ່ໃຫ້, 'measured' = ຄົນວັດ/ແກ້ເອງແລ້ວ
    "capacity_source character varying DEFAULT 'default'",
  ]) {
    await safeDdl(db, `ALTER TABLE public.odg_tms_car_type ADD COLUMN IF NOT EXISTS ${col}`);
  }

  // Fill in the estimates for any type that still has no cargo box. Guarded on
  // capacity_source so an admin's measured numbers are never clobbered, and on
  // NULL so this is a no-op after the first run.
  for (const [name, [len, wid, hei, kg, pallets, stow]] of Object.entries(DEFAULT_CAPACITY)) {
    await db.query(
      `UPDATE public.odg_tms_car_type
          SET cargo_length_cm = $2, cargo_width_cm = $3, cargo_height_cm = $4,
              payload_kg = $5, pallet_slots = $6,
              stowage_pct = COALESCE(stowage_pct, $7),
              capacity_source = 'default'
        WHERE name = $1
          AND cargo_length_cm IS NULL
          AND COALESCE(capacity_source, 'default') <> 'measured'`,
      [name, len, wid, hei, kg, pallets, stow]
    );
  }
}

// ເພີ່ມຄໍລັມແລ້ວຕ້ອງຂຶ້ນເລກນີ້ — memo ຢູ່ globalThis ຄ້າງຂ້າມ HMR
// ຈຶ່ງເຮັດໃຫ້ ALTER ໃໝ່ບໍ່ແລ່ນ ແລ້ວ SELECT ຫາຄໍລັມທີ່ຍັງບໍ່ມີ
const CAR_TYPE_SCHEMA_VERSION = "v2_capacity";

async function ensureCarTypeSchema() {
  const key = `__tmsCarTypeSchema_${CAR_TYPE_SCHEMA_VERSION}`;
  if (ctCache[key]) return;
  if (!ctCache[`${key}_p`]) {
    ctCache[`${key}_p`] = ensureCarTypeSchemaInternal(pool)
      .then(() => {
        ctCache[key] = true;
      })
      .catch((err) => {
        ctCache[`${key}_p`] = null;
        throw err;
      });
  }
  await ctCache[`${key}_p`];
}

async function listCarTypes({ activeOnly = false } = {}) {
  await ensureCarTypeSchema();
  const where = activeOnly ? "WHERE active = true" : "";
  return query(
    `SELECT code, name, COALESCE(sort_order, 0) as sort_order, active,
            cargo_length_cm, cargo_width_cm, cargo_height_cm,
            payload_kg, pallet_slots,
            COALESCE(stowage_pct, 80) AS stowage_pct,
            COALESCE(capacity_source, 'default') AS capacity_source,
            ${capacityM3Sql("cargo_length_cm", "cargo_width_cm", "cargo_height_cm")} AS capacity_m3,
            ROUND(
              ${capacityM3Sql("cargo_length_cm", "cargo_width_cm", "cargo_height_cm")}
              * COALESCE(stowage_pct, 80) / 100, 3) AS usable_m3
     FROM public.odg_tms_car_type
     ${where}
     ORDER BY COALESCE(sort_order, 0) ASC, name ASC`
  );
}

async function nextCarTypeCode() {
  await ensureCarTypeSchema();
  // Codes are T001, T002, ... — generated server-side.
  const row = await queryOne(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(code FROM 2) AS INT)), 0) AS max_n
     FROM public.odg_tms_car_type
     WHERE code ~ '^T[0-9]+$'`
  );
  const next = Number(row?.max_n ?? 0) + 1;
  return "T" + String(next).padStart(3, "0");
}

async function upsertCarType(input) {
  await ensureCarTypeSchema();
  let code = String(input?.code ?? "").trim();
  const name = String(input?.name ?? "").trim();
  if (!code) {
    code = await nextCarTypeCode();
  }
  if (!name) throw new Error("name is required");
  const sortOrder = Number.isFinite(Number(input?.sort_order))
    ? Number(input.sort_order)
    : 0;
  const active = input?.active === false ? false : true;
  const len = numOrNull(input?.cargo_length_cm);
  const wid = numOrNull(input?.cargo_width_cm);
  const hei = numOrNull(input?.cargo_height_cm);
  const kg = numOrNull(input?.payload_kg);
  const pallets = numOrNull(input?.pallet_slots);
  const stow = numOrNull(input?.stowage_pct);

  await pool.query(
    `INSERT INTO public.odg_tms_car_type
       (code, name, sort_order, active,
        cargo_length_cm, cargo_width_cm, cargo_height_cm,
        payload_kg, pallet_slots, stowage_pct, capacity_source,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, 80), 'default',
             LOCALTIMESTAMP(0), LOCALTIMESTAMP(0))
     ON CONFLICT (code) DO UPDATE
       SET name = EXCLUDED.name,
           sort_order = EXCLUDED.sort_order,
           active = EXCLUDED.active,
           -- ຄວາມຈຸບໍ່ໄດ້ຕັ້ງຢູ່ໜ້ານີ້ອີກ (ຍ້າຍໄປ "ຂໍ້ມູນລົດ" ແລ້ວ) ຈຶ່ງ
           -- COALESCE ໄວ້: ບັນທຶກຊື່/ລຳດັບ ຕ້ອງບໍ່ລຶບຄ່າຕັ້ງຕົ້ນທີ່ປຸ່ມ
           -- "ຕື່ມຄ່າຄາດຄະເນ" ຢູ່ໜ້າຂໍ້ມູນລົດເອົາໄປໃຊ້
           cargo_length_cm = COALESCE(EXCLUDED.cargo_length_cm, public.odg_tms_car_type.cargo_length_cm),
           cargo_width_cm = COALESCE(EXCLUDED.cargo_width_cm, public.odg_tms_car_type.cargo_width_cm),
           cargo_height_cm = COALESCE(EXCLUDED.cargo_height_cm, public.odg_tms_car_type.cargo_height_cm),
           payload_kg = COALESCE(EXCLUDED.payload_kg, public.odg_tms_car_type.payload_kg),
           pallet_slots = COALESCE(EXCLUDED.pallet_slots, public.odg_tms_car_type.pallet_slots),
           stowage_pct = COALESCE(EXCLUDED.stowage_pct, public.odg_tms_car_type.stowage_pct),
           updated_at = LOCALTIMESTAMP(0)`,
    [code, name, sortOrder, active, len, wid, hei, kg, pallets, stow]
  );
  return { success: true };
}

async function deleteCarType(code) {
  await ensureCarTypeSchema();
  await pool.query(
    `DELETE FROM public.odg_tms_car_type WHERE code = $1`,
    [String(code ?? "").trim()]
  );
  return { success: true };
}

module.exports = {
  ensureCarTypeSchema,
  listCarTypes,
  upsertCarType,
  deleteCarType,
  nextCarTypeCode,
  capacityM3Sql,
  numOrNull,
};
