import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { ensureSalesAssignmentTable } from "@/lib/migrations";

export async function DELETE(request, { params }) {
  try {
    await ensureSalesAssignmentTable();
    const { id } = await params;
    await query(
      "DELETE FROM public.odg_sales_assignment WHERE id = %s",
      [Number(id)],
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
