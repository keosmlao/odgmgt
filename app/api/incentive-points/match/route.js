import { NextResponse } from "next/server";
import { rows } from "@/lib/db";
import { parseIntSafe } from "@/lib/helpers";
import { getCurrentUser } from "@/lib/route-auth";
import { POINTS_SQL } from "@/lib/incentive-points-sql";
import { swrCache, clearCache } from "@/lib/cache";
import { foldAirSets } from "@/lib/incentive-sets";

/**
 * What the configured ladders actually caught: one row per product sold.
 *
 * A ladder can be read on the configuration screen and still be wrong, because
 * what it pays depends on a number nobody types — the size or price the ERP
 * carries on the sale. A band written to 11.9 when the models are 12.0 kg looks
 * perfectly ordinary on screen and pays nothing all month. The only way to know
 * is to run the month's sales through the rules and read back WHICH product
 * landed in WHICH band, which is what this returns.
 *
 * It is the report's own scoring query that produces it — not a second
 * implementation of the match — so a product shown here under a band is being
 * paid under that band on the reward report too.
 */
const RETAIL_BRANCH = process.env.ODG_RETAIL_BRANCH || "01";
const RETAIL_AR_GROUP = "101";

/**
 * The month's sales, folded to one row per product.
 *
 * The scoring query answers per bill, because that is what a reward report is
 * drilled down to. A configuration screen is asking a different question — "did
 * MY ladder catch this model" — so the bills are summed away and only their
 * count is kept.
 *
 * Cached under the `incentive-sold:` prefix on purpose: every rule write
 * already clears that prefix, so this detail can never go on showing the bands
 * that were configured a moment ago.
 */
async function loadMatches({ year, month }) {
  const scored = await rows(POINTS_SQL, [year, month, year, month, RETAIL_BRANCH, RETAIL_AR_GROUP]);
  const lines = foldAirSets(scored);
  const items = new Map();
  for (const line of lines) {
    if (!line.pcat) continue;
    const key = [line.pcat, line.brand ?? "", line.design_token ?? "", line.item_code].join("|");
    const entry = items.get(key) ?? {
      pcat: line.pcat,
      brand: line.brand ?? "",
      design: line.design_token ?? "",
      item_code: line.item_code,
      item_name: line.item_name,
      // The ERP's own wording beside the number derived from it: when a product
      // matched nothing, one of these two is what has to be fixed.
      size_name: line.size_name ?? "",
      design_name: line.design_name ?? "",
      measure: line.measure === null ? null : Number(line.measure),
      // The band that caught it, or null where none did.
      rule_max: line.rule_max === null || line.rule_max === undefined ? null : Number(line.rule_max),
      rule_band: line.rule_band ?? null,
      // Which measurement the band bounds — inches and kip are different
      // ladders, and a ceiling of 34 means nothing without it.
      rule_kind: line.rule_kind ?? null,
      matched: line.configured_points !== null && line.configured_points !== undefined,
      unit_points: Number(line.unit_points || 0),
      qty: 0,
      amount: 0,
      points: 0,
      bills: 0,
    };
    entry.qty += Number(line.qty || 0);
    entry.amount += Number(line.amount || 0);
    entry.points += Number(line.points || 0);
    entry.bills += 1;
    // A status rule can pay one bill of a model differently from the next, so
    // the rate shown is the best the model achieved rather than a blend of two.
    entry.unit_points = Math.max(entry.unit_points, Number(line.unit_points || 0));
    // The number a band was read on is no longer a property of the MODEL: an
    // air conditioner is banded on what the set actually fetched, so the same
    // model reaches a different figure on a discounted bill than on a full one.
    // Keeping whichever bill happened to be read first made two halves of one
    // set report different numbers. The best the model reached is a stable
    // answer to "which band can this model reach", and the band named beside it
    // has to come from that same bill or the row contradicts itself.
    if (entry.measure === null || (line.measure !== null && Number(line.measure) > entry.measure)) {
      entry.measure = line.measure === null ? null : Number(line.measure);
      entry.rule_max = line.rule_max === null || line.rule_max === undefined ? null : Number(line.rule_max);
      entry.rule_band = line.rule_band ?? null;
      entry.rule_kind = line.rule_kind ?? null;
      entry.size_name = line.size_name ?? "";
    }
    // A model that failed to match on ANY bill is a gap worth surfacing, even
    // if another bill of it did land in a band.
    entry.matched = entry.matched
      && line.configured_points !== null && line.configured_points !== undefined;
    items.set(key, entry);
  }
  return [...items.values()];
}

/**
 * Throw away every score held for a month, so the next read works them out
 * again from the rules as they now stand.
 *
 * Points are not stored as a decision anywhere — there is no table of earned
 * points to delete. They are what the rules make of the month's sales, and the
 * only thing kept is the cache that spares every visitor a re-scoring. So
 * "delete the points and calculate again" is exactly this: drop the cache.
 *
 * It writes nothing and deletes no rule. A month can be recalculated as often
 * as anyone likes without a single ladder changing.
 */
export async function POST(request) {
  try {
    if (!getCurrentUser(request)) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }
    const body = await request.json().catch(() => null);
    const now = new Date();
    const year = parseIntSafe(body?.year, now.getFullYear());
    const month = Math.min(12, Math.max(1, parseIntSafe(body?.month, now.getMonth() + 1)));

    // Both shapes of the month's scoring: the per-band totals the grid draws,
    // and the per-product detail this route serves. Either one left behind
    // would answer the next question with the figures just discarded.
    await clearCache(`incentive-sold:v1:${year}|${month}`);
    await clearCache(`incentive-sold:items:v2:${year}|${month}`);
    return NextResponse.json({ success: true, data: { year, month, cleared: true } });
  } catch (error) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}

export async function GET(request) {
  try {
    if (!getCurrentUser(request)) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }
    const sp = request.nextUrl.searchParams;
    const now = new Date();
    const year = parseIntSafe(sp.get("year"), now.getFullYear());
    const month = Math.min(12, Math.max(1, parseIntSafe(sp.get("month"), now.getMonth() + 1)));
    const category = String(sp.get("category") ?? "").trim();
    if (!category) {
      return NextResponse.json({ success: false, message: "category is required" }, { status: 400 });
    }

    const key = `incentive-sold:items:v2:${year}|${month}`;
    if (sp.get("nocache") === "1") await clearCache(key);
    const all = await swrCache(key, { ttl: 120_000, staleTtl: 6 * 3_600_000 },
      () => loadMatches({ year, month }));

    // Unpaid first, then by the money at stake: the product worth looking at is
    // the one that sold well and scored nothing, not the alphabetically first.
    const items = all
      .filter((item) => item.pcat === category)
      .sort((left, right) =>
        Number(left.matched) - Number(right.matched)
        || right.amount - left.amount
        || String(left.item_name).localeCompare(String(right.item_name)));

    return NextResponse.json({
      success: true,
      data: {
        year, month, category, items,
        totals: {
          items: items.length,
          qty: items.reduce((sum, item) => sum + item.qty, 0),
          amount: items.reduce((sum, item) => sum + item.amount, 0),
          points: items.reduce((sum, item) => sum + item.points, 0),
          unmatched: items.filter((item) => !item.matched).length,
          unmatchedAmount: items.filter((item) => !item.matched).reduce((sum, item) => sum + item.amount, 0),
        },
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}
