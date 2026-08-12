import { NextResponse } from "next/server";
import { rows, one } from "@/lib/db";
import { getCurrentUser } from "@/lib/route-auth";
import { swrCache } from "@/lib/cache";

/**
 * Commission rules: the base amount per position × product group, the tier
 * ladder that turns achievement into a payable rate, and the change history.
 * Read-only — the sales app owns these tables.
 *
 * Neither app_incentive_role_commission nor app_incentive_commission_tier has
 * effective_from / effective_to columns, so the scheme's validity period is
 * declared here (override with ODG_COMMISSION_FROM / ODG_COMMISSION_TO).
 */
const PERIOD_FROM = process.env.ODG_COMMISSION_FROM || "2026-06-01";
const PERIOD_TO = process.env.ODG_COMMISSION_TO || "2026-12-31";
async function loadCommission() {
  const [config, base, tiers, audit, positions] = await Promise.all([
    one(`SELECT * FROM public.app_incentive_config ORDER BY id LIMIT 1`).catch(() => null),
    rows(`SELECT position_code, group_code, base_amount FROM public.app_incentive_role_commission
          ORDER BY position_code, group_code`).catch(() => []),
    rows(`SELECT position_code, from_pct, mode, round_step FROM public.app_incentive_commission_tier
          ORDER BY position_code, from_pct`).catch(() => []),
    rows(`SELECT position_code, group_code, old_amount, new_amount, changed_by, changed_at
          FROM public.app_incentive_role_commission_audit ORDER BY changed_at DESC LIMIT 50`).catch(() => []),
    rows(`SELECT position_code, position_name_lo, position_name_en, is_manager
          FROM public.odg_position ORDER BY position_code`).catch(() => []),
  ]);

  const nameByPosition = new Map(
    positions.map((row) => [String(row.position_code), row.position_name_lo || row.position_name_en]),
  );

  const groups = [...new Set(base.map((row) => String(row.group_code)))].sort();
  const positionCodes = [...new Set([...base, ...tiers].map((row) => String(row.position_code)))].sort();

  const matrix = positionCodes.map((code) => ({
    position_code: code,
    position_name: nameByPosition.get(code) || null,
    amounts: Object.fromEntries(
      groups.map((group) => [
        group,
        Number(base.find((row) => String(row.position_code) === code && String(row.group_code) === group)?.base_amount ?? 0),
      ]),
    ),
    tiers: tiers
      .filter((row) => String(row.position_code) === code)
      .map((row) => ({
        from_pct: Number(row.from_pct || 0),
        mode: row.mode,
        round_step: Number(row.round_step || 0),
      })),
  }));

  return {
    period: { from: PERIOD_FROM, to: PERIOD_TO, source: "default" },
    config: {
      currency: config?.currency_code || "THB",
      commission_base: Number(config?.commission_base || 0),
      commission_min_pct: Number(config?.commission_min_pct || 0),
      commission_pivot_pct: Number(config?.commission_pivot_pct || 0),
      commission_round_step: Number(config?.commission_round_step || 0),
    },
    groups,
    matrix,
    audit: audit.map((row) => ({
      position_code: row.position_code,
      group_code: row.group_code,
      old_amount: Number(row.old_amount || 0),
      new_amount: Number(row.new_amount || 0),
      changed_by: row.changed_by,
      changed_at: row.changed_at,
    })),
  };
}

export async function GET(request) {
  try {
    if (!getCurrentUser(request)) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }

    const data = await swrCache(
      "commission",
      {
        ttl: 300_000,
        staleTtl: 24 * 3_600_000,
        bypass: request.nextUrl.searchParams.get("nocache") === "1",
      },
      loadCommission,
    );

    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
