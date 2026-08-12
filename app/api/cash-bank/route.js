import { NextResponse } from "next/server";
import { swrCache } from "@/lib/cache";
import { getCurrentUser } from "@/lib/route-auth";
import { loadCashBank } from "@/lib/analytics";

export async function GET(request) {
  if (!getCurrentUser(request)) {
    return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
  }
  const days = Number(request.nextUrl.searchParams.get("days") || 90);
  try {
    const data = await swrCache(
      `cash-bank:${days}`,
      { ttl: 300_000, staleTtl: 24 * 3_600_000, bypass: request.nextUrl.searchParams.get("nocache") === "1" },
      () => loadCashBank({ days }),
    );
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
