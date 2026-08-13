const { query, queryOne } = require("../lib/db");

/**
 * ແປງພິກັດເປັນຊື່ບ່ອນ (reverse geocode).
 *
 * ຜູ້ໃຫ້ບໍລິການ tracker ສົ່ງຊ່ອງ `address` ມາຫວ່າງເປົ່າ ຈຶ່ງຕ້ອງແປງເອງ.
 *
 * ເກັບຜົນໄວ້ໃນຖານຂໍ້ມູນ ໂດຍປັດພິກັດເປັນຕາໜ່າງ ~110 ແມັດ — ລົດຈອດຢູ່ບ່ອນ
 * ດຽວກັນຈະໃຊ້ຜົນເກົ່າ ບໍ່ຕ້ອງຍິງໄປຫາບໍລິການພາຍນອກຊ້ຳ. ຖ້າບໍ່ເຮັດແບບນີ້
 * ລົດ 14 ຄັນ × ທຸກ 20 ວິນາທີ = ຫຼາຍພັນຄັ້ງຕໍ່ມື້ ເຊິ່ງຈະຖືກ block.
 */

// 3 ຕຳແໜ່ງທົດນິຍົມ ≈ 110 ແມັດ — ພໍດີກັບຄວາມລະອຽດຂອງຊື່ບ້ານ/ຖະໜົນ
const GRID_DECIMALS = 3;

// Nominatim ຂໍໃຫ້ຍິງບໍ່ເກີນ 1 ຄັ້ງ/ວິນາທີ ແລະ ຕ້ອງບອກວ່າໃຜເອີ້ນ
const DEFAULT_ENDPOINT = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "ODG-TMS/1.0 (logistics dashboard)";
const TIMEOUT_MS = 8_000;

let schemaReady = null;

async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = query(`
    CREATE TABLE IF NOT EXISTS public.odg_tms_geocode_cache (
      grid_key varchar PRIMARY KEY,
      lat numeric,
      lng numeric,
      place_name varchar,
      raw_name varchar,
      looked_up_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  return schemaReady;
}

function gridKey(lat, lng) {
  return `${Number(lat).toFixed(GRID_DECIMALS)},${Number(lng).toFixed(GRID_DECIMALS)}`;
}

/**
 * ຫຍໍ້ທີ່ຢູ່ຍາວໆໃຫ້ເຫຼືອສ່ວນທີ່ຄົນໃຊ້ຈິງ.
 *
 * Nominatim ຄືນມາທັງແຖວ "ຖະໜົນ, ບ້ານ, ເມືອງ, ແຂວງ, ປະເທດ, ລະຫັດໄປສະນີ"
 * ເຊິ່ງຍາວເກີນໃສ່ບັດຖ້ຽວ. ເອົາແຕ່ ບ້ານ · ເມືອງ ພໍ.
 */
function shortPlace(address) {
  if (!address) return "";
  const parts = [
    address.village ||
      address.hamlet ||
      address.suburb ||
      address.neighbourhood ||
      address.town ||
      address.city_district,
    address.city || address.county || address.state_district,
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  // ບໍ່ເອົາຊື່ຊ້ຳ ("ໄຊທານີ, ໄຊທານີ")
  const unique = [...new Set(parts)];
  return unique.join(" · ");
}

/**
 * ຊື່ບ່ອນຂອງພິກັດນີ້. ຄືນ "" ເມື່ອຫາບໍ່ໄດ້ — ຜູ້ເອີ້ນຄວນຖືວ່າບໍ່ມີຊື່
 * ບໍ່ແມ່ນລົ້ມເຫຼວ.
 */
async function reverseGeocode(lat, lng) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return "";
  await ensureSchema();
  const key = gridKey(lat, lng);

  const cached = await queryOne(
    `SELECT COALESCE(place_name, '') AS place_name
     FROM public.odg_tms_geocode_cache WHERE grid_key = $1`,
    [key]
  );
  if (cached) return cached.place_name;

  const endpoint = process.env.GEOCODE_URL || DEFAULT_ENDPOINT;
  const url = `${endpoint}?format=jsonv2&zoom=14&accept-language=lo&lat=${encodeURIComponent(
    lat
  )}&lon=${encodeURIComponent(lng)}`;

  let placeName = "";
  let rawName = "";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (response.ok) {
      const body = await response.json();
      rawName = String(body?.display_name ?? "");
      placeName = shortPlace(body?.address) || rawName.split(",").slice(0, 2).join(" ·");
    }
  } catch (error) {
    // ບໍ່ໂຍນຕໍ່: ຊື່ບ່ອນເປັນຂໍ້ມູນປະກອບ ບໍ່ຄວນລົ້ມການເກັບ GPS
    console.error("[geocode] lookup failed", key, error?.message ?? error);
    return "";
  }

  // ຈື່ໄວ້ເຖິງແມ່ນຫາຊື່ບໍ່ໄດ້ ເພື່ອບໍ່ໃຫ້ຍິງຊ້ຳບ່ອນເກົ່າທຸກຮອບ
  await query(
    `INSERT INTO public.odg_tms_geocode_cache (grid_key, lat, lng, place_name, raw_name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (grid_key) DO NOTHING`,
    [key, Number(lat), Number(lng), placeName, rawName]
  );
  return placeName;
}

module.exports = { ensureSchema, reverseGeocode, gridKey };
