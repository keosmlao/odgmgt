// ຕາຕະລາງຂະໜາດທໍ່ຕາມສູດ (ODG TMS) — ສະເພາະການອ່ານ/ຂຽນ DB.
//
// ທໍ່ບໍ່ຕ້ອງໄປວັດເປັນລາຍການ ເພາະຂະໜາດນອກ (OD) ເປັນມາດຕະຖານຢູ່ແລ້ວ ແລະ
// ຄວາມຍາວກໍມາດຕະຖານ (4 ແມັດ). ສະນັ້ນຕາຕະລາງນີ້ມີແຕ່ ~27 ແຖວ ແຕ່ຄຸມທໍ່
// ໄດ້ 300+ ລາຍການ / ~4,500 ແຖວຖ້ຽວ.
//
// ຄວາມຍາວ 4 ແມັດແມ່ນຄ່າເລີ່ມຕົ້ນ ບໍ່ແມ່ນຂໍ້ມູນທີ່ຢືນຢັນແລ້ວ — ຖ້າຮ້ານໃດ
// ຂາຍທໍ່ 3 ແມັດ ຕ້ອງເຂົ້າໄປແກ້ length_m ຂອງແຖວນັ້ນ.
//
// ການແກະຊື່ + ຄິດ m³ ຢູ່ src/lib/pipe-name.ts ແລະ src/lib/pipe-resolve.ts.
// ໄຟລ໌ນີ້ຕ້ອງບໍ່ require ໂມດູນ .ts ເພາະ CommonJS require ຫາໄຟລ໌ .ts ບໍ່ເຫັນ
// ຢູ່ນອກ bundler ຂອງ Next (ຈະ test ຫຼື ຂຽນ script ໃຊ້ບໍ່ໄດ້).
const { pool, query } = require("../lib/db");

const pdCache = globalThis;

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

// ຂະໜາດນອກ (OD) ຕາມມາດຕະຖານ ມອກ.17 ທີ່ຮ້ານທໍ່ໃນລາວ/ໄທໃຊ້ຮ່ວມກັນ.
// [size_key, label, od_mm] — ຄວາມຍາວເລີ່ມຕົ້ນ 4 ແມັດທຸກແຖວ.
const DEFAULT_PIPE_SIZES = [
  ["in:0.375", '3/8"', 18],
  ["in:0.5", '1/2"', 21.5],
  ["in:0.75", '3/4"', 26.5],
  ["in:1", '1"', 34],
  ["in:1.25", '1 1/4"', 42],
  ["in:1.5", '1 1/2"', 48],
  ["in:2", '2"', 60],
  ["in:2.5", '2 1/2"', 76],
  ["in:3", '3"', 88.5],
  ["in:4", '4"', 114],
  ["in:5", '5"', 140],
  ["in:6", '6"', 165],
  ["in:8", '8"', 216],
  ["in:10", '10"', 280],
  ["in:12", '12"', 335],
  // ທໍ່ PPR / ທໍ່ແມັດຕຣິກ — OD ເທົ່າກັບຂະໜາດທີ່ເອີ້ນເລີຍ
  ["mm:16", "16 mm", 16],
  ["mm:20", "20 mm", 20],
  ["mm:25", "25 mm", 25],
  ["mm:32", "32 mm", 32],
  ["mm:40", "40 mm", 40],
  ["mm:50", "50 mm", 50],
  ["mm:63", "63 mm", 63],
  ["mm:75", "75 mm", 75],
  ["mm:90", "90 mm", 90],
  ["mm:110", "110 mm", 110],
  ["mm:125", "125 mm", 125],
  ["mm:160", "160 mm", 160],
];

async function ensurePipeDimSchemaInternal(db) {
  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_pipe_dim (
      size_key character varying PRIMARY KEY,
      label character varying NOT NULL,
      od_mm numeric NOT NULL,
      length_m numeric DEFAULT 4,
      packing_factor numeric DEFAULT 0.9,
      sort_order int DEFAULT 0,
      note character varying,
      -- 'default' = ຄ່າມາດຕະຖານທີ່ລະບົບໃສ່ໃຫ້, 'confirmed' = ຄົນຢືນຢັນແລ້ວ
      source character varying DEFAULT 'default',
      -- ນ້ຳໜັກຕໍ່ເສັ້ນ — ບໍ່ມີສູດທີ່ເຊື່ອຖືໄດ້ (ຂຶ້ນກັບຊັ້ນ/ຄວາມໜາຜະນັງ)
      -- ຈຶ່ງປະໄວ້ວ່າງ ໃຫ້ຕື່ມຈາກສະເປັກໂຮງງານ. ວ່າງ = ບໍ່ນັບເຂົ້ານ້ຳໜັກຖ້ຽວ.
      weight_kg numeric,
      updated_by character varying,
      updated_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_pipe_dim ADD COLUMN IF NOT EXISTS weight_kg numeric
  `);
  const existing = await db.query(`SELECT COUNT(*)::int AS n FROM public.odg_tms_pipe_dim`);
  if (Number(existing.rows?.[0]?.n ?? 0) === 0) {
    for (let i = 0; i < DEFAULT_PIPE_SIZES.length; i++) {
      const [sizeKey, label, odMm] = DEFAULT_PIPE_SIZES[i];
      await db.query(
        `INSERT INTO public.odg_tms_pipe_dim (size_key, label, od_mm, sort_order)
         VALUES ($1, $2, $3, $4) ON CONFLICT (size_key) DO NOTHING`,
        [sizeKey, label, odMm, i]
      );
    }
  }
}

// ເພີ່ມຄໍລັມແລ້ວຕ້ອງຂຶ້ນເລກນີ້ — memo ຢູ່ globalThis ຄ້າງຂ້າມ HMR
// ຈຶ່ງເຮັດໃຫ້ ALTER ໃໝ່ບໍ່ແລ່ນ ແລ້ວ SELECT ຫາຄໍລັມທີ່ຍັງບໍ່ມີ
const PIPE_DIM_SCHEMA_VERSION = "v2_weight";

async function ensurePipeDimSchema() {
  const key = `__tmsPipeDimSchema_${PIPE_DIM_SCHEMA_VERSION}`;
  if (pdCache[key]) return;
  if (!pdCache[`${key}_p`]) {
    pdCache[`${key}_p`] = ensurePipeDimSchemaInternal(pool)
      .then(() => {
        pdCache[key] = true;
      })
      .catch((err) => {
        pdCache[`${key}_p`] = null;
        throw err;
      });
  }
  await pdCache[`${key}_p`];
}

async function listPipeDimsUncached() {
  await ensurePipeDimSchema();
  return query(
    `SELECT size_key, label, od_mm, COALESCE(length_m, 4) AS length_m,
            COALESCE(packing_factor, 0.9) AS packing_factor,
            COALESCE(sort_order, 0) AS sort_order, note,
            COALESCE(source, 'default') AS source, weight_kg, updated_by, updated_at,
            -- m³ ຕໍ່ 1 ເສັ້ນ — ຕ້ອງໃຫ້ຕົງກັບ pipeM3() ໃນ src/lib/pipe-name.ts
            ROUND((od_mm / 1000) * (od_mm / 1000)
                  * COALESCE(length_m, 4) * COALESCE(packing_factor, 0.9), 6) AS m3_per_pipe
       FROM public.odg_tms_pipe_dim
      ORDER BY COALESCE(sort_order, 0) ASC, size_key ASC`
  );
}

// ຕາຕະລາງຕັ້ງຄ່ານ້ອຍ (27 / ຫຼັກສິບແຖວ) ທີ່ຖືກອ່ານທຸກຄັ້ງທີ່ຄິດພື້ນທີ່ —
// ໜ້າໜຶ່ງມີ 20 ຖ້ຽວກໍອ່ານຊ້ຳ. cache ສັ້ນໆ ຕັດ DB round-trip ອອກ
// ໂດຍທີ່ຄົນແກ້ຕາຕະລາງແລ້ວຍັງເຫັນຜົນພາຍໃນ {TTL}s.
const __tmsPipeDimList_TTL_MS = 30_000;

async function listPipeDims() {
  const now = Date.now();
  const hit = pdCache.__tmsPipeDimList;
  if (hit && now - hit.at < __tmsPipeDimList_TTL_MS) return hit.rows;
  const rows = await listPipeDimsUncached();
  pdCache.__tmsPipeDimList = { at: now, rows };
  return rows;
}

/** ລ້າງ cache ຫຼັງແກ້ຕາຕະລາງ ເພື່ອໃຫ້ເຫັນຜົນທັນທີ */
function invalidatePipeDimsCache() {
  pdCache.__tmsPipeDimList = null;
}

async function upsertPipeDim(session, input) {
  await ensurePipeDimSchema();
  const sizeKey = String(input?.size_key ?? "").trim();
  if (!sizeKey) throw new Error("size_key is required");
  const label = String(input?.label ?? "").trim();
  if (!label) throw new Error("label is required");

  const odMm = Number(input?.od_mm);
  if (!Number.isFinite(odMm) || odMm <= 0) throw new Error("od_mm must be > 0");
  const lengthM = Number(input?.length_m);
  if (!Number.isFinite(lengthM) || lengthM <= 0) throw new Error("length_m must be > 0");
  const factor = Number(input?.packing_factor ?? 0.9);
  if (!Number.isFinite(factor) || factor <= 0 || factor > 1) {
    throw new Error("packing_factor must be between 0 and 1");
  }
  const sortOrder = Number.isFinite(Number(input?.sort_order)) ? Number(input.sort_order) : 0;
  const note = input?.note ? String(input.note).trim() : null;

  await pool.query(
    `INSERT INTO public.odg_tms_pipe_dim
       (size_key, label, od_mm, length_m, packing_factor, sort_order, note,
        weight_kg, source, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confirmed', $9, LOCALTIMESTAMP(0))
     ON CONFLICT (size_key) DO UPDATE
       SET label = EXCLUDED.label,
           od_mm = EXCLUDED.od_mm,
           length_m = EXCLUDED.length_m,
           packing_factor = EXCLUDED.packing_factor,
           sort_order = EXCLUDED.sort_order,
           note = EXCLUDED.note,
           weight_kg = EXCLUDED.weight_kg,
           source = 'confirmed',
           updated_by = EXCLUDED.updated_by,
           updated_at = LOCALTIMESTAMP(0)`,
    [
      sizeKey, label, odMm, lengthM, factor, sortOrder, note,
      Number.isFinite(Number(input?.weight_kg)) && Number(input.weight_kg) > 0
        ? Number(input.weight_kg)
        : null,
      session?.usercode ?? null,
    ]
  );
  invalidatePipeDimsCache();
  return { success: true };
}

async function deletePipeDim(sizeKey) {
  await ensurePipeDimSchema();
  await pool.query(`DELETE FROM public.odg_tms_pipe_dim WHERE size_key = $1`, [
    String(sizeKey ?? "").trim(),
  ]);
  invalidatePipeDimsCache();
  return { success: true };
}

/** ລາຍການທີ່ຊື່ເລີ່ມດ້ວຍ "ທໍ່" ພ້ອມຈຳນວນແຖວ — ໃຫ້ຊັ້ນ lib ໄປແກະຊື່ຕໍ່. */
async function getPipeItemStats({ days = 90 } = {}) {
  await ensurePipeDimSchema();
  return query(
    `SELECT item_code, MAX(item_name) AS item_name, MAX(unit_code) AS unit_code,
            COUNT(*)::int AS lines
       FROM public.odg_tms_detail_item
      WHERE create_date_time_now >= LOCALTIMESTAMP - ($1 || ' days')::interval
        AND item_name LIKE 'ທໍ່%'
      GROUP BY item_code`,
    [String(days)]
  );
}

module.exports = {
  ensurePipeDimSchema,
  listPipeDims,
  upsertPipeDim,
  deletePipeDim,
  getPipeItemStats,
};
