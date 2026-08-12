import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";

/**
 * Proxies one slice of the TMS dashboard. The page loads the slices separately
 * (summary is fast, pending is slow) so each section can paint as it lands —
 * the same staggering TMS itself does.
 *
 * Needs TMS_API_URL (and TMS_API_SECRET when TMS sets REPORT_API_SECRET).
 */
const SLICES = new Set(["summary", "kpi", "delivery", "pending", "activity"]);

export async function GET(request) {
  const user = getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
  }

  const slice = request.nextUrl.searchParams.get("slice") || "summary";
  const force = request.nextUrl.searchParams.get("force") === "1" ? "&force=1" : "";
  if (!SLICES.has(slice)) {
    return NextResponse.json({ success: false, message: "unknown slice" }, { status: 400 });
  }

  const base = (process.env.TMS_API_URL || process.env.NEXT_PUBLIC_TMS_URL || "").replace(/\/$/, "");
  if (!base) {
    return NextResponse.json({ success: false, message: "TMS_API_URL is not configured" }, { status: 503 });
  }

  try {
    const response = await fetch(`${base}/api/reports/dashboard?slice=${slice}${force}`, {
      headers: process.env.TMS_API_SECRET
        ? { authorization: `Bearer ${process.env.TMS_API_SECRET}` }
        : {},
      cache: "no-store",
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) {
      return NextResponse.json(
        { success: false, message: payload?.error || `TMS responded ${response.status}` },
        { status: response.status === 401 ? 502 : response.status },
      );
    }
    return NextResponse.json({ success: true, data: payload.data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 502 });
  }
}
