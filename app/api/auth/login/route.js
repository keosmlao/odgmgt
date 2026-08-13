import { NextResponse } from "next/server";
import { authLogin } from "@/lib/auth-handlers";
import { requestIp } from "@/lib/audit";

export async function POST(request) {
  try {
    const payload = await request.json();
    const result = await authLogin(payload.username, payload.password, requestIp(request));
    if (result.error && !result.success) {
      return NextResponse.json(result, { status: 500 });
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
