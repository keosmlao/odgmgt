import { NextResponse, type NextRequest } from "next/server";
import { one } from "@/lib/db";
import { fail, errorMessage } from "@/lib/api-response";

export async function GET(request: NextRequest) {
  try {
    const username = request.nextUrl.searchParams.get("username");
    if (!username) {
      return NextResponse.json({ success: false, message: "username required" });
    }
    const exists = await one(
      "SELECT 1 FROM public.odg_user_auth WHERE username = %s",
      [username],
    );
    return NextResponse.json({ success: true, exists: Boolean(exists) });
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}
