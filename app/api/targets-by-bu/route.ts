import { type NextRequest } from "next/server";
import { rows } from "@/lib/db";
import { parseIntSafe } from "@/lib/helpers";
import { ok, fail, errorMessage } from "@/lib/api-response";

async function fetchTargets(yearFilter: number | null = null) {
  let yearClause = "";
  const params: unknown[] = [];
  if (yearFilter !== null && yearFilter !== undefined) {
    yearClause = "WHERE st.target_year = %s";
    params.push(yearFilter);
  }

  const sql = `
    SELECT
      st.bu_code,
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
      st.bu_code,
      st.sale_channel,
      st.province_code,
      province_name,
      st.district_code,
      district_name,
      st.target_year
    ORDER BY
      st.bu_code,
      st.sale_channel,
      st.province_code,
      st.district_code;
  `;

  return rows(sql, params);
}

export async function GET(request: NextRequest) {
  try {
    const year = parseIntSafe(request.nextUrl.searchParams.get("year"), null);
    const data = await fetchTargets(year);
    return ok(data);
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}
