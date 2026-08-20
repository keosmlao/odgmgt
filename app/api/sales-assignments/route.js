import { NextResponse } from "next/server";
import { rows, query } from "@/lib/db";
import { parseIntSafe } from "@/lib/helpers";
import { ensureSalesAssignmentTable } from "@/lib/migrations";
import { SELLER_TABLE } from "@/lib/sale-monthly-sql.mjs";
import { claimableChannelSql, isManagerSql, managesChannelSql, planChannelSql } from "@/lib/sales-board-roles.mjs";
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
     * ເປົ້າ is odg_sales_target and nothing else: every figure in the column comes
     * from that table's own target_amount values, and the board's grand total is
     * exactly the plan that exists — no more, no less.
     *
     * That only holds if each plan row is handed out exactly once in total. Several
     * sellers really do work one district — the assignments were derived from who
     * actually sold where — and letting each of them claim the district's whole
     * plan had the board reading 3.4× the plan that exists. So a plan row is
     * SHARED, not duplicated:
     *
     *   · the most specific area wins the row outright — a district assignment
     *     beats a province-wide one, which beats a country-wide one, so a lump is
     *     not taken by someone who merely happens to overlap it;
     *   · everyone left standing at that tier splits it evenly. Two sellers on one
     *     district-month get half each, three get a third each.
     *
     * The split replaced a winner-takes-all tiebreak on "biggest seller of that
     * BU / area / month". That rule handed one seller the whole month and the
     * other nothing, and it flipped between them from month to month as their
     * sales did — ຂາຍໜ້າຮ້ານ read as one person carrying ກ.ລ and another carrying
     * ສ.ຫາ–ທ.ວ, which is not how the counter is actually staffed.
     *
     * A MANAGER is not among the sharers OF THE CHANNEL THEY RUN. A manager
     * answers for a channel of their BU — ຂາຍສົ່ງ for a BU manager, ໂຄງການ for the
     * project manager — and that number is the SUM of what their sellers carry,
     * not a separate allocation. Letting a manager claim the ຂາຍສົ່ງ rows instead
     * left every wholesale seller under them reading ເປົ້າ 0, because 89% of a BU's
     * plan is wholesale. So their figure is returned as `rollup_amount`, which the
     * grid shows on their row and leaves out of every total — the plan is still
     * counted once, by the sellers who hold it.
     *
     * Only that channel, though. Running one channel of a BU used to bar a person
     * from the plan of EVERY channel in it, so a head who runs ຂາຍສົ່ງ and sells
     * ໂຄງການ themselves read ເປົ້າ 0 in ໂຄງການ while their plan was split among the
     * sellers beside them. The bar is now per channel — see managesChannelSql —
     * so a head with two channels on the roster rolls up both, and one with a
     * second channel they merely sell claims it like anyone else.
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
          JOIN public.odg_sales_target st
            ON st.target_year = %s
           AND st.target_month = b.month
           AND st.bu_code = b.bu_code
           ${claimMatch}
           -- Per CHANNEL, not per person: a head is kept off the plan of the
           -- channel they run and left on the plan of one they merely sell.
           AND NOT ${managesChannelSql("b", "st")}
        ),
        /**
         * Only the closest claimants stay in the running for a plan row. The
         * max is taken as a window rather than a correlated subquery so the
         * claim set is scanned once.
         */
        contender AS (
          SELECT c.*, MAX(c.specificity) OVER (PARTITION BY c.target_id) AS best
          FROM claim c
        ),
        /**
         * ...and they split it. WHERE runs before the window function, so the
         * COUNT counts the sharers that survived the tier filter, not every
         * assignment that overlapped the row.
         */
        owner AS (
          SELECT t.target_id, t.assignment_id, t.sale_channel,
                 -- ::numeric so a three-way split is a third each, not integer division.
                 t.target_amount::numeric / COUNT(*) OVER (PARTITION BY t.target_id) AS target_amount
          FROM contender t
          WHERE t.specificity = t.best
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
         *
         * Which of those rows wins does not matter: the channels rolled up are
         * the roster's, not the winning row's channel_codes. When they came
         * off the row, a head covering two channels through two area rows rolled
         * up whichever row happened to have the lower id and read 0 on the other.
         */
        mgr AS (
          SELECT DISTINCT ON (b.sale_id, b.bu_code, b.month)
                 b.id AS assignment_id, b.sale_id, b.bu_code, b.month
          FROM public.odg_sales_assignment b
          JOIN role r ON r.assignment_id = b.id AND r.is_manager
          ORDER BY b.sale_id, b.bu_code, b.month, b.id
        ),
        rollup_ch AS (
          SELECT m.assignment_id,
                 ${planChannelSql("st")} AS channel_code,
                 SUM(st.target_amount)::float AS amount
          FROM mgr m
          JOIN public.odg_sales_target st
            ON st.target_year = %s
           AND st.target_month = m.month
           AND st.bu_code = m.bu_code
           AND ${managesChannelSql("m", "st")}
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

/**
 * Bulk delete, because a delete on this board is never one row: a seller in a
 * BU is twelve rows, one per month, and a whole BU is hundreds. Firing one
 * request per id opened hundreds of parallel connections against a pool of 50,
 * so some of them failed — and a half-finished delete is what put the rows back
 * on screen at the next reload. One statement, one round trip, all or nothing.
 */
export async function DELETE(request) {
  try {
    await ensureSalesAssignmentTable();
    const payload = await request.json().catch(() => ({}));
    const ids = (Array.isArray(payload?.ids) ? payload.ids : [])
      .map((id) => parseIntSafe(id, NaN))
      .filter((id) => Number.isInteger(id));

    if (!ids.length) {
      return NextResponse.json({ success: false, message: "ids required" }, { status: 400 });
    }

    const result = await query(
      "DELETE FROM public.odg_sales_assignment WHERE id = ANY(%s)",
      [ids],
    );
    return NextResponse.json({ success: true, deleted: result.rowCount });
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
    const channelCodes = payload.channel_codes || [];

    /**
     * One submit is one seller, in one BU, with one set of channels: only the
     * area and the month change from row to row. So the varying three arrive as
     * `rows` and go in as three parallel arrays, and a whole year across several
     * provinces — each with its own districts — is a single INSERT rather than a
     * hundred parallel requests against a pool of fifty.
     *
     * A bare object still works, because one row is the same shape with a list
     * of one.
     */
    const list = Array.isArray(payload.rows) && payload.rows.length
      ? payload.rows
      : [{
          province_code: payload.province_code || payload.province,
          district_code: payload.district_code || payload.district,
          month: payload.month,
        }];

    const provinces = [];
    const districts = [];
    const months = [];
    for (const row of list) {
      const province = row.province_code || row.province;
      const district = row.district_code || row.district || "ALL";
      const month = parseIntSafe(row.month, NaN);
      if (!province) {
        return NextResponse.json(
          { success: false, message: "province_code is required" },
          { status: 400 },
        );
      }
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        return NextResponse.json(
          { success: false, message: "month \u0e15\u0e49\u0e2d\u0e07\u0ea2\u0eb9\u0ec8\u0ea5\u0eb0\u0eab\u0ea7\u0ec8\u0eb2\u0e87 1-12" },
          { status: 400 },
        );
      }
      provinces.push(String(province));
      districts.push(String(district));
      months.push(month);
    }

    if (!(saleId && buCode && provinces.length)) {
      return NextResponse.json(
        { success: false, message: "sale_id, bu_code, province_code, month are required" },
        { status: 400 },
      );
    }

    // DISTINCT, not a client-side dedupe: ON CONFLICT DO UPDATE refuses to touch
    // the same row twice in one statement, so a repeated area/month pair would
    // abort the whole insert rather than collapse into one row.
    const inserted = await rows(
      `
        INSERT INTO public.odg_sales_assignment
          (sale_id, sale_name, bu_code, province_code, district_code, channel_codes, month)
        SELECT DISTINCT %s::text, %s::text, %s::text, t.province, t.district, %s::text[], t.month
        FROM unnest(%s::text[], %s::text[], %s::int[]) AS t(province, district, month)
        ON CONFLICT (sale_id, bu_code, province_code, district_code, month)
        DO UPDATE SET
          sale_name = EXCLUDED.sale_name,
          channel_codes = EXCLUDED.channel_codes
        RETURNING id
      `,
      [String(saleId), saleName, buCode, channelCodes, provinces, districts, months],
    );

    return NextResponse.json({ success: true, count: inserted.length, ids: inserted.map((r) => r.id) });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
