import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";
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
 */
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

  try {
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
        return NextResponse.json({ success: false, message: "unknown list" }, { status: 400 });
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error(`[transport] bills ${list} failed:`, error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
