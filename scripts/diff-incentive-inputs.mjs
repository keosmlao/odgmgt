/**
 * Why the retail-incentive report and the sales application's bonus report
 * disagree for a month.
 *
 * The two reports share their scoring rules, so when a person's whole row
 * differs the cause is almost always an INPUT, not a rule. This checks the
 * inputs in the order that explains the most:
 *
 *   1. a frozen payout — the management report then serves what was paid and
 *      never recalculates, so every column can differ at once
 *   2. the target roster
 *   3. sales attribution: which employee a salename resolves to, whose
 *      precedence (alias vs roster name) used to differ between the two apps
 *   4. salenames that resolve to nobody, whose sales are dropped
 *
 * Read-only. Usage:
 *   node scripts/diff-incentive-inputs.mjs 2026 7
 */
import { loadEnv } from "./_env.mjs";

const [, , yearArg, monthArg] = process.argv;
const year = Number(yearArg);
const month = Number(monthArg);
if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
  console.error("Usage: node scripts/diff-incentive-inputs.mjs <year> <month>");
  process.exit(1);
}

const RETAIL_BRANCH = process.env.ODG_RETAIL_BRANCH || "01";
const RETAIL_AR_GROUP = "101";

// Read .env.local before lib/db.js builds its pool from those variables, so the
// script talks to exactly the database the app talks to.
loadEnv();
const { rows: q, pool } = await import("../lib/db.js");

/** Both apps bucket a bill on its approved report month, not its doc_date. */
const MONTH_FILTER = `
  COALESCE(mo.report_date, d.doc_date::date) >= make_date($1, $2, 1)
  AND COALESCE(mo.report_date, d.doc_date::date) < make_date($1, $2, 1) + INTERVAL '1 month'`;
const num = (value) => Number(value ?? 0) || 0;
const money = (value) => num(value).toLocaleString("en-US", { maximumFractionDigits: 2 });

try {
  console.log(`\n=== ${year}-${String(month).padStart(2, "0")} · branch ${RETAIL_BRANCH} / argroup ${RETAIL_AR_GROUP} ===`);

  // 1 ── A frozen payout alone explains "every column differs".
  const payout = await q(
    `SELECT id, status, people, point_reward, unit_reward, commission, total_amount, paid_by, paid_at
     FROM public.odg_incentive_payout
     WHERE target_year = $1 AND target_month = $2 AND branch_code = $3`,
    [year, month, RETAIL_BRANCH],
  ).catch(() => []);

  console.log("\n-- 1. frozen payout --");
  if (payout.length === 0) {
    console.log("   none — the management report recalculates this month live.");
  } else {
    const head = payout[0];
    console.log(`   FROZEN: status=${head.status} people=${head.people} total=${money(head.total_amount)}`);
    console.log(`   paid_by=${head.paid_by || "-"} paid_at=${head.paid_at || "-"}`);
    console.log("   >> The management report serves THESE stored figures and never recalculates,");
    console.log("      so every column can differ from the live sales-app report. This is the cause.");
  }

  // 2 ── Target roster. Identical SQL in both apps; printed so it can be ruled out.
  const roster = await q(
    `SELECT DISTINCT ON (t.emp_code)
            t.emp_code,
            COALESCE(NULLIF(e.fullname_lo, ''), e.fullname_en, t.emp_code) AS name,
            CASE WHEN t.product_group = 'AC' THEN 'AIR' ELSE 'CE_SDA' END AS group_code,
            t.target::float AS target
     FROM public.odg_retail_target_employee t
     JOIN public.odg_employee e ON e.employee_code = t.emp_code AND e.department_code = '205'
     WHERE t.year::text = $1 AND t.month::text = ANY($2)
     ORDER BY t.emp_code, t.roworder DESC`,
    [String(year), [String(month), String(month).padStart(2, "0")]],
  );
  console.log(`\n-- 2. target roster (${roster.length} people) --`);
  for (const row of roster) {
    const flag = num(row.target) > 0 ? "" : "   << target 0: the management report DROPS this person";
    console.log(`   ${row.emp_code}  ${String(row.name).padEnd(24)} ${row.group_code.padEnd(7)} ${money(row.target).padStart(14)}${flag}`);
  }

  // 3 ── Attribution. A salename that matches BOTH an alias and a roster name
  // is the case where the apps' old precedence rules disagreed.
  const ambiguous = await q(
    `SELECT DISTINCT btrim(d.salename) AS salename,
            a.employee_code AS by_alias,
            e.employee_code AS by_roster
     FROM public.odg_sale_detail d
     LEFT JOIN public.app_sale_month_override mo ON mo.doc_no = d.doc_no
     JOIN public.app_incentive_sale_alias a ON btrim(a.salename) = btrim(d.salename)
     JOIN public.odg_employee e ON btrim(e.fullname_lo) = btrim(d.salename)
     WHERE ${MONTH_FILTER}
       AND d.branch_code = $3 AND d.argroup_main = $4
       AND a.employee_code <> e.employee_code`,
    [year, month, RETAIL_BRANCH, RETAIL_AR_GROUP],
  );
  console.log("\n-- 3. salenames an alias and a roster name claim differently --");
  if (ambiguous.length === 0) console.log("   none — both precedence rules give the same answer.");
  for (const row of ambiguous) {
    console.log(`   "${row.salename}"  alias→${row.by_alias}  roster→${row.by_roster}   << both apps now use alias`);
  }

  // 4 ── Sales that belong to nobody: dropped by the sales app, and dropped by
  // the management report too once the target filter runs.
  const unresolved = await q(
    `SELECT btrim(d.salename) AS salename,
            COALESCE(SUM(d.qty), 0)::float AS qty,
            COALESCE(SUM(d.sum_amount), 0)::float AS amount
     FROM public.odg_sale_detail d
     LEFT JOIN public.app_sale_month_override mo ON mo.doc_no = d.doc_no
     LEFT JOIN public.app_incentive_sale_alias a ON btrim(a.salename) = btrim(d.salename)
     LEFT JOIN public.odg_employee e ON btrim(e.fullname_lo) = btrim(d.salename)
     WHERE ${MONTH_FILTER}
       AND d.branch_code = $3 AND d.argroup_main = $4
       AND d.item_code NOT LIKE '97%'
       AND COALESCE(a.employee_code, e.employee_code) IS NULL
     GROUP BY 1 ORDER BY 3 DESC`,
    [year, month, RETAIL_BRANCH, RETAIL_AR_GROUP],
  );
  console.log("\n-- 4. salenames resolving to nobody --");
  if (unresolved.length === 0) console.log("   none.");
  for (const row of unresolved) {
    console.log(`   "${row.salename}"  qty=${money(row.qty)}  amount=${money(row.amount)}   << add an app_incentive_sale_alias row`);
  }

  // 5 ── Per-seller sales on the shared basis. Both apps compute this the same
  // way now, so a mismatch here means the two are not reading the same month.
  const sales = await q(
    `SELECT COALESCE(a.employee_code, e.employee_code) AS employee_code,
            COALESCE(SUM(d.qty), 0)::float AS qty,
            COALESCE(SUM(d.sum_amount), 0)::float AS amount
     FROM public.odg_sale_detail d
     LEFT JOIN public.app_sale_month_override mo ON mo.doc_no = d.doc_no
     LEFT JOIN public.app_incentive_sale_alias a ON btrim(a.salename) = btrim(d.salename)
     LEFT JOIN public.odg_employee e ON btrim(e.fullname_lo) = btrim(d.salename)
     LEFT JOIN public.app_incentive_category c ON c.category_code = d.item_category
     WHERE ${MONTH_FILTER}
       AND d.branch_code = $3 AND d.argroup_main = $4
       AND d.item_code NOT LIKE '97%'
       AND COALESCE(c.is_active, true)
       AND COALESCE(a.employee_code, e.employee_code) IS NOT NULL
     GROUP BY 1`,
    [year, month, RETAIL_BRANCH, RETAIL_AR_GROUP],
  );
  const salesByCode = new Map(sales.map((row) => [String(row.employee_code), row]));
  console.log("\n-- 5. sales on the shared basis (what BOTH reports should show) --");
  console.log(`   ${"emp".padEnd(8)}${"name".padEnd(26)}${"qty".padStart(10)}${"sales".padStart(18)}${"target".padStart(16)}${"ach%".padStart(10)}`);
  for (const row of roster) {
    const hit = salesByCode.get(String(row.emp_code));
    const amount = num(hit?.amount);
    const target = num(row.target);
    const ach = target ? ((amount / target) * 100).toFixed(4) : "-";
    console.log(
      `   ${String(row.emp_code).padEnd(8)}${String(row.name).slice(0, 25).padEnd(26)}` +
      `${money(hit?.qty).padStart(10)}${money(amount).padStart(18)}${money(target).padStart(16)}${String(ach).padStart(10)}`,
    );
  }
  console.log("\nCompare these against the sales application's bonus report row by row.");
} finally {
  await pool.end();
}
