import { NextResponse, type NextRequest } from "next/server";
import { authLogin } from "@/lib/auth-handlers";
import { fail, errorMessage } from "@/lib/api-response";

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json();
    const result = await authLogin(payload.username, payload.password);
    if (result.error && !result.success) {
      return NextResponse.json(result, { status: 500 });
    }
    return NextResponse.json(result);
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}
