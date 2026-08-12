import { NextResponse, type NextRequest } from "next/server";
import { searchInventory } from "@/lib/pm/products";
import { getCurrentUser } from "@/lib/pm/session";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json([], { status: 401 });

  const q = request.nextUrl.searchParams.get("q") ?? "";
  const spareOnly = request.nextUrl.searchParams.get("spare") === "1";
  const rows = await searchInventory(q, spareOnly, 20);
  return NextResponse.json(rows);
}
