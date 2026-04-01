import { NextResponse } from "next/server";
import { rows } from "@/lib/db";

export async function GET() {
  try {
    const data = await rows(`
      SELECT code, name_1
      FROM public.ar_group
      WHERE code NOT IN ('10', '9', '104', '105')
      ORDER BY code
    `);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
