// ຈຸດສົ່ງຫຼ້າສຸດຂອງແຕ່ລະລູກຄ້າ — ພິກັດຈິງທີ່ຄົນຂັບກົດ "ສຳເລັດ" ຢູ່ໜ້າຮ້ານ.
//
// ເປັນຫຍັງຕ້ອງມີ: ບິນເປີດໃໝ່ບໍ່ມີພິກັດຈຸດສົ່ງ ຈຶ່ງຕ້ອງປັກໝຸດເອງທຸກເທື່ອ ທັງໆທີ່
// ລູກຄ້າຄົນນັ້ນເຄີຍສົ່ງມາແລ້ວຫຼາຍຮອບ. ວັດຈາກຖານຂໍ້ມູນຈິງ (2026-07-31):
// ບິນທີ່ລໍຈັດຖ້ຽວ 15,919 ໃບ ບໍ່ມີໃບໃດປັກໝຸດເອງເລີຍ ແຕ່ 13,080 ໃບ (82%)
// ມີຈຸດສົ່ງຄັ້ງກ່ອນໃຫ້ໃຊ້ໄດ້ທັນທີ.
//
// ເປັນຫຍັງເປັນຕາຕະລາງ ບໍ່ແມ່ນ query ຫາຄືນທຸກເທື່ອ: ການ scan odg_tms_detail
// (73k ແຖວ) ຫາຈຸດຫຼ້າສຸດຂອງ 3,369 ລູກຄ້າ ໃຊ້ 1.3 ວິນາທີ — ໜັກເກີນໄປສຳລັບ
// ໜ້າລໍຈັດຖ້ຽວທີ່ໂຫຼດເລື້ອຍ. ຕາຕະລາງນີ້ອັບເດດຕອນປິດບິນ ຈຶ່ງອ່ານດ້ວຍ PK.
//
// ໝາຍເຫດການວາງຊັ້ນ: CommonJS ແລະ require ແຕ່ ../lib/db ຈຶ່ງ test/script ໃຊ້ໄດ້.
const { query } = require("../lib/db");

// ປ່ຽນຄ່ານີ້ເມື່ອແກ້ໂຄງສ້າງ — ບໍ່ດັ່ງນັ້ນ globalThis ຈະຈື່ວ່າ "ສ້າງແລ້ວ"
// ຂ້າມ HMR ແລ້ວ ALTER ໃໝ່ຈະບໍ່ເຄີຍແລ່ນ
const CUSTOMER_POINT_SCHEMA_VERSION = "v1";
const cache = globalThis;

// ເງື່ອນໄຂ "ພິກັດຈຸດສົ່ງທີ່ເຊື່ອໄດ້" — ໃຊ້ຮ່ວມກັນລະຫວ່າງ backfill ແລະ ການອ່ານ
//  - status = 1 (ສົ່ງສຳເລັດ) — ບິນຍົກເລີກ/ຄືນສາງ ພິກັດບໍ່ແມ່ນຈຸດສົ່ງຂອງລູກຄ້າ
//  - ບໍ່ມີ forward_transport_code — ອັນນັ້ນຄື "ສົ່ງສາຂາ" ພິກັດເປັນສາງ ບໍ່ແມ່ນຮ້ານ
//  - lat_end/lng_end = ພິກັດຕອນປິດບິນຢູ່ໜ້າຮ້ານ (ບໍ່ແມ່ນ lat/lng ຕອນ check-in)
const DELIVERED_POINT_WHERE = `
  d.status = 1
  AND COALESCE(NULLIF(TRIM(d.cust_code), ''), '') <> ''
  AND COALESCE(NULLIF(TRIM(d.lat_end), ''), '') <> ''
  AND COALESCE(NULLIF(TRIM(d.lng_end), ''), '') <> ''
  AND TRIM(d.lat_end) NOT IN ('0', '0.0', '0.000000')
  AND COALESCE(NULLIF(TRIM(d.forward_transport_code), ''), '') = ''`;

async function ensureSchemaInternal() {
  await query(`
    CREATE TABLE IF NOT EXISTS public.odg_tms_customer_point (
      cust_code    varchar(50) PRIMARY KEY,
      lat          varchar(32) NOT NULL,
      lng          varchar(32) NOT NULL,
      bill_no      varchar(50),
      delivered_at timestamp,
      updated_at   timestamp NOT NULL DEFAULT LOCALTIMESTAMP(0)
    )`);

  // ຕື່ມຄັ້ງດຽວຕອນຕາຕະລາງຫວ່າງ — ຫຼັງຈາກນັ້ນ upsert ຕອນປິດບິນດູແລເອງ
  const [{ n }] = await query(
    `SELECT count(*)::int AS n FROM public.odg_tms_customer_point`
  );
  if (n === 0) {
    const started = Date.now();
    await query(`
      INSERT INTO public.odg_tms_customer_point (cust_code, lat, lng, bill_no, delivered_at)
      SELECT DISTINCT ON (d.cust_code)
             TRIM(d.cust_code), TRIM(d.lat_end), TRIM(d.lng_end), d.bill_no,
             COALESCE(d.sent_end, d.create_date_time_now)
        FROM public.odg_tms_detail d
       WHERE ${DELIVERED_POINT_WHERE}
       ORDER BY d.cust_code, COALESCE(d.sent_end, d.create_date_time_now) DESC
      ON CONFLICT (cust_code) DO NOTHING`);
    const [{ filled }] = await query(
      `SELECT count(*)::int AS filled FROM public.odg_tms_customer_point`
    );
    console.log(
      `[customer-point] backfill ຈຸດສົ່ງລູກຄ້າ ${filled} ລາຍ (${Date.now() - started}ms)`
    );
  }
}

async function ensureCustomerPointSchema() {
  const key = `__tmsCustomerPointSchema_${CUSTOMER_POINT_SCHEMA_VERSION}`;
  if (!cache[key]) {
    cache[key] = ensureSchemaInternal().catch((err) => {
      cache[key] = null;
      throw err;
    });
  }
  await cache[key];
}

/**
 * ບັນທຶກຈຸດສົ່ງຫຼ້າສຸດ — ຮຽກຕອນປິດບິນສຳເລັດ.
 *
 * ທັບຂອງເກົ່າສະເໝີ (ບໍ່ແມ່ນ "ຂຽນຄັ້ງທຳອິດຊະນະ" ຄື ar_customer_detail):
 * ລູກຄ້າຍ້າຍຮ້ານ ຫຼື ຄັ້ງກ່ອນຄົນຂັບກົດປິດຜິດບ່ອນ ຄັ້ງໃໝ່ຕ້ອງແກ້ໄດ້.
 * ຮັບ client ເຂົ້າມາໄດ້ ເພື່ອໃຫ້ຢູ່ transaction ດຽວກັບການປິດບິນ.
 */
async function saveCustomerPoint(
  { custCode, lat, lng, billNo, deliveredAt = null },
  client = null
) {
  const code = String(custCode ?? "").trim();
  const latText = String(lat ?? "").trim();
  const lngText = String(lng ?? "").trim();
  if (!code || !latText || !lngText) return;
  if (["0", "0.0", "0.000000"].includes(latText)) return;

  await ensureCustomerPointSchema();
  const sql = `
    INSERT INTO public.odg_tms_customer_point (cust_code, lat, lng, bill_no, delivered_at, updated_at)
    VALUES ($1, $2, $3, $4, COALESCE($5::timestamp, LOCALTIMESTAMP(0)), LOCALTIMESTAMP(0))
    ON CONFLICT (cust_code) DO UPDATE
    SET lat = EXCLUDED.lat,
        lng = EXCLUDED.lng,
        bill_no = EXCLUDED.bill_no,
        delivered_at = EXCLUDED.delivered_at,
        updated_at = EXCLUDED.updated_at`;
  const params = [code, latText, lngText, String(billNo ?? "").trim() || null, deliveredAt];
  if (client) await client.query(sql, params);
  else await query(sql, params);
}

/**
 * ຂຽນພິກັດຮ້ານລົງທະບຽນລູກຄ້າ public.ar_customer_detail.
 *
 * ມີ 2 ໂໝດ ຕາມວ່າພິກັດມາຈາກໃສ:
 *  - overwrite: true  — ທັບຂອງເກົ່າສະເໝີ. ໃຊ້ຕອນ "ປິດບິນສຳເລັດ" ເທົ່ານັ້ນ
 *    ເພາະ lat_end/lng_end ຄືພິກັດທີ່ຄົນຂັບຢືນຢູ່ໜ້າຮ້ານຈິງ. ລູກຄ້າຍ້າຍຮ້ານ ຫຼື
 *    ຄັ້ງກ່ອນປັກຜິດ ຄັ້ງໃໝ່ຕ້ອງແກ້ໄດ້ — ກົດດຽວກັບ odg_tms_customer_point.
 *  - overwrite: false — ຕື່ມສະເພາະທີ່ຍັງວ່າງ. ໃຊ້ຕອນ check-in / ຮັບຈາກລານ
 *    ລູກຄ້າ ເພາະຄົນຂັບອາດກົດແຕ່ໄກຮ້ານ ຈຶ່ງບໍ່ຄວນທັບພິກັດທີ່ດີກວ່າ.
 *
 * ວັດຈາກຖານຂໍ້ມູນຈິງ (2026-08-01): latitude/longitude ເປັນ numeric DEFAULT 0.0
 * (ບໍ່ແມ່ນ NULL) ຈຶ່ງນັບ 0 ວ່າ "ວ່າງ"; ar_code ເປັນ PK ຈຶ່ງ ON CONFLICT ໄດ້.
 *
 * ຮັບ client ໄດ້ ເພື່ອຢູ່ transaction ດຽວກັບການປິດບິນ. ໃຊ້ SAVEPOINT ເພາະການ
 * ຂຽນພິກັດເປັນເລື່ອງເສີມ — ຖ້າລົ້ມ ຕ້ອງບໍ່ພາໃຫ້ການ check-in/ປິດບິນລົ້ມນຳ.
 */
async function saveCustomerMasterPoint(
  { custCode, lat, lng, overwrite = false },
  client = null
) {
  const code = String(custCode ?? "").trim();
  const latNum = Number(String(lat ?? "").trim());
  const lngNum = Number(String(lng ?? "").trim());
  if (!code || !Number.isFinite(latNum) || !Number.isFinite(lngNum)) return;
  if (latNum === 0 || lngNum === 0) return;

  const sql = `
    INSERT INTO public.ar_customer_detail (ar_code, latitude, longitude)
    VALUES ($1, $2, $3)
    ON CONFLICT (ar_code) DO UPDATE
      SET latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude
    ${
      overwrite
        ? ""
        : `WHERE COALESCE(public.ar_customer_detail.latitude, 0) = 0
         OR COALESCE(public.ar_customer_detail.longitude, 0) = 0`
    }`;
  const params = [code, latNum, lngNum];

  if (!client) {
    await query(sql, params).catch((err) => {
      console.warn("[customer-point] ຂຽນພິກັດລົງ ar_customer_detail ບໍ່ໄດ້:", err?.message);
    });
    return;
  }

  await client.query("SAVEPOINT save_cust_master_point");
  try {
    await client.query(sql, params);
    await client.query("RELEASE SAVEPOINT save_cust_master_point");
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT save_cust_master_point");
    console.warn("[customer-point] ຂຽນພິກັດລົງ ar_customer_detail ບໍ່ໄດ້:", err?.message);
  }
}

/**
 * ຈຸດສົ່ງຫຼ້າສຸດຂອງລູກຄ້າຫຼາຍລາຍພ້ອມກັນ (ອ່ານດ້ວຍ PK ຈຶ່ງໄວ).
 *
 * @param {string[]} custCodes
 * @returns {Promise<Map<string, {lat: string, lng: string, bill_no: string, at: string, at_display: string}>>}
 */
async function getLastDeliveredPoints(custCodes) {
  const codes = Array.from(
    new Set((custCodes ?? []).map((c) => String(c ?? "").trim()).filter(Boolean))
  );
  if (codes.length === 0) return new Map();
  await ensureCustomerPointSchema();

  const rows = await query(
    `SELECT cust_code, lat, lng, COALESCE(bill_no, '') AS bill_no,
            to_char(delivered_at, 'YYYY-MM-DD') AS at,
            to_char(delivered_at, 'DD-MM-YYYY') AS at_display
       FROM public.odg_tms_customer_point
      WHERE cust_code = ANY($1::varchar[])`,
    [codes]
  );

  const map = new Map();
  for (const row of rows) {
    const code = String(row.cust_code ?? "").trim();
    if (!code) continue;
    map.set(code, {
      lat: String(row.lat ?? ""),
      lng: String(row.lng ?? ""),
      bill_no: String(row.bill_no ?? ""),
      at: String(row.at ?? ""),
      at_display: String(row.at_display ?? ""),
    });
  }
  return map;
}

/**
 * ຕື່ມຈຸດສົ່ງໃຫ້ແຖວບິນ.
 *
 * ລຳດັບຄວາມສຳຄັນ: ໝຸດທີ່ຄົນປັກເອງ → ຈຸດສົ່ງຄັ້ງກ່ອນ → ພິກັດໃນທະບຽນລູກຄ້າ.
 * ໝຸດທີ່ຄົນປັກເອງຕ້ອງຊະນະສະເໝີ — ຄົນຈັດຖ້ຽວອາດແກ້ຍ້ອນລູກຄ້າຍ້າຍຮ້ານ.
 *
 * ບໍ່ຂຽນລົງ odg_tms_pending_bill — ເປັນຄ່າຕັ້ງຕົ້ນທີ່ຄິດຕອນອ່ານ ຈຶ່ງບໍ່ທັບ
 * ການປັກໝຸດຂອງຄົນ ແລະ ຕິດຕາມໄດ້ວ່າຄ່າມາຈາກໃສ (location_source).
 */
function attachDeliveryPoint(row, lastPoint) {
  const plannedLat = String(row?.planned_lat ?? "").trim();
  const plannedLng = String(row?.planned_lng ?? "").trim();
  const custLat = String(row?.cust_lat ?? "").trim();
  const custLng = String(row?.cust_lng ?? "").trim();
  const lastLat = String(lastPoint?.lat ?? "").trim();
  const lastLng = String(lastPoint?.lng ?? "").trim();

  const out = {
    ...row,
    last_lat: lastLat,
    last_lng: lastLng,
    last_delivery_bill: lastPoint?.bill_no ?? "",
    last_delivery_at: lastPoint?.at ?? "",
    last_delivery_at_display: lastPoint?.at_display ?? "",
  };

  if (plannedLat && plannedLng) {
    out.location_source = "planned";
    return out;
  }
  if (lastLat && lastLng) {
    out.planned_lat = lastLat;
    out.planned_lng = lastLng;
    out.location_source = "last_delivery";
    return out;
  }
  // ພິກັດໃນທະບຽນລູກຄ້າສ່ວນຫຼາຍເປັນ 0 ຫຼື ບໍ່ມີ — ນັບເປັນ "ມີ" ສະເພາະທີ່ໃຊ້ໄດ້ຈິງ
  const usableCust =
    custLat && custLng && !["0", "0.0", "0.000000"].includes(custLat);
  out.location_source = usableCust ? "customer" : "";
  return out;
}

module.exports = {
  CUSTOMER_POINT_SCHEMA_VERSION,
  ensureCustomerPointSchema,
  saveCustomerPoint,
  saveCustomerMasterPoint,
  getLastDeliveredPoints,
  attachDeliveryPoint,
};
