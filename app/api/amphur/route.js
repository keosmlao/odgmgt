import { NextResponse } from "next/server";
import { rows } from "@/lib/db";

export async function GET(request) {
  try {
    const provinceCode = request.nextUrl.searchParams.get("province_code");
    if (!provinceCode) {
      return NextResponse.json(
        { success: false, message: "province_code is required" },
        { status: 400 },
      );
    }
    const data = await rows(
      `
        SELECT code, name_1
        FROM erp_amper
        WHERE province = %s
        ORDER BY code
      `,
      [provinceCode],
    );
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
