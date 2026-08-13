import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/route-auth";
import { buildTripVolume, buildTripVolumesBulk } from "@/lib/tms/actions/trip-volume";

/** Load and volume for one trip, or for several at once. */
export async function GET(request) {
  const user = getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const doc = (params.get("doc") || "").trim();
  const docs = (params.get("docs") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!doc && docs.length === 0) {
    return NextResponse.json({ success: false, message: "doc or docs required" }, { status: 400 });
  }

  try {
    const data = doc ? await buildTripVolume(doc) : await buildTripVolumesBulk(docs);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("[transport] trip-volume failed:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
