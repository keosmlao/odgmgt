import { NextResponse } from "next/server";
import { one } from "@/lib/db";
import { fail, errorMessage } from "@/lib/api-response";

export async function GET() {
  try {
    const countRow = await one("SELECT COUNT(*) AS count FROM public.odg_user_auth");
    return NextResponse.json({
      success: true,
      initialized: Number(countRow?.count || 0) > 0,
    });
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}
