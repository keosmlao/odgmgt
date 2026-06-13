import { NextResponse, type NextRequest } from "next/server";
import { rows, one, query } from "@/lib/db";
import { parseIntSafe } from "@/lib/helpers";
import { fail, errorMessage } from "@/lib/api-response";

async function fetchTargets(aggregateAll = false, yearFilter: number | null = null) {
  let yearClause = "";
  const params: unknown[] = [];
  if (yearFilter !== null && yearFilter !== undefined) {
    yearClause = "WHERE st.target_year = %s";
    params.push(yearFilter);
  }

  const sql = `
    SELECT
      ${aggregateAll ? "'ALL' AS bu_code," : "st.bu_code,"}
      st.sale_channel,
      st.province_code,
      CASE
        WHEN st.province_code = 'ALL' THEN 'ທົວປະເທດ'
        ELSE p.name_1
      END AS province_name,
      st.district_code,
      CASE
        WHEN st.district_code = 'ALL' THEN 'ທຸກເມືອງ'
        ELSE d.name_1
      END AS district_name,
      st.target_year,
      SUM(st.target_amount) FILTER (WHERE st.target_month = 1) AS jan,
      SUM(st.target_amount) FILTER (WHERE st.target_month = 2) AS feb,
      SUM(st.target_amount) FILTER (WHERE st.target_month = 3) AS mar,
      SUM(st.target_amount) FILTER (WHERE st.target_month = 4) AS apr,
      SUM(st.target_amount) FILTER (WHERE st.target_month = 5) AS may,
      SUM(st.target_amount) FILTER (WHERE st.target_month = 6) AS jun,
      SUM(st.target_amount) FILTER (WHERE st.target_month = 7) AS jul,
      SUM(st.target_amount) FILTER (WHERE st.target_month = 8) AS aug,
      SUM(st.target_amount) FILTER (WHERE st.target_month = 9) AS sep,
      SUM(st.target_amount) FILTER (WHERE st.target_month = 10) AS oct,
      SUM(st.target_amount) FILTER (WHERE st.target_month = 11) AS nov,
      SUM(st.target_amount) FILTER (WHERE st.target_month = 12) AS dec,
      SUM(st.target_amount) AS total_year
    FROM public.odg_sales_target st
    LEFT JOIN erp_province p ON p.code = st.province_code
    LEFT JOIN erp_amper d ON d.code = st.district_code
    ${yearClause}
    GROUP BY
      ${aggregateAll ? "" : "st.bu_code,"}
      st.sale_channel,
      st.province_code,
      province_name,
      st.district_code,
      district_name,
      st.target_year
    ORDER BY
      ${aggregateAll ? "" : "st.bu_code,"}
      st.sale_channel,
      st.province_code,
      st.district_code;
  `;

  return rows(sql, params);
}

export async function GET(request: NextRequest) {
  try {
    const year = parseIntSafe(request.nextUrl.searchParams.get("year"), null);
    const aggregateAll = request.nextUrl.searchParams.has("aggregate");
    const data = await fetchTargets(aggregateAll, year);
    return NextResponse.json({ success: true, data });
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}

export async function POST(request: NextRequest) {
  let payload: Record<string, unknown> = {};
  try {
    payload = await request.json();
    const required = ["bu_code", "target", "year", "month"];
    const missing = required.filter((key) =>
      [null, "", undefined].includes(payload[key] as string | null | undefined),
    );
    if (missing.length) {
      return NextResponse.json(
        { success: false, message: `Missing fields: ${missing.join(", ")}` },
        { status: 400 },
      );
    }

    const targetValue = parseIntSafe(payload.target, NaN);
    const yearValue = parseIntSafe(payload.year, NaN);
    const monthValue = parseIntSafe(payload.month, NaN);
    if ([targetValue, yearValue, monthValue].some((v) => Number.isNaN(v))) {
      return NextResponse.json(
        { success: false, message: "year, month, target ต้องเป็นตัวเลข" },
        { status: 400 },
      );
    }

    const provinceCode = payload.province_code || payload.province || "ALL";
    const districtCode = payload.district_code || payload.district || "ALL";
    const saleChannel = payload.channel_code || payload.channel;
    if (!saleChannel) {
      return NextResponse.json(
        { success: false, message: "channel is required" },
        { status: 400 },
      );
    }

    const exists = await one("SELECT 1 FROM mas_bu WHERE bu_code = %s", [payload.bu_code]);
    if (!exists) {
      const buRow = await one("SELECT name_1 FROM odg_bu WHERE code = %s", [payload.bu_code]);
      const buName = buRow?.name_1 || payload.bu_code;
      await query(
        `
          INSERT INTO mas_bu (bu_code, is_active, created_at, bu_name)
          VALUES (%s, true, NOW(), %s)
          ON CONFLICT (bu_code) DO NOTHING
        `,
        [payload.bu_code, buName],
      );
    }

    const inserted = await one(
      `
        INSERT INTO odg_sales_target
        (bu_code, province_code, district_code, sale_channel, target_amount, target_year, target_month)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT ON CONSTRAINT odg_sales_target_unique_full
        DO UPDATE SET target_amount = EXCLUDED.target_amount, sale_channel = EXCLUDED.sale_channel
        RETURNING id
      `,
      [
        payload.bu_code,
        provinceCode,
        districtCode,
        saleChannel,
        targetValue,
        yearValue,
        monthValue,
      ],
    );

    return NextResponse.json({ success: true, id: inserted?.id || null });
  } catch (error: unknown) {
    console.error("createTarget error payload:", payload);
    console.error("createTarget exception:", error);
    return fail(errorMessage(error));
  }
}
