import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";
import { getCurrentAll } from "@/lib/tms/queries/gps-current.js";
import { getPhoneFleet } from "@/lib/tms/queries/tracking.js";

/** Live vehicle and phone positions, from TMS's own trackers. */
export async function GET(request) {
  const user = getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
  }

  try {
    // Phones are best-effort: TMS lets that feed fail without losing the cars.
    const [cars, phones] = await Promise.all([getCurrentAll(), getPhoneFleet().catch(() => [])]);
    return NextResponse.json({ success: true, data: { cars, phones } });
  } catch (error) {
    console.error("[transport] fleet-live failed:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
