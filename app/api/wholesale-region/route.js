import { NextResponse } from "next/server";
import { one, rows } from "@/lib/db";
import { parseIntSafe, safeDiv } from "@/lib/helpers";
import { OVERRIDE_JOIN, REPORT_DATE } from "@/lib/sale-month-override";
import { channelCodeSql } from "@/lib/sale-monthly-sql.mjs";
import {
  LIVE_BILL_STAMP_SQL, LIVE_MAX_DOC_DATE_SQL, SALE_DETAIL_LIVE, ensureLiveView,
} from "@/lib/sale-detail-view";

/**
 * ຂາຍສົ່ງ ແຍກຕາມພາກ — the wholesale sheet of the monthly Excel report:
 *
 *   PreviousMonth_M/YYYY · YTD 1-M/YYYY
 *   × Total · HQ · WS 5 ແຂວງພາກໃຕ້
 *   × PIPE · CE+SDA · Air · Sarepart
 *   rows: Target · ACT · % · last year · YYYY/YYYY-1
 *
 * The product columns are exactly the WS block of /month-summary — same BU ×
 * channel pairs, so the two pages cannot report a different wholesale number
 * for the same month. What this page adds is the province axis: the wholesale
 * plan is the only one entered province by province, so it is the only block
 * that can be cut this way at all.
 */

/**
 * ພາກໃຕ້ — ສະຫວັນນະເຂດ and everything below it, the same five provinces as
 * /month-summary/south and as the Excel header. ສຳນັກງານໃຫ່ຍ is everything
 * else: foreign customers, bills with no province, and a wholesale target
 * entered against province 'ALL' all land there rather than nowhere.
 *
 * ⚠️ Deliberately NOT lib/sales-regions.mjs, which follows the official split
 * and leaves ສະຫວັນນະເຂດ (14) in ພາກກາງ. The sales side plans and reviews the
 * south as **5 provinces**, so 14 is counted below, not in the centre.
 */
const SOUTH_PROVINCES = ["14", "15", "16", "17", "18"];

/**
 * The three blocks of the sheet. Two sides carry the numbers and the third is
 * their sum, so the columns add up to the total exactly — nothing sits outside
 * the blocks the way it did when the sheet ran four regions wide.
 */
const BLOCKS = [
  { key: "total", label: "Total", sides: ["hq", "south"] },
  { key: "hq", label: "HQ", sides: ["hq"] },
  { key: "south", label: "WS 5 ແຂວງພາກໃຕ້", sides: ["south"] },
];

/**
 * The wholesale columns. ອາໄຫຼ່ and ປະປາ keep ຂາຍຊ່າງ (106) on the retail side
 * — see /month-summary — so only ແອ carries it here, matching how its target
 * is entered.
 */
const PRODUCTS = [
  { key: "pipe", label: "PIPE", bu: ["13"], channels: ["102"] },
  { key: "ce_sda", label: "CE+SDA", bu: ["11", "15"], channels: ["102"] },
  { key: "air", label: "Air", bu: ["12"], channels: ["102", "106"] },
  { key: "sparepart", label: "Sarepart", bu: ["14"], channels: ["102"] },
];

const SOUTH_SET = new Set(SOUTH_PROVINCES);

const sideOf = (province) => (SOUTH_SET.has(String(province ?? "").trim()) ? "south" : "hq");

/** SQL side of the same mapping, so the scan groups on two values, not 21. */
const sideSql = (column) =>
  `CASE WHEN COALESCE(${column}, '') IN (${SOUTH_PROVINCES.map((code) => `'${code}'`).join(", ")})
        THEN 'south' ELSE 'hq' END`;

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

/**
 * What the ACT rows were computed from — the same stamp as /month-summary: a
 * back-dated bill or an approved month override moves kip without moving
 * MAX(doc_date), so both are folded in and the cache is keyed on the result.
 */
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

/** Two page loads landing together share one scan instead of paying for two. */
const inFlight = new Map();

function once(key, task) {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = task().finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

const bucketKey = (bu, channel, side, month) => `${bu}|${channel}|${side}|${month}`;

/** Sums one product over the months asked for, on one side or on both. */
function sumBuckets(map, product, sides, months) {
  let total = 0;
  for (const bu of product.bu) {
    for (const channel of product.channels) {
      for (const side of sides) {
        for (const month of months) {
          total += map.get(bucketKey(bu, channel, side, month)) || 0;
        }
      }
    }
  }
  return total;
}

function buildActualMap(rowsIn, year) {
  const map = new Map();
  for (const row of rowsIn) {
    if (Number(row.year) !== year) continue;
    const key = bucketKey(
      String(row.bu_code ?? ""),
      String(row.channel_code ?? "OTHER"),
      String(row.side ?? "hq"),
      Number(row.month),
    );
    map.set(key, (map.get(key) || 0) + Number(row.amount || 0));
  }
  return map;
}

/**
 * Wholesale target rows, by province. A plan entered against province 'ALL' —
 * ຂາຍຊ່າງແອ is planned as one company figure — has no province to land in and
 * counts under ສຳນັກງານໃຫ່ຍ, where /month-summary puts it too.
 */
function buildTargetMap(rowsIn) {
  const map = new Map();
  for (const row of rowsIn) {
    const bu = String(row.bu_code ?? "");
    const channel = normalizeTargetChannel(row.sale_channel);
    const key = bucketKey(bu, channel, sideOf(row.province_code), Number(row.month));
    map.set(key, (map.get(key) || 0) + Number(row.amount || 0));
  }
  return map;
}

const range = (from, to) => {
  const months = [];
  for (let m = from; m <= to; m += 1) months.push(m);
  return months;
};

export async function GET(request) {
  // The live view has to exist before anything selects from it.
  await ensureLiveView();
  try {
    const sp = request.nextUrl.searchParams;
    const now = new Date();
    // Default to the previous month, the way the Excel report is produced.
    const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const year = parseIntSafe(sp.get("year"), previous.getFullYear());
    const month = Math.min(12, Math.max(1, parseIntSafe(sp.get("month"), previous.getMonth() + 1)));
    const lastYear = year - 1;

    const force = /^(1|true|force)$/i.test(String(sp.get("refresh") || ""));
    const source = await readSourceStamp([year, lastYear]);

    /**
     * ທຽບຮອດວັນທີປະຈຸບັນ — a month still being sold cannot be read against a
     * whole month of last year: on the 30th, ACT holds 30 days and ປີກ່ອນ holds
     * 31, and the year-on-year line reports a fall that is only the calendar.
     *
     * When the month asked for is the one the data stops in, BOTH years are cut
     * at that day of the month — this year's figure ends there anyway, so the
     * cut only ever moves last year's. A completed month cuts nothing.
     */
    const through = source.data_through ? source.data_through.split("-").map(Number) : null;
    const daysInMonth = new Date(year, month, 0).getDate();
    const cutDay =
      through && through[0] === year && through[1] === month && through[2] < daysInMonth
        ? through[2]
        : null;

    const cacheKey = `${year}|${month}|${source.stamp}`;
    const cached = cache.get(cacheKey);
    if (!force && cached) return NextResponse.json(cached);

    // Both years off one scan of odg_sale_detail: splitting them into a query
    // each reads the same 2.7 GB twice for the same answer. The month a sale
    // counts in is REPORT_DATE, not the ERP's monthdoc.
    // Days after the cut, in the cut month, in either year. Written as NOT(…)
    // so every other month passes through untouched.
    const cutSql = cutDay
      ? ` AND NOT (EXTRACT(MONTH FROM ${REPORT_DATE})::int = ${month}
                   AND EXTRACT(DAY FROM ${REPORT_DATE})::int > ${cutDay})`
      : "";
    const actualSql = `
      SELECT EXTRACT(YEAR FROM ${REPORT_DATE})::int AS year,
             EXTRACT(MONTH FROM ${REPORT_DATE})::int AS month,
             COALESCE(NULLIF(d.bu_code, ''), '-') AS bu_code,
             ${channelCodeSql("d.doc_no")} AS channel_code,
             ${sideSql("d.province")} AS side,
             COALESCE(SUM(d.sum_amount), 0)::float AS amount
      FROM ${SALE_DETAIL_LIVE} d
      ${OVERRIDE_JOIN}
      WHERE EXTRACT(YEAR FROM ${REPORT_DATE})::int = ANY(%s::int[])${cutSql}
      GROUP BY 1, 2, 3, 4, 5`;
    const targetSql = `
      SELECT bu_code, target_month AS month, sale_channel, province_code,
             COALESCE(SUM(target_amount), 0)::float AS amount
      FROM public.odg_sales_target
      WHERE target_year = %s
      GROUP BY bu_code, target_month, sale_channel, province_code`;

    const [actualRows, targetNow] = await Promise.all([
      once(`${year}|${lastYear}|${source.stamp}|${cutDay ? `${month}-${cutDay}` : "-"}`,
           () => rows(actualSql, [[year, lastYear]])),
      rows(targetSql, [year]),
    ]);

    const actual = buildActualMap(actualRows, year);
    const actualLy = buildActualMap(actualRows, lastYear);
    const target = buildTargetMap(targetNow);

    // Each side opens with its own sum, the way ລວມຂາຍສົ່ງ opens the sheet: the
    // question "how is HQ doing" is asked before "how is HQ's PIPE doing", and
    // the answer should not be four columns added up by eye. The Total block
    // needs none — the frozen column on the left is already its sum.
    const columns = BLOCKS.flatMap((block) => [
      ...(block.key === "total"
        ? []
        : [
            {
              key: `${block.key}_total`,
              block: block.key,
              product: "total",
              label: "Total",
              is_sum: true,
            },
          ]),
      ...PRODUCTS.map((product) => ({
        key: `${block.key}_${product.key}`,
        block: block.key,
        product: product.key,
        label: product.label,
      })),
    ]);

    /** One report block: Target, ACT, %, last year and the year-on-year ratio. */
    const buildSection = (key, label, months) => {
      const cells = {};
      const blockTotals = {};

      const accumulate = (bucket, cell) => ({
        target: bucket.target + cell.target,
        value: bucket.value + cell.value,
        last_year: bucket.last_year + cell.last_year,
      });
      const withRatios = (bucket) => ({
        ...bucket,
        pct: safeDiv(bucket.value, bucket.target) * 100,
        growth: safeDiv(bucket.value, bucket.last_year) * 100,
      });

      for (const block of BLOCKS) {
        let running = { target: 0, value: 0, last_year: 0 };
        for (const product of PRODUCTS) {
          const cell = {
            target: sumBuckets(target, product, block.sides, months),
            value: sumBuckets(actual, product, block.sides, months),
            last_year: sumBuckets(actualLy, product, block.sides, months),
          };
          cells[`${block.key}_${product.key}`] = withRatios(cell);
          running = accumulate(running, cell);
        }
        blockTotals[block.key] = withRatios(running);
        if (block.key !== "total") cells[`${block.key}_total`] = blockTotals[block.key];
      }

      return {
        key,
        label,
        value_label: "ACT",
        cells,
        block_totals: blockTotals,
        // Every province is on one side or the other, so this is the Total
        // block's own sum — the sheet's columns add up to it with nothing left.
        total: blockTotals.total,
      };
    };

    const result = {
      success: true,
      data: {
        meta: {
          year,
          month,
          last_year: lastYear,
          generated_at: new Date().toISOString(),
          /** Latest sale date behind these numbers. */
          data_through: source.data_through,
          /** Day both years are cut at, null when the month is complete. */
          cut_day: cutDay,
        },
        blocks: BLOCKS.map(({ key, label }) => ({ key, label })),
        products: PRODUCTS.map(({ key, label }) => ({ key, label })),
        columns,
        sections: [
          buildSection(
            "month",
            cutDay ? `1-${cutDay}/${month}/${year}` : `PreviousMonth_${month}/${year}`,
            [month],
          ),
          buildSection(
            "ytd",
            cutDay ? `YTD 1-${cutDay}/${month}/${year}` : `YTD 1-${month}/${year}`,
            range(1, month),
          ),
        ],
      },
    };

    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(cacheKey, result);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
