import pg, { type PoolClient } from "pg";

/**
 * Replaces PRODUCTMANAGERENT's src/lib/db.ts.
 *
 * That app connects with DATABASE_URL; this one already has PG* set, so the
 * pool is built from those instead. Same database (odg), same schema — the
 * product tables it reads (ic_inventory, odg_group_responsible, …) are all in
 * public, which is the default search_path here.
 *
 * Its SQL uses $1 natively, so this must NOT go through this app's own
 * lib/db.js query() helper — that rewrites %s into $n.
 */
const { Pool } = pg;

const globalForPg = globalThis as unknown as { pmPool?: pg.Pool };

export const pool =
  globalForPg.pmPool ??
  new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    max: 5,
    connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS || 5000),
    idleTimeoutMillis: 30_000,
    options: `-c search_path=${process.env.ODG_SCHEMA?.trim() || "public"}`,
  });

if (process.env.NODE_ENV !== "production") globalForPg.pmPool = pool;

pool.on("error", (error) => console.error("PM pool error:", error.message));

/** Ported unchanged: run `fn` in one transaction, commit or roll back. */
export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failure; surface the original error
    }
    throw err;
  } finally {
    client.release();
  }
}
