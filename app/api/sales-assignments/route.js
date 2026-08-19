import { NextResponse } from "next/server";
import { rows, one, query } from "@/lib/db";
import { parseIntSafe } from "@/lib/helpers";
import { ensureSalesAssignmentTable } from "@/lib/migrations";
import { SELLER_TABLE } from "@/lib/sale-monthly-sql.mjs";
import { claimableChannelSql, isManagerSql } from "@/lib/sales-board-roles.mjs";
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
    // The seller-grained rollup is built by the same pass, so one freshness
    // check covers both.
    await ensureFreshRollup([yearVal, yearVal - 1]);

    /**
     * An assignment's slice of the plan: same BU, same area, same channels.
     *
     * `channel_codes` empty means every channel. 'ALL' is a wildcard on EITHER
     * side — a seller covering the whole country claims every province's plan,
     * and a plan lump recorded for the whole country, which is how BU 16's
     * entire year is written, belongs to whoever covers a piece of it.
     */
    const claimMatch = `
           AND (b.province_code = 'ALL' OR st.province_code = 'ALL'
                OR st.province_code = b.province_code)
           AND (b.district_code = 'ALL' OR st.district_code = 'ALL'
                OR st.district_code = b.district_code)
           AND ${claimableChannelSql("b", "st")}`;

    /**
     * One assignment's own kip, split by the channel the bill was rung up in.
     *
     * Per channel rather than one lump because the board now opens a BU into
     * its channels, and a seller who works both ຂາຍສົ່ງ and ໜ້າຮ້ານ has to
     * land in both. Summing the slices gives back the old single figure, so
     * everything reading `act` is unchanged.
     */
    const sellerActualByChannel = `
      SELECT b.id AS assignment_id, sm.channel_code, SUM(sm.sum_amount)::float AS amount
      FROM public.odg_sales_assignment b
      JOIN ${SELLER_TABLE} sm
        ON sm.yeardoc = %s
       AND sm.sale_id = b.sale_id
       AND sm.monthdoc = b.month
       AND sm.bu_code = b.bu_code
       AND (b.province_code = 'ALL' OR sm.province = b.province_code)
       AND (b.district_code = 'ALL' OR sm.amper = b.district_code)
       AND (
         b.channel_codes IS NULL
         OR array_length(b.channel_codes, 1) IS NULL
         OR sm.channel_code = ANY(b.channel_codes)
       )
      GROUP BY b.id, sm.channel_code`;

    /**
     * ເປົ້າ is odg_sales_target and nothing else: every figure in the column is a
     * sum of that table's own target_amount values, never divided and never
     * scaled.
     *
     * That only adds up if each plan row has exactly ONE owner. Several sellers
     * really do work one district — the assignments were derived from who
     * actually sold where — and letting each of them claim the district's plan
     * had the board reading 3.4× the plan that exists. So a plan row goes to its
     * single best claimant and the others get nothing from it:
     *
     *   · the most specific area wins — a district row beats a province-wide one,
     *     which beats a country-wide one, so a lump is not taken by someone who
     *     merely happens to overlap it;
     *   · then the biggest seller of that BU / area / month, because the plan for
     *     an area belongs with whoever actually works it;
     *   · then the lowest id, so the answer never depends on row order.
     *
     * MANAGERS own nothing. A manager answers for a whole channel of their BU —
     * ຂາຍສົ່ງ for a BU manager, ໂຄງການ for the project manager — and that number
     * is the SUM of what their sellers carry, not a separate allocation. Letting
     * a manager claim the ຂາຍສົ່ງ rows instead left every wholesale seller under
     * them reading ເປົ້າ 0, because 89% of a BU's plan is wholesale. So their
     * figure is returned as `rollup_amount`, which the grid shows on their row
     * and leaves out of every total — the plan is still counted once, by the
     * seller who holds it.
     */
    const data = await rows(
      `
        WITH act_ch AS (${sellerActualByChannel}),
        act AS (
          SELECT assignment_id, SUM(amount) AS amount FROM act_ch GROUP BY assignment_id
        ),
        role AS (
          SELECT b.id AS assignment_id, ${isManagerSql("b")} AS is_manager
          FROM public.odg_sales_assignment b
        ),
        claim AS (
          SELECT b.id AS assignment_id, st.id AS target_id, st.target_amount,
                 st.sale_channel,
                 (CASE WHEN b.province_code <> 'ALL' THEN 2 ELSE 0 END
                  + CASE WHEN b.district_code <> 'ALL' THEN 1 ELSE 0 END) AS specificity
          FROM public.odg_sales_assignment b
          JOIN role r ON r.assignment_id = b.id AND NOT r.is_manager
          JOIN public.odg_sales_target st
            ON st.target_year = %s
           AND st.target_month = b.month
           AND st.bu_code = b.bu_code
           ${claimMatch}
        ),
        owner AS (
          SELECT DISTINCT ON (c.target_id) c.target_id, c.assignment_id, c.target_amount,
                 c.sale_channel
          FROM claim c
          LEFT JOIN act ON act.assignment_id = c.assignment_id
          ORDER BY c.target_id, c.specificity DESC,
                   act.amount DESC NULLS LAST, c.assignment_id
        ),
        /**
         * The plan a row owns, cut by the channel of the odg_sales_target rows
         * it owns. A plan row with no channel of its own is filed under 'ALL',
         * the same bucket the board labels ທຸກຊ່ອງທາງ — it is a real lump for
         * the whole BU, not a missing value to be spread across the channels.
         */
        plan_ch AS (
          SELECT assignment_id,
                 COALESCE(NULLIF(btrim(sale_channel), ''), 'ALL') AS channel_code,
                 SUM(target_amount)::float AS amount
          FROM owner GROUP BY 1, 2
        ),
        plan AS (
          SELECT assignment_id, SUM(amount) AS amount FROM plan_ch GROUP BY assignment_id
        ),
        /**
         * The manager's roll-up. One row per manager × BU × month carries it —
         * a manager with several rows in one BU-month would otherwise show that
         * month's plan once per row.
         */
        mgr AS (
          SELECT DISTINCT ON (b.sale_id, b.bu_code, b.month)
                 b.id AS assignment_id, b.bu_code, b.month, b.channel_codes
          FROM public.odg_sales_assignment b
          JOIN role r ON r.assignment_id = b.id AND r.is_manager
          ORDER BY b.sale_id, b.bu_code, b.month, b.id
        ),
        rollup_ch AS (
          SELECT m.assignment_id,
                 COALESCE(NULLIF(btrim(st.sale_channel), ''), 'ALL') AS channel_code,
                 SUM(st.target_amount)::float AS amount
          FROM mgr m
          JOIN public.odg_sales_target st
            ON st.target_year = %s
           AND st.target_month = m.month
           AND st.bu_code = m.bu_code
           AND (
             m.channel_codes IS NULL
             OR array_length(m.channel_codes, 1) IS NULL
             OR st.sale_channel = ANY(m.channel_codes)
             OR st.sale_channel = 'ALL'
           )
          GROUP BY 1, 2
        ),
        rollup AS (
          SELECT assignment_id, SUM(amount) AS amount FROM rollup_ch GROUP BY assignment_id
        ),
        /**
         * One {channel: kip} object per assignment, so the grid can hang a
         * channel level under the BU without a second round trip.
         */
        plan_map AS (
          SELECT assignment_id, jsonb_object_agg(channel_code, amount) AS by_channel
          FROM plan_ch GROUP BY assignment_id
        ),
        act_map AS (
          SELECT assignment_id, jsonb_object_agg(channel_code, amount) AS by_channel
          FROM act_ch GROUP BY assignment_id
        ),
        roll_map AS (
          SELECT assignment_id, jsonb_object_agg(channel_code, amount) AS by_channel
          FROM rollup_ch GROUP BY assignment_id
        )
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
          COALESCE(tgt.amount, 0)::float AS target_amount,
          -- Display only; never summed into a parent or the grand total.
          COALESCE(roll.amount, 0)::float AS rollup_amount,
          COALESCE(act.amount, 0)::float AS actual_amount,
          COALESCE(pm.by_channel, '{}'::jsonb) AS target_by_channel,
          COALESCE(rm.by_channel, '{}'::jsonb) AS rollup_by_channel,
          COALESCE(amp.by_channel, '{}'::jsonb) AS actual_by_channel
        FROM public.odg_sales_assignment a
        LEFT JOIN public.erp_amper am ON am.code = a.district_code
        LEFT JOIN plan tgt ON tgt.assignment_id = a.id
        LEFT JOIN rollup roll ON roll.assignment_id = a.id
        LEFT JOIN act ON act.assignment_id = a.id
        LEFT JOIN plan_map pm ON pm.assignment_id = a.id
        LEFT JOIN roll_map rm ON rm.assignment_id = a.id
        LEFT JOIN act_map amp ON amp.assignment_id = a.id
        ${where}
        ORDER BY a.created_at DESC, a.id DESC
      `,
      [yearVal, yearVal, yearVal, ...params],
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
