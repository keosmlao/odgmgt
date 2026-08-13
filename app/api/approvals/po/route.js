import { NextResponse } from "next/server";
import { rows, one, query } from "@/lib/db";
import { auditLog, requestIp } from "@/lib/audit";
import {
  PO_BASE,
  PO_ITEMS,
  mineWhere,
  readAction,
  readFilter,
  readReason,
  readScope,
  requireUser,
  textStatusWhere,
} from "@/lib/approvals";

export async function GET(request) {
  const auth = requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  try {
    const filter = readFilter(request);
    const scope = readScope(request);
    const params = [];
    const mine = mineWhere(
      scope,
      ["po.submitted_by", "po.created_by", "po.approved_by", "po.erp_creator_code", "po.user_request"],
      auth.code,
      params,
    );

    const docs = await rows(
      `
      SELECT * FROM (${PO_BASE}) po
      WHERE ${textStatusWhere(filter, "po.status")} AND ${mine}
      ORDER BY po.created_at DESC NULLS LAST, po.doc_no DESC
      LIMIT 200
      `,
      params,
    );

    const docNos = docs.map((doc) => doc.doc_no).filter(Boolean);
    const items = docNos.length ? await rows(PO_ITEMS, [docNos, docNos]) : [];

    return NextResponse.json({ success: true, data: { docs, items } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/** Approves or rejects one PO — the verdict is written to the approval trail. */
export async function POST(request) {
  const auth = requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  try {
    const body = await request.json();
    const action = readAction(body);
    const docNo = String(body?.key || "").trim();
    if (!action || !docNo) {
      return NextResponse.json({ success: false, message: "invalid request" }, { status: 400 });
    }

    const known = await one(
      `
      SELECT 1 AS ok
      FROM public.odg_pm_po_approval a
      FULL JOIN public.odg_pm_po p ON p.po_no = a.doc_no
      WHERE coalesce(a.doc_no, p.po_no) = %s
      LIMIT 1
      `,
      [docNo],
    );
    if (!known) {
      return NextResponse.json({ success: false, message: "po not found" }, { status: 404 });
    }

    const status = action === "approve" ? "approved" : "rejected";
    const reason = action === "approve" ? null : readReason(body);

    const result = await query(
      `
      INSERT INTO public.odg_pm_po_approval
        (doc_no, status, approved_by, approved_at, reject_reason, created_by, created_at, updated_at)
      VALUES (%s, %s, %s, now(), %s, %s, now(), now())
      ON CONFLICT (doc_no) DO UPDATE
        SET status = EXCLUDED.status,
            approved_by = EXCLUDED.approved_by,
            approved_at = now(),
            reject_reason = EXCLUDED.reject_reason,
            updated_at = now()
        WHERE lower(coalesce(public.odg_pm_po_approval.status, '')) NOT IN ('approved','rejected','cancelled','canceled','closed')
      `,
      [docNo, status, auth.code, reason, auth.code],
    );

    if (!result.rowCount) {
      return NextResponse.json({ success: false, message: "already handled" }, { status: 409 });
    }

    // Keep the order row in step when the PO also lives in odg_pm_po.
    await query(`UPDATE public.odg_pm_po SET status = %s WHERE po_no = %s`, [status, docNo]);

    // The PM app keeps a plain-language trail on the document; add to it.
    await query(
      `INSERT INTO public.odg_pm_po_comment (doc_no, kind, body, created_by) VALUES (%s, 'log', %s, %s)`,
      [docNo, action === "approve" ? "ອະນຸມັດ PO" : `ປະຕິເສດ PO${reason ? ` · ${reason}` : ""}`, auth.code],
    );

    auditLog(auth.code, action === "approve" ? "po_approved" : "po_rejected", `${docNo}${reason ? ` · ${reason}` : ""}`, requestIp(request));
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
