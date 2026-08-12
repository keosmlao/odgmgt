import { NextResponse } from "next/server";
import { rows, one } from "@/lib/db";

const cacheMap = new Map();
const TTL = 300_000; // 5 min

// Logical ordering for odg_ar_aging.overdue_group values.
const BUCKET_ORDER = [
  "Ondue",
  "Overdue < 60",
  "Overdue < 180",
  "Overdue < 360",
  "Overdue < 720",
  "Overdue < 1080",
  "Overdue",
];

export async function GET() {
  try {
    const cacheKey = "ar";
    const cached = cacheMap.get(cacheKey);
    if (cached && Date.now() - cached.ts < TTL) return NextResponse.json(cached.data);

    const [bucketRows, debtorRows, rev90Row] = await Promise.all([
      rows(`
        SELECT overdue_group, COUNT(*)::int AS bills, COALESCE(SUM(balance_amount), 0)::float AS balance
        FROM public.odg_ar_aging
        WHERE balance_amount > 0
        GROUP BY overdue_group
      `),
      rows(`
        SELECT ar_code, MAX(sale_name) AS sale_name,
          COALESCE(SUM(balance_amount), 0)::float AS balance,
          MAX(date_diff)::int AS max_overdue_days,
          COUNT(*)::int AS bills
        FROM public.odg_ar_aging
        WHERE balance_amount > 0
        GROUP BY ar_code
        ORDER BY balance DESC
        LIMIT 20
      `),
      one(`
        SELECT COALESCE(SUM(sum_amount), 0)::float AS total
        FROM public.odg_sale_detail
        WHERE doc_date >= CURRENT_DATE - 90
      `).catch(() => ({ total: 0 })),
    ]);

    // Resolve customer names for the top debtors from sale history.
    const debtorCodes = debtorRows.map((row) => row.ar_code).filter(Boolean);
    let nameMap = {};
    if (debtorCodes.length) {
      const nameRows = await rows(
        `SELECT ar_code, MAX(customername) AS name
         FROM public.odg_sale_detail
         WHERE ar_code = ANY(%s)
         GROUP BY ar_code`,
        [debtorCodes],
      ).catch(() => []);
      nameMap = Object.fromEntries(nameRows.map((row) => [row.ar_code, row.name]));
    }

    const buckets = bucketRows
      .map((row) => ({
        bucket: row.overdue_group || "UNKNOWN",
        bills: Number(row.bills || 0),
        balance: Number(row.balance || 0),
      }))
      .sort((a, b) => {
        const ia = BUCKET_ORDER.indexOf(a.bucket);
        const ib = BUCKET_ORDER.indexOf(b.bucket);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });

    const totalBalance = buckets.reduce((sum, row) => sum + row.balance, 0);
    const overdueBalance = buckets
      .filter((row) => row.bucket !== "Ondue")
      .reduce((sum, row) => sum + row.balance, 0);
    const rev90 = Number(rev90Row?.total || 0);
    const dso = rev90 > 0 ? totalBalance / (rev90 / 90) : 0;

    const data = {
      summary: {
        total_balance: totalBalance,
        overdue_balance: overdueBalance,
        overdue_pct: totalBalance > 0 ? (overdueBalance / totalBalance) * 100 : 0,
        dso,
      },
      buckets,
      topDebtors: debtorRows.map((row) => ({
        ar_code: row.ar_code,
        name: nameMap[row.ar_code] || row.ar_code,
        sale_name: row.sale_name || "-",
        balance: Number(row.balance || 0),
        bills: Number(row.bills || 0),
        max_overdue_days: Number(row.max_overdue_days || 0),
      })),
    };

    cacheMap.set(cacheKey, { ts: Date.now(), data });
    return NextResponse.json(data);
  } catch (error) {
    console.error("analytics/ar error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
