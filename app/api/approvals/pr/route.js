import { NextResponse } from "next/server";
import { rows, one, query } from "@/lib/db";
import { auditLog, requestIp } from "@/lib/audit";
import { ensurePrApprovalTable } from "@/lib/migrations";
import {
  PR_BASE,
  PR_LINES,
  mineWhere,
  readAction,
  readFilter,
  readReason,
  readScope,
  requireUser,
  textStatusWhere,
} from "@/lib/approvals";

/**
 * ໃບຂໍຊື້ — ERP requisitions (ic_trans, trans_flag 2) with this system's own
 * approval trail on top, and the PM module's own requisitions alongside.
 *
 * The queue used to read odg_pm_pr alone, a table nothing writes to, so it was
 * empty while the ERP held 35 requisitions waiting for someone. See PR_BASE.
 */
export async function GET(request) {
  const auth = requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  try {
    await ensurePrApprovalTable();

    const filter = readFilter(request);
    const scope = readScope(request);
    const params = [];
    // Whoever raised it in the ERP, entered it, or has already ruled on it.
    const mine = mineWhere(
      scope,
      ["pr.requester_code", "pr.erp_creator_code", "pr.created_by", "pr.approved_by"],
      auth.code,
      params,
    );

    const docs = await rows(
      `
      SELECT * FROM (${PR_BASE}) pr
      WHERE ${textStatusWhere(filter, "pr.status")} AND ${mine}
      ORDER BY pr.doc_date DESC NULLS LAST, pr.doc_no DESC
      LIMIT 200
      `,
      params,
    );

    const docNos = docs.map((doc) => doc.doc_no).filter(Boolean);
    const lines = docNos.length ? await rows(PR_LINES, [docNos, docNos]) : [];

    return NextResponse.json({ success: true, data: { docs, lines } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/**
 * Approves or rejects one requisition. The verdict goes to this system's trail
 * — the ERP's own approve_status belongs to the ERP's approval screen and is
 * not written from here, exactly as the PO queue leaves it alone.
 */
export async function POST(request) {
  const auth = requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  try {
    await ensurePrApprovalTable();

    const body = await request.json();
    const action = readAction(body);
    const docNo = String(body?.key || "").trim();
    if (!action || !docNo) {
      return NextResponse.json({ success: false, message: "invalid request" }, { status: 400 });
    }

    const known = await one(
      `
      SELECT 1 AS ok
      FROM public.ic_trans t
      WHERE t.doc_no = %s AND t.trans_flag = 2
      UNION ALL
      SELECT 1 FROM public.odg_pm_pr p WHERE p.pr_no = %s
      LIMIT 1
      `,
      [docNo, docNo],
    );
    if (!known) {
      return NextResponse.json({ success: false, message: "pr not found" }, { status: 404 });
    }

    const status = action === "approve" ? "approved" : "rejected";
    const reason = action === "approve" ? null : readReason(body);

    const result = await query(
      `
      INSERT INTO public.odg_pm_pr_approval
        (doc_no, status, approved_by, approved_at, reject_reason, created_by, created_at, updated_at)
      VALUES (%s, %s, %s, now(), %s, %s, now(), now())
      ON CONFLICT (doc_no) DO UPDATE
        SET status = EXCLUDED.status,
            approved_by = EXCLUDED.approved_by,
            approved_at = now(),
            reject_reason = EXCLUDED.reject_reason,
            updated_at = now()
        WHERE lower(coalesce(public.odg_pm_pr_approval.status, '')) NOT IN ('approved','rejected','cancelled','canceled','closed')
      `,
      [docNo, status, auth.code, reason, auth.code],
    );

    if (!result.rowCount) {
      return NextResponse.json({ success: false, message: "already handled" }, { status: 409 });
    }

    // Keep the module's own row in step when the requisition also lives there.
    await query(
      `UPDATE public.odg_pm_pr
          SET status = %s, reject_reason = %s, approved_by = %s, approved_at = now(), updated_at = now()
        WHERE pr_no = %s`,
      [status, reason, auth.code, docNo],
    );

    auditLog(
      auth.code,
      action === "approve" ? "pr_approved" : "pr_rejected",
      `${docNo}${reason ? ` · ${reason}` : ""}`,
      requestIp(request),
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
