/**
 * Runs the Sales Assignment grid's own SQL and checks the two headline numbers
 * against what they are supposed to reconcile to:
 *
 *   ເປົ້າ    ≤ odg_sales_target for the year — each plan row is divided between
 *            the assignments that claim it, never handed to each of them whole.
 *   ຍອດຂາຍ  ≤ the year's sales that carry an employee's code, since a row shows
 *            that person's own baht rather than their district's.
 *
 * Read-only. Run: node scripts/verify-assignment-grid.mjs [year]
 */
import { loadEnv } from "./_env.mjs";
import pg from "pg";
import { SELLER_TABLE } from "../lib/sale-monthly-sql.mjs";
import { claimableChannelSql, isManagerSql, managesChannelSql, planChannelSql } from "../lib/sales-board-roles.mjs";

loadEnv();

const YEAR = Number(process.argv[2] || new Date().getFullYear());
const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: 1,
  statement_timeout: 300000,
});
const q = (sql, params = []) => pool.query(sql, params).then((r) => r.rows);
const money = (n) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

const [grid] = await q(
  `WITH act AS (
     SELECT b.id AS assignment_id, COALESCE(SUM(sm.sum_amount), 0) AS amount
     FROM public.odg_sales_assignment b
     LEFT JOIN ${SELLER_TABLE} sm
       ON sm.yeardoc = $1::int AND sm.sale_id = b.sale_id AND sm.monthdoc = b.month
      AND sm.bu_code = b.bu_code
      AND (b.province_code = 'ALL' OR sm.province = b.province_code)
      AND (b.district_code = 'ALL' OR sm.amper = b.district_code)
      AND (b.channel_codes IS NULL OR array_length(b.channel_codes, 1) IS NULL
           OR sm.channel_code = ANY(b.channel_codes))
     GROUP BY b.id
   ),
   claim AS (
     SELECT b.id AS assignment_id, st.id AS target_id, st.target_amount,
            (CASE WHEN b.province_code <> 'ALL' THEN 2 ELSE 0 END
             + CASE WHEN b.district_code <> 'ALL' THEN 1 ELSE 0 END) AS specificity
     FROM public.odg_sales_assignment b
     JOIN public.odg_sales_target st
       ON st.target_year = $1::int AND st.target_month = b.month AND st.bu_code = b.bu_code
      AND (b.province_code = 'ALL' OR st.province_code = 'ALL' OR st.province_code = b.province_code)
      AND (b.district_code = 'ALL' OR st.district_code = 'ALL' OR st.district_code = b.district_code)
      AND ${claimableChannelSql("b", "st")}
     -- A manager owns nothing in the channel they run; their board figure there
     -- is a roll-up of these rows. Channels they merely sell they claim.
      AND NOT ${managesChannelSql("b", "st")}
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
          COUNT(DISTINCT a.sale_id)::int AS sellers,
          COALESCE(SUM(tgt.amount), 0)::float AS target,
          COALESCE(SUM(act.amount), 0)::float AS actual
   FROM public.odg_sales_assignment a
   LEFT JOIN target_share tgt ON tgt.assignment_id = a.id
   LEFT JOIN act ON act.assignment_id = a.id`,
  [YEAR],
);

const [ceiling] = await q(
  `SELECT (SELECT SUM(target_amount)::float FROM public.odg_sales_target
            WHERE target_year = $1::int) AS plan,
          (SELECT SUM(sm.sum_amount)::float FROM ${SELLER_TABLE} sm
            JOIN public.odg_employee e ON btrim(e.employee_code) = sm.sale_id
            WHERE sm.yeardoc = $1::int) AS employee_sales,
          (SELECT SUM(sum_amount)::float FROM public.odg_sale_detail
            WHERE yeardoc = $1::int) AS all_sales`,
  [YEAR],
);

console.log(`year ${YEAR}: ${grid.rows} assignment rows · ${grid.sellers} sellers\n`);
const line = (label, value, limit, limitLabel, exact = false) => {
  const pct = (100 * value) / limit;
  // The plan has to be matched to the kip, not merely not-exceeded: the board is
  // supposed to add up to it. A baht of rounding across 3,000 divisions is fine.
  const ok = exact ? Math.abs(value - limit) < 1 : value <= limit * 1.0001;
  console.log(
    `  ${ok ? "OK " : "!! "} ${label.padEnd(8)} ${money(value).padStart(15)}` +
      ` · ${pct.toFixed(1)}% of ${limitLabel} (${money(limit)})`,
  );
};
line("ເປົ້າ", grid.target, ceiling.plan, "the plan", true);
line("ຍອດຂາຍ", grid.actual, ceiling.employee_sales, "sales with an employee code");
console.log(
  `\n  for context, all ${YEAR} sales incl. bills with no seller: ${money(ceiling.all_sales)}`,
);

// Any of these is a real shortfall now: ເປົ້າ is a plain sum, so a plan row with
// no NON-MANAGER claimant is simply missing from the board's total. Managers do
// not count — their figure is a roll-up of these same rows.
console.log("\nplan rows no seller claims (each one is missing from the total above):");
const unclaimed = await q(
  `SELECT st.bu_code, st.sale_channel, SUM(st.target_amount)::float AS amount
   FROM public.odg_sales_target st
   WHERE st.target_year = $1::int
     AND NOT EXISTS (
       SELECT 1 FROM public.odg_sales_assignment b
       WHERE b.month = st.target_month AND b.bu_code = st.bu_code
         AND NOT ${managesChannelSql("b", "st")}
         AND (b.province_code = 'ALL' OR st.province_code = 'ALL' OR st.province_code = b.province_code)
         AND (b.district_code = 'ALL' OR st.district_code = 'ALL' OR st.district_code = b.district_code)
         AND ${claimableChannelSql("b", "st")}
     )
   GROUP BY 1, 2 ORDER BY 3 DESC`,
  [YEAR],
);
if (!unclaimed.length) console.log("  none");
for (const row of unclaimed) {
  console.log(
    `  BU ${String(row.bu_code).padEnd(3)} channel ${String(row.sale_channel).padEnd(4)}` +
      ` ${money(row.amount).padStart(15)}`,
  );
}

console.log("\nmanager roll-ups (shown on the board, counted in no total):");
for (const row of await q(
  `WITH mgr AS (
     SELECT DISTINCT ON (b.sale_id, b.bu_code, b.month)
            b.id, b.sale_id, b.sale_name, b.bu_code, b.month
     FROM public.odg_sales_assignment b
     WHERE ${isManagerSql("b")}
     ORDER BY b.sale_id, b.bu_code, b.month, b.id
   )
   SELECT m.sale_id, MIN(m.sale_name) AS name,
          string_agg(DISTINCT m.bu_code, '+') AS bus,
          string_agg(DISTINCT ${planChannelSql("st")}, '+') AS channels,
          SUM(st.target_amount)::float AS rollup
   FROM mgr m
   JOIN public.odg_sales_target st
     ON st.target_year = $1::int AND st.target_month = m.month AND st.bu_code = m.bu_code
    AND ${managesChannelSql("m", "st")}
   GROUP BY m.sale_id ORDER BY 5 DESC`,
  [YEAR],
)) {
  console.log(
    `  ${row.sale_id} ${String(row.name).padEnd(24)} BU ${String(row.bus).padEnd(12)}` +
      ` ch ${String(row.channels).padEnd(5)} ${money(row.rollup).padStart(15)}`,
  );
}

console.log("\nrows per month (carried months should match the template):");
for (const row of await q(
  `SELECT month, COUNT(*)::int AS rows, COUNT(DISTINCT sale_id)::int AS sellers
   FROM public.odg_sales_assignment GROUP BY 1 ORDER BY 1`,
)) {
  console.log(
    `  m${String(row.month).padStart(2)} ${String(row.rows).padStart(4)} rows · ${row.sellers} sellers`,
  );
}

await pool.end();
