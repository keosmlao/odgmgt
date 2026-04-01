import { NextResponse } from "next/server";
import { rows } from "@/lib/db";

export async function GET() {
  try {
    const data = await rows(`
      SELECT code, name_1
      FROM odg_bu
      ORDER BY code
    `);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
