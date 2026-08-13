// Lao GPS Tracker — Open API v1 client (https://gps.laogpstracker.com).
//
// ເປັນຫຍັງຕ້ອງມີ: ຂອງເກົ່າ (apis.thaigpstracker.co.th) ຕ້ອງຍິງ 1 request ຕໍ່ 1 IMEI
// ຈຶ່ງ 23 ຄັນ = 23 request ຕໍ່ຮອບ ແລ້ວຖືກ HTTP 429 ເປັນປະຈຳ. Open API ມີ
// GET /positions ທີ່ຄືນຕຳແໜ່ງລ່າສຸດຂອງ "ທຸກຄັນ" ໃນ request ດຽວ.
//
// ອ່ານຢ່າງດຽວ (read-only) — ບໍ່ມີ endpoint ໃດຂຽນຂໍ້ມູນກັບໄປ provider.
//
// ໝາຍເຫດການວາງຊັ້ນ: ໄຟລ໌ນີ້ເປັນ CommonJS ແລະ require ແຕ່ built-in fetch ຈຶ່ງ
// vitest ໂຫຼດໄດ້ (ຢ່າ require ໄຟລ໌ .ts ເຂົ້າມາ).
"use strict";

const DEFAULT_BASE_URL = "https://gps.laogpstracker.com/api2/public/openapi/v1";

// ຂໍ token ອາຍຸ 12 ຊົ່ວໂມງ ແລະ ຕໍ່ໃໝ່ກ່ອນໝົດ 60 ວິ
const TOKEN_RENEW_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
// login ຜິດແລ້ວ ຢຸດຍາວ 15 ນາທີ — provider ລັອກທີ່ 10 ເທື່ອ/15 ນາທີ
// ຖ້າ poll ທຸກ 30 ວິ ແລ້ວ login ຜິດທຸກຮອບ ຈະລັອກບັນຊີພາຍໃນ 5 ນາທີ
const LOGIN_FAILURE_COOLDOWN_MS = 15 * 60_000;

const cache = globalThis;

function getConfig() {
  return {
    baseUrl: (process.env.GPS_OPENAPI_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    // ⚠️ ຢ່າຕົກມາໃຊ້ GPS_TRACKER_USER/PASS: ນັ້ນເປັນບັນຊີຂອງ thaigpstracker
    // ເຊິ່ງ Lao GPS ປະຕິເສດ (ທົດສອບແລ້ວ ໄດ້ 401 INVALID_CREDENTIALS) ແລະ
    // login ຜິດ 10 ເທື່ອ/15 ນາທີ ຈະຖືກລັອກທັງບັນຊີ (429 TOO_MANY_ATTEMPTS)
    user: process.env.GPS_OPENAPI_USER || "",
    pass: process.env.GPS_OPENAPI_PASS || "",
  };
}

/** ຕັ້ງຄ່າຄົບບໍ — ຖ້າບໍ່ຄົບ ຜູ້ເອີ້ນຄວນຕົກກັບໄປໃຊ້ provider ເກົ່າ */
function isOpenApiConfigured() {
  const cfg = getConfig();
  return Boolean(cfg.user && cfg.pass);
}

function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

/** ຂໍ້ຜິດພາດຂອງ provider ພ້ອມ code ຕາມເອກະສານ (TOKEN_EXPIRED, VEHICLE_NOT_FOUND ...) */
function providerError(status, code, message) {
  const err = new Error(`GPS Open API ${status} ${code}: ${message}`);
  err.status = status;
  err.code = code;
  return err;
}

async function login() {
  const cfg = getConfig();
  if (!cfg.user || !cfg.pass) {
    throw providerError(0, "NOT_CONFIGURED", "GPS_OPENAPI_USER/PASS ຍັງບໍ່ໄດ້ຕັ້ງ");
  }
  const res = await fetchWithTimeout(`${cfg.baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: cfg.user, password: cfg.pass }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ຄຳຕອບບໍ່ແມ່ນ JSON */
  }
  if (!res.ok || !json?.success || !json?.data?.token) {
    const code = json?.error?.code ?? `HTTP_${res.status}`;
    const message = json?.error?.message ?? "login failed";
    // 429 TOO_MANY_ATTEMPTS: 10 ເທື່ອ/15 ນາທີ ຕໍ່ username+IP — ຢ່າ retry ທັນທີ
    throw providerError(res.status, code, message);
  }
  const expiresAt = Date.parse(json.data.expires_at ?? "");
  return {
    token: json.data.token,
    expiresAtMs: Number.isFinite(expiresAt)
      ? expiresAt
      : Date.now() + (Number(json.data.expires_in) || 43200) * 1000,
  };
}

/**
 * token ທີ່ຍັງບໍ່ໝົດອາຍຸ — login ພ້ອມກັນຫຼາຍຄຳຂໍໃຫ້ລວມເປັນ request ດຽວ
 * (single-flight) ບໍ່ດັ່ງນັ້ນຮອບ poll ດຽວຈະຍິງ login ຫຼາຍເທື່ອຈົນຕິດ throttle.
 */
async function getToken({ force = false } = {}) {
  const blockedUntil = cache.__tmsGpsOpenApiLoginBlockedUntil ?? 0;
  if (Date.now() < blockedUntil) {
    const err = cache.__tmsGpsOpenApiLoginError;
    throw providerError(
      err?.status ?? 401,
      err?.code ?? "LOGIN_BLOCKED",
      `login ລົ້ມກ່ອນໜ້ານີ້ — ຢຸດລອງອີກ ${Math.ceil((blockedUntil - Date.now()) / 1000)}s`
    );
  }
  const current = cache.__tmsGpsOpenApiToken;
  if (
    !force &&
    current?.token &&
    current.expiresAtMs - TOKEN_RENEW_MARGIN_MS > Date.now()
  ) {
    return current.token;
  }
  if (!force && cache.__tmsGpsOpenApiLoginPromise) {
    return cache.__tmsGpsOpenApiLoginPromise;
  }
  const promise = login()
    .then((tok) => {
      cache.__tmsGpsOpenApiToken = tok;
      cache.__tmsGpsOpenApiLoginPromise = null;
      return tok.token;
    })
    .catch((err) => {
      cache.__tmsGpsOpenApiLoginPromise = null;
      // ຜິດຍ້ອນບັນຊີ (ບໍ່ແມ່ນເນັດ) ຢ່າລອງຊ້ຳ — ຈະຍິ່ງເລັ່ງໃຫ້ຖືກລັອກ
      if (["INVALID_CREDENTIALS", "ACCOUNT_SUSPENDED", "TOO_MANY_ATTEMPTS"].includes(err?.code)) {
        cache.__tmsGpsOpenApiLoginBlockedUntil = Date.now() + LOGIN_FAILURE_COOLDOWN_MS;
        cache.__tmsGpsOpenApiLoginError = { status: err?.status, code: err?.code };
        console.warn(
          `[gps-openapi] login ຖືກປະຕິເສດ (${err?.code}) — ຢຸດລອງ 15 ນາທີ ແລ້ວໃຊ້ provider ເກົ່າແທນ`
        );
      }
      throw err;
    });
  cache.__tmsGpsOpenApiLoginPromise = promise;
  return promise;
}

/** ລືມ token ທີ່ cache ໄວ້ — ໃຊ້ຕອນ test ຫຼື ຕອນປ່ຽນ credential */
function resetOpenApiToken() {
  cache.__tmsGpsOpenApiToken = null;
  cache.__tmsGpsOpenApiLoginPromise = null;
  cache.__tmsGpsOpenApiLoginBlockedUntil = 0;
  cache.__tmsGpsOpenApiLoginError = null;
}

/**
 * ຍິງ GET ຕາມ envelope ມາດຕະຖານ { success, data, error, meta }.
 * token ໝົດອາຍຸ (401 TOKEN_EXPIRED) ໃຫ້ login ໃໝ່ແລ້ວລອງອີກເທື່ອດຽວ.
 */
async function apiGet(path, params = {}, { retryOnExpired = true } = {}) {
  const cfg = getConfig();
  const url = new URL(`${cfg.baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const token = await getToken();
  const res = await fetchWithTimeout(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ຄຳຕອບບໍ່ແມ່ນ JSON */
  }

  if (res.status === 401 && retryOnExpired) {
    resetOpenApiToken();
    return apiGet(path, params, { retryOnExpired: false });
  }
  // 202 = ກຳລັງຄິດຢູ່ເບື້ອງຫຼັງ (driver-behaviour ຊ່ວງກວ້າງ) — ບອກຜູ້ເອີ້ນໃຫ້ຖາມຄືນ
  if (res.status === 202) {
    return { pending: true, meta: json?.meta ?? null, data: null };
  }
  if (!res.ok || !json?.success) {
    const err = providerError(
      res.status,
      json?.error?.code ?? `HTTP_${res.status}`,
      json?.error?.message ?? "request failed"
    );
    if (res.status === 429) {
      err.retryAfterMs = Number(res.headers.get("retry-after") || 0) * 1000 || null;
    }
    throw err;
  }
  return { pending: false, data: json.data, meta: json.meta ?? null };
}

// ==================== ຕົວແປງຄ່າ (pure — ມີ test) ====================

/**
 * UTC ISO ຈາກ provider → "YYYY-MM-DD HH:MM:SS" ຕາມເວລາລາວ (Asia/Vientiane).
 *
 * ຈຳເປັນ: ຖານຂໍ້ມູນ ແລະ ໜ້າຈໍທັງໝົດຂອງລະບົບໃຊ້ເວລາທ້ອງຖິ່ນ +07 ຢູ່ແລ້ວ
 * ຖ້າເກັບ UTC ດິບເຂົ້າໄປ ເວລາຈະຜິດໄປ 7 ຊົ່ວໂມງ ໂດຍບໍ່ມີໃຜເຫັນ.
 */
function utcIsoToLaoStamp(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return raw;
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Vientiane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
  return parts.replace("T", " ");
}

function str(value) {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * position object ຂອງ Open API → ຮູບແບບແຖວທີ່ລະບົບນີ້ໃຊ້ຢູ່ແລ້ວ
 * (ຄືກັນກັບທີ່ fetchGpsForImei ຂອງ provider ເກົ່າຄືນ) ຈຶ່ງບໍ່ຕ້ອງແກ້ UI/DB.
 */
function mapPositionRow(pos, { carCode = "", carName = "", syncedAt = "" } = {}) {
  // ⚠️ Number(null) = 0 — ຖ້າບໍ່ກັນໄວ້ ລົດທີ່ບໍ່ເຄີຍມີພິກັດຈະຖືກແຕ້ມທີ່ 0,0
  // ກາງມະຫາສະໝຸດແອດແລນຕິກ
  const num = (v) => (v === null || v === undefined || v === "" ? Number.NaN : Number(v));
  const lat = num(pos?.latitude);
  const lng = num(pos?.longitude);
  const hasFix = Number.isFinite(lat) && Number.isFinite(lng);
  return {
    imei: str(pos?.imei).trim(),
    lat: hasFix ? String(lat) : "",
    lng: hasFix ? String(lng) : "",
    speed: str(pos?.speed_kmh),
    heading: str(pos?.direction),
    recorded_at: utcIsoToLaoStamp(pos?.time),
    address: str(pos?.address),
    // engine_on ເປັນ boolean ຢູ່ API ແຕ່ລະບົບເກົ່າເກັບເປັນ "1"/"0"
    engine_state: pos?.engine_on === true ? "1" : pos?.engine_on === false ? "0" : "",
    state_detail: str(pos?.source),
    mileage: str(pos?.mileage_km),
    sat: "",
    gsm: "",
    hdop: "",
    // ຂອງເກົ່າເອີ້ນຊ່ອງນີ້ວ່າ oil = ລະດັບນ້ຳມັນເປັນ %
    oil: str(pos?.fuel_percent),
    ad_data: "",
    input_state: "",
    car_code: carCode,
    car_name: carName,
    provider_synced_at: syncedAt,
  };
}

function laoNowStamp() {
  return utcIsoToLaoStamp(new Date().toISOString());
}

// ==================== Endpoints ====================

/**
 * ຕຳແໜ່ງລ່າສຸດຂອງທຸກຄັນ — 1 request ຕໍ່ຮອບ (ບໍ່ແມ່ນ 1 ຕໍ່ຄັນ).
 * ຄືນເປັນ Map ໂດຍໃຊ້ imei ເປັນກະແຈ ເພື່ອໃຫ້ຜູ້ເອີ້ນຈັບຄູ່ກັບຕາຕະລາງລົດເອງ.
 */
async function fetchAllPositions({ activeOnly = false } = {}) {
  const { data } = await apiGet("/positions", { active_only: activeOnly });
  const syncedAt = laoNowStamp();
  const byImei = new Map();
  for (const pos of Array.isArray(data) ? data : []) {
    const imei = str(pos?.imei).trim();
    if (!imei) continue;
    byImei.set(imei, mapPositionRow(pos, { syncedAt }));
  }
  return byImei;
}

/** ຕຳແໜ່ງລ່າສຸດຂອງຄັນດຽວ. {id} ຮັບທັງ vehicle_id ແລະ imei */
async function fetchPosition(vehicleIdOrImei) {
  const id = str(vehicleIdOrImei).trim();
  if (!id) return null;
  const { data } = await apiGet(`/vehicles/${encodeURIComponent(id)}/position`);
  return data ? mapPositionRow(data, { syncedAt: laoNowStamp() }) : null;
}

/** ລາຍການລົດໃນບັນຊີ — ໃຊ້ຈັບຄູ່ imei ແລະ ອ່ານ overspeed_kmh / fuel_capability */
async function fetchVehicles({ activeOnly = false, search = "", limit = 2000 } = {}) {
  const { data } = await apiGet("/vehicles", {
    active_only: activeOnly,
    search,
    limit,
  });
  return Array.isArray(data) ? data : [];
}

/**
 * ນ້ຳມັນທີ່ໃຊ້ຂອງທຸກຄັນ — ໃຊ້ຕົວເລກ fuel_used_litre ຂອງ provider ໂດຍກົງ.
 * ⚠️ ຢ່າຄິດເອົາເອງຈາກ fuel_percent ດິບ: ເອກະສານ provider ວັດໃຫ້ເຫັນວ່າ
 * ການບວກສ່ວນຕ່າງດິບໄດ້ 53.95 L ທຽບກັບຄ່າຈິງ 3.90 L (ເກີນ 13.8 ເທົ່າ).
 * ຊ່ວງສູງສຸດ 7 ວັນ ສຳລັບທັງບັນຊີ.
 */
async function fetchFleetFuel({ from, to }) {
  const { data, meta } = await apiGet("/fuel", { from, to });
  return { rows: Array.isArray(data) ? data : [], totals: meta?.totals ?? null };
}

/** ນ້ຳມັນຂອງຄັນດຽວ ພ້ອມແຍກລາຍວັນ (ຊ່ວງສູງສຸດ 31 ວັນ) */
async function fetchVehicleFuel(vehicleIdOrImei, { from, to, daily = true }) {
  const id = str(vehicleIdOrImei).trim();
  if (!id) return null;
  const { data } = await apiGet(`/vehicles/${encodeURIComponent(id)}/fuel`, {
    from,
    to,
    daily,
  });
  return data ?? null;
}

/**
 * ເສັ້ນທາງລາຍຈຸດ + ສະຫຼຸບ + ນ້ຳມັນ ຂອງຄັນດຽວ.
 * ເກີນ 20000 ຈຸດ provider ຈະຕັດ ແລ້ວບອກ meta.next_from ໃຫ້ຖາມຕໍ່.
 */
async function fetchVehicleHistory(
  vehicleIdOrImei,
  { from, to, includePoints = true, limit = 20000 }
) {
  const id = str(vehicleIdOrImei).trim();
  if (!id) return null;
  const { data, meta } = await apiGet(`/vehicles/${encodeURIComponent(id)}/history`, {
    from,
    to,
    include_points: includePoints,
    limit,
  });
  return data ? { ...data, meta } : null;
}

/**
 * ຈຸດເສັ້ນທາງ 1 ວັນ ໃນຮູບແບບທີ່ gps-usage.js ໃຊ້ຢູ່ແລ້ວ
 * ({recordedAt, date, lat, lng, speed, heading}).
 *
 * ຂອງເກົ່າຕ້ອງແບ່ງໜ້າເອງ (page/limit) ແລະ ຍິງຫຼາຍຮອບຕໍ່ 1 ຄັນ/1 ວັນ.
 * Open API ໃຫ້ເຖິງ 20000 ຈຸດຕໍ່ຄຳຂໍ ແລະ ຖ້າເກີນຈະບອກ meta.next_from
 * ໃຫ້ຖາມຕໍ່ — ບໍ່ຕັດຖິ້ມງຽບໆ.
 */
function mapHistoryPoint(point) {
  const num = (v) => (v === null || v === undefined || v === "" ? Number.NaN : Number(v));
  const lat = num(point?.latitude);
  const lng = num(point?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const recordedAt = utcIsoToLaoStamp(point?.time);
  if (!recordedAt) return null;
  return {
    recordedAt,
    date: recordedAt.slice(0, 10),
    lat,
    lng,
    speed: Number(point?.speed_kmh) || 0,
    heading: Number(point?.direction) || 0,
  };
}

async function fetchHistoryPoints(vehicleIdOrImei, dayYmd, { maxRequests = 5 } = {}) {
  const id = str(vehicleIdOrImei).trim();
  const day = str(dayYmd).trim();
  if (!id || !day) return { points: [], raw: 0, truncated: false };

  const points = [];
  let raw = 0;
  let from = day;
  let truncated = false;
  for (let i = 0; i < maxRequests; i++) {
    const { data, meta } = await apiGet(`/vehicles/${encodeURIComponent(id)}/history`, {
      from,
      to: day,
      include_points: true,
      limit: 20000,
    });
    const rows = Array.isArray(data?.points) ? data.points : [];
    raw += rows.length;
    for (const row of rows) {
      const mapped = mapHistoryPoint(row);
      // ຮັກສາສະເພາະຈຸດຂອງມື້ທີ່ຂໍ — ຕອນຖາມຕໍ່ດ້ວຍ next_from ອາດຄາບກ່ຽວ
      if (mapped && mapped.date === day) points.push(mapped);
    }
    if (!meta?.truncated || !meta?.next_from) break;
    from = meta.next_from;
    truncated = true;
    if (i === maxRequests - 1) {
      console.warn(
        `[gps-openapi] history imei=${id} ${day} ຈຸດຫຼາຍເກີນ ${maxRequests} ຮອບ — ອາດບໍ່ຄົບ`
      );
    }
  }
  points.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  return { points, raw, truncated };
}

module.exports = {
  DEFAULT_BASE_URL,
  isOpenApiConfigured,
  getToken,
  resetOpenApiToken,
  apiGet,
  utcIsoToLaoStamp,
  mapPositionRow,
  fetchAllPositions,
  fetchPosition,
  fetchVehicles,
  fetchFleetFuel,
  fetchVehicleFuel,
  fetchVehicleHistory,
  mapHistoryPoint,
  fetchHistoryPoints,
};
