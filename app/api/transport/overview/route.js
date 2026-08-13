import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";
import { swrCache } from "@/lib/cache";
import {
  getDashboardSummary,
  getDashboardKpi,
  getDashboardDeliveryPerformance,
  getDashboardPending,
  getDashboardActivity,
} from "@/lib/tms/queries/dashboard.js";

/**
 * One slice of the TMS transport dashboard, computed here from TMS's own code
 * (lib/tms/) against the database TMS itself reads. The page loads the slices
 * separately — summary is fast, pending is slow — so each section paints as it
 * lands, the same staggering TMS does.
 *
 * The empty session object is what TMS's own report API passes: these reports
 * are unscoped, covering every branch.
 *
 * Cached here as well as in TMS. TMS's own cache is an in-process Map with a
 * 15-second TTL, so it is empty after every restart and expires while people
 * are still arriving — which is why a cold delivery slice costs 9.4 seconds and
 * a cold pending slice 6.5. This layer persists, so a restarted process serves
 * the stored value and refreshes behind the request.
 *
 * force=1 is the page's own refresh and bypasses both.
 */
const SLICES = {
  summary: (session, force) => getDashboardSummary(session, force),
  kpi: (session, force) => getDashboardKpi(session, force),
  delivery: (session, force) => getDashboardDeliveryPerformance(session, force),
  pending: (session, force) => getDashboardPending(session, force),
  activity: (session) => getDashboardActivity(session),
};

export async function GET(request) {
  const user = getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
  }

  const slice = request.nextUrl.searchParams.get("slice") || "summary";
  const force = request.nextUrl.searchParams.get("force") === "1";
  const run = SLICES[slice];
  if (!run) {
    return NextResponse.json({ success: false, message: "unknown slice" }, { status: 400 });
  }

  try {
    const data = await swrCache(
      `transport:overview:${slice}`,
      {
        ttl: 300_000,
        staleTtl: 24 * 3_600_000,
        bypass: force || request.nextUrl.searchParams.get("nocache") === "1",
      },
      () => run({}, force),
    );
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error(`[transport] dashboard slice ${slice} failed:`, error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
