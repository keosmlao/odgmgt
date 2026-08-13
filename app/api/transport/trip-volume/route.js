import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";
import { swrCache } from "@/lib/cache";
import { buildTripVolume, buildTripVolumesBulk } from "@/lib/tms/actions/trip-volume";

/**
 * Load and volume for one trip, or for several at once.
 *
 * Cached per document, not per request. The bill lists render one of these per
 * row — bill-complete alone shows nearly two hundred — and each computation
 * resolves item dimensions, pack sizes and pipe sizes, which costs about
 * 230 ms, so a second viewer pays for none of it.
 *
 * The two builders are cached separately and must stay that way. TMS's single
 * builder returns a detailed object — capacitySource, byBill, unknownItems,
 * payloadKg and thirteen more fields — while the bulk one returns a summary
 * per document. Sharing a key lets whichever ran first answer for the other,
 * which silently strips those fields from the detail view.
 *
 * Bulk misses are still fetched in one call, so caching does not turn a single
 * round trip into N.
 */
const TTL = { ttl: 300_000, staleTtl: 24 * 3_600_000 };
const detailKey = (doc) => `transport:trip-volume:detail:${doc}`;
const summaryKey = (doc) => `transport:trip-volume:summary:${doc}`;

export async function GET(request) {
  const user = getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const bypass = params.get("nocache") === "1";
  const doc = (params.get("doc") || "").trim();
  const docs = (params.get("docs") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!doc && docs.length === 0) {
    return NextResponse.json({ success: false, message: "doc or docs required" }, { status: 400 });
  }

  try {
    if (doc) {
      const data = await swrCache(detailKey(doc), { ...TTL, bypass }, () => buildTripVolume(doc));
      return NextResponse.json({ success: true, data });
    }

    // One entry per document, but a single bulk call for whatever is missing.
    // The bulk builder returns a map keyed by doc_no, so each loader can pick
    // out its own row once the shared call resolves.
    const wanted = Array.from(new Set(docs));
    let pending = null;
    const loadAll = () => {
      if (!pending) pending = buildTripVolumesBulk(wanted);
      return pending;
    };
    const pairs = await Promise.all(
      wanted.map(async (code) => [
        code,
        await swrCache(summaryKey(code), { ...TTL, bypass }, async () => (await loadAll())[code] ?? null),
      ]),
    );
    return NextResponse.json({ success: true, data: Object.fromEntries(pairs) });
  } catch (error) {
    console.error("[transport] trip-volume failed:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
