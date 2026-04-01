import { NextResponse } from "next/server";
import { rows, one, query } from "@/lib/db";
import { parseIntSafe } from "@/lib/helpers";
import { ensureSalesAssignmentTable } from "@/lib/migrations";

export async function GET(request) {
  try {
    await ensureSalesAssignmentTable();
    const sp = request.nextUrl.searchParams;
    const filters = [];
    const params = [];
    const year = sp.get("year");
    const saleId = sp.get("sale_id");
    const buCode = sp.get("bu_code");
    const provinceCode = sp.get("province_code");
    const month = sp.get("month");
    const districtCode = sp.get("district_code");

    if (saleId) {
      filters.push("sale_id = %s");
      params.push(saleId);
    }
    if (buCode) {
      filters.push("bu_code = %s");
      params.push(buCode);
    }
    if (provinceCode) {
      filters.push("province_code = %s");
      params.push(provinceCode);
    }
    if (month) {
      filters.push("month = %s");
      params.push(parseIntSafe(month));
    }
    if (districtCode) {
      filters.push("district_code = %s");
      params.push(districtCode);
    }

    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const yearVal = parseIntSafe(year, new Date().getFullYear());
    const data = await rows(
      `
        SELECT
          a.id,
          a.sale_id,
          a.sale_name,
          a.bu_code,
          a.province_code,
          a.district_code,
          a.channel_codes,
          a.month,
          a.created_at,
          COALESCE(SUM(st.target_amount), 0)::float AS target_amount
        FROM public.odg_sales_assignment a
        LEFT JOIN public.odg_sales_target st
          ON st.target_year = %s
         AND st.target_month = a.month
         AND st.bu_code = a.bu_code
         AND (a.province_code = 'ALL' OR st.province_code = a.province_code)
         AND (a.district_code = 'ALL' OR st.district_code = a.district_code)
        ${where}
        GROUP BY a.id, a.sale_id, a.sale_name, a.bu_code, a.province_code, a.district_code, a.channel_codes, a.month, a.created_at
        ORDER BY a.created_at DESC, a.id DESC
      `,
      [yearVal, ...params],
    );
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    await ensureSalesAssignmentTable();
    const payload = await request.json();
    const saleId = payload.sale_id || payload.sale_code || payload.sale;
    const saleName = payload.sale_name || payload.name || null;
    const buCode = payload.bu_code || payload.bu;
    const provinceCode = payload.province_code || payload.province;
    const month = payload.month;
    const districtCode = payload.district_code || payload.district || "ALL";
    const channelCodes = payload.channel_codes || [];

    if (!(saleId && buCode && provinceCode && month)) {
      return NextResponse.json(
        { success: false, message: "sale_id, bu_code, province_code, month are required" },
        { status: 400 },
      );
    }

    const monthVal = parseIntSafe(month, NaN);
    if (Number.isNaN(monthVal)) {
      return NextResponse.json(
        { success: false, message: "month \u0e15\u0e49\u0e2d\u0e07\u0ec0\u0e9b\u0eb1\u0e99\u0e95\u0ebb\u0ea7\u0ec0\u0ea5\u0e81" },
        { status: 400 },
      );
    }
    if (monthVal < 1 || monthVal > 12) {
      return NextResponse.json(
        { success: false, message: "month \u0e15\u0e49\u0e2d\u0e07\u0ea2\u0eb9\u0ec8\u0ea5\u0eb0\u0eab\u0ea7\u0ec8\u0eb2\u0e87 1-12" },
        { status: 400 },
      );
    }

    const inserted = await one(
      `
        INSERT INTO public.odg_sales_assignment
        (sale_id, sale_name, bu_code, province_code, district_code, channel_codes, month)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (sale_id, bu_code, province_code, district_code, month)
        DO UPDATE SET
          sale_name = EXCLUDED.sale_name,
          bu_code = EXCLUDED.bu_code,
          province_code = EXCLUDED.province_code,
          district_code = EXCLUDED.district_code,
          channel_codes = EXCLUDED.channel_codes,
          month = EXCLUDED.month
        RETURNING id
      `,
      [String(saleId), saleName, buCode, provinceCode, districtCode, channelCodes, monthVal],
    );

    return NextResponse.json({ success: true, id: inserted?.id || null });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
