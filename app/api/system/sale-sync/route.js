import { NextResponse } from "next/server";
import { one } from "@/lib/db";

/**
 * ເວລາອັບເດດ odg_sale_detail — ຄັ້ງຫຼ້າສຸດ ແລະ ອີກດົນປານໃດຮອບຕໍ່ໄປ.
 *
 * The sale table is a copy of the ERP (scripts/refresh-sale-detail.mjs): an
 * ERP-side job reloads it seven times a day and our own cron reloads it at
 * twenty past every hour. Both log to odg_trigger_update_data, so the last run
 * is a row to read and not a guess.
 *
 * Everything is measured on the DATABASE clock and handed to the page as a
 * number of seconds, never as a timestamp to be compared against the browser's
 * own. A workstation whose date runs a day fast — this office has one — would
 * otherwise turn the countdown into a bug report.
 */

/** ນາທີທີ່ cron ຂອງພວກເຮົາແລ່ນ (crontab: 20 * * * *). */
const CRON_MINUTE = Math.min(59, Math.max(0, Number(process.env.SALE_SYNC_CRON_MINUTE || 20)));

/** ~33 s for the hourly 3-day window — how long the page waits before re-asking. */
const RUN_SECONDS = Number(process.env.SALE_SYNC_RUN_SECONDS || 45);

export async function GET() {
  try {
    const row = await one(
      `SELECT to_char((SELECT MAX(update_time) FROM public.odg_trigger_update_data
                        WHERE report_name = 'odg_sale_detail'), 'YYYY-MM-DD HH24:MI') AS last_update,
              to_char(localtimestamp, 'HH24:MI:SS') AS server_clock,
              to_char(localtimestamp, 'YYYY-MM-DD') AS server_date,
              EXTRACT(MINUTE FROM localtimestamp)::int AS minute,
              EXTRACT(SECOND FROM localtimestamp)::int AS second,
              (SELECT to_char(MAX(doc_date), 'YYYY-MM-DD') FROM public.odg_sale_detail) AS data_through`,
    );

    const minute = Number(row?.minute ?? 0);
    const second = Number(row?.second ?? 0);
    // Whole minutes to the next run of the hour, then the seconds already gone
    // out of the current minute taken back off.
    const minutesAhead = minute < CRON_MINUTE ? CRON_MINUTE - minute : 60 - minute + CRON_MINUTE;
    const secondsToNext = minutesAhead * 60 - second;

    const pad = (value) => String(value).padStart(2, "0");
    const hour = Number(row?.server_clock?.slice(0, 2) ?? 0);
    const nextHour = minute < CRON_MINUTE ? hour : (hour + 1) % 24;

    return NextResponse.json({
      success: true,
      data: {
        /** 'YYYY-MM-DD HH:MM' on the database clock. */
        last_update: row?.last_update ?? null,
        /** 'HH:MM' the next reload is due at. */
        next_update: `${pad(nextHour)}:${pad(CRON_MINUTE)}`,
        seconds_to_next: secondsToNext,
        server_clock: row?.server_clock ?? null,
        /** The database's own date, so the badge knows what "today" means. */
        server_date: row?.server_date ?? null,
        data_through: row?.data_through ?? null,
        run_seconds: RUN_SECONDS,
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
