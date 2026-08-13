// System settings — key/value pairs stored in odg_tms_setting. Reads are
// cached in-process (30s TTL) so the notify helpers can hit DB lazily without
// blowing up Postgres on every WhatsApp/LINE event.
const { pool, query, queryOne } = require("../lib/db");
const { recordAudit } = require("./audit-log");

const settingsCache = globalThis;

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

async function ensureSettingsSchemaInternal(db) {
  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_setting (
      key character varying PRIMARY KEY,
      value text,
      updated_by character varying,
      updated_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
}

async function ensureSettingsSchema() {
  if (settingsCache.__tmsSettingsSchemaReady) return;
  if (!settingsCache.__tmsSettingsSchemaPromise) {
    settingsCache.__tmsSettingsSchemaPromise = ensureSettingsSchemaInternal(pool)
      .then(() => {
        settingsCache.__tmsSettingsSchemaReady = true;
      })
      .catch((err) => {
        settingsCache.__tmsSettingsSchemaPromise = null;
        throw err;
      });
  }
  await settingsCache.__tmsSettingsSchemaPromise;
}

const CACHE_TTL_MS = 30_000;
function getCache() {
  if (!settingsCache.__tmsSettingsCache) {
    settingsCache.__tmsSettingsCache = { at: 0, map: new Map() };
  }
  return settingsCache.__tmsSettingsCache;
}

async function reloadCache() {
  await ensureSettingsSchema();
  const rows = await query(`SELECT key, value FROM public.odg_tms_setting`);
  const c = getCache();
  c.map = new Map(rows.map((r) => [r.key, r.value]));
  c.at = Date.now();
}

async function getSetting(key, fallback = "") {
  const c = getCache();
  if (Date.now() - c.at > CACHE_TTL_MS) {
    try {
      await reloadCache();
    } catch (err) {
      console.warn("[settings] cache reload failed:", err?.message ?? err);
    }
  }
  const v = c.map.get(key);
  return v == null || v === "" ? fallback : v;
}

async function getSettings(keys) {
  const out = {};
  for (const k of keys) out[k] = await getSetting(k, "");
  return out;
}

async function setSetting(key, value, userCode) {
  await ensureSettingsSchema();
  const k = String(key ?? "").trim();
  if (!k) throw new Error("setting key is required");
  const v = value == null ? null : String(value);
  const u = userCode ? String(userCode).trim() || null : null;
  const oldRow = await queryOne(
    `SELECT value FROM public.odg_tms_setting WHERE key = $1`,
    [k]
  );
  const oldValue = oldRow?.value ?? null;
  await pool.query(
    `INSERT INTO public.odg_tms_setting (key, value, updated_by, updated_at)
     VALUES ($1, $2, $3, LOCALTIMESTAMP(0))
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           updated_by = EXCLUDED.updated_by,
           updated_at = LOCALTIMESTAMP(0)`,
    [k, v, u]
  );
  // Bust the cache so the new value is read on the next call.
  const c = getCache();
  if (v == null) c.map.delete(k);
  else c.map.set(k, v);
  if (oldValue !== v) {
    await recordAudit({
      action: "setting.update",
      entityType: "setting",
      entityId: k,
      userCode: u,
      changes: {
        key: k,
        old_value: oldValue,
        new_value: v,
      },
    });
  }
  return { success: true };
}

async function setSettings(entries, userCode) {
  // All keys persist together (one atomic multi-row upsert) or none — a
  // mid-save failure no longer leaves the settings form half-applied, and the
  // read-modify-write on old_value can't interleave across keys.
  const pairs = Object.entries(entries ?? {})
    .map(([key, value]) => [String(key ?? "").trim(), value == null ? null : String(value)])
    .filter(([k]) => k);
  if (pairs.length === 0) return { success: true };
  await ensureSettingsSchema();
  const u = userCode ? String(userCode).trim() || null : null;
  const keys = pairs.map(([k]) => k);
  const oldRows = await query(
    `SELECT key, value FROM public.odg_tms_setting WHERE key = ANY($1::varchar[])`,
    [keys]
  );
  const oldMap = new Map(oldRows.map((r) => [r.key, r.value ?? null]));
  const params = [u];
  const valuesSql = pairs
    .map(([k, v]) => {
      params.push(k);
      const ki = params.length;
      params.push(v);
      return `($${ki}, $${params.length}, $1, LOCALTIMESTAMP(0))`;
    })
    .join(", ");
  await pool.query(
    `INSERT INTO public.odg_tms_setting (key, value, updated_by, updated_at)
     VALUES ${valuesSql}
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           updated_by = EXCLUDED.updated_by,
           updated_at = LOCALTIMESTAMP(0)`,
    params
  );
  // Cache refresh + best-effort audit, after the write committed.
  const c = getCache();
  for (const [k, v] of pairs) {
    if (v == null) c.map.delete(k);
    else c.map.set(k, v);
    const oldValue = oldMap.get(k) ?? null;
    if (oldValue !== v) {
      await recordAudit({
        action: "setting.update",
        entityType: "setting",
        entityId: k,
        userCode: u,
        changes: { key: k, old_value: oldValue, new_value: v },
      });
    }
  }
  return { success: true };
}

async function getSettingDirect(key) {
  await ensureSettingsSchema();
  const row = await queryOne(
    `SELECT value FROM public.odg_tms_setting WHERE key = $1`,
    [key]
  );
  return row?.value ?? "";
}

module.exports = {
  ensureSettingsSchema,
  getSetting,
  getSettings,
  setSetting,
  setSettings,
  getSettingDirect,
};
