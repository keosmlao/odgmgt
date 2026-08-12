import pg, { type QueryResultRow } from "pg";

/**
 * Replaces odss-next's src/lib/db.ts.
 *
 * ODSS reads from two places and the distinction matters:
 *
 *   query()    → the service app's own tables, schema `ods`
 *   queryOdg() → the ERP tables, schema `public`
 *
 * Both now live in the same database (odg), so ODSS separates them by opening
 * two pools with different search_paths. Its SQL names tables unqualified
 * (`from ic_inventory`), so pointing both at one pool silently reads the wrong
 * table: ods.ic_inventory has 16 columns, public.ic_inventory has 111 — hence
 * "column item_category does not exist".
 *
 * The other thing that must not be reused is this app's own query() helper: it
 * rewrites %s into $1, while the copied SQL already uses $1.
 */
const { Pool } = pg;

const base = {
  host: process.env.PGHOST || "dbk.odienmall.com",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "odg",
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD,
  max: 10,
  connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS || 5000),
  idleTimeoutMillis: Number(process.env.PGIDLE_TIMEOUT_MS || 30000),
};

const odsSchema = process.env.ODS_SCHEMA?.trim() || "ods,public";
const odgSchema = process.env.ODG_SCHEMA?.trim() || "public";

const odsPool = new Pool({ ...base, options: `-c search_path=${odsSchema}` });
const odgPool = new Pool({ ...base, options: `-c search_path=${odgSchema}` });

for (const [name, pool] of [["ODS", odsPool], ["ODG", odgPool]] as const) {
  pool.on("error", (error) => console.error(`${name} pool error:`, error.message));
}

export const db = odsPool;
export const odgDb = odgPool;

/** Service-app tables (schema ods). */
export async function query<T extends QueryResultRow>(sql: string, params: unknown[] = []) {
  return odsPool.query<T>(sql, params as never[]);
}

/** ERP tables (schema public). */
export async function queryOdg<T extends QueryResultRow>(sql: string, params: unknown[] = []) {
  return odgPool.query<T>(sql, params as never[]);
}
