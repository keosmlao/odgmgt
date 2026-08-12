import { NextResponse } from "next/server";
import { rows, one } from "@/lib/db";
import { PO_BASE, PO_ITEMS, requireUser } from "@/lib/approvals";

/** Everything known about one PO: header, item lines and the activity trail. */
export async function GET(request, { params }) {
  const auth = requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  try {
    const { docNo } = await params;
    const key = decodeURIComponent(String(docNo || "")).trim();
    if (!key) {
      return NextResponse.json({ success: false, message: "doc_no required" }, { status: 400 });
    }

    const doc = await one(`SELECT * FROM (${PO_BASE}) po WHERE po.doc_no = %s LIMIT 1`, [key]);
    if (!doc) {
      return NextResponse.json({ success: false, message: "po not found" }, { status: 404 });
    }

    const [items, activity] = await Promise.all([
      rows(PO_ITEMS, [[key], [key]]),
      rows(
        `
        SELECT c.id, c.kind, c.body, c.created_by, c.created_at, e.fullname_lo AS author_name
        FROM public.odg_pm_po_comment c
        LEFT JOIN public.odg_employee e ON e.employee_code = c.created_by
        WHERE c.doc_no = %s
        ORDER BY c.created_at
        `,
        [key],
      ),
    ]);

    return NextResponse.json({ success: true, data: { doc, items, activity } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
