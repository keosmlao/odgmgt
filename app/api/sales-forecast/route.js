import { NextResponse } from "next/server";
import { one, rows } from "@/lib/db";
import { parseIntSafe, safeDiv } from "@/lib/helpers";
import { OVERRIDE_JOIN, REPORT_DATE } from "@/lib/sale-month-override";
import { channelCodeSql } from "@/lib/sale-monthly-sql.mjs";
import {
  LIVE_BILL_STAMP_SQL, LIVE_MAX_DOC_DATE_SQL, SALE_DETAIL_LIVE, ensureLiveView,
} from "@/lib/sale-detail-view";

/**
 * ຄາດການຍອດຂາຍ — where the month lands if it keeps selling the way it has.
 *
 * The month reports answer "how much has been sold". Halfway through a month
 * that is not the question being asked in a sales meeting: the plan is for the
 * whole month, the kip on the screen is for eleven days of it, and everyone in
 * the room does the same division in their head. This page does it on paper:
 *
 *   ຂາຍແລ້ວ (1-DD) → ຄວາມໄວຕໍ່ວັນ → ຄາດການສິ້ນເດືອນ → ຂາດ/ເກີນເປົ້າ
 *                                                   → ຕ້ອງຂາຍຕໍ່ວັນທີ່ເຫຼືອ
 *
 * ປີກ່ອນ is cut at the same day of the month, never the whole of it, for the
 * same reason — see /wholesale-region, which cuts its comparison the same way.
 *
 * The method is the one /sales-overview already forecasts with, so the two
 * cannot put a different number on the same month: selling days with Sundays
 * taken out, a per-day pace, and a bias correction measured from how that
 * projection has actually behaved over the last twelve finished months.
 */

const daysInMonth = (year, month) => new Date(year, month, 0).getDate();

/**
 * ວັນຂາຍ — ວັນອາທິດບໍ່ນັບ, ຄືກັບ /sales-overview. ຮ້ານປິດວັນອາທິດ, ແລະ ຄາດການ
 * ທີ່ຫານດ້ວຍວັນປະຕິທິນຈະຕໍ່າກວ່າຄວາມຈິງທຸກເດືອນທີ່ມີ 5 ວັນອາທິດ.
 */
function sellingDays(year, month, throughDay) {
  const last = Math.min(throughDay ?? daysInMonth(year, month), daysInMonth(year, month));
  let count = 0;
  for (let day = 1; day <= last; day += 1) {
    if (new Date(year, month - 1, day).getDay() !== 0) count += 1;
  }
  return count;
}

/** ຍ້ອນຫຼັງ n ເດືອນ ຈາກ (year, month). */
function monthsBack(year, month, count) {
  const list = [];
  for (let step = 1; step <= count; step += 1) {
    const index = year * 12 + (month - 1) - step;
    list.push({ year: Math.floor(index / 12), month: (index % 12) + 1 });
  }
  return list;
}

/** Same channel mapping as the target rows of /month-summary. */
function normalizeTargetChannel(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "OTHER";
  if (/^\d+$/.test(raw)) return raw;
  const byName = {
    ຂາຍໜ້າຮ້ານ: "101",
    ຂາຍສົ່ງ: "102",
    ຂາຍໂຄງການ: "103",
    ໂຄງການ: "103",
    ພະນັກງານ: "104",
    ຂາຍຊ່າງ: "106",
    ອອນລາຍ: "107",
    ຂາຍອອນລາຍ: "107",
    ຕົວແທນຂາຍ: "108",
  };
  if (byName[raw]) return byName[raw];
  return raw.toUpperCase() === "ALL" ? "ALL" : "OTHER";
}

/** A plan entered as 'ALL' is the BU's whole month, not a channel of it. */
const ALL_CHANNEL_LABEL = "ລວມທຸກຊ່ອງທາງ";

async function readSourceStamp(years) {
  const row = await one(
    `SELECT to_char(GREATEST(MAX(d.doc_date), ${LIVE_MAX_DOC_DATE_SQL}), 'YYYY-MM-DD') AS data_through,
            COUNT(*)::text AS source_rows,
            ${LIVE_BILL_STAMP_SQL} AS live_stamp,
            (SELECT COUNT(*)::text || '@' || COALESCE(MAX(created_at)::text, '-')
               FROM public.app_sale_month_override) AS override_stamp
     FROM ${SALE_DETAIL_LIVE} d
     WHERE d.yeardoc = ANY(%s::int[])`,
    [years],
  );
  return {
    data_through: row?.data_through ?? null,
    stamp: `${row?.source_rows ?? "0"}|${row?.data_through ?? "-"}|${row?.live_stamp ?? "-"}|${row?.override_stamp ?? "-"}`,
  };
}

const cache = new Map();
const CACHE_MAX = 24;

export async function GET(request) {
  // The live view has to exist before anything selects from it.
  await ensureLiveView();
  try {
    const sp = request.nextUrl.searchParams;
    const now = new Date();
    // The month being sold is the one worth forecasting, so this page opens on
    // the current month — not the previous one the Excel report is written for.
    const year = parseIntSafe(sp.get("year"), now.getFullYear());
    const month = Math.min(12, Math.max(1, parseIntSafe(sp.get("month"), now.getMonth() + 1)));
    const lastYear = year - 1;

    const force = /^(1|true|force)$/i.test(String(sp.get("refresh") || ""));
    const source = await readSourceStamp([year, lastYear]);

    const cacheKey = `${year}|${month}|${source.stamp}`;
    const cached = cache.get(cacheKey);
    if (!force && cached) return NextResponse.json(cached);

    /**
     * ວັນຕັດ — the day the month is read up to. While the month is still being
     * sold that is the last day with a bill on it; a finished month is read
     * whole, and then the projection is just the actual figure.
     */
    const through = source.data_through ? source.data_through.split("-").map(Number) : null;
    const total = daysInMonth(year, month);
    const running = !!through && through[0] === year && through[1] === month && through[2] < total;
    const cutDay = running ? through[2] : total;

    // One scan for both years. in_cut splits each month at the same day of the
    // month, which is what lets last year be read to the same point and the
    // bias below be measured on a like-for-like projection.
    const actualSql = `
      SELECT EXTRACT(YEAR FROM ${REPORT_DATE})::int AS year,
             EXTRACT(MONTH FROM ${REPORT_DATE})::int AS month,
             (EXTRACT(DAY FROM ${REPORT_DATE})::int <= ${cutDay}) AS in_cut,
             COALESCE(NULLIF(d.bu_code, ''), '-') AS bu_code,
             ${channelCodeSql("d.doc_no")} AS channel_code,
             COALESCE(SUM(d.sum_amount), 0)::float AS amount
      FROM ${SALE_DETAIL_LIVE} d
      ${OVERRIDE_JOIN}
      WHERE EXTRACT(YEAR FROM ${REPORT_DATE})::int = ANY(%s::int[])
      GROUP BY 1, 2, 3, 4, 5`;

    const [actualRows, targetRows, buLookup, channelLookup] = await Promise.all([
      rows(actualSql, [[year, lastYear]]),
      rows(
        `SELECT bu_code, target_month AS month, sale_channel,
                COALESCE(SUM(target_amount), 0)::float AS amount
         FROM public.odg_sales_target
         WHERE target_year = %s
         GROUP BY bu_code, target_month, sale_channel`,
        [year],
      ),
      rows(`SELECT code, name_1 FROM public.odg_bu ORDER BY code`),
      rows(`SELECT code, name_1 FROM public.ar_group`),
    ]);

    const buName = {};
    for (const row of buLookup) buName[String(row.code)] = row.name_1 || String(row.code);
    /** Bills the ERP left without a BU — kept, and named, rather than dropped. */
    buName["-"] = "ບໍ່ລະບຸ BU";
    const channelName = {};
    for (const row of channelLookup) channelName[String(row.code)] = row.name_1 || String(row.code);
    const channelLabel = (code) =>
      code === "ALL" ? ALL_CHANNEL_LABEL : channelName[String(code)] || String(code);

    /**
     * ຍອດຂາຍ, keyed so every figure the page needs is one lookup: the month to
     * the cut day, the whole month, and the same for last year.
     */
    const actual = new Map();
    const key = (y, m, cut, bu, channel) => `${y}|${m}|${cut ? 1 : 0}|${bu}|${channel}`;
    const add = (map, k, amount) => map.set(k, (map.get(k) || 0) + amount);
    for (const row of actualRows) {
      add(
        actual,
        key(Number(row.year), Number(row.month), row.in_cut, String(row.bu_code), String(row.channel_code ?? "OTHER")),
        Number(row.amount || 0),
      );
    }

    /** Sum over whichever slices are asked for; `cut` null means the whole month. */
    const sum = ({ year: y, month: m, cut = null, bu = null, channel = null }) => {
      let out = 0;
      for (const [k, amount] of actual) {
        const [ky, km, kcut, kbu, kch] = k.split("|");
        if (Number(ky) !== y || Number(km) !== m) continue;
        if (cut === true && kcut !== "1") continue;
        if (cut === false && kcut !== "0") continue;
        if (bu !== null && kbu !== bu) continue;
        if (channel !== null && kch !== channel) continue;
        out += amount;
      }
      return out;
    };

    const elapsedDays = sellingDays(year, month, cutDay);
    const totalDays = sellingDays(year, month);
    const remainingDays = Math.max(0, totalDays - elapsedDays);

    /**
     * ອະຄະຕິຂອງຄາດການ: dividing by the days gone by under-reads the month,
     * because kip moves to its end. Measured over the last twelve finished
     * months — what the same projection would have said at this same day of the
     * month, against what the month actually did — and applied as one company
     * ratio. Per-BU ratios were left out on purpose: a small BU's twelve months
     * are noise, and a noisy correction is worse than an honest pace.
     */
    let ratioSum = 0;
    let ratioCount = 0;
    for (const past of monthsBack(year, month, 12)) {
      if (past.year !== year && past.year !== lastYear) continue;
      const pastCut = sum({ year: past.year, month: past.month, cut: true });
      const pastFull = sum({ year: past.year, month: past.month });
      const pastElapsed = sellingDays(past.year, past.month, cutDay);
      if (!pastCut || !pastFull || !pastElapsed) continue;
      const pastProjection = safeDiv(pastCut, pastElapsed) * sellingDays(past.year, past.month);
      if (pastProjection <= 0) continue;
      ratioSum += pastFull / pastProjection;
      ratioCount += 1;
    }
    const biasRatio = ratioCount ? ratioSum / ratioCount : 1;

    /** ເປົ້າ, by BU and by BU × channel, for the month and for the year to date. */
    const monthTarget = new Map();
    const ytdTarget = new Map();
    for (const row of targetRows) {
      const bu = String(row.bu_code ?? "-");
      const channel = normalizeTargetChannel(row.sale_channel);
      const m = Number(row.month);
      const amount = Number(row.amount || 0);
      if (m === month) add(monthTarget, `${bu}|${channel}`, amount);
      if (m <= month) add(ytdTarget, `${bu}|${channel}`, amount);
    }

    /**
     * One line of the report. Everything downstream of ຂາຍແລ້ວ is arithmetic on
     * these four numbers, so a reader can check any of it by hand.
     */
    const line = (label, { target, mtd, lastYearSame, ytdActual, ytdTargetAmount, ytdLastYear }) => {
      const pace = safeDiv(mtd, elapsedDays);
      const projected = pace * totalDays;
      const adjusted = projected * biasRatio;
      return {
        label,
        target,
        actual: mtd,
        pct: safeDiv(mtd, target) * 100,
        pace,
        projected,
        adjusted,
        projected_pct: safeDiv(adjusted, target) * 100,
        /** What the month misses by if the pace holds — 0 when it lands over. */
        shortfall: Math.max(0, target - adjusted),
        /** ຕ້ອງຂາຍຕໍ່ວັນ to still make the plan, over the selling days left. */
        required_per_day: remainingDays ? Math.max(0, target - mtd) / remainingDays : 0,
        last_year: lastYearSame,
        growth: safeDiv(mtd, lastYearSame) * 100,
        ytd_target: ytdTargetAmount,
        ytd_actual: ytdActual,
        ytd_pct: safeDiv(ytdActual, ytdTargetAmount) * 100,
        ytd_last_year: ytdLastYear,
        ytd_growth: safeDiv(ytdActual, ytdLastYear) * 100,
      };
    };

    /** YTD reads the running month at the cut day in BOTH years, like the month. */
    const ytdSum = (filter) => {
      let out = 0;
      for (let m = 1; m <= month; m += 1) {
        out += sum({ ...filter, month: m, cut: m === month ? true : null });
      }
      return out;
    };

    const buCodes = new Set();
    for (const k of actual.keys()) {
      const [ky, , , kbu] = k.split("|");
      if (Number(ky) === year) buCodes.add(kbu);
    }
    for (const k of monthTarget.keys()) buCodes.add(k.split("|")[0]);
    for (const k of ytdTarget.keys()) buCodes.add(k.split("|")[0]);

    /** Channels a BU either sold in or was given a plan for. */
    const channelsOf = (bu) => {
      const set = new Set();
      for (const k of actual.keys()) {
        const [ky, , , kbu, kch] = k.split("|");
        if (Number(ky) === year && kbu === bu) set.add(kch);
      }
      for (const map of [monthTarget, ytdTarget]) {
        for (const k of map.keys()) {
          const [kbu, kch] = k.split("|");
          // A plan entered as 'ALL' belongs to the BU, not to any one channel;
          // it stays out of the children and shows in the parent's own figures.
          if (kbu === bu && kch !== "ALL") set.add(kch);
        }
      }
      return [...set];
    };

    /** null on either side means "every one of them", the way sum() reads. */
    const targetOf = (map, bu, channel) => {
      let out = 0;
      for (const [k, amount] of map) {
        const [kbu, kch] = k.split("|");
        if (bu !== null && kbu !== bu) continue;
        if (channel !== null && kch !== channel) continue;
        out += amount;
      }
      return out;
    };

    const buRows = [...buCodes]
      .map((bu) => {
        const row = line(buName[bu] || bu, {
          target: targetOf(monthTarget, bu, null),
          mtd: sum({ year, month, cut: true, bu }),
          lastYearSame: sum({ year: lastYear, month, cut: true, bu }),
          ytdActual: ytdSum({ year, bu }),
          ytdTargetAmount: targetOf(ytdTarget, bu, null),
          ytdLastYear: ytdSum({ year: lastYear, bu }),
        });
        return {
          key: bu,
          ...row,
          children: channelsOf(bu)
            .map((channel) => ({
              key: `${bu}|${channel}`,
              ...line(channelLabel(channel), {
                target: targetOf(monthTarget, bu, channel),
                mtd: sum({ year, month, cut: true, bu, channel }),
                lastYearSame: sum({ year: lastYear, month, cut: true, bu, channel }),
                ytdActual: ytdSum({ year, bu, channel }),
                ytdTargetAmount: targetOf(ytdTarget, bu, channel),
                ytdLastYear: ytdSum({ year: lastYear, bu, channel }),
              }),
            }))
            // An empty channel is an ERP code, not a line of business.
            .filter((child) => child.target || child.actual || child.last_year)
            .sort((a, b) => b.actual - a.actual || b.target - a.target),
        };
      })
      .filter((row) => row.target || row.actual || row.last_year)
      .sort((a, b) => b.actual - a.actual || b.target - a.target);

    const company = line("ລວມທັງບໍລິສັດ", {
      target: targetOf(monthTarget, null, null),
      mtd: sum({ year, month, cut: true }),
      lastYearSame: sum({ year: lastYear, month, cut: true }),
      ytdActual: ytdSum({ year }),
      ytdTargetAmount: targetOf(ytdTarget, null, null),
      ytdLastYear: ytdSum({ year: lastYear }),
    });

    const result = {
      success: true,
      data: {
        meta: {
          year,
          month,
          last_year: lastYear,
          data_through: source.data_through,
          /** Day of the month everything is read to, in both years. */
          cut_day: cutDay,
          /** False once the month is over — then ຄາດການ is the month itself. */
          running,
          selling_days: { total: totalDays, elapsed: elapsedDays, remaining: remainingDays },
          bias_pct: (biasRatio - 1) * 100,
          bias_months: ratioCount,
          generated_at: new Date().toISOString(),
        },
        total: company,
        rows: buRows,
      },
    };

    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(cacheKey, result);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
