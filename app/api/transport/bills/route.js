import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";
import { swrCache } from "@/lib/cache";
import {
  getBillsWaitingSent,
  getBillsWaitingSentDetails,
  getBillsInProgress,
  getBillCompleteList,
} from "@/lib/tms/queries/bills.js";
import { getJobBillsWithProducts } from "@/lib/tms/queries/jobs.js";
import { getTransportBranches } from "@/lib/tms/queries/master-data.js";

/**
 * The TMS bill lists — waiting to send, in progress, completed — from TMS's own
 * queries. Read-only: the pages send every mutating action back to TMS itself.
 *
 * The lists are cached for a minute — long enough that a room full of people
 * watching the same board does not re-run them, short enough that a bill moving
 * between states shows up promptly. The single-document lookups are not cached;
 * they are opened one at a time and are already fast.
 */
const CACHEABLE = new Set(["waiting-sent", "in-progress", "complete", "branches"]);
export async function GET(request) {
  const user = getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const list = params.get("list") || "";
  const doc = params.get("doc") || "";
  const from = params.get("from") || "";
  const to = params.get("to") || "";

  const run = async () => {
    let data;
    switch (list) {
      case "waiting-sent":
        data = await getBillsWaitingSent({});
        break;
      case "in-progress":
        data = await getBillsInProgress({});
        break;
      case "complete":
        data = await getBillCompleteList({}, from || undefined, to || undefined);
        break;
      case "branches":
        data = await getTransportBranches();
        break;
      case "details":
        if (!doc) return NextResponse.json({ success: false, message: "doc required" }, { status: 400 });
        data = await getBillsWaitingSentDetails(doc);
        break;
      case "job-products":
        if (!doc) return NextResponse.json({ success: false, message: "doc required" }, { status: 400 });
        data = await getJobBillsWithProducts(doc);
        break;
      default:
        return null;
    }
    return { data };
  };

  try {
    const result = CACHEABLE.has(list)
      ? await swrCache(
          `transport:bills:${request.nextUrl.searchParams.toString()}`,
          { ttl: 60_000, staleTtl: 6 * 3_600_000, bypass: request.nextUrl.searchParams.get("nocache") === "1" },
          run,
        )
      : await run();
    if (result === null) {
      return NextResponse.json({ success: false, message: "unknown list" }, { status: 400 });
    }
    if (result instanceof NextResponse) return result;
    return NextResponse.json({ success: true, data: result.data });
  } catch (error) {
    console.error(`[transport] bills ${list} failed:`, error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
