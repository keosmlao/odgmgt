import { NextResponse } from "next/server";
import { rows, query } from "@/lib/db";
import { mineWhere, readAction, readFilter, readReason, readScope, requireUser, textStatusWhere } from "@/lib/approvals";

/** Purchase requisitions — odg_pm_pr with its lines in odg_pm_pr_line. */
export async function GET(request) {
  const auth = requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  try {
    const filter = readFilter(request);
    const scope = readScope(request);
    const params = [];
    const mine = mineWhere(scope, ["p.requester_code", "p.created_by", "p.approved_by"], auth.code, params);

    const docs = await rows(
      `
      SELECT p.id, p.pr_no, p.doc_date, p.department_code, p.requester_code, p.need_date, p.note,
             p.status, p.reject_reason, p.approved_by, p.approved_at, p.po_no, p.created_by, p.created_at,
             coalesce(l.line_count, 0) AS line_count,
             coalesce(l.est_total, 0) AS est_total,
             re.fullname_lo AS requester_name,
             ae.fullname_lo AS approver_name
      FROM public.odg_pm_pr p
      LEFT JOIN (
        SELECT pr_id, count(*)::int AS line_count, sum(coalesce(qty, 0) * coalesce(est_price, 0)) AS est_total
        FROM public.odg_pm_pr_line
        GROUP BY pr_id
      ) l ON l.pr_id = p.id
      LEFT JOIN public.odg_employee re ON re.employee_code = p.requester_code
      LEFT JOIN public.odg_employee ae ON ae.employee_code = p.approved_by
      WHERE ${textStatusWhere(filter, "p.status")} AND ${mine}
      ORDER BY p.id DESC
      LIMIT 200
      `,
      params,
    );

    const ids = docs.map((doc) => doc.id).filter((id) => id != null);
    const lines = ids.length
      ? await rows(
          `
          SELECT pr_id, line_no, item_code, item_name, unit, qty, est_price, note
          FROM public.odg_pm_pr_line
          WHERE pr_id = ANY(%s::bigint[])
          ORDER BY pr_id, line_no
          `,
          [ids],
        )
      : [];

    return NextResponse.json({ success: true, data: { docs, lines } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/** Approves or rejects one requisition. Already-settled rows are left alone. */
export async function POST(request) {
  const auth = requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  try {
    const body = await request.json();
    const action = readAction(body);
    const id = Number(body?.key);
    if (!action || !Number.isFinite(id)) {
      return NextResponse.json({ success: false, message: "invalid request" }, { status: 400 });
    }

    const result = await query(
      `
      UPDATE public.odg_pm_pr
         SET status = %s,
             reject_reason = %s,
             approved_by = %s,
             approved_at = now(),
             updated_at = now()
       WHERE id = %s
         AND lower(coalesce(status, '')) NOT IN ('approved','rejected','cancelled','canceled','closed')
      `,
      [
        action === "approve" ? "approved" : "rejected",
        action === "approve" ? null : readReason(body),
        auth.code,
        id,
      ],
    );

    if (!result.rowCount) {
      return NextResponse.json({ success: false, message: "already handled" }, { status: 409 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
