import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";
import { findEmployeeByUsername, readPositionName } from "@/lib/employee-auth";

export async function GET(request) {
  const user = getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ success: false, message: "unauthorized" });
  }

  // Tokens issued before the job title existed carry no position, and they are
  // good for a week. Filling it in here means nobody has to sign out and back
  // in to stop seeing their permission level where their title belongs.
  if (!user.position_name && user.username) {
    try {
      const { row } = await findEmployeeByUsername(user.username);
      user.position_name = await readPositionName(row?.position_code);
    } catch {
      user.position_name = null;
    }
  }

  return NextResponse.json({ success: true, user });
}
