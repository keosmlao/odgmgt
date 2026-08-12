import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";

/** Proxies the live vehicle + phone positions the fleet map needs from TMS. */
export async function GET(request) {
  const user = getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
  }

  const base = (process.env.TMS_API_URL || process.env.NEXT_PUBLIC_TMS_URL || "").replace(/\/$/, "");
  if (!base) {
    return NextResponse.json({ success: false, message: "TMS_API_URL is not configured" }, { status: 503 });
  }

  try {
    const response = await fetch(`${base}/api/reports/fleet-live`, {
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
    return NextResponse.json({ success: true, data: { cars: payload.cars, phones: payload.phones } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 502 });
  }
}
