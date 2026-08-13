const { pool, query, queryOne } = require("../lib/db");
const { getBranchScope } = require("./helpers");

const billTodoCache = globalThis;

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

async function ensureBillTodoSchemaInternal(db) {
  await safeDdl(db, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_bill_todo (
      id BIGSERIAL PRIMARY KEY,
      bill_no character varying NOT NULL,
      summary text NOT NULL,
      deadline date,
      done boolean DEFAULT false,
      created_by character varying,
      created_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0),
      done_by character varying,
      done_at timestamp without time zone
    )
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_bill_todo_bill_no
    ON public.odg_tms_bill_todo (bill_no)
  `);
  await safeDdl(db, `
    CREATE INDEX IF NOT EXISTS idx_odg_tms_bill_todo_deadline
    ON public.odg_tms_bill_todo (deadline) WHERE done = false
  `);
}

async function ensureBillTodoSchema() {
  if (billTodoCache.__tmsBillTodoSchemaReady) return;
  if (!billTodoCache.__tmsBillTodoSchemaPromise) {
    billTodoCache.__tmsBillTodoSchemaPromise = ensureBillTodoSchemaInternal(pool)
      .then(() => {
        billTodoCache.__tmsBillTodoSchemaReady = true;
      })
      .catch((err) => {
        billTodoCache.__tmsBillTodoSchemaPromise = null;
        throw err;
      });
  }
  await billTodoCache.__tmsBillTodoSchemaPromise;
}

async function ensureWorkerBranchTableForTodo() {
  await safeDdl(pool, `
    CREATE TABLE IF NOT EXISTS public.odg_tms_worker_branch (
      worker_code character varying PRIMARY KEY,
      transport_code character varying,
      position_code character varying,
      updated_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0),
      updated_by character varying
    )
  `);
  await safeDdl(pool, `ALTER TABLE public.odg_tms_worker_branch ADD COLUMN IF NOT EXISTS position_code character varying`);
  await safeDdl(pool, `ALTER TABLE public.odg_tms_worker_branch ALTER COLUMN transport_code DROP NOT NULL`);
}

function normalizeTransportRole(value) {
  const role = String(value ?? "").trim();
  return ["team_lead", "manager", "admin", "driver", "worker", "both"].includes(role)
    ? role
    : "admin";
}

async function getTransportTodoScope(session) {
  const userCode = String(session?.usercode ?? session?.code ?? "").trim();
  const branchScope = getBranchScope(session);
  await ensureWorkerBranchTableForTodo();

  const profile = userCode
    ? await queryOne(
        `SELECT COALESCE(NULLIF(TRIM(position_code), ''), 'admin') AS position_code,
                COALESCE(NULLIF(TRIM(transport_code), ''), $2) AS transport_code
         FROM public.odg_tms_worker_branch
         WHERE worker_code = $1`,
        [userCode, branchScope.branch ?? ""]
      )
    : null;

  const role = normalizeTransportRole(profile?.position_code ?? "admin");
  const branch = String(profile?.transport_code ?? branchScope.branch ?? "").trim();
  const scoped = !!branch && branch !== "02-0004";
  const readOnly = role === "team_lead" || role === "manager";
  return {
    userCode,
    branch,
    scoped,
    role,
    readOnly,
    label: readOnly ? "ທັງໝົດໃນສາຂາຂົນສົ່ງ" : "ຂອງຕົນເອງ",
  };
}

async function assertTodoCanMutate(session) {
  const scope = await getTransportTodoScope(session);
  if (scope.readOnly) {
    throw new Error("read only");
  }
  return scope;
}

// Aggregated summary used when rendering bills lists: returns one row per
// bill_no with pending count + earliest deadline so the UI can colour the
// indicator without fetching every todo upfront.
async function getBillTodoSummaryMap(billNos) {
  if (!Array.isArray(billNos) || billNos.length === 0) return new Map();
  await ensureBillTodoSchema();
  const rows = await query(
    `SELECT bill_no,
            COUNT(*) FILTER (WHERE done = false)::int AS pending_count,
            COUNT(*) FILTER (WHERE done = true)::int  AS done_count,
            to_char(MIN(deadline) FILTER (WHERE done = false), 'YYYY-MM-DD') AS earliest_deadline,
            to_char(MIN(deadline) FILTER (WHERE done = false), 'DD-MM-YYYY') AS earliest_deadline_display
     FROM public.odg_tms_bill_todo
     WHERE bill_no = ANY($1::varchar[])
     GROUP BY bill_no`,
    [billNos]
  );
  return new Map(rows.map((r) => [r.bill_no, r]));
}

async function getBillTodos(billNo) {
  const code = String(billNo ?? "").trim();
  if (!code) return [];
  await ensureBillTodoSchema();
  return query(
    `SELECT id, bill_no, summary,
            to_char(deadline,'YYYY-MM-DD') AS deadline,
            to_char(deadline,'DD-MM-YYYY') AS deadline_display,
            done,
            COALESCE(created_by,'') AS created_by,
            to_char(created_at,'DD-MM-YYYY HH24:MI') AS created_at,
            COALESCE(done_by,'') AS done_by,
            to_char(done_at,'DD-MM-YYYY HH24:MI') AS done_at
     FROM public.odg_tms_bill_todo
     WHERE bill_no = $1
     ORDER BY done ASC, deadline ASC NULLS LAST, id DESC`,
    [code]
  );
}

async function createBillTodo({ billNo, summary, deadline, userCode, session }) {
  const code = String(billNo ?? "").trim();
  const text = String(summary ?? "").trim();
  if (!code) throw new Error("bill_no is required");
  if (!text) throw new Error("ກະລຸນາໃສ່ໃນລາຍລະອຽດ");
  await assertTodoCanMutate(session);
  await ensureBillTodoSchema();

  const date = deadline ? String(deadline).trim() || null : null;
  const user = userCode ? String(userCode).trim() || null : null;

  const row = await queryOne(
    `INSERT INTO public.odg_tms_bill_todo (bill_no, summary, deadline, created_by)
     VALUES ($1, $2, $3::date, $4)
     RETURNING id`,
    [code, text, date, user]
  );
  return { success: true, id: row?.id ?? null };
}

async function setBillTodoDone({ id, done, userCode, session }) {
  if (!id) throw new Error("id is required");
  await assertTodoCanMutate(session);
  await ensureBillTodoSchema();
  const user = userCode ? String(userCode).trim() || null : null;
  await pool.query(
    `UPDATE public.odg_tms_bill_todo
     SET done = $2,
         done_by = CASE WHEN $2 THEN $3 ELSE NULL END,
         done_at = CASE WHEN $2 THEN LOCALTIMESTAMP(0) ELSE NULL END
     WHERE id = $1`,
    [id, Boolean(done), user]
  );
  return { success: true };
}

async function deleteBillTodo(id, session) {
  if (!id) throw new Error("id is required");
  await assertTodoCanMutate(session);
  await ensureBillTodoSchema();
  await pool.query(`DELETE FROM public.odg_tms_bill_todo WHERE id = $1`, [id]);
  return { success: true };
}

// Cross-bill roll-up of every todo staff have marked, joined to the bill's
// customer + delivery branch so the consolidated page can show context without
// a per-bill fetch. Branch-scoped users only see their branch's bills; pass
// includeDone=true to also return completed items (default: open only).
async function getAllBillTodos(session, includeDone) {
  await ensureBillTodoSchema();
  const scope = await getTransportTodoScope(session);
  const params = [];
  const addParam = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const branchWhere = scope.scoped ? `AND a.transport_code = ${addParam(scope.branch)}` : "";
  const ownerWhere = scope.readOnly ? "" : `AND COALESCE(NULLIF(TRIM(t.created_by), ''), '') = ${addParam(scope.userCode)}`;
  const readOnlyParam = addParam(scope.readOnly);
  const roleParam = addParam(scope.role);
  const labelParam = addParam(scope.label);
  const doneWhere = includeDone ? "" : "AND t.done = false";
  return query(
    `SELECT t.id, t.bill_no, t.summary,
            to_char(t.deadline,'YYYY-MM-DD') AS deadline,
            to_char(t.deadline,'DD-MM-YYYY') AS deadline_display,
            t.done,
            COALESCE(t.created_by,'') AS created_by,
            COALESCE(t.created_by,'') AS owner_code,
            COALESCE(
              NULLIF(TRIM(owner_e.fullname_lo), ''),
              NULLIF(TRIM(owner_e.nickname), ''),
              NULLIF(TRIM(owner_u.name_1), ''),
              NULLIF(TRIM(t.created_by), ''),
              ''
            ) AS owner_name,
            to_char(t.created_at,'DD-MM-YYYY HH24:MI') AS created_at,
            COALESCE(t.done_by,'') AS done_by,
            to_char(t.done_at,'DD-MM-YYYY HH24:MI') AS done_at,
            COALESCE(NULLIF(TRIM(cust.name_1), ''), a.transport_name, '') AS customer,
            COALESCE(a.cust_code, '') AS cust_code,
            COALESCE(a.transport_code, '') AS transport_code,
            COALESCE(tt.name_1, '') AS transport,
            ${readOnlyParam}::boolean AS scope_readonly,
            ${roleParam}::text AS scope_role,
            ${labelParam}::text AS scope_label
     FROM public.odg_tms_bill_todo t
     LEFT JOIN ic_trans_shipment a ON a.doc_no = t.bill_no
     LEFT JOIN ar_customer cust ON cust.code = a.cust_code
     LEFT JOIN transport_type tt ON tt.code = a.transport_code
     LEFT JOIN public.erp_user owner_u ON owner_u.code = t.created_by
     LEFT JOIN public.odg_employee owner_e ON owner_e.employee_code = t.created_by
     WHERE 1=1 ${doneWhere} ${branchWhere} ${ownerWhere}
     ORDER BY t.done ASC, t.deadline ASC NULLS LAST, t.id DESC
     LIMIT 1000`,
    params
  );
}

module.exports = {
  ensureBillTodoSchema,
  getBillTodoSummaryMap,
  getBillTodos,
  getAllBillTodos,
  createBillTodo,
  setBillTodoDone,
  deleteBillTodo,
};
