import { NextResponse, type NextRequest } from "next/server";
import { rows } from "@/lib/db";
import { ok, fail, errorMessage } from "@/lib/api-response";

export async function GET(request: NextRequest) {
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
    return ok(data);
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}
