import { NextResponse } from "next/server";
import { rows, one, query } from "@/lib/db";
import { parseIntSafe } from "@/lib/helpers";
import { getCurrentUser } from "@/lib/route-auth";
import { OWNER_CODES } from "@/lib/employee-auth";
import { ensurePayoutTables } from "@/lib/migrations";
import { clearCache } from "@/lib/cache";

/**
 * Marks a month's retail incentive as paid and freezes what was paid.
 *
 * The frozen lines are what the page shows from then on, so later edits to the
 * sales data can never change a month that has already been paid out.
 */
const ADMIN_ROLES = new Set(["ceo", "gm"]);
const BRANCH = process.env.ODG_RETAIL_BRANCH || "01";

function requireAdmin(request) {
  const user = getCurrentUser(request);
  if (!user) return { ok: false, status: 401, message: "unauthorized" };
  const code = String(user.username || "");
  const role = String(user.role || "").toLowerCase();
  if (OWNER_CODES.has(code) || ADMIN_ROLES.has(role)) return { ok: true, user };
  return { ok: false, status: 403, message: "forbidden" };
}

/** Payout history, newest first. */
export async function GET(request) {
  try {
    if (!getCurrentUser(request)) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }
    await ensurePayoutTables();

    const data = await rows(`
      SELECT id, target_year, target_month, branch_code, status, people,
             point_reward, unit_reward, commission, total_amount, currency,
             note, paid_by, paid_at
      FROM public.odg_incentive_payout
      ORDER BY target_year DESC, target_month DESC
    `);

    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/** Marks the given month paid, snapshotting the amounts sent in the body. */
export async function POST(request) {
  const auth = requireAdmin(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  try {
    await ensurePayoutTables();
    const body = await request.json();
    const year = parseIntSafe(body.year);
    const month = parseIntSafe(body.month);
    const note = body.note ? String(body.note).trim() : null;
    const people = Array.isArray(body.people) ? body.people : [];
    // Managers earn commission only; they belong in the same frozen payout.
    const managers = (Array.isArray(body.managers) ? body.managers : []).map((row) => ({
      employee_code: row.employee_code,
      name: row.name,
      amount: 0,
      target: 0,
      ach_pct: 0,
      points: 0,
      multiplier: 0,
      point_reward: 0,
      unit_reward: 0,
      commission: Number(row.commission || 0),
      reward: Number(row.commission || 0),
    }));
    const lines = [...people, ...managers];

    if (!year || !month) {
      return NextResponse.json({ success: false, message: "year and month required" }, { status: 400 });
    }
    if (!people.length) {
      return NextResponse.json({ success: false, message: "nothing to pay" }, { status: 400 });
    }

    const existing = await one(
      `SELECT id FROM public.odg_incentive_payout
       WHERE target_year = %s AND target_month = %s AND branch_code = %s`,
      [year, month, BRANCH],
    );
    if (existing) {
      return NextResponse.json(
        { success: false, message: "already paid" },
        { status: 409 },
      );
    }

    const totals = lines.reduce(
      (acc, row) => ({
        point_reward: acc.point_reward + Number(row.point_reward || 0),
        unit_reward: acc.unit_reward + Number(row.unit_reward || 0),
        commission: acc.commission + Number(row.commission || 0),
        total: acc.total + Number(row.reward || 0),
      }),
      { point_reward: 0, unit_reward: 0, commission: 0, total: 0 },
    );

    const created = await one(
      `INSERT INTO public.odg_incentive_payout
         (target_year, target_month, branch_code, status, people,
          point_reward, unit_reward, commission, total_amount, currency, note, paid_by)
       VALUES (%s, %s, %s, 'paid', %s, %s, %s, %s, %s, %s, %s, %s)
       RETURNING id`,
      [
        year,
        month,
        BRANCH,
        people.length,
        totals.point_reward,
        totals.unit_reward,
        totals.commission,
        totals.total,
        String(body.currency || "THB"),
        note,
        auth.user.username,
      ],
    );

    for (const row of lines) {
      await query(
        `INSERT INTO public.odg_incentive_payout_line
           (payout_id, employee_code, employee_name, sales, target, ach_pct,
            points, multiplier, point_reward, unit_reward, commission, total)
         VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
         ON CONFLICT (payout_id, employee_code) DO NOTHING`,
        [
          created.id,
          String(row.employee_code ?? "-"),
          row.name ?? null,
          Number(row.amount || 0),
          Number(row.target || 0),
          Number(row.ach_pct || 0),
          Number(row.points || 0),
          Number(row.multiplier || 0),
          Number(row.point_reward || 0),
          Number(row.unit_reward || 0),
          Number(row.commission || 0),
          Number(row.reward || 0),
        ],
      );
    }

    await clearCache("retail-incentive");
    return NextResponse.json({ success: true, id: created.id, totals });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/** Re-opens a month (removes the payout record and its frozen lines). */
export async function DELETE(request) {
  const auth = requireAdmin(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  try {
    await ensurePayoutTables();
    const sp = request.nextUrl.searchParams;
    const year = parseIntSafe(sp.get("year"));
    const month = parseIntSafe(sp.get("month"));
    if (!year || !month) {
      return NextResponse.json({ success: false, message: "year and month required" }, { status: 400 });
    }

    await query(
      `DELETE FROM public.odg_incentive_payout
       WHERE target_year = %s AND target_month = %s AND branch_code = %s`,
      [year, month, BRANCH],
    );
    await clearCache("retail-incentive");

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
