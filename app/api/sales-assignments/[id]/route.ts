import { NextResponse, type NextRequest } from "next/server";
import { query } from "@/lib/db";
import { fail, errorMessage } from "@/lib/api-response";

export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    await query(
      "DELETE FROM public.odg_sales_assignment WHERE id = %s",
      [Number(id)],
    );
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}
