import pg from "pg";
const { Pool } = pg;

const defaultConfig = {
  host: process.env.PGHOST || "dbk.odienmall.com",
  port: Number(process.env.PGPORT || 5433),
  database: process.env.PGDATABASE || "odg",
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "od@2022",
  max: 50,
  connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS || 5000),
  idleTimeoutMillis: Number(process.env.PGIDLE_TIMEOUT_MS || 30000),
};

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 50,
      connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS || 5000),
      idleTimeoutMillis: Number(process.env.PGIDLE_TIMEOUT_MS || 30000),
    })
  : new Pool(defaultConfig);

pool.on("error", (error) => {
  console.error("PostgreSQL pool error:", error);
});

function convertPlaceholders(sql) {
  let index = 0;
  return sql.replace(/%s/g, () => `$${++index}`);
}

export async function query(sql, params = []) {
  return pool.query(convertPlaceholders(sql), params);
}

export async function rows(sql, params = []) {
  const result = await query(sql, params);
  return result.rows;
}

export async function one(sql, params = []) {
  const result = await query(sql, params);
  return result.rows[0] || null;
}

export { pool };
