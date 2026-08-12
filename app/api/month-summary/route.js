import { NextResponse } from "next/server";
import { rows } from "@/lib/db";
import { parseIntSafe, safeDiv } from "@/lib/helpers";
import { MONTHLY_TABLE } from "@/lib/sale-monthly-sql.mjs";

/**
 * Company summary in the layout of the monthly Excel report:
 *   PreviousMonth_M/YYYY · YTD 1-M/YYYY · ROY M+1-12/YYYY · ACT+ROY
 * across WS sale / Retail / Project / Service buckets.
 *
 * Buckets are (BU × sale channel) pairs. BU codes come from public.odg_bu:
 *   11 ໄຟຟ້າ (CE) · 12 ແອ (Air) · 13 ປະປາ (PIPE) · 14 ອາໄຫຼ່ (Sparepart)
 *   15 ໄຟຟ້ານ້ອຍ (SDA) · 16 ສູນບໍລິການ (Service) · 17 ອອນລາຍ (Online)
 * Channel codes come from public.ar_group:
 *   101 ຂາຍໜ້າຮ້ານ · 102 ຂາຍສົ່ງ · 103 ໂຄງການ · 104 ພະນັກງານ
 *   106 ຂາຍຊ່າງ · 107 ອອນລາຍ · 108 ຕົວແທນຂາຍ
 * ຂາຍຊ່າງ (106) rolls into WS for Air and into Retail for PIPE, matching the
 * way the targets are entered for those BUs.
 */
const COLUMNS = [
  { key: "ws_pipe", group: "ws", label: "PIPE", bu: ["13"], channels: ["102"] },
  { key: "ws_ce_sda", group: "ws", label: "CE+SDA", bu: ["11", "15"], channels: ["102"] },
  { key: "ws_air", group: "ws", label: "Air", bu: ["12"], channels: ["102", "106"] },
  { key: "ws_sparepart", group: "ws", label: "Sarepart", bu: ["14"], channels: ["102"] },

  { key: "rt_air_ce", group: "retail", label: "AIR+CE", bu: ["11", "12", "15"], channels: ["101"] },
  { key: "rt_pipe", group: "retail", label: "PIPE", bu: ["13"], channels: ["101", "106"] },
  { key: "rt_sparepart", group: "retail", label: "Sparepart", bu: ["14"], channels: ["101"] },
  {
    key: "rt_online",
    group: "retail",
    label: "Online",
    bu: ["11", "12", "13", "14", "15", "17"],
    channels: ["107"],
  },

  { key: "pj_air", group: "project", label: "Air", bu: ["12"], channels: ["103"] },
  { key: "pj_ce", group: "project", label: "CE", bu: ["11"], channels: ["103"] },
  { key: "pj_pipe", group: "project", label: "PIPE", bu: ["13"], channels: ["103"] },

  {
    key: "sv_retail",
    group: "service",
    label: "Retail",
    bu: ["16"],
    channels: ["101", "102", "104", "106", "107", "108", "OTHER"],
  },
  { key: "sv_project", group: "service", label: "Project", bu: ["16"], channels: ["103"] },
];

const GROUPS = [
  { key: "ws", label: "WS sale" },
  { key: "retail", label: "Retail" },
  { key: "project", label: "Project" },
  { key: "service", label: "Service" },
];

/**
 * Service targets are stored as one lump per month (sale_channel = 'ALL').
 * The Excel splits a flat project figure out of it and leaves the rest as
 * retail, so the same constant is applied here.
 */
const SERVICE_PROJECT_MONTHLY_TARGET = Number(
  process.env.ODG_SERVICE_PROJECT_MONTHLY_TARGET || 2_000_000,
);

/** Channel used for the standalone staff-sales column on the right. */
const STAFF_CHANNEL = "104";

/** Same mapping for target rows, which store either a code or a channel name. */
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

const cache = new Map();
const TTL = 180_000;

const bucketKey = (bu, channel, month) => `${bu}|${channel}|${month}`;

/** Sums a bucket map over the requested BU codes, channels and months. */
function sumBuckets(map, column, months) {
  let total = 0;
  for (const bu of column.bu) {
    for (const channel of column.channels) {
      for (const month of months) {
        total += map.get(bucketKey(bu, channel, month)) || 0;
      }
    }
  }
  return total;
}

function sumStaff(map, months) {
  let total = 0;
  for (const [key, value] of map) {
    const [, channel, month] = key.split("|");
    if (channel === STAFF_CHANNEL && months.includes(Number(month))) total += value;
  }
  return total;
}

function buildActualMap(rowsIn) {
  const map = new Map();
  for (const row of rowsIn) {
    const key = bucketKey(
      String(row.bu_code ?? ""),
      String(row.channel_code ?? "OTHER"),
      Number(row.month),
    );
    map.set(key, (map.get(key) || 0) + Number(row.amount || 0));
  }
  return map;
}

/**
 * Target rows keep the service BU in one 'ALL' channel; split it into the
 * project / retail buckets the report expects.
 */
function buildTargetMap(rowsIn) {
  const map = new Map();
  const add = (bu, channel, month, amount) => {
    const key = bucketKey(bu, channel, month);
    map.set(key, (map.get(key) || 0) + amount);
  };

  const serviceByMonth = new Map();
  for (const row of rowsIn) {
    const bu = String(row.bu_code ?? "");
    const month = Number(row.month);
    const amount = Number(row.amount || 0);
    const channel = normalizeTargetChannel(row.sale_channel);

    if (bu === "16" && channel === "ALL") {
      serviceByMonth.set(month, (serviceByMonth.get(month) || 0) + amount);
      continue;
    }
    add(bu, channel === "ALL" ? "OTHER" : channel, month, amount);
  }

  for (const [month, amount] of serviceByMonth) {
    const project = Math.min(SERVICE_PROJECT_MONTHLY_TARGET, amount);
    add("16", "103", month, project);
    add("16", "101", month, amount - project);
  }
  return map;
}

const range = (from, to) => {
  const months = [];
  for (let m = from; m <= to; m += 1) months.push(m);
  return months;
};

export async function GET(request) {
  try {
    const sp = request.nextUrl.searchParams;
    const now = new Date();
    // Default to the previous month, the way the Excel report is produced.
    const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const year = parseIntSafe(sp.get("year"), previous.getFullYear());
    const month = Math.min(12, Math.max(1, parseIntSafe(sp.get("month"), previous.getMonth() + 1)));

    const cacheKey = `${year}|${month}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < TTL) return NextResponse.json(cached.data);

    const lastYear = year - 1;
    // Reads the pre-aggregated rollup (a few thousand rows) instead of scanning
    // odg_sale_detail; refreshed by scripts/refresh-sale-monthly.mjs.
    const actualSql = `
      SELECT bu_code, monthdoc AS month, channel_code,
             COALESCE(SUM(sum_amount), 0)::float AS amount
      FROM ${MONTHLY_TABLE}
      WHERE yeardoc = %s
      GROUP BY bu_code, monthdoc, channel_code`;
    const targetSql = `
      SELECT bu_code, target_month AS month, sale_channel,
             COALESCE(SUM(target_amount), 0)::float AS amount
      FROM public.odg_sales_target
      WHERE target_year = %s
      GROUP BY bu_code, target_month, sale_channel`;

    const [actualNow, actualPrev, targetNow] = await Promise.all([
      rows(actualSql, [year]),
      rows(actualSql, [lastYear]),
      rows(targetSql, [year]),
    ]);

    const actual = buildActualMap(actualNow);
    const actualLy = buildActualMap(actualPrev);
    const target = buildTargetMap(targetNow);

    const monthOnly = [month];
    const ytdMonths = range(1, month);
    const royMonths = month >= 12 ? [] : range(month + 1, 12);
    const yearMonths = range(1, 12);

    /** One report block: a value row, its last-year row and the two ratios. */
    const buildSection = (key, label, valueMonths, opts = {}) => {
      const { forecast = false, cumulative = false } = opts;
      const cells = {};
      for (const column of COLUMNS) {
        const plannedMonths = cumulative ? yearMonths : valueMonths;
        const targetValue = sumBuckets(target, column, plannedMonths);
        // ROY has no actuals yet: the forecast is the plan. ACT+ROY chains the
        // actuals already booked onto the forecast for the rest of the year.
        const value = forecast
          ? cumulative
            ? sumBuckets(actual, column, ytdMonths) + sumBuckets(target, column, royMonths)
            : sumBuckets(target, column, valueMonths)
          : sumBuckets(actual, column, valueMonths);
        const lastYearValue = sumBuckets(actualLy, column, plannedMonths);
        cells[column.key] = {
          target: targetValue,
          value,
          pct: safeDiv(value, targetValue) * 100,
          last_year: lastYearValue,
          growth: safeDiv(value, lastYearValue) * 100,
        };
      }

      const total = Object.values(cells).reduce(
        (acc, cell) => ({
          target: acc.target + cell.target,
          value: acc.value + cell.value,
          last_year: acc.last_year + cell.last_year,
        }),
        { target: 0, value: 0, last_year: 0 },
      );

      return {
        key,
        label,
        value_label: forecast ? (cumulative ? "FC+ACT" : "FC") : "ACT",
        cells,
        total: {
          ...total,
          pct: safeDiv(total.value, total.target) * 100,
          growth: safeDiv(total.value, total.last_year) * 100,
        },
        staff: forecast ? null : sumStaff(actual, valueMonths),
      };
    };

    const result = {
      success: true,
      data: {
        meta: {
          year,
          month,
          last_year: lastYear,
          service_project_monthly_target: SERVICE_PROJECT_MONTHLY_TARGET,
          generated_at: new Date().toISOString(),
        },
        groups: GROUPS,
        columns: COLUMNS.map(({ key, group, label }) => ({ key, group, label })),
        sections: [
          buildSection("month", `PreviousMonth_${month}/${year}`, monthOnly),
          buildSection("ytd", `YTD 1-${month}/${year}`, ytdMonths),
          buildSection("roy", `ROY ${Math.min(month + 1, 12)}-12/${year}`, royMonths, {
            forecast: true,
          }),
          buildSection("full", "ACT+ROY", yearMonths, { forecast: true, cumulative: true }),
        ],
      },
    };

    cache.set(cacheKey, { ts: Date.now(), data: result });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
