import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";
import { swrCache } from "@/lib/cache";
import { getCurrentAll } from "@/lib/tms/queries/gps-current.js";
import { getPhoneFleet } from "@/lib/tms/queries/tracking.js";

/**
 * Live vehicle and phone positions, from TMS's own trackers.
 *
 * Held for 15 seconds only. The query costs about 2 seconds and the trackers do
 * not report faster than that, so a short window costs no freshness while
 * stopping every viewer of the map — and every poll — from paying it again. Not
 * persisted: a stale position is worse than no position after a restart.
 */
export async function GET(request) {
  const user = getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
  }

  try {
    const data = await swrCache(
      "transport:fleet-live",
      { ttl: 15_000, staleTtl: 60_000, persist: false, bypass: request.nextUrl.searchParams.get("nocache") === "1" },
      async () => {
        // Phones are best-effort: TMS lets that feed fail without losing the cars.
        const [cars, phones] = await Promise.all([getCurrentAll(), getPhoneFleet().catch(() => [])]);
        return { cars, phones };
      },
    );
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("[transport] fleet-live failed:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
