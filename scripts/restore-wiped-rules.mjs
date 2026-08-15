/**
 * Undo the closing half of a "clear from this month onward".
 *
 * That clear does two different things, and only one of them is reversible:
 *
 *   rules starting in the cleared month or later   DELETED outright
 *   rules that already ran INTO it                 closed at the end of the
 *                                                  previous month
 *
 * The second is a date change and nothing more, so it can be put back — and
 * this puts it back, for the rules a given clear touched. They are identified
 * by the two marks the clear leaves together: an `effective_to` of exactly the
 * day before the cleared month, and an `updated_at` inside the minute the
 * clear ran. Nothing else in the table carries both.
 *
 * The deleted rules are NOT recoverable here. There is no history table for
 * this table; rebuilding them means re-running the grid scripts or entering
 * them again.
 *
 * The whole table is copied to a backup first, so running this is itself
 * reversible.
 *
 * Read-only unless --apply is passed. Usage:
 *   node scripts/restore-wiped-rules.mjs 2026-07-01 "2026-08-15 00:20" "2026-08-15 01:10" [--reopen-to 2099-12-31] [--apply]
 */
import { loadEnv } from "./_env.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const positional = args.filter((value) => !value.startsWith("--"));
const [clearedFrom, since, until] = positional;
const reopenAt = args.indexOf("--reopen-to");
const reopenTo = reopenAt >= 0 ? args[reopenAt + 1] : "2099-12-31";

if (!clearedFrom || !since || !until) {
  console.error('Usage: node scripts/restore-wiped-rules.mjs <cleared-month-first-day> <touched-since> <touched-until> [--reopen-to YYYY-MM-DD] [--apply]');
  process.exit(1);
}

loadEnv();
const { rows: q, query, pool } = await import("../lib/db.js");

const BACKUP = `app_incentive_point_rule_bak_${clearedFrom.replaceAll("-", "")}`;

/** The day the clear stamped on everything it closed. */
const closedAt = (await q(`SELECT (%s::date - 1)::text AS day`, [clearedFrom]))[0].day;

const affected = await q(
  `SELECT category_code, COUNT(*) AS rules,
          MIN(effective_from)::text AS earliest, MAX(effective_from)::text AS latest
   FROM public.app_incentive_point_rule
   WHERE effective_to = %s::date AND updated_at BETWEEN %s::timestamptz AND %s::timestamptz
   GROUP BY 1 ORDER BY 1`,
  [closedAt, since, until],
);

const total = affected.reduce((sum, row) => sum + Number(row.rules), 0);
console.log(`Rules closed at ${closedAt} between ${since} and ${until}:`);
console.table(affected);
console.log(`→ ${total} rules would be re-opened to ${reopenTo}`);

if (!apply) {
  console.log("\nDry run. Nothing written. Add --apply to restore.");
  await pool.end();
  process.exit(0);
}

if (total === 0) {
  console.log("Nothing to restore.");
  await pool.end();
  process.exit(0);
}

// The backup is the whole table, not only the rows about to change: it is the
// only way back if the end date restored here turns out to be the wrong one.
await query(`CREATE TABLE IF NOT EXISTS public.${BACKUP} AS TABLE public.app_incentive_point_rule WITH NO DATA`);
await query(`TRUNCATE public.${BACKUP}`);
const saved = await query(`INSERT INTO public.${BACKUP} SELECT * FROM public.app_incentive_point_rule`);
console.log(`\nBacked up ${saved.rowCount} rules to public.${BACKUP}`);

const restored = await query(
  `UPDATE public.app_incentive_point_rule
      SET effective_to = %s::date, updated_at = now()
    WHERE effective_to = %s::date AND updated_at BETWEEN %s::timestamptz AND %s::timestamptz`,
  [reopenTo, closedAt, since, until],
);
console.log(`Re-opened ${restored.rowCount} rules to ${reopenTo}`);

console.table(await q(
  `SELECT category_code, COUNT(*) AS in_force
   FROM public.app_incentive_point_rule
   WHERE (%s::date + 14) BETWEEN effective_from AND effective_to
   GROUP BY 1 ORDER BY 1`,
  [clearedFrom],
));
await pool.end();
