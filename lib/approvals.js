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
 * A purchase order is spread over three tables:
 *   odg_pm_po_approval — the approval trail, keyed by doc_no
 *   odg_pm_po          — the PM module's own order (usually absent)
 *   ic_trans           — the ERP document the POT… numbers actually belong to
 * The full join keeps every document visible; the lateral join fills in
 * supplier, dates and totals from the ERP row.
 */
export const PO_BASE = `
  WITH base AS (
    SELECT coalesce(a.doc_no, p.po_no) AS doc_no,
           coalesce(a.status, p.status) AS status,
           a.poa_no, a.wpoa_no, a.submitted_by, a.submitted_at,
           a.approved_by, a.approved_at, a.reject_reason,
           p.id AS po_id, p.supplier_code AS pm_supplier_code, p.supplier_name AS pm_supplier_name,
           p.project_id, p.contract_no, p.order_date AS pm_order_date,
           p.expected_date AS pm_expected_date, p.total AS pm_total, p.note AS pm_note,
           coalesce(a.created_by, p.created_by) AS created_by,
           coalesce(a.created_at, p.created_at) AS created_at
    FROM public.odg_pm_po_approval a
    FULL JOIN public.odg_pm_po p ON p.po_no = a.doc_no
  )
  SELECT b.doc_no, b.status, b.poa_no, b.wpoa_no, b.submitted_by, b.submitted_at,
         b.approved_by, b.approved_at, b.reject_reason, b.po_id, b.project_id, b.contract_no,
         b.created_by, b.created_at,
         coalesce(b.pm_supplier_code, e.cust_code) AS supplier_code,
         coalesce(b.pm_supplier_name, s.name_1) AS supplier_name,
         coalesce(b.pm_order_date, e.doc_date) AS order_date,
         coalesce(b.pm_expected_date, e.send_date) AS expected_date,
         coalesce(nullif(b.pm_total, 0), e.total_amount) AS total,
         coalesce(b.pm_note, e.remark) AS note,
         e.doc_time, e.branch_code, e.currency_code, e.exchange_rate, e.vat_rate,
         e.total_before_vat, e.total_vat_value, e.total_after_vat,
         e.credit_date, e.expire_date, e.approve_status AS erp_approve_status,
         e.creator_code AS erp_creator_code, e.user_request, e.create_datetime,
         se.fullname_lo AS submitter_name,
         ae.fullname_lo AS approver_name,
         ce.fullname_lo AS erp_creator_name,
         ue.fullname_lo AS requester_name
  FROM base b
  LEFT JOIN LATERAL (
    SELECT t.cust_code, t.doc_date, t.send_date, t.total_amount, t.remark, t.doc_time, t.branch_code,
           t.currency_code, t.exchange_rate, t.vat_rate, t.total_before_vat, t.total_vat_value,
           t.total_after_vat, t.credit_date, t.expire_date, t.approve_status, t.creator_code,
           t.user_request, t.create_datetime
    FROM public.ic_trans t
    WHERE t.doc_no = b.doc_no
    ORDER BY t.roworder DESC
    LIMIT 1
  ) e ON TRUE
  LEFT JOIN public.ap_supplier s ON s.code = e.cust_code
  LEFT JOIN public.odg_employee se ON se.employee_code = b.submitted_by
  LEFT JOIN public.odg_employee ae ON ae.employee_code = b.approved_by
  LEFT JOIN public.odg_employee ce ON ce.employee_code = e.creator_code
  LEFT JOIN public.odg_employee ue ON ue.employee_code = e.user_request
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
