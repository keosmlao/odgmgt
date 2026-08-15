/**
 * Write the Washer point map from the scheme sheet, as a COMPLETE grid.
 *
 * The sheet is the Design · Brand · Size · Points list management keeps. It is
 * SPARSE — it lists only the cells that earn something — and a blank cell is
 * not the same thing as a zero to the scoring query:
 *
 *   blank in the middle of a ladder → the line finds no ceiling that covers it
 *                                     within its own brand and design, so what
 *                                     it earns depends on which rules happen to
 *                                     exist beside it, not on a decision
 *   blank at the open top          → pays nothing, silently
 *
 * So the sheet is written out here in full: five bands for every brand·design
 * on it, with an explicit 0 wherever the sheet is blank. An explicit 0 is a
 * decision the report can explain and the config screen shows in red; a blank
 * is a hole nobody can see.
 *
 * `LG/SAMSUNG` on the sheet is two brands paying the same rate, which is how
 * it has always been stored — LG and SAMSUNG each get their own row.
 *
 * The transcription below is checked against the 2026-01-01→2026-05-31 rules
 * (the same sheet, last time it was loaded) and any difference is printed
 * before anything is written, so a typo here cannot pass unseen.
 *
 * Dry-run by default; pass --apply to write. Both paths print the month's
 * point totals before and after, so the effect on pay is on the record either
 * way.
 *
 *   node scripts/apply-washer-point-grid.mjs                    # dry run
 *   node scripts/apply-washer-point-grid.mjs --apply
 *   node scripts/apply-washer-point-grid.mjs --from 2026-09-01
 *   node scripts/apply-washer-point-grid.mjs --to 2026-08-31    # this month only
 */
import { readFileSync } from "node:fs";
import { loadEnv } from "./_env.mjs";

const APPLY = process.argv.includes("--apply");
const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? "" : process.argv[at + 1] || "";
};

const CATEGORY = "Washer";
/** Rules take effect on the 1st, so a month is scored by one set of rates. */
const FROM = /^\d{4}-\d{2}-01$/.test(arg("--from")) ? arg("--from") : "2026-08-01";
/** Open-ended by default: a scheme stays in force until it is changed, and
 *  re-typing it every month is how months end up with no rules at all. */
const TO = /^\d{4}-\d{2}-\d{2}$/.test(arg("--to")) ? arg("--to") : "2099-12-31";

/** The month FROM opens, and the one before it — proof the past did not move. */
const [fromYear, fromMonth] = FROM.split("-").map(Number);
const PERIODS = [
  fromMonth === 1 ? [fromYear - 1, 12] : [fromYear, fromMonth - 1],
  [fromYear, fromMonth],
];

/**
 * The five Washer size bands, smallest first — app_incentive_price_band.
 *
 * `max` is the ceiling the scoring query matches on; the token is only the
 * name it is written under. <5 stops at 5.9 because the sheet's "<5 kg" and
 * "6-11 kg" leave 5.1–5.9 unspoken, and a gap in a ladder is a line that
 * earns nothing.
 */
const BANDS = [
  { token: "<5", max: 5.9 },
  { token: "6-11", max: 11 },
  { token: "12-14", max: 14 },
  { token: "15-19", max: 19 },
  { token: ">20", max: null },
];

/**
 * The scheme sheet, transcribed. Columns follow BANDS:
 *
 *   <5 kg · 6–11 kg · 12–14 kg · 15–19 kg · >20 kg
 *
 * `_` is a cell the sheet leaves blank — written to the database as a real 0.
 */
const _ = 0;
const SHEET = {
  Dryer: {
    HISENSE: [12, 12, 14.4, 18, 18],
    LG:      [10, 10, 12,   15, 15],
    SAMSUNG: [10, 10, 12,   15, 15],
  },
  "Front Load": {
    HISENSE: [_, 12, _,  _,  _],
    LG:      [_, 10, 12, _,  _],
    SAMSUNG: [_, 10, 12, 12, 12],
  },
  "Top Load": {
    HISENSE: [_, _, _, _, 9.6],
    LG:      [_, 3, 7, 8, 8],
    SAMSUNG: [_, 3, 7, 8, 8],
  },
  "Twin Tub": {
    HISENSE: [_, _,   2.4, _, _],
    LG:      [_, 2,   2,   2, _],
    SAMSUNG: [_, _,   2,   2, _],
  },
};

/** Every cell of the grid, one row per (design · brand · band). */
const GRID = Object.entries(SHEET).flatMap(([design, brands]) =>
  Object.entries(brands).flatMap(([brand, rates]) =>
    BANDS.map((band, index) => ({ design, brand, band, points: rates[index] })),
  ),
);

loadEnv();
const { OVERRIDE_JOIN, REPORT_MONTH_FILTER, REPORT_DATE } = await import("../lib/sale-month-override.js");
const { pool } = await import("../lib/db.js");

/**
 * One connection for the whole run, because the dry run works by writing the
 * grid inside a transaction, scoring the months against it, and rolling back.
 * Pool-level queries would land on other connections and score the OLD rules,
 * which is exactly the number the dry run exists to disprove.
 */
const client = await pool.connect();
const query = (sql, params = []) => client.query(sql, params);
const rows = async (sql, params = []) => (await client.query(sql, params)).rows;

/** The report's own scoring query, so these totals are the pay run's totals. */
function pointsQuery() {
  const src = readFileSync(new URL("../lib/incentive-points-sql.js", import.meta.url), "utf8");
  const start = src.indexOf("WITH line AS (");
  const end = src.lastIndexOf("`");
  if (start < 0 || end < start) throw new Error("could not locate POINTS_SQL");
  let index = 0;
  return src.slice(start, end)
    .replaceAll("${OVERRIDE_JOIN}", OVERRIDE_JOIN)
    .replaceAll("${REPORT_MONTH_FILTER}", REPORT_MONTH_FILTER)
    .replaceAll("${REPORT_DATE}", REPORT_DATE)
    .replace(/%s/g, () => `$${++index}`);
}

const SQL = pointsQuery();
const BRANCH = process.env.ODG_RETAIL_BRANCH || "01";
const num = (value) => Number(value || 0);
const fmt = (value) => num(value).toFixed(2);
const label = ([year, month]) => `${year}-${String(month).padStart(2, "0")}`;

/** Points of the month, split into the Washer half this script can move. */
async function totals(year, month) {
  const list = await rows(SQL, [year, month, year, month, BRANCH, "101"]);
  const sum = (subset) => subset.reduce((acc, row) => acc + num(row.points), 0);
  return { all: sum(list), washer: sum(list.filter((row) => row.pcat === CATEGORY)) };
}

try {
  const on = `${FROM.slice(0, 7)}-15`;
  const current = await rows(
    `SELECT design_token, brand_code, size_token, max(points)::float AS points, count(*)::int AS copies
     FROM public.app_incentive_point_rule
     WHERE category_code = $1 AND $2::date BETWEEN effective_from AND effective_to
     GROUP BY 1, 2, 3
     ORDER BY 1, 2, 3`,
    [CATEGORY, on],
  );

  console.log(`\n===== ຕັ້ງຄ່າ ${CATEGORY} ໃໝ່ຕາມຕາຕະລາງ · ມີຜົນ ${FROM} ຫາ ${TO} =====`);
  console.log(`ແຖວທີ່ຈະຂຽນ: ${GRID.length}  (${GRID.length / BANDS.length} ຄູ່ ຍີ່ຫໍ້×ປະເພດ × ${BANDS.length} ຊ່ອງຂະໜາດ)`);
  console.log(`ຊ່ອງເກົ່າທີ່ຍັງມີຜົນຢູ່ ${on}: ${current.length}`);

  // The sheet against the last time the sheet was loaded. A cell that differs
  // is either a real change management made, or a typo above — and the run
  // says which cells to look at rather than leaving both possibilities open.
  const previous = await rows(
    `SELECT design_token, brand_code, size_token, points::float AS points
     FROM public.app_incentive_point_rule
     WHERE category_code = $1 AND effective_from = '2026-01-01' AND effective_to = '2026-05-31'`,
    [CATEGORY],
  );
  if (previous.length) {
    const was = new Map(previous.map((row) => [`${row.design_token}|${row.brand_code}|${row.size_token}`, num(row.points)]));
    const drift = GRID
      .map((cell) => ({ ...cell, was: was.get(`${cell.design}|${cell.brand}|${cell.band.token}`) }))
      .filter((cell) => (cell.was ?? 0) !== cell.points);
    console.log(`\n-- ທຽບກັບຕາຕະລາງທີ່ໂຫຼດຄັ້ງກ່ອນ (2026-01-01→2026-05-31, ${previous.length} ແຖວ) --`);
    for (const cell of drift) {
      const from = cell.was === undefined ? "ຫວ່າງ" : fmt(cell.was);
      console.log(`   ${cell.design.padEnd(11)} ${cell.brand.padEnd(8)} ${cell.band.token.padEnd(7)} ${from.padStart(6)} → ${fmt(cell.points)}`);
    }
    if (drift.length === 0) console.log("   ຄືກັນທຸກຊ່ອງ");
  }

  // What actually changes, cell by cell, including the cells that only change
  // because a blank stops being a hole.
  const before = new Map(current.map((row) => [`${row.design_token}|${row.brand_code}|${row.size_token}`, num(row.points)]));
  const onSheet = new Set(GRID.map((cell) => `${cell.design}|${cell.brand}`));
  const changes = GRID
    .map((cell) => ({ ...cell, was: before.get(`${cell.design}|${cell.brand}|${cell.band.token}`) }))
    .filter((cell) => cell.was !== cell.points);
  const dropped = current.filter((row) => !onSheet.has(`${row.design_token}|${row.brand_code}`));

  console.log(`\n-- ຊ່ອງທີ່ປ່ຽນຈາກທີ່ມີຜົນຢູ່ຕອນນີ້ (${changes.length}) --`);
  for (const cell of changes) {
    const from = cell.was === undefined ? "ຫວ່າງ" : fmt(cell.was);
    console.log(`   ${cell.design.padEnd(11)} ${cell.brand.padEnd(8)} ${cell.band.token.padEnd(7)} ${from.padStart(6)} → ${fmt(cell.points)}`);
  }
  if (changes.length === 0) console.log("   ບໍ່ມີ");

  console.log("\n-- ຄູ່ທີ່ບໍ່ມີໃນຕາຕະລາງ → ປິດກົດເກົ່າ (ໄດ້ 0) --");
  for (const row of dropped) {
    console.log(`   ${row.design_token.padEnd(11)} ${row.brand_code.padEnd(8)} ${row.size_token.padEnd(7)} ${fmt(row.points).padStart(6)} → ປິດ`);
  }
  if (dropped.length === 0) console.log("   ບໍ່ມີ");

  const baseline = [];
  console.log("");
  for (const period of PERIODS) {
    const value = await totals(...period);
    baseline.push(value);
    console.log(`ກ່ອນ  ${label(period)}  ຄະແນນລວມ=${fmt(value.all)}  ${CATEGORY}=${fmt(value.washer)}`);
  }

  // Closing a rule keeps it readable, but the rules that start on or after
  // FROM are deleted outright, so print every live rule as the SQL that
  // recreates it. The run's own output is then enough to put back a decision
  // someone made in the config screen and nobody wrote down anywhere else.
  if (APPLY) {
    const snapshot = await rows(
      `SELECT brand_code, design_token, size_token, points, max_value, band_kind,
              effective_from::text AS ef, effective_to::text AS et
       FROM public.app_incentive_point_rule
       WHERE category_code = $1 AND effective_to >= $2::date
       ORDER BY design_token, brand_code, size_token, effective_from`,
      [CATEGORY, FROM],
    );
    console.log(`\n-- ສຳຮອງກົດເກົ່າ ${snapshot.length} ແຖວ (ກ໊ອບປີ້ເກັບໄວ້ກ່ອນ) --`);
    for (const row of snapshot) {
      const max = row.max_value === null ? "NULL" : row.max_value;
      const kind = row.band_kind === null ? "NULL" : `'${row.band_kind}'`;
      console.log(`INSERT INTO public.app_incentive_point_rule (category_code, brand_code, design_token, size_token, effective_from, effective_to, points, max_value, band_kind)`
        + ` VALUES ('${CATEGORY}', '${row.brand_code}', '${row.design_token}', '${row.size_token}', '${row.ef}', '${row.et}', ${row.points}, ${max}, ${kind});`);
    }
  }

  await query("BEGIN");
  try {
    // Rules that already priced a closed month keep their history; rules that
    // start on or after FROM never priced a paid month, so they go.
    const closed = await query(
      `UPDATE public.app_incentive_point_rule
          SET effective_to = $2::date - 1, updated_at = now()
        WHERE category_code = $1 AND effective_from < $2::date AND effective_to >= $2::date`,
      [CATEGORY, FROM],
    );
    const removed = await query(
      `DELETE FROM public.app_incentive_point_rule
        WHERE category_code = $1 AND effective_from >= $2::date`,
      [CATEGORY, FROM],
    );
    let written = 0;
    for (const cell of GRID) {
      // max_value / band_kind are what the scoring query and the config screen
      // both read now — a rule written without them is invisible to the grid.
      const result = await query(
        `INSERT INTO public.app_incentive_point_rule
                (category_code, brand_code, design_token, size_token, effective_from, effective_to, points, max_value, band_kind)
         VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, 'size')
         ON CONFLICT (category_code, brand_code, design_token, size_token, effective_from, effective_to, is_special)
         DO UPDATE SET points = EXCLUDED.points, max_value = EXCLUDED.max_value,
                       band_kind = EXCLUDED.band_kind, updated_at = now()`,
        [CATEGORY, cell.brand, cell.design, cell.band.token, FROM, TO, cell.points, cell.band.max],
      );
      written += result.rowCount;
    }
    console.log(`\nປິດແຖວເກົ່າ: ${closed.rowCount}  ລຶບແຖວທີ່ຍັງບໍ່ທັນໃຊ້: ${removed.rowCount}  ຂຽນໃໝ່: ${written}`);

    for (const [index, period] of PERIODS.entries()) {
      const after = await totals(...period);
      console.log(`ຫຼັງ  ${label(period)}  ຄະແນນລວມ=${fmt(after.all)}  ${CATEGORY}=${fmt(after.washer)}`
        + `   ຕ່າງ ${fmt(after.all - baseline[index].all)}  (${CATEGORY} ${fmt(after.washer - baseline[index].washer)})`);
    }

    if (APPLY) {
      await query("COMMIT");
      console.log("\nບັນທຶກແລ້ວ.\n");
    } else {
      await query("ROLLBACK");
      console.log("\n(dry run — ຄືນຄ່າເກົ່າໝົດແລ້ວ, ບໍ່ໄດ້ຂຽນຫຍັງ. ໃສ່ --apply ເພື່ອບັນທຶກ)\n");
    }
  } catch (error) {
    await query("ROLLBACK");
    throw error;
  }
} finally {
  client.release();
  await pool.end();
}
