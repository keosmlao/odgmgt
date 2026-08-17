import { NextResponse } from "next/server";
import { rows, one, query } from "@/lib/db";
import { parseIntSafe } from "@/lib/helpers";
import { ensureSalesAssignmentTable } from "@/lib/migrations";
import { MONTHLY_TABLE } from "@/lib/sale-monthly-sql.mjs";
import { ensureFreshRollup } from "@/lib/sale-rollup";

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

    // Actuals come from the rollup, so they bucket on the month a bill is
    // credited to (app_sale_month_override) exactly as the sales reports do.
    await ensureFreshRollup([yearVal, yearVal - 1]);

    /**
     * An assignment's slice of the plan: same BU, same area, same channels.
     *
     * Both figures are aggregated in their own LATERAL rather than joined and
     * SUMmed together — two joins that each match several rows would multiply
     * into each other, and the target would grow by however many months of
     * sales happened to match.
     *
     * `channel_codes` empty means every channel. On the target side an 'ALL'
     * row is a lump nobody split by channel, so it belongs to whoever covers
     * the area; the rollup has no such row, its channels are always resolved.
     */
    const areaMatch = `
       AND (a.province_code = 'ALL' OR %ALIAS%.province_code = a.province_code)
       AND (a.district_code = 'ALL' OR %ALIAS%.district_code = a.district_code)`;

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
          -- The grid used to print the raw code ("0103"); the district table is
          -- the only place its name lives, and it is one join away.
          COALESCE(NULLIF(btrim(am.name_1), ''), a.district_code) AS district_name,
          tgt.amount::float AS target_amount,
          act.amount::float AS actual_amount
        FROM public.odg_sales_assignment a
        LEFT JOIN public.erp_amper am ON am.code = a.district_code
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(st.target_amount), 0) AS amount
          FROM public.odg_sales_target st
          WHERE st.target_year = %s
            AND st.target_month = a.month
            AND st.bu_code = a.bu_code
            ${areaMatch.replaceAll("%ALIAS%", "st")}
            AND (
              a.channel_codes IS NULL
              OR array_length(a.channel_codes, 1) IS NULL
              OR st.sale_channel = ANY(a.channel_codes)
              OR st.sale_channel = 'ALL'
            )
        ) tgt ON TRUE
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(sm.sum_amount), 0) AS amount
          FROM ${MONTHLY_TABLE} sm
          WHERE sm.yeardoc = %s
            AND sm.monthdoc = a.month
            AND sm.bu_code = a.bu_code
            AND (a.province_code = 'ALL' OR sm.province = a.province_code)
            AND (a.district_code = 'ALL' OR sm.amper = a.district_code)
            AND (
              a.channel_codes IS NULL
              OR array_length(a.channel_codes, 1) IS NULL
              OR sm.channel_code = ANY(a.channel_codes)
            )
        ) act ON TRUE
        ${where}
        ORDER BY a.created_at DESC, a.id DESC
      `,
      [yearVal, yearVal, ...params],
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
