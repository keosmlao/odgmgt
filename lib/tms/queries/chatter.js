// Odoo-style chatter — discussion thread + activities + followers, attached to
// any record via (model, record_id). For model='bill' the pending-bill change
// history is merged in read-time as 'system' messages (audit trail) — no write
// hooks needed.
const { pool, query, queryOne } = require("../lib/db");
const {
  normalizeMsgType,
  serializeMentions,
  collectChatterRecipients,
} = require("../lib/chatter-helpers");

const chatCache = globalThis;

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

async function ensureChatterSchemaInternal(db) {
  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_chatter_message (
      id bigserial PRIMARY KEY,
      model character varying NOT NULL,
      record_id character varying NOT NULL,
      msg_type character varying NOT NULL DEFAULT 'comment',
      body text,
      mentions character varying,
      author_code character varying,
      author_name character varying,
      created_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  await safeDdl(db, `ALTER TABLE public.odg_chatter_message ADD COLUMN IF NOT EXISTS mentions character varying`);
  await safeDdl(db, `ALTER TABLE public.odg_chatter_message ADD COLUMN IF NOT EXISTS attachment_data text`);
  await safeDdl(db, `ALTER TABLE public.odg_chatter_message ADD COLUMN IF NOT EXISTS attachment_name character varying`);
  await safeDdl(db, `ALTER TABLE public.odg_chatter_message ADD COLUMN IF NOT EXISTS updated_at timestamp without time zone`);
  await safeDdl(db, `CREATE INDEX IF NOT EXISTS idx_chatter_model_record ON public.odg_chatter_message (model, record_id, created_at)`);
  // Time-windowed scan for the notification feed (model + recent created_at).
  await safeDdl(db, `CREATE INDEX IF NOT EXISTS idx_chatter_message_model_created ON public.odg_chatter_message (model, created_at)`);

  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_chatter_follower (
      model character varying NOT NULL,
      record_id character varying NOT NULL,
      user_code character varying NOT NULL,
      user_name character varying,
      created_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0),
      PRIMARY KEY (model, record_id, user_code)
    )
  `);

  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_chatter_activity (
      id bigserial PRIMARY KEY,
      model character varying NOT NULL,
      record_id character varying NOT NULL,
      act_type character varying NOT NULL DEFAULT 'todo',
      summary text,
      due_date date,
      assignee_code character varying,
      assignee_name character varying,
      done boolean NOT NULL DEFAULT false,
      done_at timestamp without time zone,
      created_by character varying,
      created_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  await safeDdl(db, `CREATE INDEX IF NOT EXISTS idx_chatter_activity_record ON public.odg_chatter_activity (model, record_id, done)`);

  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_chatter_read (
      user_code character varying NOT NULL,
      model character varying NOT NULL,
      record_id character varying NOT NULL,
      last_read_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0),
      PRIMARY KEY (user_code, model, record_id)
    )
  `);

}

async function ensureChatterSchema() {
  if (chatCache.__tmsChatterSchemaReady) return;
  if (!chatCache.__tmsChatterSchemaPromise) {
    chatCache.__tmsChatterSchemaPromise = ensureChatterSchemaInternal(pool)
      .then(() => { chatCache.__tmsChatterSchemaReady = true; })
      .catch((err) => { chatCache.__tmsChatterSchemaPromise = null; throw err; });
  }
  await chatCache.__tmsChatterSchemaPromise;
}

// Authorisation: which records a user may read/post chatter on.
// - DM ("ຂໍ້ຄວາມລອຍ"): strictly private — only the two participants may read/post.
// - Bill conversations: OPEN to every logged-in user. Sales gives a bill its
//   delivery branch via the odg_tms_pending_bill override, and that branch's
//   staff must be able to read/reply on the bill thread even though the ERP
//   shipment row still points elsewhere; department/branch scoping used to block
//   them. Bill chatter is therefore a shared, org-internal discussion (only DMs
//   stay private).
async function canAccessRecord(session, model, recordId) {
  const r = String(recordId ?? "").trim();
  // Direct messages are private: record_id is "dm:<codeA>|<codeB>" and ONLY the
  // two participants may read/post. Without this, any logged-in user could open
  // any DM by guessing the key.
  if (model === "dm") {
    const me = String(session?.usercode ?? "").trim();
    if (!me || !r) return false;
    const key = r.startsWith("dm:") ? r.slice(3) : r;
    const parts = key.split("|").map((x) => x.trim()).filter(Boolean);
    return parts.includes(me);
  }
  // Bill (and other non-DM) conversations are visible to all authenticated users.
  return true;
}

// ---- Messages ----
async function listChatterMessages(model, recordId) {
  await ensureChatterSchema();
  const m = String(model ?? "").trim();
  const r = String(recordId ?? "").trim();
  if (!m || !r) return [];
  const rows = await query(
    `SELECT id, msg_type, body, COALESCE(mentions, '') AS mentions, author_code,
            COALESCE(NULLIF(TRIM(author_name), ''), author_code, '-') AS author_name,
            (attachment_data IS NOT NULL AND attachment_data <> '') AS has_attachment,
            COALESCE(attachment_name, '') AS attachment_name,
            (updated_at IS NOT NULL) AS edited,
            created_at,
            to_char(created_at,'DD-MM-YYYY HH24:MI') AS created_at_display
     FROM public.odg_chatter_message
     WHERE model = $1 AND record_id = $2
     ORDER BY created_at DESC, id DESC
     LIMIT 300`,
    [m, r]
  );
  // Audit trail: merge pending-bill change history as system messages so every
  // edit on the "ລໍຖ້າຈັດຖ້ຽວ" (bills-pending) screen — status, delivery date,
  // transport branch, route, round, remark, map pin — shows in the conversation.
  // NOTE: the history table columns are changed_by / changed_at (NOT
  // user_code / created_at) — using the wrong names silently dropped the whole
  // audit trail from the chatter.
  let systemRows = [];
  if (m === "bill") {
    try {
      systemRows = await query(
        `SELECT NULL::bigint AS id, 'system' AS msg_type,
                CONCAT_WS(' · ',
                  CASE WHEN h.action_status IS NOT NULL THEN CONCAT('ສະຖານະ: ',
                    CASE h.action_status
                      WHEN 'sales_not_notified' THEN 'ພະນັກງານຂາຍຍັງບໍ່ແຈ້ງ'
                      WHEN 'contact_failed' THEN 'ຕິດຕໍ່ບໍ່ໄດ້'
                      WHEN 'customer_postponed' THEN 'ລູກຄ້າເລື່ອນວັນຮັບ'
                      WHEN 'customer_cancelled' THEN 'ລູກຄ້າປະຕິເສດ/ຍົກເລີກ'
                      WHEN 'contacted_ready' THEN 'ພ້ອມຮັບ'
                      WHEN 'delivery_scheduled' THEN 'ຕາຕະລາງການຈັດສົ່ງ'
                      ELSE h.action_status
                    END) END,
                  CASE WHEN h.scheduled_date IS NOT NULL THEN CONCAT('ວັນຮັບ: ', to_char(h.scheduled_date,'DD-MM-YYYY')) END,
                  CASE WHEN NULLIF(TRIM(h.transport_code),'') IS NOT NULL THEN CONCAT('ຂົນສົ່ງ: ', COALESCE(NULLIF(TRIM(tt.name_1),''), h.transport_code)) END,
                  CASE WHEN NULLIF(TRIM(h.delivery_route_code),'') IS NOT NULL THEN CONCAT('ສາຍ: ', COALESCE(NULLIF(TRIM(rt.name),''), h.delivery_route_code)) END,
                  CASE WHEN NULLIF(TRIM(h.delivery_round_code),'') IS NOT NULL THEN CONCAT('ຮອບ: ', COALESCE(NULLIF(TRIM(dr.name),''), h.delivery_round_code)) END,
                  CASE WHEN NULLIF(TRIM(h.planned_lat),'') IS NOT NULL THEN 'ປັກໝຸດຈຸດສົ່ງ' END,
                  CASE WHEN NULLIF(TRIM(h.remark),'') IS NOT NULL THEN CONCAT('ໝາຍເຫດ: ', h.remark) END
                ) AS body,
                '' AS mentions, COALESCE(h.changed_by,'') AS author_code,
                COALESCE(NULLIF(TRIM(emp.fullname_lo),''), NULLIF(TRIM(emp.nickname),''), NULLIF(TRIM(h.changed_by),''), 'ລະບົບ') AS author_name,
                false AS has_attachment, '' AS attachment_name, false AS edited,
                h.changed_at AS created_at, to_char(h.changed_at,'DD-MM-YYYY HH24:MI') AS created_at_display
         FROM public.odg_tms_pending_bill_history h
         LEFT JOIN public.transport_type tt ON tt.code = NULLIF(TRIM(h.transport_code), '')
         LEFT JOIN public.odg_tms_delivery_route rt ON rt.code = NULLIF(TRIM(h.delivery_route_code), '')
         LEFT JOIN public.odg_tms_delivery_round dr ON dr.code = NULLIF(TRIM(h.delivery_round_code), '')
         LEFT JOIN public.odg_employee emp ON emp.employee_code = h.changed_by
         WHERE h.bill_no = $1
         ORDER BY h.changed_at DESC
         LIMIT 100`,
        [r]
      );
    } catch {
      systemRows = [];
    }
  }
  return [...rows, ...systemRows]
    .filter((x) => x.body && String(x.body).trim())
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

async function postChatterMessage({ model, recordId, body, msgType, mentions, attachmentData, attachmentName, authorCode, authorName }) {
  await ensureChatterSchema();
  const m = String(model ?? "").trim();
  const r = String(recordId ?? "").trim();
  const text = String(body ?? "").trim();
  const att = String(attachmentData ?? "").trim();
  if (!m || !r) throw new Error("model and record_id are required");
  if (!text && !att) throw new Error("body or attachment is required");
  // Guard against oversized base64 payloads (~4MB).
  if (att && att.length > 5_600_000) throw new Error("attachment too large");
  const type = normalizeMsgType(msgType);
  const men = serializeMentions(mentions);
  const res = await pool.query(
    `INSERT INTO public.odg_chatter_message
       (model, record_id, msg_type, body, mentions, attachment_data, attachment_name, author_code, author_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [m, r, type, text, men, att || null, attachmentName ? String(attachmentName).slice(0, 200) : null, authorCode ?? null, authorName ?? null]
  );
  // Auto-follow on posting.
  if (authorCode) {
    await pool.query(
      `INSERT INTO public.odg_chatter_follower (model, record_id, user_code, user_name)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [m, r, authorCode, authorName ?? null]
    );
  }
  // Push to the mobile app (best-effort) — notify everyone in the bill's
  // conversation: @mentioned + the bill's salesperson + existing followers.
  if (type !== "system") {
    try {
      let saleCode = null;
      let headManagers = [];
      if (m === "bill") {
        const sale = await pool.query(
          `SELECT sale_code FROM public.ic_trans WHERE doc_no = $1 LIMIT 1`,
          [r]
        );
        saleCode = sale.rows?.[0]?.sale_code ?? null;
        if (saleCode) {
          // The salesperson's department head / manager must be looped in.
          const hm = await pool.query(
            `SELECT employee_code FROM public.odg_employee
             WHERE position_code IN ('11', '12')
               AND department_code = (
                 SELECT department_code FROM public.odg_employee
                 WHERE employee_code = $1 LIMIT 1)`,
            [String(saleCode).trim()]
          );
          headManagers = hm.rows.map((x) => x.employee_code);
        }
      }
      // Direct message: the recipient is the other half of the dm:<a>|<b> key.
      const dmOther = [];
      if (m === "dm" && r.startsWith("dm:")) {
        for (const code of r.slice(3).split("|").map((x) => x.trim())) {
          if (code && code !== authorCode) dmOther.push(code);
        }
      }
      const isDm = m === "dm";
      let recipients;
      if (isDm) {
        // Private DM: notify ONLY the other participant — never followers,
        // mentions, or the bill salesperson, which would leak the message to
        // people who aren't part of the conversation.
        recipients = Array.from(
          new Set(dmOther.filter((c) => c && c !== authorCode))
        );
      } else {
        const fol = await pool.query(
          `SELECT user_code FROM public.odg_chatter_follower WHERE model = $1 AND record_id = $2`,
          [m, r]
        );
        recipients = collectChatterRecipients({
          mentions: men,
          followers: [...fol.rows.map((x) => x.user_code), ...headManagers],
          saleCode,
          authorCode,
        });
      }
      if (recipients.length > 0) {
        const who = String(authorName || authorCode || "").trim();
        const preview = text ? text.slice(0, 80) : "ໄດ້ແນບໄຟລ໌";
        const { pushToEmployees, pushToDriver } = require("./push");
        if (isDm) {
          // In-app push only. DMs are private — do NOT send to the external LINE
          // channel, and never label the conversation key as a "bill".
          const dmData = {
            type: "dm",
            dm: r,
            href: `/?dm=${encodeURIComponent(r)}`,
          };
          await pushToEmployees(
            recipients,
            "💬 ຂໍ້ຄວາມໃໝ່",
            `${who}: ${preview}`,
            dmData
          );
          // Driver apps register their FCM under odg_tms_fcm_tokens
          // (pushToDriver), not the web app_fcm_token table — push there too so
          // driver recipients of a DM are notified.
          for (const code of recipients) {
            void pushToDriver(code, "💬 ຂໍ້ຄວາມໃໝ່", `${who}: ${preview}`, dmData);
          }
        } else {
          await pushToEmployees(recipients, `ບິນ ${r}`, `${who}: ${preview}`, {
            type: "chatter",
            bill_no: r,
            href: `/tracking?search=${r}`,
          });
          // LINE notify (best-effort) — bill conversations only.
          try {
            const lineRows = await query(
              `SELECT DISTINCT NULLIF(TRIM(u.line_id::text), '') AS line_id
               FROM public.erp_user u
               WHERE u.code = ANY($1) AND NULLIF(TRIM(u.line_id::text), '') IS NOT NULL`,
              [recipients]
            );
            if (lineRows.length > 0) {
              const { sendLineText } = require("../lib/line");
              const msg = `📋 ບິນ ${r}\n${who}: ${preview}`;
              await Promise.all(
                lineRows.map((x) => sendLineText(x.line_id, msg).catch(() => undefined))
              );
            }
          } catch (err) {
            console.warn("[chatter] line notify failed:", err?.message ?? err);
          }
        }
      }
    } catch (err) {
      console.warn("[chatter] push failed:", err?.message ?? err);
    }
  }
  return { success: true, id: res.rows?.[0]?.id ?? null };
}

// Edit / delete — only the original author may change their own message.
async function editChatterMessage({ id, body, authorCode }) {
  await ensureChatterSchema();
  const text = String(body ?? "").trim();
  if (!text) throw new Error("body is required");
  const res = await pool.query(
    `UPDATE public.odg_chatter_message
       SET body = $1, updated_at = LOCALTIMESTAMP(0)
     WHERE id = $2 AND author_code = $3`,
    [text, Number(id), String(authorCode ?? "").trim()]
  );
  if (res.rowCount === 0) throw new Error("not found or not owner");
  return { success: true };
}

async function deleteChatterMessage({ id, authorCode }) {
  await ensureChatterSchema();
  const res = await pool.query(
    `DELETE FROM public.odg_chatter_message WHERE id = $1 AND author_code = $2`,
    [Number(id), String(authorCode ?? "").trim()]
  );
  if (res.rowCount === 0) throw new Error("not found or not owner");
  return { success: true };
}

// Raw attachment for the serving API route (kept out of the thread payload so
// the message list stays lean — base64 blobs are fetched on demand instead).
async function getChatterAttachment(id) {
  await ensureChatterSchema();
  return queryOne(
    `SELECT model, record_id, attachment_data, attachment_name
     FROM public.odg_chatter_message
     WHERE id = $1`,
    [Number(id)]
  );
}

// ---- Read state / unread badges ----
async function markChatterRead({ model, recordId, userCode }) {
  await ensureChatterSchema();
  const u = String(userCode ?? "").trim();
  const m = String(model ?? "").trim();
  const r = String(recordId ?? "").trim();
  if (!u || !m || !r) return { success: true };
  await pool.query(
    `INSERT INTO public.odg_chatter_read (user_code, model, record_id, last_read_at)
     VALUES ($1, $2, $3, LOCALTIMESTAMP(0))
     ON CONFLICT (user_code, model, record_id)
     DO UPDATE SET last_read_at = LOCALTIMESTAMP(0)`,
    [u, m, r]
  );
  return { success: true };
}

// Unread comment/note count per record (excludes the user's own posts and
// records read since the last message). Returns only records with unread > 0.
async function getUnreadCounts(userCode, model, recordIds) {
  await ensureChatterSchema();
  const u = String(userCode ?? "").trim();
  const ids = (Array.isArray(recordIds) ? recordIds : [])
    .map((x) => String(x).trim())
    .filter(Boolean);
  if (!u || ids.length === 0) return [];
  return query(
    `SELECT cm.record_id, COUNT(*)::int AS unread
     FROM public.odg_chatter_message cm
     LEFT JOIN public.odg_chatter_read cr
       ON cr.model = cm.model AND cr.record_id = cm.record_id AND cr.user_code = $1
     WHERE cm.model = $2
       AND cm.record_id = ANY($3)
       AND cm.msg_type IN ('note', 'comment')
       AND COALESCE(cm.author_code, '') <> $1
       AND cm.created_at > COALESCE(cr.last_read_at, TIMESTAMP '1970-01-01')
     GROUP BY cm.record_id`,
    [u, String(model ?? "bill").trim(), ids]
  );
}

// Unified inbox: every record the user is involved in (followed, @mentioned,
// the bill's salesperson, or they posted) with last message + unread count.
async function getInboxConversations(userCode) {
  await ensureChatterSchema();
  const u = String(userCode ?? "").trim();
  if (!u) return [];
  return query(
    `WITH involved AS (
       SELECT DISTINCT cm.model, cm.record_id
       FROM public.odg_chatter_message cm
       LEFT JOIN public.ic_trans it ON it.doc_no = cm.record_id AND cm.model = 'bill'
       WHERE cm.msg_type IN ('note', 'comment')
         AND cm.model IN ('bill', 'job')
         AND (
           EXISTS (SELECT 1 FROM public.odg_chatter_follower cf
                   WHERE cf.model = cm.model AND cf.record_id = cm.record_id AND cf.user_code = $1)
           OR (',' || COALESCE(cm.mentions, '') || ',') LIKE ('%,' || $1 || ',%')
           OR (cm.model = 'bill' AND COALESCE(it.sale_code, '') = $1)
           OR (cm.model = 'bill' AND EXISTS (
                 SELECT 1 FROM public.odg_employee me
                 JOIN public.odg_employee sp ON sp.department_code = me.department_code
                 WHERE me.employee_code = $1
                   AND me.position_code IN ('11', '12')
                   AND sp.employee_code = COALESCE(it.sale_code, '')))
           OR cm.author_code = $1
         )
     )
     SELECT
       iv.model,
       iv.record_id,
       last.body AS last_body,
       last.author_name AS last_author,
       to_char(last.created_at, 'DD-MM-YYYY HH24:MI') AS last_at,
       COALESCE(unr.unread, 0) AS unread,
       COALESCE(NULLIF(TRIM(cu.name_1), ''), NULLIF(TRIM(it.cust_code), ''), '') AS title
     FROM involved iv
     LEFT JOIN public.ic_trans it ON it.doc_no = iv.record_id AND iv.model = 'bill'
     LEFT JOIN public.ar_customer cu ON cu.code = it.cust_code
     LEFT JOIN LATERAL (
       SELECT m.body, m.author_name, m.created_at
       FROM public.odg_chatter_message m
       WHERE m.model = iv.model AND m.record_id = iv.record_id AND m.msg_type IN ('note', 'comment')
       ORDER BY m.created_at DESC
       LIMIT 1
     ) last ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS unread
       FROM public.odg_chatter_message m
       LEFT JOIN public.odg_chatter_read cr
         ON cr.model = m.model AND cr.record_id = m.record_id AND cr.user_code = $1
       WHERE m.model = iv.model AND m.record_id = iv.record_id
         AND m.msg_type IN ('note', 'comment')
         AND COALESCE(m.author_code, '') <> $1
         AND m.created_at > COALESCE(cr.last_read_at, TIMESTAMP '1970-01-01')
     ) unr ON true
     ORDER BY last.created_at DESC NULLS LAST
     LIMIT 100`,
    [u]
  );
}

// People for direct messages — ONLY users who have logged into the system
// (have a presence record), deduped per user, with online status, last login,
// the 1:1 DM key (model='dm'), last DM message + unread. Online-first.
async function listDmPeople(userCode) {
  await ensureChatterSchema();
  const u = String(userCode ?? "").trim();
  if (!u) return [];
  return query(
    `WITH pres AS (
       SELECT user_code,
              MAX(last_seen_at) AS last_seen_at,
              BOOL_OR(status = 'online' AND last_seen_at >= LOCALTIMESTAMP(0) - INTERVAL '90 seconds') AS online,
              MAX(username) AS username,
              MAX(title) AS title
       FROM public.odg_tms_user_presence
       WHERE COALESCE(NULLIF(TRIM(user_code), ''), '') <> ''
       GROUP BY user_code
     )
     SELECT
       p.user_code AS code,
       COALESCE(NULLIF(TRIM(e.fullname_lo), ''), NULLIF(TRIM(e.nickname), ''), NULLIF(TRIM(p.username), ''), p.user_code) AS name,
       COALESCE(NULLIF(TRIM(p.title), ''), '') AS title,
       ('dm:' || LEAST($1, p.user_code) || '|' || GREATEST($1, p.user_code)) AS record_id,
       COALESCE(p.online, false) AS online,
       to_char(p.last_seen_at, 'DD-MM-YYYY HH24:MI') AS last_seen,
       last.body AS last_body,
       COALESCE(unr.unread, 0) AS unread
     FROM pres p
     LEFT JOIN public.odg_employee e ON e.employee_code = p.user_code
     LEFT JOIN LATERAL (
       SELECT m.body, m.created_at FROM public.odg_chatter_message m
       WHERE m.model = 'dm'
         AND m.record_id = ('dm:' || LEAST($1, p.user_code) || '|' || GREATEST($1, p.user_code))
       ORDER BY m.created_at DESC LIMIT 1
     ) last ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS unread FROM public.odg_chatter_message m
       LEFT JOIN public.odg_chatter_read cr
         ON cr.model = 'dm' AND cr.record_id = m.record_id AND cr.user_code = $1
       WHERE m.model = 'dm'
         AND m.record_id = ('dm:' || LEAST($1, p.user_code) || '|' || GREATEST($1, p.user_code))
         AND COALESCE(m.author_code, '') <> $1
         AND m.created_at > COALESCE(cr.last_read_at, TIMESTAMP '1970-01-01')
     ) unr ON true
     WHERE p.user_code <> $1
     ORDER BY online DESC, p.last_seen_at DESC NULLS LAST, name ASC
     LIMIT 300`,
    [u]
  );
}

// DM read receipt — whether the peer has read my latest message in this DM.
async function getDmPeerRead(myCode, recordId) {
  await ensureChatterSchema();
  const u = String(myCode ?? "").trim();
  const r = String(recordId ?? "").trim();
  if (!u || !r.startsWith("dm:")) return { seen: false };
  const peer = r
    .slice(3)
    .split("|")
    .map((x) => x.trim())
    .find((x) => x && x !== u);
  if (!peer) return { seen: false };
  const row = await queryOne(
    `SELECT (mymax.created_at IS NOT NULL
             AND COALESCE(cr.last_read_at, TIMESTAMP '1970-01-01') >= mymax.created_at) AS seen
     FROM (SELECT MAX(created_at) AS created_at FROM public.odg_chatter_message
           WHERE model = 'dm' AND record_id = $1 AND author_code = $2) mymax
     LEFT JOIN public.odg_chatter_read cr
       ON cr.model = 'dm' AND cr.record_id = $1 AND cr.user_code = $3`,
    [r, u, peer]
  );
  return { seen: !!row?.seen };
}

// ---- Followers ----
async function listFollowers(model, recordId) {
  await ensureChatterSchema();
  return query(
    `SELECT user_code, COALESCE(NULLIF(TRIM(user_name),''), user_code) AS user_name
     FROM public.odg_chatter_follower
     WHERE model = $1 AND record_id = $2 ORDER BY created_at ASC`,
    [String(model ?? "").trim(), String(recordId ?? "").trim()]
  );
}

async function toggleFollower({ model, recordId, userCode, userName }) {
  await ensureChatterSchema();
  const m = String(model ?? "").trim();
  const r = String(recordId ?? "").trim();
  const u = String(userCode ?? "").trim();
  if (!m || !r || !u) throw new Error("model, record_id, user required");
  const existing = await pool.query(
    `SELECT 1 FROM public.odg_chatter_follower WHERE model=$1 AND record_id=$2 AND user_code=$3`,
    [m, r, u]
  );
  if (existing.rowCount > 0) {
    await pool.query(`DELETE FROM public.odg_chatter_follower WHERE model=$1 AND record_id=$2 AND user_code=$3`, [m, r, u]);
    return { following: false };
  }
  await pool.query(
    `INSERT INTO public.odg_chatter_follower (model, record_id, user_code, user_name)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [m, r, u, userName ?? null]
  );
  return { following: true };
}

// Bulk add followers idempotently (no toggle). Used when a bill is assigned a
// transport branch so the branch's staff start following the bill — and, since
// postChatterMessage resolves followers fresh at post time, get notified by the
// message posted right after. Accepts [{ code, name }] and skips blanks/dupes.
async function addFollowers({ model, recordId, users }) {
  await ensureChatterSchema();
  const m = String(model ?? "").trim();
  const r = String(recordId ?? "").trim();
  const list = Array.isArray(users) ? users : [];
  if (!m || !r || list.length === 0) return { added: 0 };
  const seen = new Set();
  let added = 0;
  for (const u of list) {
    const code = String(u?.code ?? "").trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const res = await pool.query(
      `INSERT INTO public.odg_chatter_follower (model, record_id, user_code, user_name)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [m, r, code, u?.name ? String(u.name).trim() : null]
    );
    added += res.rowCount ?? 0;
  }
  return { added };
}

// ---- Activities ----
async function listActivities(model, recordId) {
  await ensureChatterSchema();
  return query(
    `SELECT id, act_type, summary,
            to_char(due_date,'DD-MM-YYYY') AS due_date_display,
            to_char(due_date,'YYYY-MM-DD') AS due_date,
            assignee_code,
            COALESCE(NULLIF(TRIM(assignee_name),''), assignee_code, '') AS assignee_name,
            done, to_char(done_at,'DD-MM-YYYY HH24:MI') AS done_at_display,
            CASE WHEN NOT done AND due_date IS NOT NULL AND due_date < CURRENT_DATE THEN true ELSE false END AS overdue
     FROM public.odg_chatter_activity
     WHERE model = $1 AND record_id = $2
     ORDER BY done ASC, due_date ASC NULLS LAST, id DESC
     LIMIT 100`,
    [String(model ?? "").trim(), String(recordId ?? "").trim()]
  );
}

async function scheduleActivity({ model, recordId, actType, summary, dueDate, assigneeCode, assigneeName, createdBy }) {
  await ensureChatterSchema();
  const m = String(model ?? "").trim();
  const r = String(recordId ?? "").trim();
  const s = String(summary ?? "").trim();
  if (!m || !r) throw new Error("model and record_id are required");
  if (!s) throw new Error("summary is required");
  const res = await pool.query(
    `INSERT INTO public.odg_chatter_activity
       (model, record_id, act_type, summary, due_date, assignee_code, assignee_name, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [m, r, String(actType ?? "todo").trim() || "todo", s,
     dueDate ? String(dueDate).trim() : null,
     assigneeCode ? String(assigneeCode).trim() : null, assigneeName ?? null, createdBy ?? null]
  );
  return { success: true, id: res.rows?.[0]?.id ?? null };
}

async function completeActivity(id) {
  await ensureChatterSchema();
  await pool.query(
    `UPDATE public.odg_chatter_activity SET done = true, done_at = LOCALTIMESTAMP(0) WHERE id = $1`,
    [Number(id)]
  );
  return { success: true };
}

async function deleteActivity(id) {
  await ensureChatterSchema();
  await pool.query(`DELETE FROM public.odg_chatter_activity WHERE id = $1`, [Number(id)]);
  return { success: true };
}

// ---- Users (for @mention + assignee) ----
async function listChatterUsers() {
  return query(
    `SELECT e.employee_code AS code,
            COALESCE(NULLIF(TRIM(e.fullname_lo), ''), NULLIF(TRIM(e.nickname), ''), e.employee_code) AS name
     FROM public.odg_employee e
     WHERE e.employment_status = 'ACTIVE'
     ORDER BY name ASC
     LIMIT 500`
  );
}

module.exports = {
  ensureChatterSchema,
  canAccessRecord,
  listChatterMessages,
  postChatterMessage,
  editChatterMessage,
  deleteChatterMessage,
  getChatterAttachment,
  markChatterRead,
  getUnreadCounts,
  getInboxConversations,
  listDmPeople,
  getDmPeerRead,
  listFollowers,
  toggleFollower,
  addFollowers,
  listActivities,
  scheduleActivity,
  completeActivity,
  deleteActivity,
  listChatterUsers,
};
