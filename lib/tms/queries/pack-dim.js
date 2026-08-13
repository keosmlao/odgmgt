// ຂະໜາດຫີບທີ່ວັດແລ້ວ (ODG TMS) — ສະເພາະການອ່ານ/ຂຽນ DB.
//
// ຂໍ້ຕໍ່ (ຂໍ້ງໍ, ສາມຕາ, ຂໍ້ຕໍ່ລົດ ...) ວັດເປັນຕົວຍາກ ເພາະຮູບຊົງບໍ່ເປັນກ່ອງ.
// ແຕ່ຂາຍເປັນ "ຫີບ" ເຊິ່ງເປັນກ່ອງ ແລະ ຊື່ບອກຈຳນວນຕໍ່ຫີບໄວ້ແລ້ວ ສະນັ້ນວັດ
// 1 ຫີບ ໄດ້ທັງ m³/ຫີບ ແລະ m³/ຕົວ.
//
// ການແກະຊື່ + ຄາດຄະເນຂ້າມຂະໜາດ ຢູ່ src/lib/item-pack.ts ແລະ
// src/lib/pack-resolve.ts. ໄຟລ໌ນີ້ຕ້ອງບໍ່ require ໂມດູນ .ts (CommonJS require
// ຫາໄຟລ໌ .ts ບໍ່ເຫັນຢູ່ນອກ bundler ຂອງ Next).
const { pool, query } = require("../lib/db");

const packCache = globalThis;

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

async function ensurePackDimSchemaInternal(db) {
  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_pack_dim (
      roworder BIGSERIAL PRIMARY KEY,
      -- ຕະກຸນ ຕາມທີ່ parseFamily() ແກະໄດ້ (ຂໍ້ຄວາມກ່ອນຄຳ "ຂະໜາດ")
      family character varying NOT NULL,
      -- NULL = ໃຊ້ກັບທຸກຂະໜາດຂອງຕະກຸນນີ້ (ສິນຄ້າຂະໜາດດຽວ)
      size_key character varying,
      pack_unit character varying,
      pack_qty numeric,
      width_cm numeric,
      length_cm numeric,
      height_cm numeric,
      weight_kg numeric,
      note character varying,
      -- ລາຍການທີ່ຄົນເລືອກຕອນວັດ — ໄວ້ອ້າງອີງວ່າວັດຫີບຂອງໃຜ
      measured_item_code character varying,
      updated_by character varying,
      updated_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  // 'measured' = ຄັງວັດເອງ · 'factory' = ນຳເຂົ້າຈາກສະເປັກໂຮງງານ (ເຊັ່ນ SCG)
  // ສອງອັນນີ້ໜ້າເຊື່ອຖືເທົ່າກັນ ຕ່າງຈາກຄ່າຄາດຄະເນ ຈຶ່ງເກັບໄວ້ບອກທີ່ມາ
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_pack_dim
    ADD COLUMN IF NOT EXISTS source character varying DEFAULT 'measured'
  `);
  await safeDdl(db, `
    ALTER TABLE public.odg_tms_pack_dim
    ADD COLUMN IF NOT EXISTS brand character varying
  `);
  // ຕະກຸນ+ຂະໜາດ ຕ້ອງມີແຖວດຽວ. size_key NULL ໃນ Postgres ບໍ່ຊ້ຳກັນເອງ ຈຶ່ງ
  // ຕ້ອງໃຊ້ COALESCE ໃນ index ບໍ່ດັ່ງນັ້ນສິນຄ້າຂະໜາດດຽວຈະຊ້ຳໄດ້.
  await safeDdl(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_odg_tms_pack_dim_family_size
    ON public.odg_tms_pack_dim (family, COALESCE(size_key, '*'))
  `);
}

// ເພີ່ມຄໍລັມແລ້ວຕ້ອງຂຶ້ນເລກນີ້ — memo ຢູ່ globalThis ຄ້າງຂ້າມ HMR
// ຈຶ່ງເຮັດໃຫ້ ALTER ໃໝ່ບໍ່ແລ່ນ ແລ້ວ SELECT ຫາຄໍລັມທີ່ຍັງບໍ່ມີ
const PACK_DIM_SCHEMA_VERSION = "v2_source_brand";

async function ensurePackDimSchema() {
  const key = `__tmsPackDimSchema_${PACK_DIM_SCHEMA_VERSION}`;
  if (packCache[key]) return;
  if (!packCache[`${key}_p`]) {
    packCache[`${key}_p`] = ensurePackDimSchemaInternal(pool)
      .then(() => {
        packCache[key] = true;
      })
      .catch((err) => {
        packCache[`${key}_p`] = null;
        throw err;
      });
  }
  await packCache[`${key}_p`];
}

async function listPackDimsUncached() {
  await ensurePackDimSchema();
  return query(
    `SELECT roworder, family, size_key, pack_unit, pack_qty,
            width_cm, length_cm, height_cm, weight_kg, note,
            measured_item_code, COALESCE(source, 'measured') AS source, brand,
            updated_by, updated_at,
            ROUND((width_cm / 100) * (length_cm / 100) * (height_cm / 100), 6) AS pack_m3,
            CASE WHEN pack_qty > 0
                 THEN ROUND((width_cm / 100) * (length_cm / 100) * (height_cm / 100)
                            / pack_qty, 8)
            END AS piece_m3
       FROM public.odg_tms_pack_dim
      ORDER BY family ASC, size_key ASC NULLS FIRST`
  );
}

// ຕາຕະລາງຕັ້ງຄ່ານ້ອຍ (27 / ຫຼັກສິບແຖວ) ທີ່ຖືກອ່ານທຸກຄັ້ງທີ່ຄິດພື້ນທີ່ —
// ໜ້າໜຶ່ງມີ 20 ຖ້ຽວກໍອ່ານຊ້ຳ. cache ສັ້ນໆ ຕັດ DB round-trip ອອກ
// ໂດຍທີ່ຄົນແກ້ຕາຕະລາງແລ້ວຍັງເຫັນຜົນພາຍໃນ {TTL}s.
const __tmsPackDimList_TTL_MS = 30_000;

async function listPackDims() {
  const now = Date.now();
  const hit = packCache.__tmsPackDimList;
  if (hit && now - hit.at < __tmsPackDimList_TTL_MS) return hit.rows;
  const rows = await listPackDimsUncached();
  packCache.__tmsPackDimList = { at: now, rows };
  return rows;
}

/** ລ້າງ cache ຫຼັງແກ້ຕາຕະລາງ ເພື່ອໃຫ້ເຫັນຜົນທັນທີ */
function invalidatePackDimsCache() {
  packCache.__tmsPackDimList = null;
}

async function upsertPackDim(session, input) {
  await ensurePackDimSchema();
  const family = String(input?.family ?? "").trim();
  if (!family) throw new Error("family is required");

  const sizeKey = input?.size_key ? String(input.size_key).trim() : null;
  if (sizeKey && !/^(in|mm):\d+(\.\d+)?$/.test(sizeKey)) {
    throw new Error("size_key must look like in:1.25 or mm:25");
  }

  const dims = ["width_cm", "length_cm", "height_cm"].map((key) => {
    const n = Number(input?.[key]);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be > 0`);
    return n;
  });

  const packQty = Number(input?.pack_qty);
  if (!Number.isFinite(packQty) || packQty <= 0) {
    throw new Error("pack_qty must be > 0");
  }
  const weightKg =
    input?.weight_kg === null || input?.weight_kg === undefined || input?.weight_kg === ""
      ? null
      : Number(input.weight_kg);
  if (weightKg !== null && (!Number.isFinite(weightKg) || weightKg < 0)) {
    throw new Error("weight_kg must be >= 0");
  }

  await pool.query(
    `INSERT INTO public.odg_tms_pack_dim
       (family, size_key, pack_unit, pack_qty, width_cm, length_cm, height_cm,
        weight_kg, note, measured_item_code, source, brand, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, LOCALTIMESTAMP(0))
     ON CONFLICT (family, COALESCE(size_key, '*')) DO UPDATE
       SET pack_unit = EXCLUDED.pack_unit,
           pack_qty = EXCLUDED.pack_qty,
           width_cm = EXCLUDED.width_cm,
           length_cm = EXCLUDED.length_cm,
           height_cm = EXCLUDED.height_cm,
           weight_kg = EXCLUDED.weight_kg,
           note = EXCLUDED.note,
           measured_item_code = EXCLUDED.measured_item_code,
           source = EXCLUDED.source,
           brand = EXCLUDED.brand,
           updated_by = EXCLUDED.updated_by,
           updated_at = LOCALTIMESTAMP(0)`,
    [
      family,
      sizeKey,
      input?.pack_unit ? String(input.pack_unit).trim() : null,
      packQty,
      dims[0],
      dims[1],
      dims[2],
      weightKg,
      input?.note ? String(input.note).trim() : null,
      input?.measured_item_code ? String(input.measured_item_code).trim() : null,
      input?.source === "factory" ? "factory" : "measured",
      input?.brand ? String(input.brand).trim() : null,
      session?.usercode ?? null,
    ]
  );
  invalidatePackDimsCache();
  return { success: true };
}

async function deletePackDim(roworder) {
  await ensurePackDimSchema();
  const id = Number(roworder);
  if (!Number.isFinite(id)) throw new Error("roworder is required");
  await pool.query(`DELETE FROM public.odg_tms_pack_dim WHERE roworder = $1`, [id]);
  invalidatePackDimsCache();
  return { success: true };
}

/**
 * ລາຍການທີ່ບໍ່ແມ່ນທໍ່ ແລະ ຍັງບໍ່ມີຂະໜາດຢູ່ໃນ master data ເກົ່າ ພ້ອມຈຳນວນແຖວ.
 * ຊັ້ນ lib ໄປແກະຊື່ + ຈັບຄູ່ກັບຫີບທີ່ວັດແລ້ວຕໍ່.
 */
async function getPackItemStats({ days = 90 } = {}) {
  await ensurePackDimSchema();
  return query(
    `SELECT i.item_code, MAX(i.item_name) AS item_name, MAX(i.unit_code) AS unit_code,
            COUNT(*)::int AS lines
       FROM public.odg_tms_detail_item i
      WHERE i.create_date_time_now >= LOCALTIMESTAMP - ($1 || ' days')::interval
        AND i.item_name NOT LIKE 'ທໍ່%'
        AND NOT EXISTS (SELECT 1 FROM public.odg_item_size z WHERE z.ic_code = i.item_code)
        AND NOT EXISTS (
          SELECT 1 FROM public.odg_wms_product_dimension z WHERE z.ic_code = i.item_code
        )
      GROUP BY i.item_code`,
    [String(days)]
  );
}

module.exports = {
  ensurePackDimSchema,
  listPackDims,
  upsertPackDim,
  deletePackDim,
  getPackItemStats,
};
