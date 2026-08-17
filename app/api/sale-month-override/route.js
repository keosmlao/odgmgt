import { NextResponse } from "next/server";
import { rows, one, query } from "@/lib/db";
import { parseIntSafe } from "@/lib/helpers";
import { getCurrentUser } from "@/lib/route-auth";
import { OWNER_CODES } from "@/lib/employee-auth";
import { clearCache } from "@/lib/cache";

/**
 * Bills credited to a month other than the one they were billed in.
 *
 * A sale closed on the 30th but invoiced on the 1st belongs to the month the
 * branch earned it in — both for the seller's points and for the month's kip.
 * The scoring query and the sales rollup both read
 * public.app_sale_month_override, so one row here moves the bill on every
 * screen at once; before this route existed the row had to be written by hand
 * in SQL, which meant nobody could see what had been moved, or why.
 *
 * The move is deliberately bounded: only to an adjacent month, and only within
 * a bill's own date. Anything further is a correction to the ERP, not a
 * reporting decision.
 */
const ADMIN_ROLES = new Set(["ceo", "gm"]);

/** Same bar as freezing a payout: moving a bill moves money between months. */
function canApprove(user) {
  if (!user) return false;
  return (
    OWNER_CODES.has(String(user.username || "")) ||
    ADMIN_ROLES.has(String(user.role || "").toLowerCase())
  );
}

/** Days a report_date may sit from the bill's own date. */
const MAX_SHIFT_DAYS = 31;

const dayDiff = (a, b) =>
  Math.round((new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86_400_000);

const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));

export async function GET(request) {
  try {
    const user = getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }

    const sp = request.nextUrl.searchParams;

    /**
     * Bill lookup for the picker. Answered from the sales rows themselves so
     * the screen can show what is actually being moved — the amount, the
     * customer, the branch — rather than accepting any string as a doc_no.
     */
    const find = String(sp.get("q") ?? "").trim();
    if (find) {
      const like = `%${find}%`;
      const bills = await rows(
        `SELECT d.doc_no,
                MIN(d.doc_date)::date::text AS doc_date,
                COALESCE(SUM(d.sum_amount), 0)::float AS amount,
                COUNT(*)::int AS lines,
                COALESCE(NULLIF(MIN(d.customer_code), ''), '') AS customer_code,
                COALESCE(NULLIF(MIN(d.bu_name), ''), '') AS bu_name,
                (SELECT mo.report_date::text FROM public.app_sale_month_override mo
                  WHERE mo.doc_no = d.doc_no) AS report_date
           FROM public.odg_sale_detail d
          WHERE d.doc_no ILIKE %s
          GROUP BY d.doc_no
          ORDER BY MIN(d.doc_date) DESC
          LIMIT 25`,
        [like],
      );
      return NextResponse.json({ success: true, data: { bills } });
    }

    // The list itself, with the sale each row moves so the effect is legible.
    const year = parseIntSafe(sp.get("year"), 0);
    const list = await rows(
      `SELECT mo.doc_no, mo.report_date::text AS report_date,
              mo.original_date::text AS original_date,
              mo.reason, mo.approved_by, mo.created_at,
              COALESCE(s.amount, 0)::float AS amount,
              COALESCE(s.bu_name, '') AS bu_name
         FROM public.app_sale_month_override mo
         LEFT JOIN LATERAL (
           SELECT SUM(d.sum_amount) AS amount, MIN(d.bu_name) AS bu_name
             FROM public.odg_sale_detail d WHERE d.doc_no = mo.doc_no
         ) s ON TRUE
        ${year ? "WHERE EXTRACT(YEAR FROM mo.report_date) = %s" : ""}
        ORDER BY mo.report_date DESC, mo.created_at DESC`,
      year ? [year] : [],
    );

    return NextResponse.json({
      success: true,
      data: { overrides: list, can_approve: canApprove(user) },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const user = getCurrentUser(request);
    if (!user) return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    if (!canApprove(user)) return NextResponse.json({ success: false, message: "forbidden" }, { status: 403 });

    const body = await request.json().catch(() => ({}));
    const docNo = String(body.doc_no || "").trim();
    const reportDate = String(body.report_date || "").trim();
    const reason = String(body.reason || "").trim();

    if (!docNo) return NextResponse.json({ success: false, message: "doc_no required" }, { status: 400 });
    if (!isDate(reportDate)) {
      return NextResponse.json({ success: false, message: "report_date must be YYYY-MM-DD" }, { status: 400 });
    }
    if (!reason) {
      // The reason is the whole audit trail: a month later nobody remembers
      // which bill was moved on whose say-so.
      return NextResponse.json({ success: false, message: "reason required" }, { status: 400 });
    }

    const bill = await one(
      `SELECT MIN(doc_date)::date::text AS doc_date, COALESCE(SUM(sum_amount), 0)::float AS amount
         FROM public.odg_sale_detail WHERE doc_no = %s`,
      [docNo],
    );
    if (!bill?.doc_date) {
      return NextResponse.json({ success: false, message: "bill not found" }, { status: 404 });
    }

    const shift = Math.abs(dayDiff(reportDate, bill.doc_date));
    if (shift > MAX_SHIFT_DAYS) {
      return NextResponse.json(
        { success: false, message: `report_date is ${shift} days from the bill — max ${MAX_SHIFT_DAYS}` },
        { status: 400 },
      );
    }

    await query(
      `INSERT INTO public.app_sale_month_override
         (doc_no, report_date, original_date, reason, approved_by, created_at)
       VALUES (%s, %s, %s, %s, %s, now())
       ON CONFLICT (doc_no) DO UPDATE
         SET report_date = EXCLUDED.report_date,
             reason = EXCLUDED.reason,
             approved_by = EXCLUDED.approved_by,
             created_at = now()`,
      [docNo, reportDate, bill.doc_date, reason, user.email || user.username || String(user.id ?? "")],
    );

    // Both rollups bucket on report_date, so they now disagree with this row
    // until they are rebuilt. The month-summary page rebuilds on its own next
    // load; clearing the report caches stops the old split being served first.
    await clearCache();

    return NextResponse.json({ success: true, data: { doc_no: docNo, report_date: reportDate, amount: bill.amount } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const user = getCurrentUser(request);
    if (!user) return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    if (!canApprove(user)) return NextResponse.json({ success: false, message: "forbidden" }, { status: 403 });
    const docNo = String(request.nextUrl.searchParams.get("doc_no") || "").trim();
    if (!docNo) return NextResponse.json({ success: false, message: "doc_no required" }, { status: 400 });

    await query(`DELETE FROM public.app_sale_month_override WHERE doc_no = %s`, [docNo]);
    await clearCache();
    return NextResponse.json({ success: true, data: { doc_no: docNo } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
