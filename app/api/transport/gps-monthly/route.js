import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";

/**
 * Proxies the GPS monthly summary from the TMS app so the ported page shows
 * exactly what TMS shows. The distance figures come from TMS's own daily
 * rollup and its fuel-efficiency service; recomputing them here would drift.
 *
 * Needs TMS_API_URL (and TMS_API_SECRET when TMS sets REPORT_API_SECRET).
 */
export async function GET(request) {
  const user = getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  const windowDays = params.get("window") || "30";
  const refresh = params.get("refresh") === "1" ? "1" : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ success: false, message: "from/to must be YYYY-MM-DD" }, { status: 400 });
  }

  const base = (process.env.TMS_API_URL || process.env.NEXT_PUBLIC_TMS_URL || "").replace(/\/$/, "");
  if (!base) {
    return NextResponse.json({ success: false, message: "TMS_API_URL is not configured" }, { status: 503 });
  }

  const url =
    `${base}/api/reports/gps-monthly?from=${from}&to=${to}&window=${windowDays}` +
    (refresh ? "&refresh=1" : "");

  try {
    const response = await fetch(url, {
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
    return NextResponse.json({
      success: true,
      data: { rows: payload.rows, fuel: payload.fuel, efficiency: payload.efficiency },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 502 });
  }
}
