import { NextResponse } from "next/server";
import { rows, one, query } from "@/lib/db";
import { parseIntSafe } from "@/lib/helpers";
import { ensureTargetUniqueConstraint } from "@/lib/migrations";

async function fetchTargets(aggregateAll = false, yearFilter = null) {
  let yearClause = "";
  const params = [];
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
        WHEN st.province_code = 'ALL' THEN '\u0e97\u0ebb\u0ea7\u0e9b\u0eb0\u0ec0\u0e97\u0e94'
        ELSE p.name_1
      END AS province_name,
      st.district_code,
      CASE
        WHEN st.district_code = 'ALL' THEN '\u0e97\u0eb8\u0e81\u0ec0\u0ea1\u0eb7\u0ead\u0e87'
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

export async function GET(request) {
  try {
    const year = parseIntSafe(request.nextUrl.searchParams.get("year"), null);
    const aggregateAll = request.nextUrl.searchParams.has("aggregate");
    const data = await fetchTargets(aggregateAll, year);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  let payload = {};
  try {
    payload = await request.json();
    const required = ["bu_code", "target", "year", "month"];
    const missing = required.filter((key) => [null, "", undefined].includes(payload[key]));
    if (missing.length) {
      return NextResponse.json(
        { success: false, message: `Missing fields: ${missing.join(", ")}` },
        { status: 400 },
      );
    }

    const targetValue = parseIntSafe(payload.target, NaN);
    const yearValue = parseIntSafe(payload.year, NaN);
    const monthValue = parseIntSafe(payload.month, NaN);
    if ([targetValue, yearValue, monthValue].some(Number.isNaN)) {
      return NextResponse.json(
        { success: false, message: "year, month, target \u0e15\u0e49\u0e2d\u0e07\u0e40\u0e1b\u0e47\u0e19\u0e15\u0e31\u0e27\u0e40\u0e25\u0e02" },
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

    await ensureTargetUniqueConstraint();

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
  } catch (error) {
    console.error("createTarget error payload:", payload);
    console.error("createTarget exception:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
