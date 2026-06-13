import pg from "pg";
import type { PoolConfig, QueryResult, QueryResultRow } from "pg";

const { Pool } = pg;

const defaultConfig: PoolConfig = {
  host: process.env.PGHOST || "db.odienmall.com",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "odg",
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "od@2022",
  max: 50,
  connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS || 5000),
  idleTimeoutMillis: Number(process.env.PGIDLE_TIMEOUT_MS || 30000),
};

function createPool(): pg.Pool {
  const instance = process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 50,
        connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS || 5000),
        idleTimeoutMillis: Number(process.env.PGIDLE_TIMEOUT_MS || 30000),
      })
    : new Pool(defaultConfig);

  instance.on("error", (error) => {
    console.error("PostgreSQL pool error:", error);
  });

  return instance;
}

// Cache the pool on globalThis so HMR / module re-evaluation in dev reuses a
// single pool instead of opening a new one (which exhausts connections).
const globalForPool = globalThis as unknown as { __odgPool?: pg.Pool };
export const pool: pg.Pool = globalForPool.__odgPool ?? (globalForPool.__odgPool = createPool());

function convertPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/%s/g, () => `$${(index += 1)}`);
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(convertPlaceholders(sql), params);
}

export async function rows<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await query<T>(sql, params);
  return result.rows;
}

export async function one<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const result = await query<T>(sql, params);
  return result.rows[0] ?? null;
}
