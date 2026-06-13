import { NextResponse, type NextRequest } from "next/server";
import { one } from "@/lib/db";
import { generatePasswordHash } from "@/lib/auth";
import { getCurrentUser } from "@/lib/route-auth";
import { fail, errorMessage } from "@/lib/api-response";

type Ctx = { params: Promise<{ userId: string }> };

export async function PUT(request: NextRequest, ctx: Ctx) {
  try {
    const user = getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }
    if (!new Set(["admin", "ceo"]).has(String(user.role || "").toLowerCase())) {
      return NextResponse.json({ success: false, message: "forbidden" }, { status: 403 });
    }

    const { userId } = await ctx.params;
    const payload = await request.json();
    const fields: string[] = [];
    const sqlParams: unknown[] = [];

    if (payload.username) {
      fields.push("username = %s");
      sqlParams.push(payload.username);
    }
    if ("full_name" in payload) {
      fields.push("full_name = %s");
      sqlParams.push(payload.full_name);
    }
    if (payload.role) {
      fields.push("role = %s");
      sqlParams.push(payload.role);
    }
    if ("bu_code" in payload) {
      fields.push("bu_code = %s");
      sqlParams.push(payload.bu_code);
    }
    if ("channel_codes" in payload) {
      fields.push("channel_codes = %s");
      sqlParams.push(payload.channel_codes);
    }
    if ("is_active" in payload) {
      fields.push("is_active = %s");
      sqlParams.push(Boolean(payload.is_active));
    }
    if (payload.password) {
      fields.push("password_hash = %s");
      sqlParams.push(generatePasswordHash(payload.password));
    }

    if (!fields.length) {
      return NextResponse.json(
        { success: false, message: "no fields to update" },
        { status: 400 },
      );
    }

    sqlParams.push(Number(userId));
    const data = await one(
      `
        UPDATE public.odg_user_auth
        SET ${fields.join(", ")}
        WHERE id = %s
        RETURNING id, username, full_name, role, bu_code, channel_codes, is_active, created_at
      `,
      sqlParams,
    );
    if (!data) {
      return NextResponse.json({ success: false, message: "not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, data });
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}

export async function DELETE(request: NextRequest, ctx: Ctx) {
  try {
    const user = getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }
    if (!new Set(["admin", "ceo"]).has(String(user.role || "").toLowerCase())) {
      return NextResponse.json({ success: false, message: "forbidden" }, { status: 403 });
    }

    const { userId } = await ctx.params;
    const currentUsername = String(user.username || "").toLowerCase();
    const userIdNum = Number(userId);

    if (currentUsername === "keo") {
      const target = await one(
        "SELECT username FROM public.odg_user_auth WHERE id = %s",
        [userIdNum],
      );
      const targetUsername = String(target?.username || "").toLowerCase();
      if (targetUsername && targetUsername === currentUsername) {
        return NextResponse.json(
          { success: false, message: "cannot delete self" },
          { status: 403 },
        );
      }
    }

    const deleted = await one(
      "DELETE FROM public.odg_user_auth WHERE id = %s RETURNING id",
      [userIdNum],
    );
    if (!deleted) {
      return NextResponse.json({ success: false, message: "not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}
