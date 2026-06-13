import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const user = getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ success: false, message: "unauthorized" });
  }
  return NextResponse.json({ success: true, user });
}
