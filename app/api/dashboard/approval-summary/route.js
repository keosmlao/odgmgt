import { NextResponse } from "next/server";
import { one } from "@/lib/db";
import { swrCache } from "@/lib/cache";
import { requireUser } from "@/lib/approvals";

/**
 * Compact approval workload for the executive dashboard.
 *
 * The notification bell lives in the topbar, so this is polled every 60 seconds
 * by every open tab on every page, and the dashboard asks for it too. It was
 * running its three queries every time — 2.8 to 4 seconds each on the server —
 * which is a standing load that grows with the number of people signed in.
 *
 * Cached for a minute, matching the poll interval: the bell cannot show
 * anything staler than it already would between two polls, and one process now
 * runs the queries once a minute regardless of how many tabs are open.
 */
export async function GET(request) {
  const auth = requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  try {
    const [pr, po, product] = await swrCache(
      "dashboard:approval-summary",
      { ttl: 60_000, staleTtl: 6 * 3_600_000, bypass: request.nextUrl.searchParams.get("nocache") === "1" },
      () => Promise.all([
      one(`
        SELECT count(*)::int AS pending,
               coalesce(sum(coalesce(l.est_total, 0)), 0)::float AS value,
               count(*) FILTER (WHERE coalesce(p.created_at, p.doc_date::timestamp) < now() - interval '2 days')::int AS overdue
        FROM public.odg_pm_pr p
        LEFT JOIN (
          SELECT pr_id, sum(coalesce(qty, 0) * coalesce(est_price, 0)) AS est_total
          FROM public.odg_pm_pr_line GROUP BY pr_id
        ) l ON l.pr_id = p.id
        WHERE lower(coalesce(p.status, '')) NOT IN ('approved','rejected','cancelled','canceled','closed')
      `),
      one(`
        WITH pending_po AS (
          SELECT coalesce(a.doc_no, p.po_no) AS doc_no,
                 coalesce(a.status, p.status) AS status,
                 coalesce(nullif(p.total, 0), e.total_amount, 0) AS total,
                 coalesce(a.created_at, p.created_at, e.create_datetime) AS created_at
          FROM public.odg_pm_po_approval a
          FULL JOIN public.odg_pm_po p ON p.po_no = a.doc_no
          LEFT JOIN LATERAL (
            SELECT total_amount, create_datetime FROM public.ic_trans
            WHERE doc_no = coalesce(a.doc_no, p.po_no)
            ORDER BY roworder DESC LIMIT 1
          ) e ON true
        )
        SELECT count(*)::int AS pending,
               coalesce(sum(total), 0)::float AS value,
               count(*) FILTER (WHERE created_at < now() - interval '2 days')::int AS overdue
        FROM pending_po
        WHERE lower(coalesce(status, '')) NOT IN ('approved','rejected','cancelled','canceled','closed')
      `),
      one(`
        SELECT (docs + drafts)::int AS pending, overdue::int
        FROM (
          SELECT
            (SELECT count(*) FROM public.odg_manage_product WHERE coalesce(status, 0) = 0) AS docs,
            (SELECT count(*) FROM public.odg_product_draft WHERE coalesce(approve_status, 0) = 0) AS drafts,
            (SELECT count(*) FROM public.odg_manage_product WHERE coalesce(status, 0) = 0 AND create_date_time_now < now() - interval '2 days')
              + (SELECT count(*) FROM public.odg_product_draft WHERE coalesce(approve_status, 0) = 0 AND created_date_time_now < now() - interval '2 days') AS overdue
        ) q
      `),
      ]),
    );

    const queues = {
      pr: { pending: Number(pr?.pending || 0), overdue: Number(pr?.overdue || 0), value: Number(pr?.value || 0) },
      po: { pending: Number(po?.pending || 0), overdue: Number(po?.overdue || 0), value: Number(po?.value || 0) },
      product: { pending: Number(product?.pending || 0), overdue: Number(product?.overdue || 0), value: 0 },
    };
    return NextResponse.json({
      success: true,
      queues,
      totalPending: queues.pr.pending + queues.po.pending + queues.product.pending,
      totalOverdue: queues.pr.overdue + queues.po.overdue + queues.product.overdue,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
