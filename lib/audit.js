import { query, rows } from "./db";

/**
 * Audit trail for the management app: who logged in, who approved/rejected
 * documents and who changed users or targets. The table is created on demand
 * so no manual migration step is needed.
 */

let auditTableReady = false;

export async function ensureAuditTable() {
  if (auditTableReady) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS public.odg_audit_log (
        id         BIGSERIAL PRIMARY KEY,
        at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        username   TEXT,
        action     TEXT NOT NULL,
        detail     TEXT,
        ip         TEXT
      );
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_odg_audit_log_at ON public.odg_audit_log (at DESC);
    `);
    auditTableReady = true;
  } catch (error) {
    console.error("ensureAuditTable error:", error);
  }
}

/** Fire-and-forget write — an audit failure must never break the real action. */
export function auditLog(username, action, detail = null, ip = null) {
  void (async () => {
    try {
      await ensureAuditTable();
      await query(
        `INSERT INTO public.odg_audit_log (username, action, detail, ip) VALUES (%s, %s, %s, %s)`,
        [username || null, String(action).slice(0, 60), detail ? String(detail).slice(0, 500) : null, ip || null],
      );
    } catch (error) {
      console.error("auditLog error:", error.message);
    }
  })();
}

/** Best-effort client IP extraction for the audit trail. */
export function requestIp(request) {
  try {
    const fwd = request.headers.get("x-forwarded-for");
    if (fwd) return fwd.split(",")[0].trim();
    return request.headers.get("x-real-ip") || null;
  } catch {
    return null;
  }
}

/** Recent audit entries, newest first, with optional action/username filters. */
export async function listAuditLog({ action, username, limit = 200 } = {}) {
  await ensureAuditTable();
  const where = [];
  const params = [];
  if (action) {
    params.push(action);
    where.push(`action = %s`);
  }
  if (username) {
    params.push(`%${username}%`);
    where.push(`username ILIKE %s`);
  }
  params.push(Math.min(Number(limit) || 200, 1000));
  return rows(
    `SELECT id, at, username, action, detail, ip
     FROM public.odg_audit_log
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY id DESC
     LIMIT %s`,
    params,
  );
}
