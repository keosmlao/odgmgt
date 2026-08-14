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
      { table: "app_incentive_product_status", order: "item_code", limit: 300, period: "range", itemName: "item_code" },
      { table: "app_incentive_product_status_rule", order: "item_code", limit: 300, period: "range", itemName: "item_code" },
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
    return { where: `WHERE %s::date BETWEEN t.effective_from AND t.effective_to`, params: [monthDate] };
  }
  if (period === "month") {
    return { where: `WHERE t.effect_month <= %s::date`, params: [monthEnd] };
  }
  return { where: "", params: [] };
}

/** Reads better with the product name next to its code, not tacked on at the end. */
function orderColumns(data, spec) {
  const columns = data.length ? Object.keys(data[0]) : [];
  if (!spec.itemName) return columns;
  const rest = columns.filter((column) => !["item_name", "item_brand"].includes(column));
  const at = rest.indexOf(spec.itemName);
  if (at < 0) return columns;
  return [...rest.slice(0, at + 1), "item_name", "item_brand", ...rest.slice(at + 1)];
}

async function loadTable(spec, { monthDate, monthEnd, all }) {
  const scoped = Boolean(spec.period) && !all;
  const { where, params } = scoped ? periodClause(spec.period, monthDate, monthEnd) : { where: "", params: [] };

  // The config tables only store the item code — the name lives in the product master.
  const select = spec.itemName
    ? `SELECT t.*,
              COALESCE(NULLIF(i.name_1, ''), NULLIF(i.name_eng_1, '')) AS item_name,
              COALESCE(NULLIF(i.item_brand, ''), 'UNKNOWN') AS item_brand
         FROM public."${spec.table}" t
         LEFT JOIN public.ic_inventory i ON i.code = t."${spec.itemName}"`
    : `SELECT t.* FROM public."${spec.table}" t`;
  const order = spec.order
    .split(",")
    .map((column) => `t.${column.trim()}`)
    .join(", ");

  const [data, count] = await Promise.all([
    rows(`${select} ${where} ORDER BY ${order} LIMIT ${spec.limit || 500}`, params).catch((error) => {
      console.error(`incentive-config: ${spec.table} failed:`, error.message);
      return [];
    }),
    one(`SELECT COUNT(*)::int AS n FROM public."${spec.table}"`).catch(() => ({ n: 0 })),
  ]);

  return {
    table: spec.table,
    period: spec.period || null,
    scoped,
    total: Number(count?.n || 0),
    shown: data.length,
    columns: orderColumns(data, spec),
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
      // The version tag is part of the key so a change in the payload shape
      // (extra columns, new joins) is not masked by the persisted cache.
      `incentive-config:v3:${year}|${month}|${all ? "all" : "month"}`,
      { ttl: 300_000, staleTtl: 24 * 3_600_000, bypass: sp.get("nocache") === "1" },
      () => loadConfig({ year, month, all }),
    );

    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
