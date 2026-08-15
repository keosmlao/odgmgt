/**
 * Take an item category out of the incentive scheme.
 *
 * Clearing app_incentive_category.pointmap_category leaves the category with
 * no point group, and the report matches no rule for it — so its sales still
 * count toward ຍອດຂາຍ, achievement and commission, but earn no points. The row
 * itself is kept, so the category stays visible in the config screen (marked
 * "ບໍ່ມີກຸ່ມຄະແນນ") and the decision can be undone by picking a group again.
 *
 * The effect is measured by running the report's own scoring query inside a
 * transaction, so the printed before/after is the real answer rather than an
 * estimate. A dry run rolls that transaction back.
 *
 *   node scripts/set-category-out-of-scheme.mjs 004
 *   node scripts/set-category-out-of-scheme.mjs 004 --apply
 */
import { readFileSync } from "node:fs";
import { loadEnv } from "./_env.mjs";

const APPLY = process.argv.includes("--apply");
/**
 * --delete removes the row outright instead of clearing its point group. Both
 * score the same — the report reads an absent row and a null group alike — so
 * this is only about whether the category should still appear in the config
 * screen at all. Nothing references app_incentive_category, so the row can go.
 */
const DELETE = process.argv.includes("--delete");
const CODES = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (CODES.length === 0) {
  console.error("Usage: node scripts/set-category-out-of-scheme.mjs <category_code…> [--apply]");
  process.exit(1);
}
/** Months whose figures the change can still move. */
const PERIODS = [[2026, 7], [2026, 8]];

loadEnv();
const { OVERRIDE_JOIN, REPORT_MONTH_FILTER, REPORT_DATE } = await import("../lib/sale-month-override.js");
const { pool } = await import("../lib/db.js");

/** The report's own scoring query, so this can never drift from the report. */
function pointsQuery() {
  const src = readFileSync(new URL("../app/api/retail-incentive/route.js", import.meta.url), "utf8");
  const start = src.indexOf("WITH line AS (");
  const end = src.indexOf("`,", start);
  if (start < 0 || end < 0) throw new Error("could not locate the point query in route.js");
  let index = 0;
  return src.slice(start, end)
    .replaceAll("${OVERRIDE_JOIN}", OVERRIDE_JOIN)
    .replaceAll("${REPORT_MONTH_FILTER}", REPORT_MONTH_FILTER)
    .replaceAll("${REPORT_DATE}", REPORT_DATE)
    .replace(/%s/g, () => `$${++index}`);
}

const SQL = pointsQuery();
const BRANCH = process.env.ODG_RETAIL_BRANCH || "01";
const fmt = (value) => Number(value).toFixed(2);
const label = ([year, month]) => `${year}-${String(month).padStart(2, "0")}`;

async function totalPoints(client, [year, month]) {
  const { rows } = await client.query(SQL, [year, month, year, month, BRANCH, "101"]);
  return rows.reduce((sum, row) => sum + Number(row.points || 0), 0);
}

const client = await pool.connect();
try {
  const { rows: current } = await client.query(
    `SELECT category_code, category_name, pointmap_category, group_code, is_active
     FROM public.app_incentive_category WHERE category_code = ANY($1) ORDER BY category_code`,
    [CODES],
  );
  if (current.length === 0) {
    console.log(`\nບໍ່ພົບໝວດ ${CODES.join(", ")} ໃນ app_incentive_category — ບໍ່ຢູ່ໃນເງື່ອນໄຂຢູ່ແລ້ວ.`);
  } else {
    console.log("");
    for (const row of current) {
      console.log(`   ${row.category_code}  ${String(row.category_name || "").padEnd(24)}`
        + `ກຸ່ມຄະແນນ=${row.pointmap_category ?? "(ບໍ່ມີແລ້ວ)"}  group=${row.group_code ?? "-"}  active=${row.is_active}`);
    }
    console.log("");

    await client.query("BEGIN");
    const before = [];
    for (const period of PERIODS) before.push(await totalPoints(client, period));

    const updated = DELETE
      ? await client.query(`DELETE FROM public.app_incentive_category WHERE category_code = ANY($1)`, [CODES])
      : await client.query(
        `UPDATE public.app_incentive_category SET pointmap_category = NULL
         WHERE category_code = ANY($1) AND pointmap_category IS NOT NULL`,
        [CODES],
      );

    for (const [index, period] of PERIODS.entries()) {
      const after = await totalPoints(client, period);
      console.log(`${label(period)}  ຄະແນນລວມ ${fmt(before[index])} → ${fmt(after)}   ຕ່າງ ${fmt(after - before[index])}`);
    }

    if (APPLY) {
      await client.query("COMMIT");
      console.log(`\nບັນທຶກແລ້ວ: ${updated.rowCount} ໝວດ.`);
    } else {
      await client.query("ROLLBACK");
      console.log("\n(dry run — ຖອນຄືນແລ້ວ. ໃສ່ --apply ເພື່ອບັນທຶກ)");
    }
  }
} finally {
  client.release();
  await pool.end();
}
