const { pool, query } = require("../lib/db");

const auditCache = globalThis;

async function ensureAuditLogSchema() {
  if (auditCache.__tmsAuditLogReady) return;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS public.odg_tms_audit_log (
       id bigserial PRIMARY KEY,
       action character varying NOT NULL,
       entity_type character varying,
       entity_id character varying,
       user_code character varying,
       ip_addr character varying,
       changes jsonb,
       created_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
     )`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_audit_created ON public.odg_tms_audit_log (created_at DESC)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_audit_entity ON public.odg_tms_audit_log (entity_type, entity_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_audit_user ON public.odg_tms_audit_log (user_code, created_at DESC)`
  );
  auditCache.__tmsAuditLogReady = true;
}

// Best-effort audit write. Should never throw — the audit log being unavailable
// must not break the caller. Returns the inserted id (or null on failure).
/**
 * @param {{ action: string, entityType?: string|null, entityId?: string|null, userCode?: string|null, changes?: any, ipAddr?: string|null }} input
 */
async function recordAudit(input) {
  const { action, entityType = null, entityId = null, userCode = null, changes = null, ipAddr = null } = input || {};
  try {
    await ensureAuditLogSchema();
    const row = await pool.query(
      `INSERT INTO public.odg_tms_audit_log (action, entity_type, entity_id, user_code, ip_addr, changes)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id`,
      [
        String(action ?? "").slice(0, 64),
        entityType ? String(entityType).slice(0, 64) : null,
        entityId ? String(entityId).slice(0, 64) : null,
        userCode ? String(userCode).slice(0, 64) : null,
        ipAddr ? String(ipAddr).slice(0, 64) : null,
        changes == null ? null : JSON.stringify(changes),
      ]
    );
    // ທຸກການເຄື່ອນໄຫວໃນເວັບຜ່ານ recordAudit ຢູ່ແລ້ວ ຈຶ່ງແຂວນການແຈ້ງເຕືອນໄວ້
    // ບ່ອນນີ້ບ່ອນດຽວ — action ໃໝ່ໃນອະນາຄົດຖືກກວມເອງໂດຍບໍ່ຕ້ອງໄປແກ້ຫຍັງອີກ.
    //
    // ບໍ່ await: ການແຈ້ງເຕືອນຊ້າກວ່າການຂຽນ audit ຫຼາຍເທົ່າ ແລະ ບໍ່ຄວນຖ່ວງ
    // ຄຳຕອບຂອງ action ທີ່ຜູ້ໃຊ້ກຳລັງລໍຢູ່.
    try {
      const { notifyManagersOfActivity } = require("./activity-feed");
      void notifyManagersOfActivity({
        action,
        entityType,
        entityId,
        userCode,
      });
    } catch (err) {
      console.warn("[audit] activity notify skipped:", err?.message ?? err);
    }

    return row.rows[0]?.id ?? null;
  } catch (err) {
    console.warn("[audit] write failed:", err?.message ?? err);
    return null;
  }
}

/**
 * @param {{ fromDate?: string, toDate?: string, entityType?: string, entityId?: string, userCode?: string, action?: string, limit?: number }} [opts]
 */
async function listAuditLog(opts) {
  const { fromDate, toDate, entityType, entityId, userCode, action, limit = 200 } = opts || {};
  await ensureAuditLogSchema();
  const where = [];
  const params = [];
  if (fromDate) {
    params.push(fromDate);
    where.push(`l.created_at::date >= $${params.length}::date`);
  }
  if (toDate) {
    params.push(toDate);
    where.push(`l.created_at::date <= $${params.length}::date`);
  }
  if (entityType) {
    params.push(entityType);
    where.push(`l.entity_type = $${params.length}`);
  }
  if (entityId) {
    params.push(entityId);
    where.push(`l.entity_id = $${params.length}`);
  }
  if (userCode) {
    params.push(userCode);
    where.push(`l.user_code = $${params.length}`);
  }
  if (action) {
    params.push(action);
    where.push(`l.action = $${params.length}`);
  }
  const lim = Math.max(1, Math.min(1000, Number(limit) || 200));
  return query(
    `SELECT l.id, l.action, l.entity_type, l.entity_id, l.user_code, l.ip_addr, l.changes,
            COALESCE(
              NULLIF(TRIM(e.fullname_lo), ''),
              NULLIF(TRIM(e.nickname), ''),
              NULLIF(TRIM(u.name_1), ''),
              NULLIF(TRIM(l.user_code), ''),
              'system'
            ) AS user_name,
            to_char(l.created_at,'YYYY-MM-DD HH24:MI:SS') AS created_at
     FROM public.odg_tms_audit_log l
     LEFT JOIN public.erp_user u ON u.code = l.user_code
     LEFT JOIN public.odg_employee e ON e.employee_code = l.user_code
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY l.created_at DESC
     LIMIT ${lim}`,
    params
  );
}

module.exports = { ensureAuditLogSchema, recordAudit, listAuditLog };
