import { NextResponse } from "next/server";
import { rows, query } from "@/lib/db";
import { mineWhere, numericStatusWhere, readAction, readFilter, readScope, requireUser } from "@/lib/approvals";

/**
 * Product name approvals come from two places:
 *   odg_manage_product(+_detail) — RQ documents asking to create / rename items
 *   odg_product_draft            — new item drafts waiting for sign-off
 * Both use a smallint status: 0 waiting, 1 approved, -1 rejected.
 */
export async function GET(request) {
  const auth = requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  try {
    const filter = readFilter(request);
    const scope = readScope(request);

    const docParams = [];
    const docMine = mineWhere(scope, ["m.creator_code", "m.approve_code"], auth.code, docParams);
    const draftParams = [];
    const draftMine = mineWhere(scope, ["d.user_created", "d.approver"], auth.code, draftParams);

    const [docs, drafts] = await Promise.all([
      rows(
        `
        SELECT m.doc_no, m.doc_date, m.status, m.item_count, m.creator_code,
               m.approve_code, m.approve_time, m.create_date_time_now,
               ce.fullname_lo AS creator_name,
               ae.fullname_lo AS approver_name
        FROM public.odg_manage_product m
        LEFT JOIN public.odg_employee ce ON ce.employee_code = m.creator_code
        LEFT JOIN public.odg_employee ae ON ae.employee_code = m.approve_code
        WHERE ${numericStatusWhere(filter, "m.status")} AND ${docMine}
        ORDER BY m.roworder DESC
        LIMIT 200
        `,
        docParams,
      ),
      rows(
        `
        SELECT d.roworder, d.name_1, d.name_2, d.unit_code, d.wh_code, d.ph5 AS brand_code,
               d.user_created, d.approve_status, d.approver, d.requst_status, d.created_date_time_now
        FROM public.odg_product_draft d
        WHERE ${numericStatusWhere(filter, "d.approve_status")} AND ${draftMine}
        ORDER BY d.roworder DESC
        LIMIT 200
        `,
        draftParams,
      ),
    ]);

    const docNos = docs.map((doc) => doc.doc_no).filter(Boolean);
    const lines = docNos.length
      ? await rows(
          `
          SELECT doc_no, code, name_1, name_2, new_name_1, new_name_2
          FROM public.odg_manage_product_detail
          WHERE doc_no = ANY(%s::text[])
          ORDER BY roworder
          `,
          [docNos],
        )
      : [];

    return NextResponse.json({ success: true, data: { docs, lines, drafts } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/** Approves or rejects one RQ document or one draft item. */
export async function POST(request) {
  const auth = requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  try {
    const body = await request.json();
    const action = readAction(body);
    const source = String(body?.source || "").toLowerCase();
    if (!action) {
      return NextResponse.json({ success: false, message: "invalid action" }, { status: 400 });
    }

    const status = action === "approve" ? 1 : -1;

    if (source === "doc") {
      const docNo = String(body?.key || "").trim();
      if (!docNo) {
        return NextResponse.json({ success: false, message: "doc_no required" }, { status: 400 });
      }
      const result = await query(
        `
        UPDATE public.odg_manage_product
           SET status = %s, approve_code = %s, approve_time = now(), update_code = %s, update_time = now()
         WHERE doc_no = %s AND coalesce(status, 0) = 0
        `,
        [status, auth.code, auth.code, docNo],
      );
      if (!result.rowCount) {
        return NextResponse.json({ success: false, message: "already handled" }, { status: 409 });
      }
      return NextResponse.json({ success: true });
    }

    if (source === "draft") {
      const rowOrder = Number(body?.key);
      if (!Number.isFinite(rowOrder)) {
        return NextResponse.json({ success: false, message: "roworder required" }, { status: 400 });
      }
      const result = await query(
        `
        UPDATE public.odg_product_draft
           SET approve_status = %s, approver = %s
         WHERE roworder = %s AND coalesce(approve_status, 0) = 0
        `,
        [status, auth.code, rowOrder],
      );
      if (!result.rowCount) {
        return NextResponse.json({ success: false, message: "already handled" }, { status: 409 });
      }
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, message: "invalid source" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
