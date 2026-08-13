import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";
import { swrCache } from "@/lib/cache";
import {
  getGpsUsageSummary,
  getGpsUsageSummaryCached,
} from "@/lib/tms/queries/gps-usage.js";
import { getFuelByCar } from "@/lib/tms/queries/fuel.js";
import { buildFuelEfficiency } from "@/lib/tms/lib/fuel-efficiency-service";

/**
 * GPS monthly summary: distance from TMS's own daily rollup, fuel from its fuel
 * records, and km/L from its fuel-efficiency service. Recomputing any of these
 * here would drift from what TMS shows.
 *
 * The blank session is how TMS's own report API calls these — every branch, no
 * scoping.
 */
const ALL_BRANCHES = {
  usercode: "",
  username: "",
  logistic_code: "",
  department: "",
  title: "",
  emp_department_code: "",
  emp_department_name: "",
  position_title: "",
  app_role: "",
  position_code: "",
  branch_codes: "",
};

export async function GET(request) {
  const user = getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const fromDate = params.get("from") || "";
  const toDate = params.get("to") || "";
  const windowDays = Number(params.get("window") || 30) || 30;
  const refresh = params.get("refresh") === "1";
  const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!isDate(fromDate) || !isDate(toDate)) {
    return NextResponse.json({ success: false, message: "from/to must be YYYY-MM-DD" }, { status: 400 });
  }

  try {
    // refresh=1 is the page's own "rebuild the rollup" button, so it must not
    // be answered from cache.
    const data = await swrCache(
      `transport:gps-monthly:${fromDate}:${toDate}:${windowDays}`,
      { ttl: 600_000, staleTtl: 24 * 3_600_000, bypass: refresh || request.nextUrl.searchParams.get("nocache") === "1" },
      async () => {
        const [rows, fuel, efficiency] = await Promise.all([
          refresh
            ? getGpsUsageSummary(fromDate, toDate, undefined, { fillMissing: true })
            : getGpsUsageSummaryCached(fromDate, toDate),
          getFuelByCar({ fromDate, toDate, session: ALL_BRANCHES }),
          buildFuelEfficiency(ALL_BRANCHES, toDate, windowDays),
        ]);
        return { rows, fuel, efficiency };
      },
    );
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("[transport] gps-monthly failed:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
