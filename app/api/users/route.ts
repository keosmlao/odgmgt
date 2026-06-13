import { NextResponse, type NextRequest } from "next/server";
import { rows, one } from "@/lib/db";
import { generatePasswordHash } from "@/lib/auth";
import { getCurrentUser } from "@/lib/route-auth";
import { fail, errorMessage } from "@/lib/api-response";

export async function GET(request: NextRequest) {
  try {
    const user = getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }
    const data = await rows(`
      SELECT id, username, full_name, role, bu_code, channel_codes, is_active, created_at
      FROM public.odg_user_auth
      ORDER BY id DESC
    `);
    return NextResponse.json({ success: true, data });
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }
    if (!new Set(["admin", "ceo"]).has(String(user.role || "").toLowerCase())) {
      return NextResponse.json({ success: false, message: "forbidden" }, { status: 403 });
    }

    const payload = await request.json();
    const username = payload.username;
    const password = payload.password;
    const fullName = payload.full_name || null;
    const role = payload.role || "user";
    const buCode = payload.bu_code || null;
    const channelCodes = payload.channel_codes ?? null;
    const isActive = payload.is_active ?? true;

    if (!username || !password) {
      return NextResponse.json(
        { success: false, message: "username and password required" },
        { status: 400 },
      );
    }

    const exists = await one(
      "SELECT 1 FROM public.odg_user_auth WHERE username = %s",
      [username],
    );
    if (exists) {
      return NextResponse.json(
        { success: false, message: "username already exists" },
        { status: 409 },
      );
    }

    const data = await one(
      `
        INSERT INTO public.odg_user_auth
        (username, password_hash, full_name, role, bu_code, channel_codes, is_active)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        RETURNING id, username, full_name, role, bu_code, channel_codes, is_active, created_at
      `,
      [
        username,
        generatePasswordHash(password),
        fullName,
        role,
        buCode,
        channelCodes,
        Boolean(isActive),
      ],
    );

    return NextResponse.json({ success: true, data });
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}
