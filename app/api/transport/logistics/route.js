import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";
import { swrCache } from "@/lib/cache";
import {
  getReportDailyDepartment,
  getReportDailyActivityBills,
  getReportDailyActivityItems,
  getReportPendingDaily,
} from "@/lib/tms/queries/reports.js";
import { getAvailableBillProducts } from "@/lib/tms/queries/bills.js";
import { getPodTracking, getPodSummary, getPodLiveFeed, getPodBillProof } from "@/lib/tms/queries/pod.js";
import { addDays, getLaoToday } from "@/lib/tms/lib/lao-date";

/**
 * The TMS logistics reports: proof of delivery, the daily report by sales
 * department, and the daily pending-bill report. Each case mirrors TMS's own
 * report API, including its defaults — the live POD feed in particular is
 * called with no dates, so it falls back to the last three days.
 *
 * The day-scoped reports are cached; pod-live and pod-proof are not. A live
 * feed that lags is worse than one that takes a moment, and pod-proof is a
 * single-bill lookup that is already fast.
 */
const CACHEABLE = new Set(["pod", "daily-department", "daily-bills", "pending-daily"]);
export async function GET(request) {
  const user = getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
  }

  const p = request.nextUrl.searchParams;
  const report = p.get("report") || "";
  const from = p.get("from") || "";
  const to = p.get("to") || "";
  const branch = (p.get("branch") || "").trim();
  const doc = (p.get("doc") || "").trim();

  const run = async () => {
    let data;
    switch (report) {
      case "pod": {
        const opts = {
          session: {},
          fromDate: from,
          toDate: to,
          branch,
          driver: (p.get("driver") || "").trim(),
          state: (p.get("state") || "all").trim(),
          search: (p.get("search") || "").trim(),
          limit: Number(p.get("limit") || 300) || 300,
          requireSignature: p.get("requireSignature") === "1",
        };
        const [rows, summary] = await Promise.all([getPodTracking(opts), getPodSummary(opts)]);
        data = { rows, ...summary };
        break;
      }
      case "pod-live": {
        const minutes = Number(p.get("minutes") || 720) || 720;
        const today = getLaoToday();
        const rows = await getPodLiveFeed({
          session: {},
          fromDate: from || addDays(today, -3),
          toDate: to || today,
          minutes,
          limit: Number(p.get("limit") || 60) || 60,
          branch,
          driver: (p.get("driver") || "").trim(),
          requireSignature: p.get("requireSignature") === "1",
        });
        data = { rows, minutes };
        break;
      }
      case "pod-proof": {
        const bill = p.get("bill") || "";
        if (!bill) return NextResponse.json({ success: false, message: "bill required" }, { status: 400 });
        data = await getPodBillProof(bill, doc || undefined);
        break;
      }
      case "daily-department":
        data = await getReportDailyDepartment({}, from, to, p.get("salesOnly") !== "0", branch);
        break;
      case "daily-bills":
        data = await getReportDailyActivityBills({}, from, to, branch);
        break;
      case "daily-items":
        data = await getReportDailyActivityItems({}, from, to, branch);
        break;
      case "pending-daily":
        data = await getReportPendingDaily({}, from, to);
        break;
      case "bill-products":
        if (!doc) return NextResponse.json({ success: false, message: "doc required" }, { status: 400 });
        data = await getAvailableBillProducts(doc);
        break;
      default:
        return null;
    }
    return { data };
  };

  try {
    const key = `transport:logistics:${request.nextUrl.searchParams.toString()}`;
    const result = CACHEABLE.has(report)
      ? await swrCache(
          key,
          { ttl: 300_000, staleTtl: 24 * 3_600_000, bypass: request.nextUrl.searchParams.get("nocache") === "1" },
          run,
        )
      : await run();
    if (result === null) {
      return NextResponse.json({ success: false, message: "unknown report" }, { status: 400 });
    }
    if (result instanceof NextResponse) return result;
    return NextResponse.json({ success: true, data: result.data });
  } catch (error) {
    console.error(`[transport] logistics ${report} failed:`, error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
