import { NextResponse } from "next/server";
import { rows, query } from "@/lib/db";
import { parseIntSafe } from "@/lib/helpers";
import { getCurrentUser } from "@/lib/route-auth";
import { clearCache } from "@/lib/cache";

/**
 * Products held out of the scheme, and the ones paid at a rate of their own.
 *
 * The point map answers "what does this KIND of product earn". This answers the
 * exception: one item code that earns nothing however well it sells (a TV
 * bracket, a giveaway), or one on a promotion that pays half or a fifth more.
 * It is a separate decision from the ladders, made about a single product
 * rather than a band, which is why it is a screen of its own.
 *
 * It is not a new mechanism. The scoring query already multiplies every line by
 * the status its item carries, so writing a row here is the same act the
 * maintenance scripts perform — with the list visible, and the sales it
 * silences shown beside it.
 */
const RETAIL_BRANCH = process.env.ODG_RETAIL_BRANCH || "01";

const firstOf = (year, month) => `${year}-${String(month).padStart(2, "0")}-01`;
const lastOf = (year, month) => new Date(Date.UTC(Number(year), Number(month), 0)).toISOString().slice(0, 10);
const midOf = (year, month) => `${year}-${String(month).padStart(2, "0")}-15`;

export async function GET(request) {
  try {
    if (!getCurrentUser(request)) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }
    const sp = request.nextUrl.searchParams;
    const now = new Date();
    const year = parseIntSafe(sp.get("year"), now.getFullYear());
    const month = Math.min(12, Math.max(1, parseIntSafe(sp.get("month"), now.getMonth() + 1)));

    /**
     * Item search, for the picker.
     *
     * Kept out of the main payload deliberately: the catalogue is tens of
     * thousands of rows, and a screen that lists exceptions has no business
     * shipping all of them. Answered from the catalogue rather than from sales,
     * so a product can be excluded BEFORE it sells rather than after.
     */
    const find = String(sp.get("q") ?? "").trim();
    if (find) {
      const like = `%${find}%`;
      const items = await rows(
        `SELECT i.code AS item_code,
                COALESCE(NULLIF(i.name_1, ''), i.code) AS item_name,
                COALESCE(i.item_brand, '') AS brand,
                COALESCE(NULLIF(c.name_1, ''), i.item_category, '') AS category
           FROM public.ic_inventory i
           LEFT JOIN public.ic_category c ON c.code = i.item_category
          WHERE i.code ILIKE %s OR i.name_1 ILIKE %s
          ORDER BY i.code
          LIMIT 40`,
        [like, like],
      );
      return NextResponse.json({ success: true, data: { items } });
    }

    const [statuses, ruleRows, sold] = await Promise.all([
      rows(`SELECT status_code, multiplier::float AS multiplier
              FROM public.app_incentive_status_multiplier ORDER BY multiplier, status_code`),
      // Every rule, not only the ones in force: a rule written for last month is
      // part of the record of why last month paid what it did.
      rows(
        `SELECT r.item_code, r.status_code, r.note,
                r.effective_from::text AS effective_from, r.effective_to::text AS effective_to,
                (%s::date BETWEEN r.effective_from AND r.effective_to) AS in_force,
                COALESCE(m.multiplier, 1)::float AS multiplier,
                COALESCE(NULLIF(i.name_1, ''), r.item_code) AS item_name,
                COALESCE(i.item_brand, '') AS brand,
                COALESCE(NULLIF(c.name_1, ''), i.item_category, '') AS category
           FROM public.app_incentive_product_status_rule r
           LEFT JOIN public.app_incentive_status_multiplier m ON m.status_code = r.status_code
           LEFT JOIN public.ic_inventory i ON i.code = r.item_code
           LEFT JOIN public.ic_category c ON c.code = i.item_category
          ORDER BY (%s::date BETWEEN r.effective_from AND r.effective_to) DESC,
                   r.effective_from DESC, r.item_code`,
        [midOf(year, month), midOf(year, month)],
      ),
      // What each of them actually sold in the month being looked at — an
      // exclusion nobody can see the cost of is one nobody will ever revisit.
      rows(
        `SELECT d.item_code,
                COALESCE(SUM(d.qty), 0)::float AS qty,
                COALESCE(SUM(d.sum_amount), 0)::float AS amount
           FROM public.odg_sale_detail d
          WHERE d.branch_code = %s
            AND d.doc_date >= %s::date AND d.doc_date <= %s::date
          GROUP BY d.item_code`,
        [RETAIL_BRANCH, firstOf(year, month), lastOf(year, month)],
      ),
    ]);

    const byItem = new Map(sold.map((row) => [row.item_code, row]));
    const items = ruleRows.map((rule) => ({
      ...rule,
      qty: byItem.get(rule.item_code)?.qty ?? 0,
      amount: byItem.get(rule.item_code)?.amount ?? 0,
    }));

    return NextResponse.json({
      success: true,
      data: {
        year, month, statuses, items,
        totals: {
          items: items.length,
          inForce: items.filter((item) => item.in_force).length,
          // Only what a rule actually silences counts as withheld: a status
          // that pays 1.2× is on this screen too, and is not a loss.
          withheld: items
            .filter((item) => item.in_force && item.multiplier < 1)
            .reduce((sum, item) => sum + item.amount, 0),
        },
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}

/** The item and the window a rule is addressed by, or an error string. */
function ruleOf(body) {
  const item = String(body?.item_code ?? "").trim();
  const status = String(body?.status_code ?? "").trim();
  if (!item) return { error: "item_code is required" };
  const now = new Date();
  const year = parseIntSafe(body?.year, now.getFullYear());
  const month = Math.min(12, Math.max(1, parseIntSafe(body?.month, now.getMonth() + 1)));
  return { item, status, from: firstOf(year, month), to: lastOf(year, month) };
}

/**
 * Hold a product out of the scheme, or give it a rate of its own.
 *
 * Bounded to the selected month unless asked to run on: an exclusion that
 * quietly outlives the promotion it was written for is the same failure as a
 * rate that does, and it is harder to notice because nothing appears on the
 * point map. `forever` is there because most exclusions genuinely are
 * permanent — a TV bracket never earns — and saying so explicitly is better
 * than re-writing it every month.
 */
export async function POST(request) {
  try {
    if (!getCurrentUser(request)) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }
    const body = await request.json().catch(() => null);
    const rule = ruleOf(body);
    if (rule.error) return NextResponse.json({ success: false, message: rule.error }, { status: 400 });
    if (!rule.status) {
      return NextResponse.json({ success: false, message: "status_code is required" }, { status: 400 });
    }
    const known = await rows(
      `SELECT 1 FROM public.app_incentive_status_multiplier WHERE status_code = %s`, [rule.status]);
    if (known.length === 0) {
      return NextResponse.json({ success: false, message: "unknown status_code" }, { status: 400 });
    }
    const to = body?.forever ? "2099-12-31" : rule.to;
    const note = String(body?.note ?? "").trim();

    const saved = await rows(
      `INSERT INTO public.app_incentive_product_status_rule
              (item_code, status_code, note, effective_from, effective_to, updated_at)
       VALUES (%s, %s, %s, %s::date, %s::date, now())
       ON CONFLICT (item_code, effective_from)
       DO UPDATE SET status_code = EXCLUDED.status_code, note = EXCLUDED.note,
                     effective_to = EXCLUDED.effective_to, updated_at = now()
       RETURNING item_code, status_code, effective_from::text AS effective_from,
                 effective_to::text AS effective_to`,
      [rule.item, rule.status, note, rule.from, to],
    );

    await clearCache("incentive-sold:");
    return NextResponse.json({ success: true, data: saved[0] });
  } catch (error) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}

/**
 * Put a product back in the scheme.
 *
 * The window is part of the address, so removing one month's exception leaves
 * any other month's alone — the same rule the point map follows.
 */
export async function DELETE(request) {
  try {
    if (!getCurrentUser(request)) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }
    const body = await request.json().catch(() => null);
    const item = String(body?.item_code ?? "").trim();
    const from = String(body?.effective_from ?? "").trim();
    if (!item || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      return NextResponse.json({ success: false, message: "item_code and effective_from are required" }, { status: 400 });
    }
    const removed = await query(
      `DELETE FROM public.app_incentive_product_status_rule
        WHERE item_code = %s AND effective_from = %s::date`,
      [item, from],
    );

    await clearCache("incentive-sold:");
    return NextResponse.json({ success: true, data: { removed: removed.rowCount } });
  } catch (error) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}
