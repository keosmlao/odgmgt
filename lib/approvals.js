import { getCurrentUser } from "./route-auth";

/**
 * Shared pieces for the three approval queues (product names, PR, PO).
 *
 * The queues are open to every account that can sign in, so the guard below
 * only proves the caller is signed in and hands back the employee code that
 * gets written into approve_code / approved_by / approver.
 */
export function requireUser(request) {
  const user = getCurrentUser(request);
  const code = String(user?.username || "").trim();
  if (!user || !code) return { ok: false, status: 401, message: "unauthorized" };
  return { ok: true, user, code };
}

export const FILTERS = ["pending", "approved", "rejected", "all"];

export function readFilter(request) {
  const value = String(request.nextUrl.searchParams.get("filter") || "pending").toLowerCase();
  return FILTERS.includes(value) ? value : "pending";
}

/**
 * "mine" keeps only the documents the signed-in employee is tied to; "all"
 * drops the restriction. There is no approver table in the database
 * (erp_doc_approve / erp_user_group_approve are empty), so involvement is
 * read from whoever raised, submitted or already ruled on the document.
 */
export function readScope(request) {
  return String(request.nextUrl.searchParams.get("scope") || "mine").toLowerCase() === "all" ? "all" : "mine";
}

/**
 * Builds `(col1 = %s OR col2 = %s …)` for the "mine" scope and pushes the
 * employee code once per column. Returns TRUE when the scope is "all".
 */
export function mineWhere(scope, columns, code, params) {
  if (scope === "all" || !columns.length) return "TRUE";
  const parts = columns.map((column) => {
    params.push(code);
    return `${column} = %s`;
  });
  return `(${parts.join(" OR ")})`;
}

/**
 * Text status columns (odg_pm_pr, odg_pm_po, odg_pm_po_approval). Those tables
 * default to 'draft' and only ever settle on 'approved' / 'rejected', so
 * anything not settled is still waiting for someone.
 */
const SETTLED = "('approved','rejected','cancelled','canceled','closed')";

export function textStatusWhere(filter, column) {
  if (filter === "approved") return `lower(${column}) = 'approved'`;
  if (filter === "rejected") return `lower(${column}) = 'rejected'`;
  if (filter === "pending") return `lower(coalesce(${column}, '')) NOT IN ${SETTLED}`;
  return "TRUE";
}

/** Smallint status columns (odg_manage_product, odg_product_draft): 1 approved, -1 rejected, 0 waiting. */
export function numericStatusWhere(filter, column) {
  if (filter === "approved") return `${column} = 1`;
  if (filter === "rejected") return `${column} = -1`;
  if (filter === "pending") return `coalesce(${column}, 0) = 0`;
  return "TRUE";
}

/**
 * ໃບສັ່ງຊື້ / ໃບຂໍຊື້ — both live in the ERP and both are approved here.
 *
 * The documents are raised in the ERP (ic_trans: trans_flag 6 carries the PO…
 * numbers, trans_flag 2 the PR… ones) and never touch this system until
 * somebody rules on them. So the ERP side DRIVES both queues and the local
 * tables hang off it:
 *
 *   odg_pm_po_approval / odg_pm_pr_approval — the verdict, keyed by doc_no
 *   odg_pm_po / odg_pm_pr                   — the PM module's own documents
 *
 * Built the other way round — trail FULL JOIN module, the ERP only filled in —
 * the PO queue showed the single order somebody had once submitted here and
 * the PR queue showed nothing at all, while the ERP held 46 orders and 58
 * requisitions waiting for a decision.
 *
 * ສະຖານະ: a verdict given here wins, because it is the later word; but only a
 * VERDICT does. The PM app writes 'draft' when a document is submitted, and a
 * draft must not hide an order the ERP has already approved.
 */
const VERDICT = "('approved','rejected','cancelled','canceled','closed')";

/** Trail verdict, else the ERP's own reading of the document. */
const statusSql = (trail, erpApprove, erpLast, erpDoc, fallback) => `
  CASE WHEN lower(coalesce(${trail}, '')) IN ${VERDICT} THEN ${trail}
       WHEN coalesce(${erpLast}, 0) <> 0 THEN 'cancelled'
       WHEN coalesce(${erpApprove}, 0) = 1 THEN 'approved'
       WHEN ${erpDoc} IS NOT NULL THEN 'pending'
       ELSE coalesce(${trail}, ${fallback}) END`;

/**
 * One row per ERP document: ic_trans can hold more than one row for a doc_no
 * and the newest is the one that counts.
 */
const erpDocs = (where) => `
  SELECT DISTINCT ON (t.doc_no) t.*
  FROM public.ic_trans t
  WHERE ${where}
  ORDER BY t.doc_no, t.roworder DESC`;

export const PO_ERP_WHERE = `t.trans_flag = 6 AND t.doc_no LIKE 'PO%'`;

export const PO_BASE = `
  WITH erp AS (${erpDocs("t.trans_flag = 6 AND t.doc_no LIKE 'PO%'")}),
  base AS (
    SELECT coalesce(a.doc_no, e.doc_no, p.po_no) AS doc_no,
           ${statusSql("a.status", "e.approve_status", "e.last_status", "e.doc_no", "p.status")} AS status,
           a.poa_no, a.wpoa_no, a.submitted_by, a.submitted_at,
           a.approved_by, a.approved_at, a.reject_reason,
           p.id AS po_id, p.supplier_code AS pm_supplier_code, p.supplier_name AS pm_supplier_name,
           p.project_id, p.contract_no, p.order_date AS pm_order_date,
           p.expected_date AS pm_expected_date, p.total AS pm_total, p.note AS pm_note,
           coalesce(a.created_by, e.creator_code, p.created_by) AS created_by,
           coalesce(a.created_at, e.create_datetime, p.created_at) AS created_at,
           e.cust_code, e.doc_date AS erp_doc_date, e.send_date, e.total_amount, e.remark,
           e.doc_time, e.branch_code, e.currency_code, e.exchange_rate, e.vat_rate,
           e.total_before_vat, e.total_vat_value, e.total_after_vat,
           e.credit_date, e.expire_date, e.approve_status, e.creator_code, e.user_request,
           e.create_datetime
    FROM erp e
    FULL JOIN public.odg_pm_po_approval a ON a.doc_no = e.doc_no
    FULL JOIN public.odg_pm_po p ON p.po_no = coalesce(a.doc_no, e.doc_no)
  )
  SELECT b.doc_no, b.status, b.poa_no, b.wpoa_no, b.submitted_by, b.submitted_at,
         b.approved_by, b.approved_at, b.reject_reason, b.po_id, b.project_id, b.contract_no,
         b.created_by, b.created_at,
         coalesce(b.pm_supplier_code, b.cust_code) AS supplier_code,
         coalesce(b.pm_supplier_name, s.name_1) AS supplier_name,
         coalesce(b.pm_order_date, b.erp_doc_date) AS order_date,
         coalesce(b.pm_expected_date, b.send_date) AS expected_date,
         coalesce(nullif(b.pm_total, 0), b.total_amount) AS total,
         coalesce(b.pm_note, b.remark) AS note,
         b.doc_time, b.branch_code, b.currency_code, b.exchange_rate, b.vat_rate,
         b.total_before_vat, b.total_vat_value, b.total_after_vat,
         b.credit_date, b.expire_date, b.approve_status AS erp_approve_status,
         b.creator_code AS erp_creator_code, b.user_request, b.create_datetime,
         se.fullname_lo AS submitter_name,
         ae.fullname_lo AS approver_name,
         ce.fullname_lo AS erp_creator_name,
         ue.fullname_lo AS requester_name
  FROM base b
  LEFT JOIN public.ap_supplier s ON s.code = b.cust_code
  LEFT JOIN public.odg_employee se ON se.employee_code = b.submitted_by
  LEFT JOIN public.odg_employee ae ON ae.employee_code = b.approved_by
  LEFT JOIN public.odg_employee ce ON ce.employee_code = b.creator_code
  LEFT JOIN public.odg_employee ue ON ue.employee_code = b.user_request
`;

export const PR_ERP_WHERE = `t.trans_flag = 2 AND t.doc_no LIKE 'PR%'`;

export const PR_BASE = `
  WITH erp AS (${erpDocs("t.trans_flag = 2 AND t.doc_no LIKE 'PR%'")}),
  lines AS (
    SELECT d.doc_no, count(*)::int AS line_count,
           sum(coalesce(d.qty, 0) * coalesce(d.price, 0)) AS est_total
    FROM public.ic_trans_detail d
    WHERE d.doc_no LIKE 'PR%'
    GROUP BY d.doc_no
  ),
  pm AS (
    SELECT p.*, coalesce(l.line_count, 0) AS pm_line_count, coalesce(l.est_total, 0) AS pm_est_total
    FROM public.odg_pm_pr p
    LEFT JOIN (
      SELECT pr_id, count(*)::int AS line_count,
             sum(coalesce(qty, 0) * coalesce(est_price, 0)) AS est_total
      FROM public.odg_pm_pr_line
      GROUP BY pr_id
    ) l ON l.pr_id = p.id
  ),
  base AS (
    SELECT coalesce(a.doc_no, e.doc_no, pm.pr_no) AS doc_no,
           ${statusSql("a.status", "e.approve_status", "e.last_status", "e.doc_no", "pm.status")} AS status,
           a.approved_by, a.approved_at, a.reject_reason,
           pm.id AS pr_id,
           coalesce(e.doc_date, pm.doc_date) AS doc_date,
           coalesce(nullif(btrim(coalesce(e.department_code, '')), ''), pm.department_code) AS department_code,
           coalesce(e.user_request, e.creator_code, pm.requester_code) AS requester_code,
           coalesce(e.send_date, pm.need_date) AS need_date,
           coalesce(nullif(btrim(coalesce(e.remark, '')), ''), pm.note) AS note,
           coalesce(nullif(l.line_count, 0), pm.pm_line_count, 0) AS line_count,
           coalesce(nullif(l.est_total, 0), nullif(e.total_amount, 0), pm.pm_est_total, 0) AS est_total,
           pm.po_no,
           coalesce(a.created_by, e.creator_code, pm.created_by) AS created_by,
           coalesce(a.created_at, e.create_datetime, pm.created_at) AS created_at,
           e.creator_code AS erp_creator_code, e.doc_time, e.branch_code,
           e.approve_status AS erp_approve_status
    FROM erp e
    FULL JOIN public.odg_pm_pr_approval a ON a.doc_no = e.doc_no
    LEFT JOIN lines l ON l.doc_no = e.doc_no
    FULL JOIN pm ON pm.pr_no = coalesce(a.doc_no, e.doc_no)
  )
  SELECT b.*,
         re.fullname_lo AS requester_name,
         ae.fullname_lo AS approver_name,
         /*
          * ຊື່ພະແນກ: the document carries an ERP department code, and when it
          * does not — some requisitions are raised without one — the person who
          * raised it still belongs to a department, which is the honest answer
          * to "whose requisition is this". The two code systems are different
          * (ERP 2031 · HR 201), hence two lookups.
          *
          * The HR list writes the same department with a ພະແນກ prefix the ERP
          * list leaves off, and the queue groups on this name: left alone,
          * ຂາຍສົ່ງປະປາ and ພະແນກຂາຍສົ່ງປະປາ became two groups for one
          * department. Stripping the prefix is what makes them one.
          */
         coalesce(ed.name_1, regexp_replace(hd.name_1, '^ພະແນກ\\s*', '')) AS department_name
  FROM base b
  LEFT JOIN public.odg_employee re ON re.employee_code = b.requester_code
  LEFT JOIN public.odg_employee ae ON ae.employee_code = b.approved_by
  LEFT JOIN public.erp_department_list ed ON ed.code = b.department_code
  LEFT JOIN public.odg_department_list hd ON hd.code = re.department_code
`;

export const PR_LINES = `
  SELECT d.doc_no, d.line_number AS line_no, d.item_code, d.item_name,
         d.unit_code AS unit, d.qty, d.price AS est_price, d.remark AS note
  FROM public.ic_trans_detail d
  WHERE d.doc_no = ANY(%s::text[])
  UNION ALL
  SELECT p.pr_no, i.line_no, i.item_code, i.item_name, i.unit, i.qty, i.est_price, i.note
  FROM public.odg_pm_pr_line i
  JOIN public.odg_pm_pr p ON p.id = i.pr_id
  WHERE p.pr_no = ANY(%s::text[])
`;

/** Items come from the ERP document, or from the PM order when it has its own. */
export const PO_ITEMS = `
  SELECT d.doc_no, d.item_code, d.item_name, d.unit_code, d.qty,
         d.price AS unit_price, d.sum_amount AS total, d.wh_code, d.shelf_code,
         w.name_1 AS wh_name, sh.name_1 AS shelf_name
  FROM public.ic_trans_detail d
  LEFT JOIN public.ic_warehouse w ON w.code = d.wh_code
  LEFT JOIN public.ic_shelf sh ON sh.code = d.shelf_code
  WHERE d.doc_no = ANY(%s::text[])
  UNION ALL
  SELECT p.po_no, i.item_code, i.item_name, i.unit_code, i.qty,
         i.unit_price, i.total, NULL, NULL, NULL, NULL
  FROM public.odg_pm_po_item i
  JOIN public.odg_pm_po p ON p.id = i.po_id
  WHERE p.po_no = ANY(%s::text[])
`;

export function readAction(body) {
  const action = String(body?.action || "").toLowerCase();
  return action === "approve" || action === "reject" ? action : null;
}

export function readReason(body) {
  const reason = String(body?.reason || "").trim();
  return reason ? reason.slice(0, 500) : null;
}
