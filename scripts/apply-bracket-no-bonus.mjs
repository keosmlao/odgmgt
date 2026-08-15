/**
 * Take TV brackets out of the incentive scheme.
 *
 * A bracket sits in item_category 004 (ອຸປະກອນພາບແລະສຽງ), which IS a scored
 * AV category, so a branded bracket matches an AV price-band rule and earns a
 * TV's points. HISENSE brackets are given away at price 0, which lands in the
 * AV "<=10000" band and paid 10 points a unit for a free item.
 *
 * Brackets are accessories, not products the scheme rewards, so each bracket
 * item code gets a `special_no_bonus` status (multiplier 0). That is the
 * mechanism the scheme already uses for deliberate exclusions — it keeps the
 * sale in ຍອດຂາຍ and achievement, and only removes the points.
 *
 * Dry-run by default; pass --apply to write. Prints the point totals before
 * and after so the effect on pay is on the record either way.
 *
 *   node scripts/apply-bracket-no-bonus.mjs           # dry run
 *   node scripts/apply-bracket-no-bonus.mjs --apply
 */
import { readFileSync } from "node:fs";
import { loadEnv } from "./_env.mjs";

const APPLY = process.argv.includes("--apply");
const FROM = "2026-07-01";
const TO = "2099-12-31";
const NOTE = "ຂາຈັບໂທລະທັດ ບໍ່ຢູ່ໃນເງື່ອນໄຂການໃຫ້ຄະແນນ";
/** Months to report the effect on: every month the change can still move. */
const PERIODS = [[2026, 7], [2026, 8]];

loadEnv();
const { OVERRIDE_JOIN, REPORT_MONTH_FILTER, REPORT_DATE } = await import("../lib/sale-month-override.js");
const { rows, query, pool } = await import("../lib/db.js");

/**
 * The report's own scoring query, read straight out of the route so this can
 * never drift from what the report shows.
 */
function pointsQuery() {
  const src = readFileSync(new URL("../app/api/retail-incentive/route.js", import.meta.url), "utf8");
  const start = src.indexOf("WITH line AS (");
  const end = src.indexOf("`,", start);
  if (start < 0 || end < 0) throw new Error("could not locate the point query in route.js");
  return src.slice(start, end)
    .replaceAll("${OVERRIDE_JOIN}", OVERRIDE_JOIN)
    .replaceAll("${REPORT_MONTH_FILTER}", REPORT_MONTH_FILTER)
    .replaceAll("${REPORT_DATE}", REPORT_DATE);
}

const SQL = pointsQuery();
const isBracket = (row) => String(row.item_name || "").includes("ຂາຈັບ");

async function totals(year, month) {
  const list = await rows(SQL, [year, month, year, month, process.env.ODG_RETAIL_BRANCH || "01", "101"]);
  const sum = (rowsIn) => rowsIn.reduce((acc, row) => acc + Number(row.points || 0), 0);
  return { all: sum(list), brackets: sum(list.filter(isBracket)) };
}

const fmt = (value) => Number(value).toFixed(2);
const label = ([year, month]) => `${year}-${String(month).padStart(2, "0")}`;

try {
  const targets = await rows(
    `SELECT DISTINCT d.item_code
     FROM public.odg_sale_detail d
     WHERE d.item_name ILIKE '%ຂາຈັບ%'
     ORDER BY 1`,
  );
  console.log(`\nລະຫັດຂາຈັບທີ່ຈະຕັ້ງເປັນ special_no_bonus: ${targets.length}`);
  console.log(`ຊ່ວງມີຜົນ: ${FROM} .. ${TO}\n`);

  const before = [];
  for (const period of PERIODS) before.push(await totals(...period));
  for (const [index, period] of PERIODS.entries()) {
    console.log(`ກ່ອນ  ${label(period)}  ຄະແນນລວມ=${fmt(before[index].all)}  ຂາຈັບ=${fmt(before[index].brackets)}`);
  }

  if (!APPLY) {
    console.log("\n(dry run — ບໍ່ໄດ້ຂຽນ. ໃສ່ --apply ເພື່ອບັນທຶກ)");
  } else {
    const inserted = await query(
      `INSERT INTO public.app_incentive_product_status_rule
              (item_code, status_code, weight, note, effective_from, effective_to)
       SELECT DISTINCT d.item_code, 'special_no_bonus', 1, %s, %s::date, %s::date
       FROM public.odg_sale_detail d
       WHERE d.item_name ILIKE '%%ຂາຈັບ%%'
       ON CONFLICT (item_code, effective_from) DO NOTHING`,
      [NOTE, FROM, TO],
    );
    console.log(`\nເພີ່ມແຖວ: ${inserted.rowCount}\n`);

    for (const [index, period] of PERIODS.entries()) {
      const after = await totals(...period);
      console.log(`ຫຼັງ  ${label(period)}  ຄະແນນລວມ=${fmt(after.all)}  ຂາຈັບ=${fmt(after.brackets)}`
        + `   ຕ່າງ ${fmt(after.all - before[index].all)}`);
    }
  }
} finally {
  await pool.end();
}
