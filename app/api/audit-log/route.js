import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";
import { listAuditLog } from "@/lib/audit";

/** Read-only audit trail for executives/admins. */
export async function GET(request) {
  try {
    const user = getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }
    if (!new Set(["admin", "ceo", "gm"]).has(String(user.role || "").toLowerCase())) {
      return NextResponse.json({ success: false, message: "forbidden" }, { status: 403 });
    }

    const sp = request.nextUrl.searchParams;
    const data = await listAuditLog({
      action: sp.get("action") || "",
      username: sp.get("username") || "",
      limit: sp.get("limit") || 200,
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
