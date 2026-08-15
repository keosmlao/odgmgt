/**
 * Copy the rules in force in one month into another, as that month's own.
 *
 * The screen's "copy last month" only ever reaches backwards, which is the
 * usual direction: a scheme is carried forward. It cannot help when the month
 * that has the scheme is the LATER one — a month cleared by mistake, or one
 * configured ahead before anyone got to the month before it — and re-typing a
 * grid by hand is how a month ends up subtly different from its neighbour.
 *
 * What is written is month-bounded, exactly like an edit made on the screen:
 * from the 1st to the last day of the target month, and nothing outside it. The
 * source month is read, never touched.
 *
 * A rule the target month already has is left alone (ON CONFLICT DO NOTHING),
 * so this fills gaps and overwrites nothing.
 *
 * Dry-run by default; both paths print the target month's points before and
 * after, so the effect on pay is on the record either way.
 *
 *   node scripts/copy-rules-between-months.mjs --category Washer --from 2026-08 --to 2026-07
 *   node scripts/copy-rules-between-months.mjs --category Washer --from 2026-08 --to 2026-07 --apply
 */
import { readFileSync } from "node:fs";
import { loadEnv } from "./_env.mjs";

const APPLY = process.argv.includes("--apply");
const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? "" : process.argv[at + 1] || "";
};
const CATEGORY = arg("--category");
const FROM = arg("--from");
const TO = arg("--to");
if (!CATEGORY || !/^\d{4}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}$/.test(TO)) {
  console.error("Usage: node scripts/copy-rules-between-months.mjs --category <code> --from YYYY-MM --to YYYY-MM [--apply]");
  process.exit(1);
}

loadEnv();
const { rows: q, query, pool } = await import("../lib/db.js");
const { OVERRIDE_JOIN, REPORT_DATE, REPORT_MONTH_FILTER } = await import("../lib/sale-month-override.js");

/** The report's own scoring query, so these totals are the pay run's totals. */
const src = readFileSync(new URL("../lib/incentive-points-sql.js", import.meta.url), "utf8");
const POINTS_SQL = src.slice(src.indexOf("WITH line AS ("), src.lastIndexOf("`"))
  .replaceAll("${OVERRIDE_JOIN}", OVERRIDE_JOIN)
  .replaceAll("${REPORT_MONTH_FILTER}", REPORT_MONTH_FILTER)
  .replaceAll("${REPORT_DATE}", REPORT_DATE);
const BRANCH = process.env.ODG_RETAIL_BRANCH || "01";

const [toYear, toMonth] = TO.split("-").map(Number);
const first = `${TO}-01`;
const last = new Date(Date.UTC(toYear, toMonth, 0)).toISOString().slice(0, 10);
const readOn = `${FROM}-15`;

async function scored() {
  const lines = await q(POINTS_SQL, [toYear, toMonth, toYear, toMonth, BRANCH, "101"]);
  let all = 0;
  let mine = 0;
  for (const line of lines) {
    all += Number(line.points || 0);
    if (line.pcat === CATEGORY) mine += Number(line.points || 0);
  }
  return { all, mine };
}

const source = await q(
  `SELECT brand_code, design_token, size_token, points::float AS points,
          max_value::float AS max_value, band_kind
     FROM public.app_incentive_point_rule
    WHERE category_code = %s AND %s::date BETWEEN effective_from AND effective_to
    ORDER BY design_token, brand_code, max_value NULLS LAST`,
  [CATEGORY, readOn],
);
const existing = await q(
  `SELECT COUNT(*) AS n FROM public.app_incentive_point_rule
    WHERE category_code = %s AND %s::date BETWEEN effective_from AND effective_to`,
  [CATEGORY, `${TO}-15`],
);

console.log(`${CATEGORY}: ${source.length} rules in force ${FROM} → would be written into ${TO} (${first} … ${last})`);
console.log(`${CATEGORY}: ${existing[0].n} rules already in force in ${TO} — those are left untouched`);
for (const row of source.slice(0, 8)) {
  console.log(`   ${row.design_token || "—"}  ${row.brand_code}  ${row.size_token}  → ${row.points}`);
}
if (source.length > 8) console.log(`   … ${source.length - 8} more`);

const before = await scored();
console.log(`\nກ່ອນ  ${TO}  ຄະແນນລວມ=${before.all.toFixed(2)}  ${CATEGORY}=${before.mine.toFixed(2)}`);

if (!APPLY) {
  console.log("\n(dry run — ບໍ່ໄດ້ຂຽນຫຍັງ. ໃສ່ --apply ເພື່ອບັນທຶກ)");
  await pool.end();
  process.exit(0);
}

const written = await query(
  `INSERT INTO public.app_incentive_point_rule
          (category_code, brand_code, design_token, size_token,
           effective_from, effective_to, points, max_value, band_kind, is_special)
   SELECT r.category_code, r.brand_code, r.design_token, r.size_token,
          %s::date, %s::date, r.points, r.max_value, r.band_kind, r.is_special
     FROM public.app_incentive_point_rule r
    WHERE r.category_code = %s AND %s::date BETWEEN r.effective_from AND r.effective_to
   ON CONFLICT (category_code, brand_code, design_token, size_token, effective_from, effective_to, is_special)
   DO NOTHING`,
  [first, last, CATEGORY, readOn],
);
console.log(`\nຂຽນໃໝ່: ${written.rowCount} ກົດ`);

const after = await scored();
console.log(`ຫຼັງ  ${TO}  ຄະແນນລວມ=${after.all.toFixed(2)}  ${CATEGORY}=${after.mine.toFixed(2)}`
  + `   ຕ່າງ ${(after.all - before.all).toFixed(2)}  (${CATEGORY} ${(after.mine - before.mine).toFixed(2)})`);
await pool.end();
