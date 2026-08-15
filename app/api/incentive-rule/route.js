import { NextResponse } from "next/server";
import { rows } from "@/lib/db";
import { parseIntSafe } from "@/lib/helpers";
import { getCurrentUser } from "@/lib/route-auth";

/**
 * The point rules behind one sold line, and which of them the report used.
 *
 * The reward screen can already say "1.25 points a unit", but not why that
 * number and not another. This returns every rule that could have matched the
 * line's category / brand / design on the month it was scored, ordered by the
 * SAME precedence the report applies, so the first row is the one that won and
 * the rest explain what it beat:
 *
 *   exact band            → a rule written for this band wins outright
 *   smallest covering "<=" → otherwise the tightest ceiling that still covers it
 *   is_special, narrower window, newer  → the existing tie-breaks
 */
export async function GET(request) {
  try {
    if (!getCurrentUser(request)) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }
    const sp = request.nextUrl.searchParams;
    const category = sp.get("category_code");
    if (!category) {
      return NextResponse.json({ success: false, message: "category_code is required" }, { status: 400 });
    }
    const brand = sp.get("brand_code") ?? "";
    const design = sp.get("design_token") ?? "";
    const size = sp.get("size_token") ?? "";
    const now = new Date();
    const year = parseIntSafe(sp.get("year"), now.getFullYear());
    const month = Math.min(12, Math.max(1, parseIntSafe(sp.get("month"), now.getMonth() + 1)));
    // Mid-month stands for the month, the same date the config screen scopes by.
    const on = `${year}-${String(month).padStart(2, "0")}-15`;

    const candidates = await rows(
      `SELECT r.id, r.category_code, r.brand_code, r.design_token, r.size_token,
              r.points::float AS points, r.is_special,
              r.effective_from::text AS effective_from,
              r.effective_to::text AS effective_to,
              (r.effective_to - r.effective_from) AS span_days,
              (r.size_token = %s) AS exact_band
       FROM public.app_incentive_point_rule r
       WHERE r.category_code = %s
         AND r.brand_code = %s
         AND r.design_token = %s
         AND %s::date BETWEEN r.effective_from AND r.effective_to
         AND (
           r.size_token = %s
           OR (
             %s ~ '^<=' AND r.size_token ~ '^<='
             AND (substring(r.size_token from '([0-9.]+)'))::numeric
                 >= (substring(%s from '([0-9.]+)'))::numeric
           )
         )
       ORDER BY (r.size_token = %s) DESC,
                CASE WHEN r.size_token ~ '^<='
                     THEN (substring(r.size_token from '([0-9.]+)'))::numeric
                     ELSE 1e18 END ASC,
                r.is_special DESC,
                (r.effective_to - r.effective_from) ASC,
                r.updated_at DESC, r.id DESC`,
      [size, category, brand, design, on, size, size, size, size],
    );

    /**
     * What the neighbours pay.
     *
     * With no matching rule the screen could only say so, which leaves the one
     * question that matters unanswered: what should this have earned? The
     * comparisons are the two a person makes anyway — the same design priced by
     * other brands, and the same brand priced on its other designs — so the
     * answer is on the screen instead of in someone's head.
     */
    /**
     * One line per neighbour, not one per RULE.
     *
     * A band routinely carries two rules at once in the same month: the
     * long-running scheme, and the month-bounded copy that "copy last month"
     * writes over it. Both are in force, both are correct, and the scoring
     * query silently prefers the narrower — so listing every row printed the
     * same brand and band twice, at the same rate, and read as a data fault.
     *
     * DISTINCT ON keeps the one that would actually be paid, in the same
     * precedence the scoring query applies. Display order is settled afterwards
     * on the flags the inner query already computed, so it costs no parameters.
     */
    const nearby = await rows(
      `SELECT * FROM (
         SELECT DISTINCT ON (r.brand_code, r.design_token, r.size_token)
                r.brand_code, r.design_token, r.size_token, r.points::float AS points,
                (r.brand_code = %s) AS same_brand,
                (r.design_token = %s) AS same_design,
                (r.size_token = %s) AS same_band
           FROM public.app_incentive_point_rule r
          WHERE r.category_code = %s
            AND %s::date BETWEEN r.effective_from AND r.effective_to
            AND (r.brand_code = %s OR r.design_token = %s)
            AND NOT (r.brand_code = %s AND r.design_token = %s AND r.size_token = %s)
          ORDER BY r.brand_code, r.design_token, r.size_token,
                   r.is_special DESC, (r.effective_to - r.effective_from) ASC,
                   r.updated_at DESC, r.id DESC
       ) r
       ORDER BY r.same_design DESC, r.same_band DESC,
                r.brand_code, r.design_token, r.size_token`,
      [brand, design, size, category, on, brand, design, brand, design, size],
    ).catch(() => []);

    // What other brands pay for exactly this design and band — the closest
    // thing to an answer the map can give without anyone deciding anything.
    const peers = nearby
      .filter((row) => row.same_design && row.same_band && !row.same_brand)
      .map((row) => Number(row.points));
    const sorted = [...peers].sort((left, right) => left - right);
    const middle = sorted.length
      ? (sorted.length % 2 ? sorted[sorted.length >> 1]
        : (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2)
      : null;

    return NextResponse.json({
      success: true,
      data: {
        query: { category_code: category, brand_code: brand, design_token: design, size_token: size, year, month },
        winner: candidates[0] ?? null,
        candidates,
        nearby,
        suggestion: middle === null ? null : { points: Math.round(middle * 4) / 4, from: peers.length },
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}
