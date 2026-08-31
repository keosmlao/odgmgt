/**
 * ອັບເດດ odg_sale_detail ຈາກ ERP — ຮອບລະຊົ່ວໂມງ.
 *
 * odg_sale_detail is a copy of the ERP view public.sale_detail_2022. An
 * ERP-side job reloads it seven times on a working day — 07:30, 12:00, 14:00,
 * 16:30, 17:00, 18:00, 19:30 — and the morning gap between the first two is
 * four and a half hours wide: on 31/08/2026 at 10:00 the ERP had 49 bills for
 * the day and every report on this system showed none.
 *
 * This runs the same reload on the hour, so the gap is never wider than one.
 * It is the ERP job's own statement, with the DELETE that has to go in front
 * of it written out: the window is emptied and refilled inside ONE
 * transaction, so no report can read a month with a hole in it, and running it
 * twice changes nothing.
 *
 * Same 31-day window as the ERP job, which is what catches a bill entered late
 * against an earlier day or one cancelled after it was copied — a window that
 * only covered today would leave both behind.
 *
 * Every run is logged to odg_trigger_update_data, the same table the ERP job
 * logs to, so "when was this last current" has one answer and not two.
 *
 * Run:   node --env-file=.env.local scripts/refresh-sale-detail.mjs
 * Cron:  20 * * * * — twenty past, clear of the ERP job's own :00 and :30.
 */
import pg from "pg";
import { ensureFreshRollup } from "../lib/sale-rollup.js";

const TARGET = "public.odg_sale_detail";
const SOURCE = "public.sale_detail_2022";
const WINDOW_DAYS = Number(process.env.SALE_DETAIL_WINDOW_DAYS || 31);

/** The copy's own sequence — the ERP view has nothing to put in it. */
const SKIP = new Set(["roworder"]);

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 10_000,
});

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const say = (message) => console.log(`[${stamp()}] ${message}`);

const columnsOf = async (client, relation) =>
  (
    await client.query(
      `SELECT a.attname AS name
       FROM pg_attribute a
       WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [relation],
    )
  ).rows.map((row) => row.name);

const started = Date.now();
const client = await pool.connect();
let failed = false;

try {
  // Read the column list from the catalog rather than writing it out: the ERP
  // adds columns without warning, and a hardcoded list would quietly stop
  // copying whatever was added last.
  const target = await columnsOf(client, TARGET);
  const source = new Set(await columnsOf(client, SOURCE));
  const shared = target.filter((name) => !SKIP.has(name) && source.has(name));
  const missing = target.filter((name) => !SKIP.has(name) && !source.has(name));
  if (missing.length) say(`ບໍ່ມີໃນ ${SOURCE}, ຂ້າມ: ${missing.join(", ")}`);

  const list = shared.map((name) => `"${name.replace(/"/g, '""')}"`).join(", ");
  const where = `doc_date BETWEEN current_date - ${WINDOW_DAYS} AND current_date`;

  await client.query("BEGIN");
  // One writer at a time, however the job is triggered.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('odg_sale_detail_refresh'))");

  const removed = await client.query(`DELETE FROM ${TARGET} WHERE ${where}`);
  const added = await client.query(
    `INSERT INTO ${TARGET} (${list}) SELECT ${list} FROM ${SOURCE} WHERE ${where}`,
  );
  await client.query(
    `INSERT INTO public.odg_trigger_update_data(report_name, update_time)
     VALUES ('odg_sale_detail', localtimestamp(0))`,
  );
  await client.query("COMMIT");

  say(
    `${WINDOW_DAYS} ວັນ · ລຶບ ${removed.rowCount} ແຖວ · ໃສ່ຄືນ ${added.rowCount} ແຖວ · ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s`,
  );

  const check = await client.query(
    `SELECT to_char(MAX(doc_date), 'YYYY-MM-DD') AS latest,
            COUNT(*) FILTER (WHERE doc_date = current_date) AS today
     FROM ${TARGET}`,
  );
  say(`ຂໍ້ມູນຮອດ ${check.rows[0].latest} · ບິນມື້ນີ້ ${check.rows[0].today} ແຖວ`);

  /**
   * ຕາຕະລາງສະຫຼຸບ (odg_sale_monthly ແລະ ພີ່ນ້ອງຂອງມັນ) ອ່ານມາຈາກຕາຕະລາງນີ້.
   *
   * They rebuild themselves when the source moves, but on the first page load
   * after a reload — fifteen seconds a reader would otherwise sit through,
   * every hour, for work that has just been done here anyway.
   */
  if (!/^(1|true)$/i.test(String(process.env.SALE_DETAIL_SKIP_ROLLUP || ""))) {
    const rollupStarted = Date.now();
    const thisYear = new Date().getFullYear();
    const result = await ensureFreshRollup([thisYear, thisYear - 1]);
    say(
      result.refreshed
        ? `ສະຫຼຸບເດືອນ ສ້າງໃໝ່ · ${((Date.now() - rollupStarted) / 1000).toFixed(1)}s`
        : "ສະຫຼຸບເດືອນ ຍັງທັນສະໄໝ ບໍ່ຕ້ອງສ້າງໃໝ່",
    );
  }
} catch (error) {
  failed = true;
  await client.query("ROLLBACK").catch(() => {});
  console.error(`[${stamp()}] ລົ້ມເຫຼວ: ${error.message}`);
} finally {
  client.release();
  await pool.end();
}

process.exit(failed ? 1 : 0);
