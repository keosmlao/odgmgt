/**
 * Print a suggested rate for every point-map gap that actually cost money.
 *
 * The reasoning lives in ./_suggest-rules.mjs and is shared with the script
 * that writes the rules, so what is reviewed here is exactly what gets saved.
 *
 * Read-only.
 *   node scripts/suggest-missing-point-rules.mjs 2026 8
 */
import { readFileSync } from "node:fs";
import { loadEnv } from "./_env.mjs";
import { computeSuggestions, loadInputs } from "./_suggest-rules.mjs";

const year = Number(process.argv[2]);
const month = Number(process.argv[3]);
if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
  console.error("Usage: node scripts/suggest-missing-point-rules.mjs <year> <month>");
  process.exit(1);
}

loadEnv();
const { OVERRIDE_JOIN, REPORT_MONTH_FILTER, REPORT_DATE } = await import("../lib/sale-month-override.js");
const { rows, pool } = await import("../lib/db.js");

/** The report's own scoring query, so sold tokens match the pay run exactly. */
function pointsQuery() {
  const src = readFileSync(new URL("../app/api/retail-incentive/route.js", import.meta.url), "utf8");
  const start = src.indexOf("WITH line AS (");
  const end = src.indexOf("`,", start);
  let index = 0;
  return src.slice(start, end)
    .replaceAll("${OVERRIDE_JOIN}", OVERRIDE_JOIN)
    .replaceAll("${REPORT_MONTH_FILTER}", REPORT_MONTH_FILTER)
    .replaceAll("${REPORT_DATE}", REPORT_DATE)
    .replace(/%s/g, () => `$${++index}`);
}

const money = (value) => Math.round(Number(value ?? 0)).toLocaleString("en-US");

try {
  const { ruleRows, soldRows } = await loadInputs(rows, year, month, pointsQuery());
  const suggestions = computeSuggestions(ruleRows, soldRows);

  console.log(`\n=== ຄຳແນະນຳຄ່າຄະແນນ · ${year}-${String(month).padStart(2, "0")} ===\n`);
  console.log(`   ${"ໝວດ".padEnd(8)}${"ຍີ່ຫໍ້".padEnd(14)}${"ແບບ".padEnd(13)}${"ຂັ້ນ".padEnd(13)}${"ແນະນຳ".padStart(7)}   ${"ອ້າງອີງ".padEnd(24)}${"ໜ່ວຍ".padStart(7)}${"ຍອດ".padStart(12)}`);
  let unlocked = 0;
  for (const row of suggestions) {
    unlocked += row.amount;
    console.log(
      `   ${String(row.category_code).padEnd(8)}${String(row.brand_code).padEnd(14)}`
      + `${String(row.design_token || "—").padEnd(13)}${String(row.size_token).padEnd(13)}`
      + `${String(row.points).padStart(7)}   ${`${row.basis} · ${row.from} ຍີ່ຫໍ້`.padEnd(24)}`
      + `${String(row.qty).padStart(7)}${money(row.amount).padStart(12)}`,
    );
  }
  const strong = suggestions.filter((row) => row.from >= 3);
  console.log(`\n   ${suggestions.length} ແຖວ · ຍອດຂາຍທີ່ປົດລັອກ ${money(unlocked)}`);
  console.log(`   ໃນນັ້ນ ${strong.length} ແຖວ ອ້າງອີງ ≥3 ຍີ່ຫໍ້ (ຊຸດທີ່ແນະນຳໃຫ້ອະນຸມັດກ່ອນ)\n`);
} finally {
  await pool.end();
}
