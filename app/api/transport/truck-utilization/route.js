import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";
import { swrCache } from "@/lib/cache";
import { buildUtilizationReport } from "@/lib/tms/actions/trip-volume";

/**
 * Truck space utilisation. buildUtilizationReport is the session-free core of
 * TMS's getUtilizationReport — item dimensions, truck capacity and the
 * distribution bands are all worked out there.
 */
export async function GET(request) {
  const user = getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!isDate(from) || !isDate(to)) {
    return NextResponse.json({ success: false, message: "from/to must be YYYY-MM-DD" }, { status: 400 });
  }

  try {
    const data = await swrCache(
      `transport:truck-utilization:${from}:${to}`,
      { ttl: 600_000, staleTtl: 24 * 3_600_000, bypass: request.nextUrl.searchParams.get("nocache") === "1" },
      () => buildUtilizationReport(from, to),
    );
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("[transport] truck-utilization failed:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
