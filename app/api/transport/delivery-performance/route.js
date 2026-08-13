import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";
import { getDeliveryPerformance } from "@/lib/tms/queries/reports.js";

/**
 * Delivery performance for one month, from TMS's own getDeliveryPerformance.
 *
 * This is the report that must not be reimplemented: its carry-in and carry-out
 * counts depend on the rules inside getBillsPending, which a from-scratch
 * version got wrong by roughly 90 bills.
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

  try {
    const data = await getDeliveryPerformance({}, month);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("[transport] delivery-performance failed:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
