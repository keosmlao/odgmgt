import { one, query } from "./db";

/**
 * Stale-while-revalidate cache for the report endpoints, backed by Postgres.
 *
 * - Within `ttl` the value is served from memory.
 * - Between `ttl` and `staleTtl` the stored value is served immediately while a
 *   refresh runs in the background.
 * - A cold process (deploy, restart, first visit of the day) falls back to the
 *   `app_report_cache` table, so nobody waits for a full rebuild.
 */
const store = new Map();
const inFlight = new Map();

const CACHE_TABLE = "public.app_report_cache";
let tableReady = null;

async function ensureTable() {
  if (!tableReady) {
    tableReady = query(`
      CREATE TABLE IF NOT EXISTS ${CACHE_TABLE} (
        cache_key  text PRIMARY KEY,
        payload    jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `).catch((error) => {
      tableReady = null;
      throw error;
    });
  }
  return tableReady;
}

async function readPersisted(key) {
  try {
    await ensureTable();
    const row = await one(
      `SELECT payload, EXTRACT(EPOCH FROM (now() - updated_at)) * 1000 AS age_ms
       FROM ${CACHE_TABLE} WHERE cache_key = %s`,
      [key],
    );
    if (!row) return null;
    return { value: row.payload, age: Number(row.age_ms || 0) };
  } catch (error) {
    console.error("report cache read failed:", error.message);
    return null;
  }
}

async function writePersisted(key, value) {
  try {
    await ensureTable();
    await query(
      `INSERT INTO ${CACHE_TABLE} (cache_key, payload, updated_at)
       VALUES (%s, %s, now())
       ON CONFLICT (cache_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  } catch (error) {
    console.error("report cache write failed:", error.message);
  }
}

function refreshInBackground(key, loader) {
  if (inFlight.has(key)) return;
  const task = Promise.resolve()
    .then(loader)
    .then(async (value) => {
      store.set(key, { ts: Date.now(), value });
      await writePersisted(key, value);
      return value;
    })
    .catch((error) => console.error(`cache refresh failed for ${key}:`, error.message))
    .finally(() => inFlight.delete(key));
  inFlight.set(key, task);
}

export async function swrCache(key, options, loader) {
  const { ttl = 300_000, staleTtl = 24 * 3_600_000, persist = true, bypass = false } = options || {};

  // `?nocache=1` on a report endpoint: recompute and refresh both layers.
  if (bypass) {
    const value = await loader();
    store.set(key, { ts: Date.now(), value });
    if (persist) await writePersisted(key, value);
    return value;
  }

  const entry = store.get(key);
  const now = Date.now();

  if (entry && now - entry.ts < ttl) return entry.value;

  if (entry && now - entry.ts < staleTtl) {
    refreshInBackground(key, loader);
    return entry.value;
  }

  // Nothing usable in memory: a restarted process can still answer from the
  // table instead of making the first visitor wait for a full rebuild.
  if (persist) {
    const persisted = await readPersisted(key);
    if (persisted && persisted.age < staleTtl) {
      store.set(key, { ts: now - persisted.age, value: persisted.value });
      if (persisted.age >= ttl) refreshInBackground(key, loader);
      return persisted.value;
    }
  }

  if (inFlight.has(key)) return inFlight.get(key);
  const task = Promise.resolve()
    .then(loader)
    .then(async (value) => {
      store.set(key, { ts: Date.now(), value });
      if (persist) await writePersisted(key, value);
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

export function cacheStats() {
  return { entries: store.size, refreshing: inFlight.size };
}

export async function clearCache(prefix = "") {
  if (!prefix) {
    store.clear();
  } else {
    for (const key of store.keys()) {
      if (key.startsWith(prefix)) store.delete(key);
    }
  }
  try {
    await ensureTable();
    if (prefix) {
      await query(`DELETE FROM ${CACHE_TABLE} WHERE cache_key LIKE %s`, [`${prefix}%`]);
    } else {
      await query(`DELETE FROM ${CACHE_TABLE}`);
    }
  } catch (error) {
    console.error("report cache clear failed:", error.message);
  }
}


