const { Pool } = require("pg");

/**
 * Replaces tms/src/lib/db.js.
 *
 * The copied query modules are unchanged, so they still call query/queryOne
 * (the odg database) and queryB/queryOneB (odservice). Only how the pools are
 * configured differs: TMS reads PG_HOST / PG_DATABASE / PG_USER (and the same
 * with a _B suffix), this app already has PGHOST / PGDATABASE / PGUSER set, so
 * those are used as the fallback. Both point at the same server TMS uses —
 * db.odienmall.com — which is the whole reason this copy can replace the REST
 * proxy: the numbers come off the same rows TMS reads.
 *
 * ODSERVICE_DATABASE overrides the second database if it is ever renamed.
 */
const globalPools = globalThis;

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value) !== "") return value;
  }
  return undefined;
}

function required(value, key, label) {
  if (value === undefined) throw new Error(`Missing ${key} for ${label} database connection`);
  return value;
}

function buildPoolConfig(prefix, label) {
  const isSecondary = prefix === "_B";
  const database = isSecondary
    ? pick(process.env.PG_DATABASE_B, process.env.ODSERVICE_DATABASE, "odservice")
    : pick(process.env.PG_DATABASE, process.env.PGDATABASE);

  return {
    host: required(pick(process.env[`PG_HOST${prefix}`], process.env.PGHOST), `PG_HOST${prefix}`, label),
    port: Number.parseInt(pick(process.env[`PG_PORT${prefix}`], process.env.PGPORT, "5432"), 10) || 5432,
    database: required(database, `PG_DATABASE${prefix}`, label),
    user: required(pick(process.env[`PG_USER${prefix}`], process.env.PGUSER), `PG_USER${prefix}`, label),
    password: pick(process.env[`PG_PASSWORD${prefix}`], process.env.PGPASSWORD) ?? "",
    // Kept from TMS: 10 is not enough — getBillsPending fans out internally and
    // several of these reports run their queries concurrently.
    max: Number(process.env.PG_POOL_MAX ?? 25),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS || 10_000),
    ssl: process.env[`PG_SSL${prefix}`] && process.env[`PG_SSL${prefix}`] !== "false"
      ? { rejectUnauthorized: false }
      : undefined,
  };
}

function getOrCreatePool(key, prefix) {
  if (!globalPools.__tmsPgPools) globalPools.__tmsPgPools = {};
  if (!globalPools.__tmsPgPools[key]) {
    globalPools.__tmsPgPools[key] = new Pool(buildPoolConfig(prefix, key));
    globalPools.__tmsPgPools[key].on("error", (error) =>
      console.error(`TMS ${key} pool error:`, error.message),
    );
  }
  return globalPools.__tmsPgPools[key];
}

function sanitizeRows(rows) {
  return JSON.parse(JSON.stringify(rows));
}

/**
 * TMS keeps its schema current from application code: 24 of the copied query
 * modules run CREATE TABLE / CREATE INDEX / ALTER TABLE the first time a code
 * path is used — 172 statements in all, against odg_tms, odg_tms_gps_current,
 * odg_tms_gps_daily, odg_tms_pending_bill and others.
 *
 * That belongs to TMS, which owns those tables. Here it is actively harmful:
 * this app only reads them, and ALTER TABLE takes an ACCESS EXCLUSIVE lock on
 * tables TMS is writing continuously — its GPS worker updates
 * odg_tms_gps_current on a tick. Every restart had this app queue behind live
 * traffic and hold it up in turn, which is what produced 30-second timeouts on
 * the first load of a transport screen.
 *
 * So DDL is dropped here rather than sent. Checked before doing this: none of
 * the 172 statements creates a TEMP or UNLOGGED table, so nothing depends on
 * one being made per session — they are all persistent schema TMS already
 * maintains.
 *
 * If a table or column this app reads is genuinely missing, the SELECT fails
 * loudly and the fix is to deploy TMS, not to start writing schema from here.
 */
const DDL = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*(CREATE|ALTER|DROP|TRUNCATE|COMMENT\s+ON)\b/i;

function isDdl(text) {
  return DDL.test(String(text ?? ""));
}

const pool = getOrCreatePool("primary", "");

// Built on first use, not at import. odservice is only reached by the pending-
// bill paths (getBillsPending and what it calls), so if it is ever unreachable
// the reports that do not touch it must still work rather than every module
// failing to load.
function getPoolB() {
  return getOrCreatePool("secondary", "_B");
}

async function query(text, params = []) {
  if (isDdl(text)) return [];
  const client = await pool.connect();
  try {
    const result = await client.query(text, [...params]);
    return sanitizeRows(result.rows);
  } finally {
    client.release();
  }
}

async function queryOne(text, params = []) {
  const rows = await query(text, params);
  return rows[0] ?? null;
}

async function queryB(text, params = []) {
  if (isDdl(text)) return [];
  const client = await getPoolB().connect();
  try {
    const result = await client.query(text, [...params]);
    return sanitizeRows(result.rows);
  } finally {
    client.release();
  }
}

async function queryOneB(text, params = []) {
  const rows = await queryB(text, params);
  return rows[0] ?? null;
}

module.exports = { pool, getPoolB, query, queryOne, queryB, queryOneB };
