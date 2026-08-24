import { NextResponse } from "next/server";
import { one, rows } from "@/lib/db";
import { parseIntSafe, safeDiv } from "@/lib/helpers";
import { getCurrentUser } from "@/lib/route-auth";
import { OWNER_CODES } from "@/lib/employee-auth";
import { OVERRIDE_JOIN, REPORT_DATE } from "@/lib/sale-month-override";
import { channelCodeSql, CHANNEL_NAMES } from "@/lib/sale-monthly-sql.mjs";
import { isRegionKey, provincesOf, REGIONS, regionOf } from "@/lib/sales-regions.mjs";

/** ທຸກລະຫັດແຂວງທີ່ຮູ້ຈັກ — ໃຊ້ພິສູດ "ບໍ່ລະບຸພື້ນທີ່" ດ້ວຍການປະຕິເສດ. */
const KNOWN_PROVINCES = REGIONS.flatMap((region) => region.provinces);

/**
 * ພາບລວມການຂາຍ — the executives' sales page.
 *
 * One question per block, the first being the only one that matters on the 24th
 * of a month: where does this month land if nothing changes, and how far is that
 * from the plan. Everything else on the page cuts that same number by BU, by
 * channel, by region.
 *
 * ACT comes from odg_sale_detail on REPORT_DATE (a bill approved into an earlier
 * month counts where it was credited), the plan from odg_sales_target — the same
 * two sources as ສະຫຼຸບເດືອນ, so the two pages cannot drift apart.
 */

/** ໜ້ານີ້ຂອງຜູ້ບໍລິຫານ ແລະ ຄົນທີ່ຖືກອະນຸຍາດ — ພະນັກງານຂາຍທົ່ວໄປບໍ່ເຫັນ. */
const ALLOWED_ROLES = new Set(["ceo", "gm", "sale_bu_manager", "sale_supervisor"]);

const BU_NAMES = {
  11: "ໄຟຟ້າ",
  12: "ແອ",
  13: "ປະປາ",
  14: "ອາໄຫຼ່",
  15: "ໄຟຟ້ານ້ອຍ",
  16: "ສູນບໍລິການ",
  17: "ອອນລາຍ",
};

const daysInMonth = (year, month) => new Date(year, month, 0).getDate();

/**
 * ວັນຂາຍ — ວັນອາທິດບໍ່ນັບ. ຮ້ານປິດວັນອາທິດ, ແລະ ຄາດການທີ່ຫານດ້ວຍວັນປະຕິທິນ
 * ຈະຕໍ່າກວ່າຄວາມຈິງທຸກເດືອນທີ່ມີ 5 ວັນອາທິດ.
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

/**
 * ຄືກັບ ສະຫຼຸບເດືອນ: ສະແຕມທີ່ຂະຫຍັບທຸກຄັ້ງທີ່ແຫຼ່ງຂໍ້ມູນຂະຫຍັບ ເພື່ອຄຳຕອບເກົ່າ
 * ຢູ່ໃນ cache ບໍ່ໄດ້ອາຍຸຍາວກວ່າຂໍ້ມູນຂອງມັນ.
 */
async function readSourceStamp(years) {
  const row = await one(
    `SELECT to_char(MAX(d.doc_date), 'YYYY-MM-DD') AS data_through,
            COUNT(*)::text AS source_rows,
            (SELECT COUNT(*)::text || '@' || COALESCE(MAX(created_at)::text, '-')
               FROM public.app_sale_month_override) AS override_stamp
     FROM public.odg_sale_detail d
     WHERE d.yeardoc = ANY(%s::int[])`,
    [years],
  );
  return {
    data_through: row?.data_through ?? null,
    stamp: `${row?.source_rows ?? "0"}|${row?.data_through ?? "-"}|${row?.override_stamp ?? "-"}`,
  };
}

const cache = new Map();
const CACHE_MAX = 32;
const inFlight = new Map();

function once(key, task) {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = task().finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

/**
 * ໜຶ່ງສະແກນ ຮັບໃຊ້ທຸກຕົວກັ່ນຕອງ: ດຶງມາເປັນກ້ອນຕາມ (ປີ · ເດືອນ · BU · ຊ່ອງທາງ ·
 * ແຂວງ · ກ່ອນວັນຕັດ) ແລ້ວກັ່ນຕອງໃນ JS. ຖ້າໃສ່ WHERE ຕາມຕົວເລືອກຜູ້ໃຊ້ແທນ ທຸກ
 * ການກົດ chip ໜຶ່ງເທື່ອ = ສະແກນຕາຕະລາງ 2.7 GB ໃໝ່ອີກເທື່ອໜຶ່ງ.
 */
function loadBuckets(years, cutDay, stamp) {
  const sql = `
    SELECT EXTRACT(YEAR FROM ${REPORT_DATE})::int AS year,
           EXTRACT(MONTH FROM ${REPORT_DATE})::int AS month,
           COALESCE(NULLIF(d.bu_code, ''), '-') AS bu_code,
           ${channelCodeSql("d.doc_no")} AS channel_code,
           COALESCE(NULLIF(d.province, ''), '-') AS province,
           (EXTRACT(DAY FROM ${REPORT_DATE})::int <= %s) AS before_cut,
           COALESCE(SUM(d.sum_amount), 0)::float AS amount
    FROM public.odg_sale_detail d
    ${OVERRIDE_JOIN}
    WHERE EXTRACT(YEAR FROM ${REPORT_DATE})::int = ANY(%s::int[])
    GROUP BY 1, 2, 3, 4, 5, 6`;
  return once(`${years.join("-")}|${cutDay}|${stamp}`, () => rows(sql, [cutDay, years]));
}

const targetSql = `
  SELECT bu_code, target_month AS month, sale_channel,
         COALESCE(NULLIF(province_code, ''), 'ALL') AS province_code,
         COALESCE(SUM(target_amount), 0)::float AS amount
  FROM public.odg_sales_target
  WHERE target_year = %s
  GROUP BY 1, 2, 3, 4`;

/** ແຖວເປົ້າເກັບຊ່ອງທາງເປັນລະຫັດ ຫຼື ຊື່ — ດຶງລົງເປັນລະຫັດອັນດຽວ. */
function normalizeTargetChannel(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "ALL";
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
  return byName[raw] || (raw.toUpperCase() === "ALL" ? "ALL" : raw);
}

/** ຈັດອັນດັບ ແລະ ຄິດສ່ວນແບ່ງ — ໃຊ້ທັງ ແຍກຕາມ BU ແລະ ແຍກຕາມຊ່ອງທາງ. */
function ranked(map, names) {
  const total = [...map.values()].reduce((sum, value) => sum + value, 0);
  return [...map.entries()]
    .map(([code, amount]) => ({
      code,
      label: names[code] || code,
      amount,
      share: safeDiv(amount, total) * 100,
    }))
    .filter((row) => row.amount !== 0)
    .sort((a, b) => b.amount - a.amount);
}

export async function GET(request) {
  const user = getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const role = String(user.role || "").toLowerCase();
  const isOwner = OWNER_CODES.has(String(user.username || ""));
  if (!isOwner && !ALLOWED_ROLES.has(role)) {
    return NextResponse.json({ success: false, error: "forbidden" }, { status: 403 });
  }

  try {
    const sp = request.nextUrl.searchParams;
    const now = new Date();
    const year = parseIntSafe(sp.get("year"), now.getFullYear());
    const month = Math.min(12, Math.max(1, parseIntSafe(sp.get("month"), now.getMonth() + 1)));
    const mode = sp.get("mode") === "ytd" ? "ytd" : "month";
    const regionParam = String(sp.get("region") || "ALL").toUpperCase();
    const region = isRegionKey(regionParam) || regionParam === "U" ? regionParam : "ALL";

    // ຫົວໜ້າ BU ເຫັນສະເພາະ BU ແລະ ຊ່ອງທາງຂອງຕົນ ບໍ່ວ່າຈະສົ່ງ ?bu= ມາແນວໃດ.
    let bu = String(sp.get("bu") || "ALL");
    let channel = String(sp.get("channel") || "ALL");
    if (role === "sale_bu_manager" && !isOwner) {
      if (user.bu_code) bu = String(user.bu_code);
      if (Array.isArray(user.channel_codes) && user.channel_codes.length && channel === "ALL") {
        channel = user.channel_codes.map(String).join(",");
      }
    }
    const buWanted = bu === "ALL" ? null : new Set(bu.split(",").map((code) => code.trim()));
    const channelWanted =
      channel === "ALL" ? null : new Set(channel.split(",").map((code) => code.trim()));
    const provinceWanted =
      region === "ALL" ? null : new Set(region === "U" ? [] : provincesOf(region));

    const lastYear = year - 1;
    const source = await readSourceStamp([year, lastYear]);

    /**
     * ວັນຕັດ: ຖ້າເດືອນທີ່ເລືອກຄືເດືອນທີ່ຂໍ້ມູນຢຸດຢູ່ ໃຫ້ຕັດຢູ່ວັນນັ້ນ (ເດືອນຍັງບໍ່ຈົບ);
     * ເດືອນທີ່ຜ່ານໄປແລ້ວ ໃຊ້ວັນສຸດທ້າຍຂອງເດືອນ. ວັນຕັດອັນດຽວກັນນີ້ຖືກໃຊ້ຄືນກັບ 12
     * ເດືອນຫຼ້າສຸດ ເພື່ອວັດອະຄະຕິຂອງຄາດການ — ທຽບຢູ່ຈຸດດຽວກັນຂອງເດືອນຈຶ່ງຍຸດຕິທຳ.
     */
    const through = source.data_through ? new Date(`${source.data_through}T00:00:00`) : now;
    const isRunningMonth =
      through.getFullYear() === year && through.getMonth() + 1 === month;
    const cutDay = isRunningMonth ? through.getDate() : daysInMonth(year, month);

    const cacheKey = `${year}|${month}|${mode}|${region}|${bu}|${channel}|${cutDay}|${source.stamp}`;
    const cached = cache.get(cacheKey);
    const force = /^(1|true|force)$/i.test(String(sp.get("refresh") || ""));
    if (!force && cached) return NextResponse.json(cached);

    /**
     * ຈຳນວນບິນ ນັບຈາກ doc_no ບໍ່ຊ້ຳ ຈຶ່ງບວກຕໍ່ຈາກກ້ອນຂ້າງເທິງບໍ່ໄດ້ (ບິນໜຶ່ງມີໄດ້
     * ຫຼາຍ BU) — ຄຳຖາມແຍກ ຖືຕົວກັ່ນຕອງອັນດຽວກັນ.
     */
    const billWhere = [];
    const billParams = [year, month];
    if (buWanted) {
      billWhere.push("x.bu_code = ANY(%s::text[])");
      billParams.push([...buWanted]);
    }
    if (channelWanted) {
      billWhere.push("x.channel_code = ANY(%s::text[])");
      billParams.push([...channelWanted]);
    }
    if (provinceWanted) {
      billWhere.push(
        region === "U" ? "NOT (x.province = ANY(%s::text[]))" : "x.province = ANY(%s::text[])",
      );
      billParams.push(region === "U" ? KNOWN_PROVINCES : [...provinceWanted]);
    }
    const billSql = `
      SELECT COUNT(DISTINCT x.doc_no)::int AS bills
      FROM (
        SELECT d.doc_no,
               COALESCE(NULLIF(d.bu_code, ''), '-') AS bu_code,
               ${channelCodeSql("d.doc_no")} AS channel_code,
               COALESCE(NULLIF(d.province, ''), '-') AS province
        FROM public.odg_sale_detail d
        ${OVERRIDE_JOIN}
        WHERE EXTRACT(YEAR FROM ${REPORT_DATE})::int = %s
          AND EXTRACT(MONTH FROM ${REPORT_DATE})::int = %s
      ) x
      ${billWhere.length ? `WHERE ${billWhere.join(" AND ")}` : ""}`;

    const [buckets, targetRows, billRow] = await Promise.all([
      loadBuckets([year, lastYear], cutDay, source.stamp),
      rows(targetSql, [year]),
      one(billSql, billParams),
    ]);

    const keep = (row) => {
      if (buWanted && !buWanted.has(String(row.bu_code))) return false;
      if (channelWanted && !channelWanted.has(String(row.channel_code))) return false;
      if (!provinceWanted) return true;
      if (region === "U") return regionOf(row.province) === "U";
      return provinceWanted.has(String(row.province));
    };

    /** ຍອດຂອງເດືອນໜຶ່ງ — ທັງເດືອນ ຫຼື ສະເພາະກ່ອນວັນຕັດ. */
    const sumMonth = (targetYear, targetMonth, onlyBeforeCut = false) => {
      let total = 0;
      for (const row of buckets) {
        if (Number(row.year) !== targetYear || Number(row.month) !== targetMonth) continue;
        if (onlyBeforeCut && !row.before_cut) continue;
        if (!keep(row)) continue;
        total += Number(row.amount || 0);
      }
      return total;
    };

    const monthActual = sumMonth(year, month);
    const lastYearMonthActual = sumMonth(lastYear, month);
    let ytdActual = 0;
    let lastYearYtdActual = 0;
    for (let m = 1; m <= month; m += 1) {
      ytdActual += sumMonth(year, m);
      lastYearYtdActual += sumMonth(lastYear, m);
    }

    // ── ເປົ້າ ─────────────────────────────────────────────────────
    // ⚠️ ເປົ້າຂາຍສົ່ງເທົ່ານັ້ນທີ່ຕັ້ງເປັນລາຍແຂວງ; ໜ້າຮ້ານ/ໂຄງການ/ຊ່າງ/ອອນລາຍ/ບໍລິການ
    //    ຕັ້ງເປັນກ້ອນດຽວທັງບໍລິສັດ (province_code = 'ALL'). ເມື່ອເລືອກພາກ ຈຶ່ງນັບ
    //    ສະເພາະແຖວທີ່ມີແຂວງຈິງ — ບໍ່ດັ່ງນັ້ນທຸກພາກຈະໄດ້ເປົ້າກ້ອນນັ້ນຄົນລະເທື່ອ.
    const targetFor = (wantedMonth) => {
      let total = 0;
      for (const row of targetRows) {
        if (Number(row.month) !== wantedMonth) continue;
        if (buWanted && !buWanted.has(String(row.bu_code))) continue;
        const targetChannel = normalizeTargetChannel(row.sale_channel);
        if (channelWanted && targetChannel !== "ALL" && !channelWanted.has(targetChannel)) continue;
        const province = String(row.province_code);
        if (provinceWanted) {
          if (province === "ALL") continue;
          if (region === "U" ? regionOf(province) !== "U" : !provinceWanted.has(province)) continue;
        }
        total += Number(row.amount || 0);
      }
      return total;
    };

    const monthTarget = targetFor(month);
    let ytdTarget = 0;
    for (let m = 1; m <= month; m += 1) ytdTarget += targetFor(m);

    // ── ຄາດການສິ້ນເດືອນ ───────────────────────────────────────────
    const totalSellingDays = sellingDays(year, month);
    const elapsedSellingDays = sellingDays(year, month, cutDay);
    const remainingSellingDays = Math.max(0, totalSellingDays - elapsedSellingDays);
    const perDayActual = safeDiv(monthActual, elapsedSellingDays);
    const perDayTarget = safeDiv(monthTarget, totalSellingDays);
    const gap = Math.max(0, monthTarget - monthActual);
    const perDayRequired = remainingSellingDays ? safeDiv(gap, remainingSellingDays) : 0;
    const projected = perDayActual * totalSellingDays;

    /**
     * ອະຄະຕິຂອງຄາດການ: ຄາດການແບບຫານວັນສະເໝີຕົ້ນສະເໝີປາຍຕໍ່າກວ່າຄວາມຈິງ ເພາະ
     * ຍອດຍ້າຍໄປທ້າຍເດືອນ. ວັດຈາກ 12 ເດືອນຫຼ້າສຸດທີ່ຈົບແລ້ວ — ຄາດການ ນະ ວັນຕັດ
     * ດຽວກັນ ທຽບກັບຍອດຈິງທີ່ອອກມາ — ແລ້ວປັບຄາດການເດືອນນີ້ດ້ວຍອັດຕາສະເລ່ຍນັ້ນ.
     */
    let ratioSum = 0;
    let ratioCount = 0;
    for (const past of monthsBack(year, month, 12)) {
      if (past.year !== year && past.year !== lastYear) continue;
      const pastCut = sumMonth(past.year, past.month, true);
      const pastFull = sumMonth(past.year, past.month);
      const pastElapsed = sellingDays(past.year, past.month, cutDay);
      const pastTotal = sellingDays(past.year, past.month);
      if (!pastCut || !pastElapsed || !pastFull) continue;
      const pastProjection = safeDiv(pastCut, pastElapsed) * pastTotal;
      if (pastProjection <= 0) continue;
      ratioSum += pastFull / pastProjection;
      ratioCount += 1;
    }
    const biasRatio = ratioCount ? ratioSum / ratioCount : 1;

    // ── ແຍກຕາມ BU ແລະ ຊ່ອງທາງ (ຕາມໂໝດທີ່ເລືອກ) ──────────────────
    const scopeMonths = mode === "ytd" ? Array.from({ length: month }, (_, i) => i + 1) : [month];
    const byBu = new Map();
    const byChannel = new Map();
    const byRegion = new Map();
    for (const row of buckets) {
      if (Number(row.year) !== year || !scopeMonths.includes(Number(row.month))) continue;
      if (!keep(row)) continue;
      const amount = Number(row.amount || 0);
      const buCode = String(row.bu_code);
      const channelCode = String(row.channel_code);
      const regionKey = regionOf(row.province);
      byBu.set(buCode, (byBu.get(buCode) || 0) + amount);
      byChannel.set(channelCode, (byChannel.get(channelCode) || 0) + amount);
      byRegion.set(regionKey, (byRegion.get(regionKey) || 0) + amount);
    }

    const scopeActual = mode === "ytd" ? ytdActual : monthActual;
    const scopeTarget = mode === "ytd" ? ytdTarget : monthTarget;
    const scopeLastYear = mode === "ytd" ? lastYearYtdActual : lastYearMonthActual;

    const result = {
      success: true,
      data: {
        meta: {
          year,
          month,
          mode,
          region,
          bu,
          channel,
          last_year: lastYear,
          data_through: source.data_through,
          generated_at: new Date().toISOString(),
          running_month: isRunningMonth,
        },
        days: {
          total: totalSellingDays,
          elapsed: elapsedSellingDays,
          remaining: remainingSellingDays,
          cut_day: cutDay,
        },
        forecast: {
          projected,
          adjusted: projected * biasRatio,
          bias_pct: (biasRatio - 1) * 100,
          bias_months: ratioCount,
          target: monthTarget,
          pct_of_target: safeDiv(projected, monthTarget) * 100,
          shortfall: Math.max(0, monthTarget - projected),
          booked: monthActual,
          from_pace: Math.max(0, projected - monthActual),
        },
        month: {
          actual: monthActual,
          target: monthTarget,
          pct: safeDiv(monthActual, monthTarget) * 100,
          gap,
          per_day_actual: perDayActual,
          per_day_target: perDayTarget,
          per_day_required: perDayRequired,
          speed_up_pct: perDayActual ? (perDayRequired / perDayActual - 1) * 100 : 0,
          last_year: lastYearMonthActual,
          growth: safeDiv(monthActual, lastYearMonthActual) * 100,
          bills: Number(billRow?.bills || 0),
          avg_bill: safeDiv(monthActual, Number(billRow?.bills || 0)),
        },
        ytd: {
          actual: ytdActual,
          target: ytdTarget,
          pct: safeDiv(ytdActual, ytdTarget) * 100,
          last_year: lastYearYtdActual,
          growth: safeDiv(ytdActual, lastYearYtdActual) * 100,
        },
        scope: {
          actual: scopeActual,
          target: scopeTarget,
          pct: safeDiv(scopeActual, scopeTarget) * 100,
          last_year: scopeLastYear,
          growth: safeDiv(scopeActual, scopeLastYear) * 100,
        },
        by_bu: ranked(byBu, BU_NAMES),
        by_channel: ranked(byChannel, CHANNEL_NAMES),
        by_region: [...byRegion.entries()]
          .map(([key, amount]) => ({ code: key, amount }))
          .sort((a, b) => b.amount - a.amount),
      },
    };

    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(cacheKey, result);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
