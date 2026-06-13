import { NextResponse, type NextRequest } from "next/server";
import { query, one } from "@/lib/db";
import { ALLOWED_ROLES, generatePasswordHash } from "@/lib/auth";
import { getCurrentUser } from "@/lib/route-auth";
import { fail, errorMessage } from "@/lib/api-response";

export async function POST(request: NextRequest) {
  try {
    const user = getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ success: false, message: "unauthorized" });
    }
    if (!new Set(["ceo", "gm"]).has(user.role)) {
      return NextResponse.json({ success: false, message: "forbidden" });
    }

    const payload = await request.json();
    const username = payload.username;
    const password = payload.password;
    const fullName = payload.full_name || payload.name;
    const role = payload.role || "sale";
    const buCode = payload.bu_code || null;
    const channelCodes = payload.channel_codes || [];

    if (!ALLOWED_ROLES.has(role)) {
      return NextResponse.json({ success: false, message: "invalid role" });
    }
    if (!username || !password) {
      return NextResponse.json({
        success: false,
        message: "username and password required",
      });
    }
    if (role === "sale_bu_manager" && !buCode) {
      return NextResponse.json({
        success: false,
        message: "bu_code required for sale_bu_manager",
      });
    }
    if (role === "sale_bu_manager" && !channelCodes.length) {
      return NextResponse.json({
        success: false,
        message: "channel_codes required for sale_bu_manager",
      });
    }

    const existing = await one(
      "SELECT 1 FROM public.odg_user_auth WHERE username = %s",
      [username],
    );
    if (existing) {
      return NextResponse.json({ success: false, message: "username already exists" });
    }

    await query(
      `
        INSERT INTO public.odg_user_auth
        (username, password_hash, full_name, role, bu_code, channel_codes)
        VALUES (%s, %s, %s, %s, %s, %s)
      `,
      [
        username,
        generatePasswordHash(password),
        fullName,
        role,
        buCode,
        channelCodes,
      ],
    );

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}
