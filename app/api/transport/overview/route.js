import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";
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
    const data = await run({}, force);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error(`[transport] dashboard slice ${slice} failed:`, error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
