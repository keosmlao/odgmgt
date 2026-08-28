import { NextResponse } from "next/server";
import { one, rows } from "@/lib/db";
import { parseIntSafe, safeDiv } from "@/lib/helpers";
import { OVERRIDE_JOIN, REPORT_DATE } from "@/lib/sale-month-override";
import { channelCodeSql } from "@/lib/sale-monthly-sql.mjs";

/**
 * ຂາຍສົ່ງ ແຍກຕາມພາກ — the wholesale sheet of the monthly Excel report:
 *
 *   PreviousMonth_M/YYYY · YTD 1-M/YYYY
 *   × wholesale total · WS Metro · WS north · WS central · WS 5 ແຂວງພາກໃຕ້
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
 * The four blocks of the sheet, by province code (public.erp_province).
 *
 * ⚠️ Deliberately NOT lib/sales-regions.mjs. That file follows the official
 * split, where ສະຫວັນນະເຂດ (14) sits in ພາກກາງ. The sales side plans and
 * reviews the south as **5 provinces** — ສະຫວັນນະເຂດ ລົງໄປ — and the Excel
 * header says so in as many words, so 14 is counted below, not in the centre.
 * The same 14-18 boundary as /month-summary/south.
 *
 * ນະຄອນຫຼວງ stands alone as "Metro": it is most of the country's wholesale on
 * its own, and folded into the centre it would hide every other province there.
 */
const REGIONS = [
  { key: "metro", label: "WS Metro", provinces: ["01"] },
  { key: "north", label: "WS north", provinces: ["02", "03", "04", "05", "06", "07", "08"] },
  { key: "central", label: "WS central", provinces: ["09", "10", "11", "12", "13"] },
  { key: "south", label: "WS 5 ແຂວງພາກໃຕ້", provinces: ["14", "15", "16", "17", "18"] },
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

const PROVINCE_TO_REGION = new Map(
  REGIONS.flatMap((region) => region.provinces.map((province) => [province, region.key])),
);

/** ນອກ 4 ພາກ — ຕ່າງປະເທດ (19, 20), ລະຫັດວ່າງ ແລະ ເປົ້າທີ່ຕັ້ງເປັນ 'ALL'. */
const OUTSIDE = "outside";

const regionOf = (province) => PROVINCE_TO_REGION.get(String(province ?? "").trim()) ?? OUTSIDE;

/** SQL side of the same mapping, so the scan groups on 5 values instead of 21. */
const regionSql = (column) =>
  `CASE ${REGIONS.map(
    (region) =>
      `WHEN COALESCE(${column}, '') IN (${region.provinces.map((p) => `'${p}'`).join(", ")}) THEN '${region.key}'`,
  ).join("\n        ")}
        ELSE '${OUTSIDE}' END`;

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

const bucketKey = (bu, channel, region, month) => `${bu}|${channel}|${region}|${month}`;

/** Sums one product over the months asked for, in one region or in all of them. */
function sumBuckets(map, product, regionKey, months) {
  const regionKeys = regionKey ? [regionKey] : [...REGIONS.map((r) => r.key), OUTSIDE];
  let total = 0;
  for (const bu of product.bu) {
    for (const channel of product.channels) {
      for (const region of regionKeys) {
        for (const month of months) {
          total += map.get(bucketKey(bu, channel, region, month)) || 0;
        }
      }
    }
  }
  return total;
}

/**
 * ກິບຂາຍສົ່ງທີ່ບໍ່ຕົກໃສ່ພາກໃດ.
 *
 * On the ACT side that is foreign customers and bills with no province on them.
 * On the Target side it is also ຂາຍຊ່າງແອ, whose plan is entered as one company
 * figure (province_code 'ALL') while its sales land province by province — so
 * the four blocks are short of that target and the total is not. Reported
 * rather than spread around, because guessing a split would be an invention.
 */
const sumOutsideRegions = (map, months) =>
  PRODUCTS.reduce((total, product) => total + sumBuckets(map, product, OUTSIDE, months), 0);

function buildActualMap(rowsIn, year) {
  const map = new Map();
  for (const row of rowsIn) {
    if (Number(row.year) !== year) continue;
    const key = bucketKey(
      String(row.bu_code ?? ""),
      String(row.channel_code ?? "OTHER"),
      String(row.region ?? OUTSIDE),
      Number(row.month),
    );
    map.set(key, (map.get(key) || 0) + Number(row.amount || 0));
  }
  return map;
}

/**
 * Wholesale target rows, by province. A wholesale plan entered against province
 * 'ALL' has no region to land in; it is kept under OUTSIDE so the company total
 * still adds up and the page can say how much sits there.
 */
function buildTargetMap(rowsIn) {
  const map = new Map();
  for (const row of rowsIn) {
    const bu = String(row.bu_code ?? "");
    const channel = normalizeTargetChannel(row.sale_channel);
    const region = regionOf(row.province_code);
    const key = bucketKey(bu, channel, region, Number(row.month));
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

    const cacheKey = `${year}|${month}|${source.stamp}`;
    const cached = cache.get(cacheKey);
    if (!force && cached) return NextResponse.json(cached);

    // Both years off one scan of odg_sale_detail: splitting them into a query
    // each reads the same 2.7 GB twice for the same answer. The month a sale
    // counts in is REPORT_DATE, not the ERP's monthdoc.
    const actualSql = `
      SELECT EXTRACT(YEAR FROM ${REPORT_DATE})::int AS year,
             EXTRACT(MONTH FROM ${REPORT_DATE})::int AS month,
             COALESCE(NULLIF(d.bu_code, ''), '-') AS bu_code,
             ${channelCodeSql("d.doc_no")} AS channel_code,
             ${regionSql("d.province")} AS region,
             COALESCE(SUM(d.sum_amount), 0)::float AS amount
      FROM public.odg_sale_detail d
      ${OVERRIDE_JOIN}
      WHERE EXTRACT(YEAR FROM ${REPORT_DATE})::int = ANY(%s::int[])
      GROUP BY 1, 2, 3, 4, 5`;
    const targetSql = `
      SELECT bu_code, target_month AS month, sale_channel, province_code,
             COALESCE(SUM(target_amount), 0)::float AS amount
      FROM public.odg_sales_target
      WHERE target_year = %s
      GROUP BY bu_code, target_month, sale_channel, province_code`;

    const [actualRows, targetNow] = await Promise.all([
      once(`${year}|${lastYear}|${source.stamp}`, () => rows(actualSql, [[year, lastYear]])),
      rows(targetSql, [year]),
    ]);

    const actual = buildActualMap(actualRows, year);
    const actualLy = buildActualMap(actualRows, lastYear);
    const target = buildTargetMap(targetNow);

    const columns = REGIONS.flatMap((region) =>
      PRODUCTS.map((product) => ({
        key: `${region.key}_${product.key}`,
        region: region.key,
        product: product.key,
        label: product.label,
      })),
    );

    /** One report block: Target, ACT, %, last year and the year-on-year ratio. */
    const buildSection = (key, label, months) => {
      const cells = {};
      const regionTotals = {};

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

      for (const region of REGIONS) {
        let running = { target: 0, value: 0, last_year: 0 };
        for (const product of PRODUCTS) {
          const cell = {
            target: sumBuckets(target, product, region.key, months),
            value: sumBuckets(actual, product, region.key, months),
            last_year: sumBuckets(actualLy, product, region.key, months),
          };
          cells[`${region.key}_${product.key}`] = withRatios(cell);
          running = accumulate(running, cell);
        }
        regionTotals[region.key] = withRatios(running);
      }

      // The wholesale total counts every province, the four blocks included and
      // whatever fell outside them — the sheet's own columns would otherwise
      // quietly drop foreign sales from the company figure.
      const total = PRODUCTS.reduce(
        (bucket, product) =>
          accumulate(bucket, {
            target: sumBuckets(target, product, null, months),
            value: sumBuckets(actual, product, null, months),
            last_year: sumBuckets(actualLy, product, null, months),
          }),
        { target: 0, value: 0, last_year: 0 },
      );

      return {
        key,
        label,
        value_label: "ACT",
        cells,
        region_totals: regionTotals,
        total: withRatios(total),
        /** ສ່ວນທີ່ບໍ່ຕົກໃສ່ພາກໃດ — ບອກໄວ້ ດີກວ່າໃຫ້ໄປພົບເອງວ່າຄໍລຳບວກແລ້ວບໍ່ເທົ່າຍອດລວມ. */
        outside: {
          target: sumOutsideRegions(target, months),
          value: sumOutsideRegions(actual, months),
          last_year: sumOutsideRegions(actualLy, months),
        },
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
        },
        regions: REGIONS.map(({ key, label }) => ({ key, label })),
        products: PRODUCTS.map(({ key, label }) => ({ key, label })),
        columns,
        sections: [
          buildSection("month", `PreviousMonth_${month}/${year}`, [month]),
          buildSection("ytd", `YTD 1-${month}/${year}`, range(1, month)),
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
