import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";

/**
 * Proxies the delivery-performance report from the TMS app.
 *
 * The report is NOT recomputed here on purpose. carry_in / carry_out depend on
 * TMS's pending-bill rules (remaining counts, service bills, branch transfers);
 * a local reimplementation matched the lead-time buckets exactly but was ~90
 * bills out on the backlog, so the only way the two screens agree is to let TMS
 * own the arithmetic.
 *
 * Needs TMS_API_URL (and TMS_API_SECRET when TMS sets REPORT_API_SECRET).
 */
export async function GET(request) {
  const user = getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
  }

  const month = request.nextUrl.searchParams.get("month") || "";
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ success: false, message: "month must be YYYY-MM" }, { status: 400 });
  }

  const base = (process.env.TMS_API_URL || process.env.NEXT_PUBLIC_TMS_URL || "").replace(/\/$/, "");
  if (!base) {
    return NextResponse.json(
      { success: false, message: "TMS_API_URL is not configured" },
      { status: 503 },
    );
  }

  try {
    const response = await fetch(`${base}/api/reports/delivery-performance?month=${month}`, {
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
    return NextResponse.json({ success: true, data: payload.report });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 502 });
  }
}
