import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { rows } from "@/lib/db";
import { parseIntSafe } from "@/lib/helpers";
import { errorMessage } from "@/lib/api-response";

interface FiltersResult {
  years: number[];
  bu: QueryResultRow[];
  channels: QueryResultRow[];
  provinces: QueryResultRow[];
}

// Cache filters for 10 minutes (they rarely change)
let filtersCache: FiltersResult | null = null;
let filtersCacheTs = 0;
const FILTERS_TTL = 600_000;

export async function GET() {
  try {
    if (filtersCache && Date.now() - filtersCacheTs < FILTERS_TTL) {
      return NextResponse.json(filtersCache);
    }

    const [yearsRows, buRows, channelRows, provinceRows] = await Promise.all([
      rows(`
        SELECT DISTINCT yeardoc AS year FROM public.odg_sale_detail WHERE yeardoc IS NOT NULL
        UNION
        SELECT DISTINCT target_year AS year FROM public.odg_sales_target WHERE target_year IS NOT NULL
        ORDER BY year
      `),
      rows(`
        SELECT DISTINCT bu_code AS code, bu_name AS name_1
        FROM public.odg_sale_detail
        WHERE bu_code IS NOT NULL AND bu_code != ''
        ORDER BY bu_code
      `),
      rows(`
        SELECT code, name_1 FROM public.ar_group
        WHERE code NOT IN ('10', '9', '104', '105')
        ORDER BY code
      `),
      rows(`SELECT code, name_1 FROM public.erp_province ORDER BY name_1`),
    ]);

    const result: FiltersResult = {
      years: yearsRows
        .map((r) => parseIntSafe(r.year, null))
        .filter((v): v is number => v !== null),
      bu: buRows || [],
      channels: channelRows || [],
      provinces: provinceRows || [],
    };

    filtersCache = result;
    filtersCacheTs = Date.now();

    return NextResponse.json(result);
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
