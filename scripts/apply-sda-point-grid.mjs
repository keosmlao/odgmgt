/**
 * Rewrite the SDA point map from the scheme sheet, as a COMPLETE grid.
 *
 * The sheet management issued lists only the cells that earn something. The
 * scoring query reads a blank cell two different ways, and neither of them is
 * "no points":
 *
 *   blank at a `<=` band  → falls up to the nearest ceiling above and pays a
 *                           rate nobody wrote (HANABISHI ≤1,000 was paid the
 *                           ≤2,000 rate on 575 units)
 *   blank at `>5000`      → pays 0, because the top band has nothing above it
 *                           to fall to (a 6,000 kettle scored nothing)
 *
 * So the sheet is written out here in full: five bands for every brand on it,
 * with an explicit 0 wherever the sheet is blank. An explicit 0 is a decision
 * the report can explain; a blank is a hole that behaves differently depending
 * on where in the ladder it sits.
 *
 * Brands NOT on the sheet earn nothing, so their existing rules are closed —
 * that is the point of "start from the sheet, not from what is in there now".
 *
 * Dry-run by default; pass --apply to write. Both paths print the point totals
 * before and after, so the effect on pay is on the record either way.
 *
 *   node scripts/apply-sda-point-grid.mjs                      # dry run
 *   node scripts/apply-sda-point-grid.mjs --apply
 *   node scripts/apply-sda-point-grid.mjs --from 2026-09-01
 */
import { readFileSync } from "node:fs";
import { loadEnv } from "./_env.mjs";

const APPLY = process.argv.includes("--apply");
const fromArg = process.argv[process.argv.indexOf("--from") + 1];
/** Rules take effect on the 1st, so a month is scored by one set of rates. */
const FROM = /^\d{4}-\d{2}-01$/.test(fromArg || "") ? fromArg : "2026-08-01";
const TO = "2099-12-31";
/** Months to report the effect on: the month before FROM, to prove it did not
 *  move, and the month FROM opens, which is the one that changes. */
const PERIODS = [[2026, 7], [2026, 8]];

/** The five SDA price bands, smallest first — app_incentive_price_band. */
const BANDS = ["<=500", "<=1000", "<=2000", "<=5000", ">5000"];

/**
 * The scheme sheet, transcribed. Columns follow BANDS:
 *
 *   ≤500 · 501–1,000 · 1,001–2,000 · 2,001–5,000 · ມາກກວ່າ 5,000
 *
 * `_` is a cell the sheet leaves blank — it is written to the database as a
 * real 0, not left out.
 */
const _ = 0;
const SHEET = {
  // ເຄື່ອງໃຊ້ໄຟຟ້ານ້ອຍ
  OTH: {
    AJ:            [_, _,    0.5,  _,    1.5],
    CAMEL:         [_, _,    0.5,  1.25, _],
    DAIKIN:        [_, _,    _,    1.25, 1.5],
    HANABISHI:     [_, _,    0.5,  _,    1.5],
    HATARI:        [_, _,    0.5,  1.25, 1.5],
    HISENSE:       [_, _,    0.8,  _,    2.4],
    MIDEA:         [_, 0.4,  0.8,  2,    2.4],
    PANASONIC:     [_, _,    _,    2,    _],
    PHILIPS:       [_, _,    0.8,  _,    2.4],
    "SCI-MAX":     [_, _,    0.8,  _,    2.4],
    SHARP:         [_, _,    0.8,  2,    2.4],
    "SMART HOME":  [_, 0.25, 0.5,  _,    _],
    "SURE VISION": [_, _,    0.8,  _,    2.4],
    TEFAL:         [_, 0.5,  _,    2.5,  _],
  },
  // ເຄື່ອງເຮັດນ້ຳອຸ່ນ
  WH: {
    CENTON:        [_, _,    2,    _,    4],
    MIDEA:         [_, 0.9,  2.25, 3.6,  _],
    PANASONIC:     [_, _,    _,    3.2,  4],
    SHARP:         [_, _,    2,    _,    4],
  },
  // ຕູ້ກົດນ້ຳ
  DISP: {
    "BEST COOL":   [_, _,    1.25, 2,    2.5],
    MIDEA:         [_, _,    _,    2,    2.5],
    SHARP:         [_, _,    2,    _,    4],
  },
  // ເຄື່ອງຟອກອາກາດ
  AIRP: {
    DAIKIN:        [_, _,    _,    1.5,  2],
    SAMSUNG:       [_, _,    _,    2.4,  3.2],
    "SMART HOME":  [_, _,    _,    _,    3.2],
  },
  // ເຕົາໄມໂຄເວັບ
  MW: {
    MIDEA:         [_, _,    1.25, 1.25, _],
    PANASONIC:     [_, _,    1.25, 1.25, _],
    SAMSUNG:       [_, _,    _,    1.25, 2.5],
    SHARP:         [_, _,    1.25, _,    2.5],
  },
};

/** Every cell of the grid, one row per (subtype · brand · band). */
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
 * grid inside a transaction, scoring the month against it, and rolling back.
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

/** Points of the month, split into the SDA half this script can move. */
async function totals(year, month) {
  const list = await rows(SQL, [year, month, year, month, BRANCH, "101"]);
  const sum = (subset) => subset.reduce((acc, row) => acc + num(row.points), 0);
  return { all: sum(list), sda: sum(list.filter((row) => row.pcat === "SDA")) };
}

try {
  const on = `${FROM.slice(0, 7)}-15`;
  const current = await rows(
    `SELECT design_token, brand_code, size_token, max(points)::float AS points, count(*)::int AS copies
     FROM public.app_incentive_point_rule
     WHERE category_code = 'SDA' AND $1::date BETWEEN effective_from AND effective_to
     GROUP BY 1, 2, 3
     ORDER BY 1, 2, 3`,
    [on],
  );

  console.log(`\n===== ຕັ້ງຄ່າ SDA ໃໝ່ຕາມຕາຕະລາງ · ມີຜົນ ${FROM} ຫາ ${TO} =====`);
  console.log(`ແຖວທີ່ຈະຂຽນ: ${GRID.length}  (${GRID.length / BANDS.length} ຄູ່ ຍີ່ຫໍ້×ປະເພດ × ${BANDS.length} ຊ່ອງລາຄາ)`);
  console.log(`ຊ່ອງເກົ່າທີ່ຍັງມີຜົນຢູ່: ${current.length}`);
  const doubled = current.filter((row) => row.copies > 1);
  if (doubled.length) {
    console.log(`ຊ້ຳກັນ (ຫຼາຍກົດຄາບຊ່ອງດຽວ): ${doubled.map((row) => `${row.design_token}·${row.brand_code}·${row.size_token}×${row.copies}`).join(", ")}`);
  }

  // What actually changes, cell by cell, including the cells that only change
  // because a blank stops falling up.
  const before = new Map(current.map((row) => [`${row.design_token}|${row.brand_code}|${row.size_token}`, num(row.points)]));
  const onSheet = new Set(GRID.map((cell) => `${cell.design}|${cell.brand}`));
  const changes = GRID
    .map((cell) => ({ ...cell, was: before.get(`${cell.design}|${cell.brand}|${cell.band}`) }))
    .filter((cell) => cell.was !== cell.points);
  const dropped = current.filter((row) => !onSheet.has(`${row.design_token}|${row.brand_code}`));

  console.log("\n-- ຊ່ອງທີ່ປ່ຽນ (ຫວ່າງ → ຂຽນ 0 ຊັດເຈນ, ຫຼື ອັດຕາຕ່າງ) --");
  for (const cell of changes) {
    const was = cell.was === undefined ? "ຫວ່າງ" : fmt(cell.was);
    console.log(`   ${cell.design.padEnd(5)} ${cell.brand.padEnd(12)} ${cell.band.padEnd(8)} ${was.padStart(6)} → ${fmt(cell.points)}`);
  }
  if (changes.length === 0) console.log("   ບໍ່ມີ");

  console.log("\n-- ຍີ່ຫໍ້ທີ່ບໍ່ມີໃນຕາຕະລາງ → ປິດກົດເກົ່າ (ໄດ້ 0) --");
  for (const row of dropped) {
    console.log(`   ${row.design_token.padEnd(5)} ${row.brand_code.padEnd(12)} ${row.size_token.padEnd(8)} ${fmt(row.points).padStart(6)} → ປິດ`);
  }
  if (dropped.length === 0) console.log("   ບໍ່ມີ");

  const baseline = [];
  console.log("");
  for (const period of PERIODS) {
    const value = await totals(...period);
    baseline.push(value);
    console.log(`ກ່ອນ  ${label(period)}  ຄະແນນລວມ=${fmt(value.all)}  SDA=${fmt(value.sda)}`);
  }

  // The write always happens; only the ending differs. A dry run that never
  // wrote could not answer the one question worth asking before approving a
  // pay change — how much does the pay move.
  // Closing a rule keeps it readable, but the rules that start on or after
  // FROM are deleted outright, so print every live rule as the SQL that
  // recreates it. The run's own output is then enough to put back a decision
  // someone made in the config screen and nobody wrote down anywhere else.
  if (APPLY) {
    const snapshot = await rows(
      `SELECT brand_code, design_token, size_token, points, effective_from::text AS ef, effective_to::text AS et
       FROM public.app_incentive_point_rule
       WHERE category_code = 'SDA' AND effective_to >= $1::date
       ORDER BY design_token, brand_code, size_token, effective_from`,
      [FROM],
    );
    console.log(`\n-- ສຳຮອງກົດເກົ່າ ${snapshot.length} ແຖວ (ກ໊ອບປີ້ເກັບໄວ້ກ່ອນ) --`);
    for (const row of snapshot) {
      console.log(`INSERT INTO public.app_incentive_point_rule (category_code, brand_code, design_token, size_token, effective_from, effective_to, points)`
        + ` VALUES ('SDA', '${row.brand_code}', '${row.design_token}', '${row.size_token}', '${row.ef}', '${row.et}', ${row.points});`);
    }
  }

  await query("BEGIN");
  try {
    // Rules that already priced a closed month keep their history; rules that
    // start on or after FROM never priced a paid month, so they go.
    const closed = await query(
      `UPDATE public.app_incentive_point_rule
          SET effective_to = $1::date - 1, updated_at = now()
        WHERE category_code = 'SDA' AND effective_from < $1::date AND effective_to >= $1::date`,
      [FROM],
    );
    const removed = await query(
      `DELETE FROM public.app_incentive_point_rule
        WHERE category_code = 'SDA' AND effective_from >= $1::date`,
      [FROM],
    );
    let written = 0;
    for (const cell of GRID) {
      const result = await query(
        `INSERT INTO public.app_incentive_point_rule
                (category_code, brand_code, design_token, size_token, effective_from, effective_to, points)
         VALUES ('SDA', $1, $2, $3, $4::date, $5::date, $6)
         ON CONFLICT (category_code, brand_code, design_token, size_token, effective_from, effective_to, is_special)
         DO UPDATE SET points = EXCLUDED.points, updated_at = now()`,
        [cell.brand, cell.design, cell.band, FROM, TO, cell.points],
      );
      written += result.rowCount;
    }
    console.log(`\nປິດແຖວເກົ່າ: ${closed.rowCount}  ລຶບແຖວທີ່ຍັງບໍ່ທັນໃຊ້: ${removed.rowCount}  ຂຽນໃໝ່: ${written}`);

    for (const [index, period] of PERIODS.entries()) {
      const after = await totals(...period);
      console.log(`ຫຼັງ  ${label(period)}  ຄະແນນລວມ=${fmt(after.all)}  SDA=${fmt(after.sda)}`
        + `   ຕ່າງ ${fmt(after.all - baseline[index].all)}  (SDA ${fmt(after.sda - baseline[index].sda)})`);
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
