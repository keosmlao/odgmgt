/**
 * Write the suggested point rules into the map.
 *
 * A third of in-scope sales earns nothing today because the rate for that
 * brand and band was never written — not because the scheme excludes it. This
 * fills those gaps with the rates derived in ./_suggest-rules.mjs.
 *
 * Only suggestions backed by at least --min-brands other brands are written
 * (3 by default). A rate inferred from one brand is a guess, and guessing on a
 * seller's pay is not something a script should do unasked.
 *
 * Runs inside a transaction and prints the month's point total before and
 * after, so the effect on pay is on the record. Dry-run by default.
 *
 *   node scripts/apply-point-rule-suggestions.mjs 2026 8
 *   node scripts/apply-point-rule-suggestions.mjs 2026 8 --apply
 *   node scripts/apply-point-rule-suggestions.mjs 2026 8 --min-brands 5 --apply
 */
import { readFileSync } from "node:fs";
import { loadEnv } from "./_env.mjs";
import { computeSuggestions, loadInputs } from "./_suggest-rules.mjs";

const argv = process.argv.slice(2);
const year = Number(argv[0]);
const month = Number(argv[1]);
const APPLY = argv.includes("--apply");
const minIndex = argv.indexOf("--min-brands");
const MIN_BRANDS = minIndex >= 0 ? Number(argv[minIndex + 1]) : 3;

if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || !Number.isFinite(MIN_BRANDS)) {
  console.error("Usage: node scripts/apply-point-rule-suggestions.mjs <year> <month> [--min-brands N] [--apply]");
  process.exit(1);
}

/** New rules start with the month being fixed, not with the year: the first
 *  half of 2026 has not been reviewed and must not move under anyone. */
const FROM = `${year}-${String(month).padStart(2, "0")}-01`;
const TO = "2099-12-31";

loadEnv();
const { OVERRIDE_JOIN, REPORT_MONTH_FILTER, REPORT_DATE } = await import("../lib/sale-month-override.js");
const { rows, pool } = await import("../lib/db.js");

/** The report's own scoring query, so the measured effect is the real one. */
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

const SQL = pointsQuery();
const BRANCH = process.env.ODG_RETAIL_BRANCH || "01";
const totalPoints = async (client, y, m) => {
  const { rows: list } = await client.query(SQL, [y, m, y, m, BRANCH, "101"]);
  return list.reduce((sum, row) => sum + Number(row.points || 0), 0);
};
const money = (value) => Math.round(Number(value ?? 0)).toLocaleString("en-US");

const { ruleRows, soldRows } = await loadInputs(rows, year, month, SQL);
const all = computeSuggestions(ruleRows, soldRows);
const chosen = all.filter((row) => row.from >= MIN_BRANDS);

console.log(`\nຄຳແນະນຳທັງໝົດ ${all.length} ແຖວ · ອ້າງອີງ ≥${MIN_BRANDS} ຍີ່ຫໍ້ = ${chosen.length} ແຖວ\n`);
let group = "";
for (const row of chosen) {
  const label = `${row.category_code}|${row.brand_code}`;
  if (label !== group) {
    group = label;
    console.log(`  ${row.category_code} · ${row.brand_code}   (ຍອດ ${money(row.amount)})`);
  }
  console.log(`      ${String(row.design_token || "—").padEnd(13)}${String(row.size_token).padEnd(13)}→ ${String(row.points).padStart(6)}   ${row.basis} · ${row.from} ຍີ່ຫໍ້`);
}
if (chosen.length === 0) {
  console.log("  (ບໍ່ມີແຖວທີ່ຜ່ານເກນ)");
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const before = { current: await totalPoints(client, year, month) };
  const prevMonth = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
  before.previous = await totalPoints(client, prevMonth.y, prevMonth.m);

  let written = 0;
  for (const row of chosen) {
    const result = await client.query(
      `INSERT INTO public.app_incentive_point_rule
              (category_code, brand_code, design_token, size_token, points,
               is_special, effective_from, effective_to)
       SELECT $1::varchar, $2::varchar, $3::varchar, $4::varchar, $5::numeric, false, $6::date, $7::date
       WHERE NOT EXISTS (
         SELECT 1 FROM public.app_incentive_point_rule r
         WHERE r.category_code = $1::varchar AND r.brand_code = $2::varchar
           AND r.design_token = $3::varchar AND r.size_token = $4::varchar
           AND r.effective_from = $6::date
       )`,
      [row.category_code, row.brand_code, row.design_token, row.size_token, row.points, FROM, TO],
    );
    written += result.rowCount;
  }

  const after = { current: await totalPoints(client, year, month), previous: await totalPoints(client, prevMonth.y, prevMonth.m) };

  console.log(`\nຈະເພີ່ມ ${written} ແຖວ · ມີຜົນ ${FROM} .. ${TO}\n`);
  console.log(`  ${year}-${String(month).padStart(2, "0")}  ຄະແນນ ${before.current.toFixed(2)} → ${after.current.toFixed(2)}   ຕ່າງ ${(after.current - before.current).toFixed(2)}`);
  console.log(`  ${prevMonth.y}-${String(prevMonth.m).padStart(2, "0")}  ຄະແນນ ${before.previous.toFixed(2)} → ${after.previous.toFixed(2)}   ຕ່າງ ${(after.previous - before.previous).toFixed(2)}   (ຄວນເປັນ 0)`);

  if (APPLY) {
    await client.query("COMMIT");
    console.log("\nບັນທຶກແລ້ວ.");
  } else {
    await client.query("ROLLBACK");
    console.log("\n(dry run — ຖອນຄືນແລ້ວ. ໃສ່ --apply ເພື່ອບັນທຶກ)");
  }
} finally {
  client.release();
  await pool.end();
}
