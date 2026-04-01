import { NextResponse } from "next/server";
import { one } from "@/lib/db";
import { ensureAuthTable } from "@/lib/migrations";

export async function GET(request) {
  try {
    await ensureAuthTable();
    const username = request.nextUrl.searchParams.get("username");
    if (!username) {
      return NextResponse.json({ success: false, message: "username required" });
    }
    const exists = await one(
      "SELECT 1 FROM public.odg_user_auth WHERE username = %s",
      [username],
    );
    return NextResponse.json({ success: true, exists: Boolean(exists) });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
