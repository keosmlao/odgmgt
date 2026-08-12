import { type NextRequest, NextResponse } from "next/server";
import { searchSuppliers } from "@/lib/pm/products";
import { getCurrentUser } from "@/lib/pm/session";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json([], { status: 401 });
  const q = request.nextUrl.searchParams.get("q") ?? "";
  return NextResponse.json(await searchSuppliers(q, 20));
}
