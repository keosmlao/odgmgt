/**
 * Fills public.odg_sales_assignment from a year's real sales instead of by hand.
 * See scripts/_derive-assignment-sql.mjs for how a bill becomes a seller + area.
 *
 * Each month is taken as it happened: a seller is assigned the provinces and
 * districts they actually billed in THAT month. The months that have not been
 * sold yet cannot say anything, so they inherit the last month that has data —
 * the same coverage carried forward to December, which is what a plan for the
 * rest of the year is.
 *
 * Reports before it writes, because both money columns are sensitive to the
 * number of rows. An assignment row claims the WHOLE target of its BU / area /
 * month, and the rollup it reads for ຍອດຂາຍ has no seller dimension, so two
 * sellers over one district each show the district's entire plan and its entire
 * baht. The dry run prints what the grid's header would read after the insert.
 *
 * Existing rows are never touched (ON CONFLICT DO NOTHING), so a hand-made row
 * keeps its channels and its area even where the sales say something narrower.
 *
 * Usage:
 *   node scripts/derive-sales-assignments.mjs [year] [options]
 *
 *   --mode=          faithful | exclusive | gap (default faithful — every seller
 *                    who really sold there). See `fresh` below.
 *   --min-amount=N   ignore a seller's area-month below N baht (default 0).
 *   --bu=11,12,13    restrict to these BUs (default: the BUs that have a target
 *                    plan for the year — a row whose BU has no plan reads ເປົ້າ 0).
 *   --all-bu         keep every BU, planned or not.
 *   --through=8      the last month that has data, carried forward to December
 *                    (default: the last month with any sale).
 *   --no-carry       write only the months that really have sales.
 *   --shop-branch=01 the branch whose counter staff are kept off the board
 *                    (01 = ສາຂາຂົວຫຼວງ). Empty string disables the rule.
 *   --shop-pct=90    a seller selling this much of their year over that branch's
 *                    counter is counter staff, not an area seller.
 *   --prune          also DELETE rows belonging to sellers the rules exclude, so
 *                    a re-run converges instead of only ever adding.
 *   --apply          write. Without it the script only reports.
 *
 * The dry run always prices all three modes, so the rows and the ເປົ້າ / ຍອດຂາຍ
 * each one produces are visible before anything is written.
 */
import { loadEnv } from "./_env.mjs";
import pg from "pg";
import { SALES_BY_SELLER_AREA_MONTH, SHOP_SHARE_BY_SELLER } from "./_derive-assignment-sql.mjs";
import { MONTHLY_TABLE, SELLER_TABLE } from "../lib/sale-monthly-sql.mjs";
import {
  BOARD_MANAGERS,
  SELLER_DEPARTMENT_BU_SQL,
  claimableChannelSql,
  isManagerSql,
} from "../lib/sales-board-roles.mjs";

loadEnv();

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const list = (name) => (value(name) || "").split(",").map((s) => s.trim()).filter(Boolean);

const YEAR = Number(argv.find((a) => /^\d{4}$/.test(a)) || new Date().getFullYear());
const MIN_AMOUNT = Number(value("min-amount", "0"));
const BU_ARG = list("bu");
const ALL_BU = flag("all-bu");
const THROUGH = value("through") ? Number(value("through")) : null;
const CARRY = !flag("no-carry");
const APPLY = flag("apply");
const PRUNE = flag("prune");
const MODE = value("mode", "faithful");
const SHOP_BRANCH = value("shop-branch", "01");
const SHOP_PCT = Number(value("shop-pct", "90"));


const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: 1,
  connectionTimeoutMillis: 8000,
  // The one-off full-year scan runs past any sane per-request limit.
  statement_timeout: 0,
});

const money = (n) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * Both money columns exactly as app/api/sales-assignments computes them, over a
 * set of candidate rows called `combined` (sale_id, bu_code, province_code,
 * district_code, month, channel_codes). If that route's SQL changes, the numbers
 * this script reports stop being a forecast — keep the two in step.
 *
 * ເປົ້າ divides each plan row between the assignments that claim it, so the
 * column adds back up to odg_sales_target however the areas are cut. ຍອດຂາຍ
 * reads the seller-grained rollup, so a row shows that person's own baht and not
 * their whole district's.
 *
 * The year's parameter number is passed in because Postgres cannot type a
 * parameter the statement never references: a query over the existing rows alone
 * takes the year as $1, one that also builds `fresh` takes it later.
 */
const gridTotalsSql = (year) => `
  , act AS (
    SELECT b.rowid AS assignment_id, COALESCE(SUM(sm.sum_amount), 0) AS amount
    FROM combined b
    LEFT JOIN ${SELLER_TABLE} sm
      ON sm.yeardoc = ${year}::int
     AND sm.sale_id = b.sale_id AND sm.monthdoc = b.month AND sm.bu_code = b.bu_code
     AND (b.province_code = 'ALL' OR sm.province = b.province_code)
     AND (b.district_code = 'ALL' OR sm.amper = b.district_code)
     AND (b.channel_codes IS NULL OR array_length(b.channel_codes, 1) IS NULL
          OR sm.channel_code = ANY(b.channel_codes))
    GROUP BY b.rowid
  ),
  claim AS (
    SELECT b.rowid AS assignment_id, st.id AS target_id, st.target_amount,
           (CASE WHEN b.province_code <> 'ALL' THEN 2 ELSE 0 END
            + CASE WHEN b.district_code <> 'ALL' THEN 1 ELSE 0 END) AS specificity
    FROM combined b
    JOIN public.odg_sales_target st
      ON st.target_year = ${year}::int
     AND st.target_month = b.month
     AND st.bu_code = b.bu_code
     AND (b.province_code = 'ALL' OR st.province_code = 'ALL' OR st.province_code = b.province_code)
     AND (b.district_code = 'ALL' OR st.district_code = 'ALL' OR st.district_code = b.district_code)
     AND ${claimableChannelSql("b", "st")}
    WHERE NOT ${isManagerSql("b")}
  ),
  owner AS (
    SELECT DISTINCT ON (c.target_id) c.target_id, c.assignment_id, c.target_amount
    FROM claim c
    LEFT JOIN act ON act.assignment_id = c.assignment_id
    ORDER BY c.target_id, c.specificity DESC, act.amount DESC NULLS LAST, c.assignment_id
  ),
  target_share AS (
    SELECT assignment_id, SUM(target_amount) AS amount FROM owner GROUP BY assignment_id
  )
  SELECT COUNT(*)::int AS rows,
         COALESCE(SUM(tgt.amount), 0)::float AS target,
         COALESCE(SUM(act.amount), 0)::float AS actual
  FROM combined r
  LEFT JOIN target_share tgt ON tgt.assignment_id = r.rowid
  LEFT JOIN act ON act.assignment_id = r.rowid`;

/**
 * Rows the writer would add: over the floor, in a kept BU, not already there.
 *
 * Reads the `coverage` temp table, which is already one row per seller × area ×
 * month with the carried-forward months included.
 *
 * Two sellers over one district each claim that district's whole plan and whole
 * baht, because neither the target table nor the rollup knows about sellers. The
 * three modes are the three honest answers to that:
 *
 *   faithful  — every seller who really sold there. True coverage; both money
 *               columns overstate unless the API divides them.
 *   exclusive — one seller per area-month, the biggest that month wins. No
 *               double counting inside the derived set; a hand-made row for the
 *               same area still overlaps.
 *   gap       — only area-months nobody covers yet, so the header does not move.
 */
const MODES = ["faithful", "exclusive", "gap"];
if (!MODES.includes(MODE)) {
  console.error(`--mode must be one of ${MODES.join(" | ")}`);
  process.exit(1);
}
const fresh = (mode) => `
  SELECT c.sale_id, c.sale_name, c.bu_code, c.province_code, c.district_code,
         c.month, c.amount, c.carried
  FROM coverage c
  WHERE c.amount >= $1::numeric
    AND (cardinality($2::text[]) = 0 OR c.bu_code = ANY($2::text[]))
    -- Not already covered by a row this person holds. An exact duplicate is the
    -- obvious case; a wider one matters just as much, because an 'ALL' row
    -- already counts every district's baht and plan, and adding the district
    -- underneath it would count that slice a second time.
    AND NOT EXISTS (
      SELECT 1 FROM public.odg_sales_assignment o
      WHERE o.sale_id = c.sale_id AND o.bu_code = c.bu_code AND o.month = c.month
        AND (o.province_code = 'ALL' OR o.province_code = c.province_code)
        AND (o.district_code = 'ALL' OR o.district_code = c.district_code)
    )
    ${mode === "exclusive" ? `AND NOT EXISTS (
      SELECT 1 FROM coverage o
      WHERE o.bu_code = c.bu_code AND o.province_code = c.province_code
        AND o.district_code = c.district_code AND o.month = c.month
        AND (o.amount, o.sale_id) > (c.amount, c.sale_id)
    )` : ""}
    ${mode === "gap" ? `AND NOT EXISTS (
      SELECT 1 FROM public.odg_sales_assignment o
      WHERE o.bu_code = c.bu_code AND o.month = c.month
        AND (o.province_code = 'ALL' OR c.province_code = 'ALL'
             OR o.province_code = c.province_code)
        AND (o.district_code = 'ALL' OR c.district_code = 'ALL'
             OR o.district_code = c.district_code)
    )` : ""}`;

/** What --apply would write, and what the detail listing shows. */
const FRESH = fresh(MODE);

const client = await pool.connect();
const q = (sql, params = []) => client.query(sql, params).then((r) => r.rows);

try {
  let buCodes = BU_ARG;
  if (!buCodes.length && !ALL_BU) {
    const planned = await q(
      `SELECT DISTINCT bu_code FROM public.odg_sales_target
       WHERE target_year = $1::int AND COALESCE(bu_code, '') <> '' ORDER BY 1`,
      [YEAR],
    );
    buCodes = planned.map((r) => r.bu_code);
  }
  /** What FRESH takes, in its own numbering. */
  const args = [MIN_AMOUNT, buCodes];
  console.log(
    `year ${YEAR} · mode ${MODE} · floor ${money(MIN_AMOUNT)} baht per area-month · ` +
      `BU ${buCodes.length ? buCodes.join(",") : "all"} · ` +
      (APPLY ? "APPLY" : "dry run"),
  );

  console.log("\nreading the year's sales…");
  const started = process.hrtime.bigint();
  // Materialized once: this reads the 2.7 GB detail table, and every report
  // below would otherwise pay for it again.
  await client.query(`CREATE TEMP TABLE month_sales AS ${SALES_BY_SELLER_AREA_MONTH}`, [YEAR]);
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;

  const [sold] = await q(
    `SELECT MAX(month)::int AS last_month, COUNT(*)::int AS area_months,
            COUNT(DISTINCT sale_id)::int AS sellers, SUM(amount)::float AS baht
     FROM month_sales`,
  );
  const [source] = await q(
    `SELECT SUM(sum_amount)::float AS baht, MAX(doc_date)::text AS through
     FROM public.odg_sale_detail WHERE yeardoc = $1::int`,
    [YEAR],
  );
  const template = THROUGH ?? sold.last_month;
  console.log(
    `${sold.area_months} area-months · ${sold.sellers} sellers · ` +
      `${money(sold.baht)} of ${money(source.baht)} baht ` +
      `(${((100 * sold.baht) / source.baht).toFixed(1)}% of the year) · ${seconds.toFixed(0)}s`,
  );
  console.log(`sales data runs through ${source.through}`);

  /**
   * Which BUs each person's ERP department lets them sell for. A bill can carry
   * anyone's code — a warehouse or purchasing clerk closes a sale now and then —
   * and the derivation would otherwise hand them a BU's plan on the strength of
   * it. Managers are exempt: BOARD_MANAGERS is a decision, not an inference.
   */
  await client.query(`CREATE TEMP TABLE seller_bu AS ${SELLER_DEPARTMENT_BU_SQL}`);
  await client.query(`CREATE INDEX ON seller_bu (sale_id, bu_code)`);
  const [deptStat] = await q(
    `SELECT COUNT(DISTINCT sale_id)::int AS people, COUNT(*)::int AS pairs FROM seller_bu`,
  );
  console.log(
    `\nERP departments map ${deptStat.people} people onto ${deptStat.pairs} person-BU pairs`,
  );

  /** Counter staff of one branch, who are not area sellers — see the shared SQL. */
  await client.query(`CREATE TEMP TABLE shop_seller AS
    SELECT sale_id, total, shop, (100.0 * shop / NULLIF(total, 0)) AS pct
    FROM (${SHOP_SHARE_BY_SELLER}) s`, [YEAR, SHOP_BRANCH || " "]);
  const excluded = SHOP_BRANCH
    ? await q(
        `SELECT s.sale_id,
                COALESCE(NULLIF(btrim(e.fullname_lo), ''), s.sale_id) AS name,
                s.total::float, s.pct::float
         FROM shop_seller s
         LEFT JOIN public.odg_employee e ON btrim(e.employee_code) = s.sale_id
         WHERE s.pct >= $1::numeric ORDER BY s.total DESC`,
        [SHOP_PCT],
      )
    : [];
  if (excluded.length) {
    console.log(
      `\ncounter staff of branch ${SHOP_BRANCH} kept off the board ` +
        `(>= ${SHOP_PCT}% of their year over that counter):`,
    );
    for (const r of excluded) {
      console.log(
        `  ${r.sale_id} ${String(r.name).padEnd(26)} ${String(Math.round(r.pct)).padStart(3)}%` +
          ` · ${money(r.total).padStart(13)} baht`,
      );
    }
  }

  /**
   * The months that have sales, plus — for every later month — a copy of the
   * template month's coverage. `carried` marks which is which, so the report can
   * separate what happened from what is being projected.
   */
  console.log("\nsales the department rule refuses to assign:");
  for (const row of await q(
    `SELECT s.sale_id,
            COALESCE(NULLIF(btrim(e.fullname_lo), ''), s.sale_id) AS name,
            s.bu_code,
            COALESCE(NULLIF(btrim(u.department), ''), '(none)') AS erp_dept,
            SUM(s.amount)::float AS baht
     FROM month_sales s
     LEFT JOIN public.odg_employee e ON btrim(e.employee_code) = s.sale_id
     LEFT JOIN public.erp_user u ON btrim(u.code) = s.sale_id
     WHERE NOT EXISTS (
       SELECT 1 FROM seller_bu sb
       WHERE sb.sale_id = s.sale_id AND sb.bu_code = s.bu_code
     )
     GROUP BY s.sale_id, name, s.bu_code, erp_dept
     ORDER BY 5 DESC LIMIT 14`,
  )) {
    console.log(
      `  ${row.sale_id} ${String(row.name).padEnd(24)} BU ${String(row.bu_code).padEnd(3)}` +
        ` dept ${String(row.erp_dept).padEnd(11)} ${money(row.baht).padStart(13)} baht`,
    );
  }

  await client.query(
    `CREATE TEMP TABLE coverage AS
     WITH kept AS (
       SELECT s.* FROM month_sales s
       WHERE NOT EXISTS (
         SELECT 1 FROM shop_seller x
         WHERE x.sale_id = s.sale_id AND x.pct >= $2::numeric
       )
       -- The department has to agree that this person sells this BU.
       AND EXISTS (
         SELECT 1 FROM seller_bu sb
         WHERE sb.sale_id = s.sale_id AND sb.bu_code = s.bu_code
       )
     )
     SELECT sale_id, sale_name, bu_code, province_code, district_code, month,
            amount, false AS carried
     FROM kept
     WHERE month <= $1::int
     ${CARRY ? `
     UNION ALL
     SELECT s.sale_id, s.sale_name, s.bu_code, s.province_code, s.district_code,
            m.month, s.amount, true
     FROM kept s
     CROSS JOIN generate_series($1::int + 1, 12) AS m(month)
     WHERE s.month = $1::int` : ""}`,
    [template, SHOP_BRANCH ? SHOP_PCT : 1e9],
  );
  await client.query(
    `CREATE INDEX ON coverage (sale_id, bu_code, province_code, district_code, month)`,
  );
  const [cov] = await q(
    `SELECT COUNT(*)::int AS rows,
            COUNT(*) FILTER (WHERE carried)::int AS carried,
            COUNT(DISTINCT sale_id)::int AS sellers
     FROM coverage`,
  );
  console.log(
    CARRY
      ? `carrying month ${template} forward to December: ` +
          `${cov.rows} area-months (${cov.carried} projected) · ${cov.sellers} sellers`
      : `no carry-forward: ${cov.rows} area-months · ${cov.sellers} sellers`,
  );

  console.log("\nby BU:");
  for (const row of await q(
    `SELECT c.bu_code, COUNT(*)::int AS area_months,
            COUNT(DISTINCT c.sale_id)::int AS sellers,
            SUM(c.amount) FILTER (WHERE NOT c.carried)::float AS baht,
            EXISTS (SELECT 1 FROM public.odg_sales_target st
                     WHERE st.target_year = $1::int AND st.bu_code = c.bu_code) AS has_plan
     FROM coverage c GROUP BY 1 ORDER BY 4 DESC NULLS LAST`,
    [YEAR],
  )) {
    console.log(
      `  BU ${String(row.bu_code).padEnd(3)} ${String(row.area_months).padStart(5)} area-months` +
        ` · ${String(row.sellers).padStart(3)} sellers · ${money(row.baht).padStart(15)} baht` +
        (row.has_plan ? "" : "  ⚠ no target plan"),
    );
  }

  const [existing] = await q(
    `SELECT COUNT(*)::int AS rows, COUNT(DISTINCT sale_id)::int AS sellers
     FROM public.odg_sales_assignment`,
  );
  const [plannedTotal] = await q(
    `SELECT SUM(target_amount)::float AS amount FROM public.odg_sales_target
     WHERE target_year = $1::int`,
    [YEAR],
  );
  const [soldTotal] = await q(
    `SELECT SUM(sum_amount)::float AS amount FROM ${MONTHLY_TABLE} WHERE yeardoc = $1::int`,
    [YEAR],
  );

  /** Both money columns as the grid computes them, for a given set of rows. */
  const gridTotals = (rowsSql, params) =>
    q(`${rowsSql} ${gridTotalsSql("$" + params.length)}`, params).then(([row]) => row);

  const today = await gridTotals(
    `WITH combined AS (
       SELECT id AS rowid, sale_id, bu_code, province_code, district_code, month, channel_codes
       FROM public.odg_sales_assignment
     )`,
    [YEAR],
  );
  console.log(
    `\nassignment table today: ${existing.rows} rows · ${existing.sellers} sellers · ` +
      `ເປົ້າ ${money(today.target)} · ຍອດຂາຍ ${money(today.actual)}`,
  );
  console.log(
    `for reference — the plan is ${money(plannedTotal.amount)}` +
      ` and the year's real baht is ${money(soldTotal.amount)}`,
  );

  console.log("\nwhat each mode would do (both columns as the grid computes them today):");
  for (const name of MODES) {
    const row = await gridTotals(
      `WITH fresh AS (${fresh(name)}),
       combined AS (
         SELECT id AS rowid, sale_id, bu_code, province_code, district_code, month, channel_codes
         FROM public.odg_sales_assignment
         UNION ALL
         -- Negative ids so a candidate row never collides with a stored one.
         SELECT -row_number() OVER ()::int, sale_id, bu_code, province_code, district_code,
                month, NULL::text[]
         FROM fresh
       )`,
      [...args, YEAR],
    );
    const [counted] = await q(
      `WITH fresh AS (${fresh(name)})
       SELECT COUNT(*)::int AS added, COUNT(DISTINCT sale_id)::int AS sellers FROM fresh`,
      args,
    );
    console.log(
      `  ${(name === MODE ? "→ " : "  ") + name.padEnd(10)}` +
        ` +${String(counted.added).padStart(5)} rows · ${String(counted.sellers).padStart(2)} sellers` +
        ` · ເປົ້າ ${money(row.target).padStart(15)} (${(row.target / plannedTotal.amount).toFixed(2)}×)` +
        ` · ຍອດຂາຍ ${money(row.actual).padStart(15)} (${(row.actual / soldTotal.amount).toFixed(2)}×)`,
    );
  }

  console.log(`\nlargest areas ${MODE} would add:`);
  for (const r of await q(
    `WITH fresh AS (${FRESH})
     SELECT sale_id, sale_name, bu_code, province_code, district_code,
            SUM(amount)::float AS amount, COUNT(*)::int AS months,
            COUNT(*) FILTER (WHERE carried)::int AS carried
     FROM fresh GROUP BY 1,2,3,4,5 ORDER BY 6 DESC LIMIT 15`,
    args,
  )) {
    console.log(
      `  ${r.sale_id} ${String(r.sale_name).padEnd(26)} BU ${String(r.bu_code).padEnd(3)}` +
        ` prov ${String(r.province_code).padEnd(3)} dist ${String(r.district_code).padEnd(5)}` +
        ` ${String(r.months).padStart(2)}m (${r.carried} projected) ${money(r.amount).padStart(13)}`,
    );
  }

  /**
   * Plan rows no assignment claims.
   *
   * ເປົ້າ is a plain sum of odg_sales_target — a plan row goes whole to its single
   * best claimant, never divided and never scaled — so a plan row with no
   * claimant at all is simply missing from the board, and the board is supposed
   * to add up to the plan. Each one gets a row for its own exact area, held by
   * that BU's biggest seller of the year.
   *
   * These are areas the plan plans for and nobody sold in, so the row is real
   * information rather than a patch: it says who is now answerable for it.
   */
  const PLAN_GAP = `
    SELECT top.sale_id, top.sale_name, g.bu_code, g.province_code, g.district_code,
           g.target_month AS month, 0::float AS amount, true AS carried
    FROM (
      SELECT st.bu_code, st.province_code, st.district_code, st.target_month
      FROM public.odg_sales_target st
      WHERE st.target_year = $3::int
        -- A manager does not count as cover: they own no plan row, their board
        -- figure is a roll-up of what their sellers hold.
        AND NOT EXISTS (
          SELECT 1 FROM public.odg_sales_assignment b
          WHERE b.bu_code = st.bu_code AND b.month = st.target_month
            AND NOT ${isManagerSql("b")}
            AND (b.province_code = 'ALL' OR st.province_code = 'ALL'
                 OR st.province_code = b.province_code)
            AND (b.district_code = 'ALL' OR st.district_code = 'ALL'
                 OR st.district_code = b.district_code)
            AND ${claimableChannelSql("b", "st")}
        )
      GROUP BY 1, 2, 3, 4
    ) g
    JOIN LATERAL (
      SELECT c.sale_id, MIN(c.sale_name) AS sale_name
      FROM coverage c
      WHERE c.bu_code = g.bu_code AND NOT ${isManagerSql("c")}
      GROUP BY c.sale_id ORDER BY SUM(c.amount) DESC LIMIT 1
    ) top ON TRUE`;

  const gaps = await q(PLAN_GAP.replace("$3", "$1"), [YEAR]);
  if (gaps.length) {
    console.log(`\nplan rows nobody claims — handing each to that BU's top seller:`);
    for (const r of gaps.slice(0, 12)) {
      console.log(
        `  BU ${String(r.bu_code).padEnd(3)} prov ${String(r.province_code).padEnd(3)}` +
          ` dist ${String(r.district_code).padEnd(5)} m${String(r.month).padStart(2)}` +
          ` → ${r.sale_id} ${r.sale_name}`,
      );
    }
    if (gaps.length > 12) console.log(`  … ${gaps.length - 12} more`);
  }

  if (!APPLY) {
    console.log("\ndry run — nothing written. Pass --apply to insert.");
  } else {
    if (PRUNE) {
      if (excluded.length) {
        const removed = await q(
          `DELETE FROM public.odg_sales_assignment
           WHERE sale_id = ANY($1::text[]) RETURNING id`,
          [excluded.map((r) => r.sale_id)],
        );
        console.log(`\npruned ${removed.length} rows belonging to counter staff`);
      }
      // Rows whose BU the person's department does not cover. Manager rows are
      // left alone — they are assigned deliberately, not inferred from bills.
      const offDept = await q(
        `DELETE FROM public.odg_sales_assignment a
         WHERE NOT ${isManagerSql("a")}
           AND NOT EXISTS (
             SELECT 1 FROM seller_bu sb
             WHERE sb.sale_id = a.sale_id AND sb.bu_code = a.bu_code
           )
         RETURNING id`,
      );
      console.log(`pruned ${offDept.length} rows whose BU the department does not cover`);
    }
    const inserted = await q(
      `WITH fresh AS (${FRESH} UNION ALL ${PLAN_GAP})
       INSERT INTO public.odg_sales_assignment
         (sale_id, sale_name, bu_code, province_code, district_code, channel_codes, month)
       SELECT sale_id, sale_name, bu_code, province_code, district_code, NULL, month FROM fresh
       ON CONFLICT (sale_id, bu_code, province_code, district_code, month) DO NOTHING
       RETURNING id`,
      [...args, YEAR],
    );
    console.log(`\ninserted ${inserted.length} rows (mode ${MODE})`);

    /**
     * The manager rows, from lib/sales-board-roles.
     *
     * One row per BU × month, over the whole BU ('ALL'/'ALL') and naming the
     * channel they answer for, because that is what the board rolls up onto
     * them. Their other rows in the same BU are removed: a manager owns no plan
     * row, so a district row of theirs would just sit there reading ເປົ້າ 0 while
     * quietly keeping that district out of a seller's hands.
     */
    for (const { saleId, buCode, channels } of BOARD_MANAGERS) {
      const [emp] = await q(
        `SELECT COALESCE(NULLIF(btrim(fullname_lo), ''), $1::text) AS name
         FROM public.odg_employee WHERE btrim(employee_code) = $1::text`,
        [saleId],
      );
      const buFilter = buCode === "*" ? "" : "AND st.bu_code = $5::text";
      const added = await q(
        `INSERT INTO public.odg_sales_assignment
           (sale_id, sale_name, bu_code, province_code, district_code, channel_codes, month)
         SELECT $1::text, $2::text, st.bu_code, 'ALL', 'ALL', $3::text[], st.target_month
         FROM public.odg_sales_target st
         WHERE st.target_year = $4::int AND st.sale_channel = ANY($3::text[]) ${buFilter}
         GROUP BY st.bu_code, st.target_month
         ON CONFLICT (sale_id, bu_code, province_code, district_code, month) DO NOTHING
         RETURNING id`,
        buCode === "*"
          ? [saleId, emp?.name || saleId, channels, YEAR]
          : [saleId, emp?.name || saleId, channels, YEAR, buCode],
      );
      const dropped = await q(
        `DELETE FROM public.odg_sales_assignment
         WHERE sale_id = $1::text
           AND ($2::text = '*' OR bu_code = $2::text)
           AND NOT (province_code = 'ALL' AND district_code = 'ALL')
         RETURNING id`,
        [saleId, buCode],
      );
      const fixed = await q(
        `UPDATE public.odg_sales_assignment
         SET channel_codes = $3::text[]
         WHERE sale_id = $1::text
           AND ($2::text = '*' OR bu_code = $2::text)
           AND COALESCE(channel_codes, '{}') <> $3::text[]
         RETURNING id`,
        [saleId, buCode, channels],
      );
      console.log(
        `  ${saleId} BU ${buCode.padEnd(3)} ch ${channels.join("+")}: ` +
          `+${added.length} rows, -${dropped.length} area rows, ${fixed.length} channels set`,
      );
    }

    const [now] = await q(
      `SELECT COUNT(*)::int AS rows, COUNT(DISTINCT sale_id)::int AS sellers
       FROM public.odg_sales_assignment`,
    );
    console.log(`odg_sales_assignment now: ${now.rows} rows · ${now.sellers} sellers`);
  }
} finally {
  client.release();
  await pool.end();
}
