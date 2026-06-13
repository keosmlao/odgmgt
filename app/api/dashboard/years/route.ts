import { NextResponse } from "next/server";
import { rows } from "@/lib/db";
import { parseIntSafe } from "@/lib/helpers";
import { fail, errorMessage } from "@/lib/api-response";

export async function GET() {
  try {
    const data = await rows(`
      SELECT DISTINCT yeardoc AS year
      FROM public.odg_sale_detail
      WHERE yeardoc IS NOT NULL
      UNION
      SELECT DISTINCT target_year AS year
      FROM public.odg_sales_target
      WHERE target_year IS NOT NULL
      ORDER BY year
    `);
    return NextResponse.json({
      success: true,
      data: data
        .map((row) => parseIntSafe(row.year, null))
        .filter((value) => value !== null),
    });
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}
