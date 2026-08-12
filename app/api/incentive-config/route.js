import { NextResponse } from "next/server";
import { rows, one } from "@/lib/db";
import { parseIntSafe } from "@/lib/helpers";
import { getCurrentUser } from "@/lib/route-auth";
import { swrCache } from "@/lib/cache";

/**
 * Read-only view of the incentive scheme's configuration
 * (the app_incentive_* / app_commission_* tables the sales app maintains).
 *
 * Several tables are versioned in time, so by default each one is filtered to
 * the rules in force during the selected month; `all=1` returns every version.
 */
const SECTIONS = [
  {
    key: "points",
    tables: [
      { table: "app_incentive_category", order: "group_code, category_code" },
      { table: "app_incentive_pointmap_category", order: "sort_order, code" },
      {
        table: "app_incentive_point_rule",
        order: "category_code, brand_code, size_token",
        limit: 400,
        period: "range",
      },
      {
        table: "app_incentive_point_map",
        order: "category_code, brand_code, size_token",
        limit: 400,
        period: "month",
      },
    ],
  },
  {
    key: "rewards",
    tables: [
      { table: "app_incentive_unit_reward", order: "reward_code", period: "range" },
      { table: "app_incentive_special_reward", order: "reward_code", period: "range" },
    ],
  },
  {
    key: "product",
    tables: [
      { table: "app_incentive_status_multiplier", order: "status_code" },
      { table: "app_incentive_product_status", order: "item_code", limit: 300, period: "range" },
      { table: "app_incentive_product_status_rule", order: "item_code", limit: 300, period: "range" },
    ],
  },
  {
    key: "mapping",
    tables: [
      { table: "app_incentive_design_token", order: "design_token" },
      { table: "app_incentive_size_token", order: "size_token" },
      { table: "app_incentive_sale_alias", order: "employee_code" },
    ],
  },
];

/**
 * `range`  → effective_from ≤ mid-month ≤ effective_to
 * `month`  → effect_month falls on or before the end of the selected month
 */
function periodClause(period, monthDate, monthEnd) {
  if (period === "range") {
    return { where: `WHERE %s::date BETWEEN effective_from AND effective_to`, params: [monthDate] };
  }
  if (period === "month") {
    return { where: `WHERE effect_month <= %s::date`, params: [monthEnd] };
  }
  return { where: "", params: [] };
}

async function loadTable(spec, { monthDate, monthEnd, all }) {
  const scoped = Boolean(spec.period) && !all;
  const { where, params } = scoped ? periodClause(spec.period, monthDate, monthEnd) : { where: "", params: [] };

  const [data, count] = await Promise.all([
    rows(
      `SELECT * FROM public."${spec.table}" ${where} ORDER BY ${spec.order} LIMIT ${spec.limit || 500}`,
      params,
    ).catch(() => []),
    one(`SELECT COUNT(*)::int AS n FROM public."${spec.table}"`).catch(() => ({ n: 0 })),
  ]);

  return {
    table: spec.table,
    period: spec.period || null,
    scoped,
    total: Number(count?.n || 0),
    shown: data.length,
    columns: data.length ? Object.keys(data[0]) : [],
    rows: data,
  };
}

async function loadConfig({ year, month, all }) {
  const monthDate = `${year}-${String(month).padStart(2, "0")}-15`;
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-28`;

  const [config, sections] = await Promise.all([
    one(`SELECT * FROM public.app_incentive_config ORDER BY id LIMIT 1`).catch(() => null),
    Promise.all(
      SECTIONS.map(async (section) => ({
        key: section.key,
        tables: await Promise.all(
          section.tables.map((spec) => loadTable(spec, { monthDate, monthEnd, all })),
        ),
      })),
    ),
  ]);

  return { meta: { year, month, all }, config, sections };
}

export async function GET(request) {
  try {
    if (!getCurrentUser(request)) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }

    const sp = request.nextUrl.searchParams;
    const now = new Date();
    const year = parseIntSafe(sp.get("year"), now.getFullYear());
    const month = Math.min(12, Math.max(1, parseIntSafe(sp.get("month"), now.getMonth() + 1)));
    const all = sp.get("all") === "1";

    const data = await swrCache(
      `incentive-config:${year}|${month}|${all ? "all" : "month"}`,
      { ttl: 300_000, staleTtl: 24 * 3_600_000, bypass: sp.get("nocache") === "1" },
      () => loadConfig({ year, month, all }),
    );

    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
