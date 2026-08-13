const { pool, query, queryOne } = require("../lib/db");

const cache = globalThis;

async function ensureCustomerRatingSchema() {
  if (cache.__tmsCustomerRatingReady) return;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS public.odg_tms_customer_rating (
       id bigserial PRIMARY KEY,
       bill_no character varying NOT NULL,
       token character varying UNIQUE,
       stars int CHECK (stars BETWEEN 1 AND 5),
       comment text,
       submitted_at timestamp without time zone,
       created_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
     )`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_customer_rating_bill ON public.odg_tms_customer_rating (bill_no)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_customer_rating_submitted ON public.odg_tms_customer_rating (submitted_at)`
  );
  cache.__tmsCustomerRatingReady = true;
}

// Create a rating-request row for a bill if one doesn't already exist.
// Returns the token that should be embedded in the public rating URL.
async function createRatingToken(billNo) {
  await ensureCustomerRatingSchema();
  const code = String(billNo ?? "").trim();
  if (!code) throw new Error("bill_no required");
  const existing = await queryOne(
    `SELECT token FROM public.odg_tms_customer_rating WHERE bill_no = $1 AND submitted_at IS NULL LIMIT 1`,
    [code]
  );
  if (existing?.token) return existing.token;
  const token = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  await pool.query(
    `INSERT INTO public.odg_tms_customer_rating (bill_no, token) VALUES ($1, $2)`,
    [code, token]
  );
  return token;
}

async function getRatingByToken(token) {
  await ensureCustomerRatingSchema();
  return queryOne(
    `SELECT id, bill_no, stars, comment, submitted_at
     FROM public.odg_tms_customer_rating WHERE token = $1`,
    [String(token ?? "").trim()]
  );
}

async function submitRating({ token, stars, comment }) {
  await ensureCustomerRatingSchema();
  const t = String(token ?? "").trim();
  const s = Math.max(1, Math.min(5, Math.trunc(Number(stars))));
  if (!t) throw new Error("token required");
  if (!Number.isFinite(s)) throw new Error("invalid stars");
  const row = await queryOne(
    `SELECT id, submitted_at FROM public.odg_tms_customer_rating WHERE token = $1`,
    [t]
  );
  if (!row) throw new Error("token not found");
  if (row.submitted_at) throw new Error("already submitted");
  await pool.query(
    `UPDATE public.odg_tms_customer_rating
     SET stars = $1, comment = $2, submitted_at = LOCALTIMESTAMP(0)
     WHERE token = $3`,
    [s, comment ? String(comment).slice(0, 1000) : null, t]
  );
  return { success: true };
}

// Aggregated stats for the dashboard.
async function getCustomerRatingSummary({ fromDate, toDate } = {}) {
  await ensureCustomerRatingSchema();
  const where = ["submitted_at IS NOT NULL"];
  const params = [];
  if (fromDate) {
    params.push(fromDate);
    where.push(`submitted_at::date >= $${params.length}::date`);
  }
  if (toDate) {
    params.push(toDate);
    where.push(`submitted_at::date <= $${params.length}::date`);
  }
  const row = await queryOne(
    `SELECT COUNT(*)::int AS total,
            AVG(stars)::numeric(4,2) AS avg_stars,
            COUNT(*) FILTER (WHERE stars >= 4)::int AS positive,
            COUNT(*) FILTER (WHERE stars <= 2)::int AS negative
     FROM public.odg_tms_customer_rating
     WHERE ${where.join(" AND ")}`,
    params
  );
  return {
    total: Number(row?.total ?? 0),
    avg_stars: row?.avg_stars == null ? null : Number(row.avg_stars),
    positive: Number(row?.positive ?? 0),
    negative: Number(row?.negative ?? 0),
  };
}

async function listRecentRatings(limit = 50) {
  await ensureCustomerRatingSchema();
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  return query(
    `SELECT id, bill_no, stars, comment,
            to_char(submitted_at,'YYYY-MM-DD HH24:MI') AS submitted_at
     FROM public.odg_tms_customer_rating
     WHERE submitted_at IS NOT NULL
     ORDER BY submitted_at DESC
     LIMIT ${lim}`
  );
}

module.exports = {
  ensureCustomerRatingSchema,
  createRatingToken,
  getRatingByToken,
  submitRating,
  getCustomerRatingSummary,
  listRecentRatings,
};
