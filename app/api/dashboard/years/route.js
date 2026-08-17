import { NextResponse } from "next/server";
import { rows } from "@/lib/db";
import { parseIntSafe } from "@/lib/helpers";
import { SALE_DETAIL_REPORTED, ensureReportedView } from "@/lib/sale-detail-view";

export async function GET() {
  await ensureReportedView();
  try {
    const data = await rows(`
      SELECT DISTINCT yeardoc AS year
      FROM ${SALE_DETAIL_REPORTED}
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
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
