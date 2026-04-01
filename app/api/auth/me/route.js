import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";

export async function GET(request) {
  const user = getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ success: false, message: "unauthorized" });
  }
  return NextResponse.json({ success: true, user });
}
