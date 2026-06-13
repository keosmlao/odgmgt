import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";
import { buildDashboardPayload } from "@/lib/dashboard";
import { errorMessage } from "@/lib/api-response";

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const year = sp.get("year");
    let bu = sp.get("bu") || "ALL";
    let channel = sp.get("channel") || "ALL";
    const province = sp.get("province") || "ALL";
    const month = sp.get("month");

    const user = getCurrentUser(request);
    if (user && user.role === "sale_bu_manager") {
      if (user.bu_code) {
        bu = user.bu_code;
      }
      if (Array.isArray(user.channel_codes) && user.channel_codes.length) {
        channel = user.channel_codes.map(String).join(",");
      }
    }

    const data = await buildDashboardPayload(year, bu, channel, province, month);
    return NextResponse.json(data);
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
