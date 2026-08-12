import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";

/**
 * Proxies the TMS logistics reports (POD, daily-by-department, daily pending)
 * so the copied pages show exactly what TMS shows. Query parameters are passed
 * through untouched — the report itself decides which ones it reads.
 */
export async function GET(request) {
  const user = getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
  }

  const base = (process.env.TMS_API_URL || process.env.NEXT_PUBLIC_TMS_URL || "").replace(/\/$/, "");
  if (!base) {
    return NextResponse.json({ success: false, message: "TMS_API_URL is not configured" }, { status: 503 });
  }

  const search = request.nextUrl.searchParams.toString();

  try {
    const response = await fetch(`${base}/api/reports/logistics?${search}`, {
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
