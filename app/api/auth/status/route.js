import { NextResponse } from "next/server";
import { one } from "@/lib/db";
import { ensureAuthTable } from "@/lib/migrations";

export async function GET() {
  try {
    await ensureAuthTable();
    const countRow =
      (await one("SELECT COUNT(*) AS count FROM public.odg_user_auth")) || {};
    return NextResponse.json({
      success: true,
      initialized: Number(countRow.count || 0) > 0,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
