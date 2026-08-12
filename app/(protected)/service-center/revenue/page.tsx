// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name; imports rewritten.
import { ChevronLeft, ChevronRight } from "lucide-react";
import { monthlyRevenueMatrix, REV_CATEGORIES, type RevCategory } from "@/lib/ods/monthly-report";
import Link from "next/link";

/**
 * **ສະຫຼຸບລາຍຮັບປະຈຳເດືອນ — ສະບັບນຳສະເໜີຜູ້ບໍລິຫານ** (ໜ້າດຽວ · ພິມ A4 ໄດ້).
 *
 * ແຍກ 2 ຊັ້ນ: **ຕິດຕັ້ງ / ສ້ອມ** × **ແອ / ເຄື່ອງໃຊ້ໄຟຟ້າ** ⇒ 4 ໝວດ + ອື່ນໆ.
 *
 * ⚠️ ຕົວເລກມາຈາກ `monthlyRevenueMatrix` ເທົ່ານັ້ນ — ຢ່າຄິດສູດເອງໃໝ່.
 * engine (ວັດ 04-08-2026) ນັບຕິດຕັ້ງ **ຄືກັບ /install-revenue ພໍດີ**:
 * ບິນຜູກໃບງານ = ນັບຕາມວັນປິດງານສຸດທ້າຍ · ບິນຍັງບໍ່ຜູກ = ນັບຕາມວັນທີບິນ
 * · ໃບ HSV (ກີບ) ແປງດ້ວຍອັດຕາ tb_bill_rate ກ່ອນລວມ.
 *
 * ໜ້ານີ້ບໍ່ມີເມນູ/ປຸ່ມຕອນພິມ (`print:hidden`) ⇒ ໄດ້ເອກະສານສະອາດ.
 */
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ year?: string }> };

const LABEL: Record<RevCategory, string> = {
  install_ac: "ຕິດຕັ້ງ · ແອ",
  install_app: "ຕິດຕັ້ງ · ເຄື່ອງໃຊ້ໄຟຟ້າ",
  repair_ac: "ສ້ອມ · ແອ",
  repair_app: "ສ້ອມ · ເຄື່ອງໃຊ້ໄຟຟ້າ",
  other: "ອື່ນໆ",
};
const BAR: Record<RevCategory, string> = {
  install_ac: "bg-brand-700",
  install_app: "bg-brand-400",
  repair_ac: "bg-brand-600",
  repair_app: "bg-brand-500",
  other: "bg-slate-400",
};
const MONTHS = ["ມັງກອນ","ກຸມພາ","ມີນາ","ເມສາ","ພຶດສະພາ","ມິຖຸນາ","ກໍລະກົດ","ສິງຫາ","ກັນຍາ","ຕຸລາ","ພະຈິກ","ທັນວາ"];
/** ຊື່ເດືອນຫຍໍ້ ສຳລັບແທ່ງກຣາຟ */
const MONTH_SHORT = ["ມັງກອນ","ກຸມພາ","ມີນາ","ເມສາ","ພຶດສະພາ","ມິຖຸນາ","ກໍລະກົດ","ສິງຫາ","ກັນຍາ","ຕຸລາ","ພະຈິກ","ທັນວາ"]
  .map((label) => label.slice(0, 3));

export default async function RevenueSummaryPage({ searchParams }: Props) {
  const params = await searchParams;
  const thisYear = new Date().getFullYear();
  const year = Number(params.year) >= 2020 && Number(params.year) <= thisYear ? Number(params.year) : thisYear;

  const matrix = await monthlyRevenueMatrix(year);
  const cell = (y: number, m: number) => matrix.get(`${y}-${String(m + 1).padStart(2, "0")}`);

  const nowMonth = new Date().getMonth();
  const rows = MONTHS.map((label, index) => {
    const now = cell(year, index);
    const prev = cell(year - 1, index);
    const total = now?.total ?? 0;
    const last = prev?.total ?? 0;
    return {
      label,
      current: year === thisYear && index === nowMonth,
      values: Object.fromEntries(REV_CATEGORIES.map((c) => [c, now?.[c] ?? 0])) as Record<RevCategory, number>,
      total,
      last,
      target: now?.target ?? 0,
      yoy: last > 0 ? ((total - last) / last) * 100 : null,
    };
  });

  const active = rows.filter((row) => row.total > 0);
  const grand = rows.reduce((sum, row) => sum + row.total, 0);
  const lastYear = rows.reduce((sum, row) => sum + row.last, 0);
  const targetSum = rows.reduce((sum, row) => sum + row.target, 0);
  const byCategory = Object.fromEntries(
    REV_CATEGORIES.map((c) => [c, rows.reduce((sum, row) => sum + row.values[c], 0)]),
  ) as Record<RevCategory, number>;
  const peak = active.reduce((best, row) => (row.total > best.total ? row : best), active[0] ?? rows[0]);
  const best = REV_CATEGORIES.reduce((a, b) => (byCategory[a] >= byCategory[b] ? a : b));
  const average = active.length > 0 ? grand / active.length : 0;
  const maxMonth = rows.reduce((max, row) => Math.max(max, row.total), 1);
  const money = (value: number) => Math.round(value).toLocaleString();
  const pct = (value: number) => (grand > 0 ? Math.round((value / grand) * 100) : 0);
  const yoyAll = lastYear > 0 ? ((grand - lastYear) / lastYear) * 100 : null;
  const hasTarget = targetSum > 0;
  const yearHref = (y: number) => `/revenue-summary?year=${y}`;

  return (
    <div className="w-full space-y-6 bg-white p-6 text-slate-800 print:p-0">
      {/* ── ຫົວ + ຕົວເລືອກປີ ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-brand-800">ODIEN SERVICE CENTER</p>
          <h1 className="mt-1 text-2xl font-bold">ລາຍງານລາຍຮັບປະຈຳປີ {year}</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            ແຍກຕາມປະເພດງານ (ຕິດຕັ້ງ · ສ້ອມແປງ) ແລະ ປະເພດເຄື່ອງ (ແອ · ເຄື່ອງໃຊ້ໄຟຟ້າ) · ຫົວໜ່ວຍ: ບາດ
          </p>
        </div>
        <nav className="flex shrink-0 items-center gap-1 rounded-xl border border-slate-300 px-1 py-1 print:hidden">
          <Link href={yearHref(year - 1)} className="flex items-center gap-0.5 rounded-lg px-2 py-1 text-xs hover:bg-slate-100">
            <ChevronLeft className="size-3.5" /> {year - 1}
          </Link>
          <span className="px-2 text-sm font-bold tabular-nums">{year}</span>
          <Link
            href={yearHref(year + 1)}
            aria-disabled={year >= thisYear}
            className="flex items-center gap-0.5 rounded-lg px-2 py-1 text-xs hover:bg-slate-100 aria-disabled:pointer-events-none aria-disabled:opacity-30"
          >
            {year + 1} <ChevronRight className="size-3.5" />
          </Link>
        </nav>
      </div>

      {/* ── ຕົວເລກຫຼັກ ── */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-brand-200 bg-brand-50/60 p-4">
          <p className="text-[11px] font-semibold text-slate-500">ລາຍຮັບລວມທັງປີ</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-brand-800">{money(grand)}</p>
          {yoyAll !== null ? (
            <p className={`text-xs font-semibold ${yoyAll >= 0 ? "text-brand-800" : "text-brand-orange-700"}`}>
              {yoyAll >= 0 ? "▲" : "▼"} {Math.abs(Math.round(yoyAll))}% ທຽບປີ {year - 1}
            </p>
          ) : (
            <p className="text-xs text-slate-400">ປີ {year - 1} ບໍ່ມີຂໍ້ມູນ</p>
          )}
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-[11px] font-semibold text-slate-500">ສະເລ່ຍຕໍ່ເດືອນ</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{money(average)}</p>
          <p className="text-xs text-slate-400">ຈາກ {active.length} ເດືອນທີ່ມີລາຍຮັບ</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-[11px] font-semibold text-slate-500">ເດືອນສູງສຸດ</p>
          <p className="mt-1 text-2xl font-bold">{peak?.label ?? "-"}</p>
          <p className="text-xs tabular-nums text-slate-400">{money(peak?.total ?? 0)} ບາດ</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-[11px] font-semibold text-slate-500">ເປົ້າທັງປີ</p>
          {hasTarget ? (
            <>
              <p className="mt-1 text-2xl font-bold tabular-nums">{money(targetSum)}</p>
              <p className="text-xs font-semibold text-brand-800">
                ສຳເລັດ {grand > 0 ? Math.round((grand / targetSum) * 100) : 0}%
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 text-2xl font-bold text-slate-300">—</p>
              <p className="text-xs text-slate-400">
                ຍັງບໍ່ຕັ້ງເປົ້າ ·{" "}
                <Link href="/manage/revenue-targets" className="text-brand-800 underline print:hidden">
                  ໄປຕັ້ງເປົ້າ
                </Link>
              </p>
            </>
          )}
        </div>
      </div>

      {/* ── ກຣາຟລາຍເດືອນ (ແທ່ງຊ້ອນຕາມໝວດ) ── */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-bold">ລາຍຮັບລາຍເດືອນ</h2>
        <div className="mt-3 flex h-44 items-end gap-1.5 sm:gap-2">
          {rows.map((row) => (
            <div key={row.label} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
              <div
                className={`flex w-full max-w-9 flex-col-reverse overflow-hidden rounded-t ${row.current ? "ring-2 ring-brand-600" : ""}`}
                style={{ height: `${Math.max((row.total / maxMonth) * 100, row.total > 0 ? 2 : 0)}%` }}
                title={`${row.label}: ${money(row.total)} ບາດ`}
              >
                {REV_CATEGORIES.map((category) =>
                  row.values[category] > 0 ? (
                    <span
                      key={category}
                      className={BAR[category]}
                      style={{ height: `${(row.values[category] / row.total) * 100}%` }}
                    />
                  ) : null,
                )}
              </div>
              <span className={`text-[9px] ${row.current ? "font-bold text-brand-800" : "text-slate-400"}`}>
                {MONTH_SHORT[MONTHS.indexOf(row.label)]}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ── ສັດສ່ວນຕາມໝວດ ── */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-bold">ອົງປະກອບລາຍຮັບ</h2>
        <div className="flex h-4 w-full overflow-hidden rounded-full">
          {REV_CATEGORIES.map((category) => (
            <span key={category} className={BAR[category]} style={{ width: `${pct(byCategory[category])}%` }} />
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
          {REV_CATEGORIES.map((category) => (
            <div key={category}>
              <p className="flex items-center gap-1.5 text-slate-500">
                <span className={`size-2 rounded-full ${BAR[category]}`} />
                {LABEL[category]}
              </p>
              <p className="mt-0.5 font-bold tabular-nums">{money(byCategory[category])}</p>
              <p className="text-[10px] text-slate-400">{pct(byCategory[category])}%</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── ຕາຕະລາງລາຍເດືອນ ── */}
      <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[860px] border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left">
              <th className="px-3 py-2 font-semibold">ເດືອນ</th>
              {REV_CATEGORIES.map((category) => (
                <th key={category} className="px-3 py-2 text-right font-semibold">
                  {LABEL[category]}
                </th>
              ))}
              <th className="px-3 py-2 text-right font-semibold">ລວມ</th>
              {hasTarget && <th className="px-3 py-2 text-right font-semibold">ເປົ້າ</th>}
              <th className="px-3 py-2 text-right font-semibold">ທຽບ {year - 1}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.label}
                className={`border-b border-slate-100 ${row.current ? "bg-brand-50/70 font-semibold" : ""}`}
              >
                <td className="px-3 py-1.5 font-medium">
                  {row.label}
                  {row.current && (
                    <span className="ml-1.5 rounded bg-brand-700 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      ເດືອນນີ້
                    </span>
                  )}
                </td>
                {REV_CATEGORIES.map((category) => (
                  <td key={category} className="px-3 py-1.5 text-right tabular-nums text-slate-600">
                    {row.values[category] > 0 ? money(row.values[category]) : "—"}
                  </td>
                ))}
                <td className="px-3 py-1.5 text-right font-bold tabular-nums">{money(row.total)}</td>
                {hasTarget && (
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">
                    {row.target > 0 ? (
                      <>
                        {money(row.target)}
                        <span className={`ml-1 text-[10px] font-semibold ${row.total >= row.target ? "text-brand-800" : "text-slate-400"}`}>
                          {row.total > 0 ? `${Math.round((row.total / row.target) * 100)}%` : ""}
                        </span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                )}
                <td
                  className={`px-3 py-1.5 text-right tabular-nums ${
                    row.yoy === null ? "text-slate-300" : row.yoy >= 0 ? "text-brand-800" : "text-brand-orange-700"
                  }`}
                >
                  {row.yoy === null ? "—" : `${row.yoy >= 0 ? "+" : ""}${Math.round(row.yoy)}%`}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-brand-800 font-bold">
              <td className="px-3 py-2">ລວມ</td>
              {REV_CATEGORIES.map((category) => (
                <td key={category} className="px-3 py-2 text-right tabular-nums">
                  {money(byCategory[category])}
                </td>
              ))}
              <td className="px-3 py-2 text-right tabular-nums">{money(grand)}</td>
              {hasTarget && <td className="px-3 py-2 text-right tabular-nums">{money(targetSum)}</td>}
              <td />
            </tr>
          </tfoot>
        </table>
      </section>

      {/* ── ຂໍ້ສັງເກດ — ຄິດຈາກຂໍ້ມູນ ບໍ່ແມ່ນຂໍ້ຄວາມຕາຍຕົວ ── */}
      <section className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs leading-6">
        <h2 className="mb-1 text-sm font-bold">ຂໍ້ສັງເກດ</h2>
        <ul className="list-disc space-y-0.5 pl-5">
          <li>
            ໝວດທີ່ສ້າງລາຍຮັບຫຼາຍສຸດແມ່ນ <b>{LABEL[best]}</b> ຄິດເປັນ {pct(byCategory[best])}% ຂອງລາຍຮັບທັງປີ
          </li>
          <li>
            ເດືອນ <b>{peak?.label}</b> ສູງສຸດທີ່ {money(peak?.total ?? 0)} ບາດ — ສູງກວ່າຄ່າສະເລ່ຍ{" "}
            {average > 0 ? Math.round((((peak?.total ?? 0) - average) / average) * 100) : 0}%
          </li>
          {yoyAll !== null && (
            <li>
              ລາຍຮັບລວມ {yoyAll >= 0 ? "ເພີ່ມຂຶ້ນ" : "ຫຼຸດລົງ"} {Math.abs(Math.round(yoyAll))}% ທຽບກັບປີ {year - 1}
              （{money(lastYear)} ບາດ）
            </li>
          )}
          {hasTarget && (
            <li>
              ທຽບເປົ້າທັງປີ {money(targetSum)} ບາດ — ສຳເລັດແລ້ວ{" "}
              <b>{grand > 0 ? Math.round((grand / targetSum) * 100) : 0}%</b>
            </li>
          )}
        </ul>
      </section>

      <p className="border-t border-slate-200 pt-3 text-[10px] leading-5 text-slate-400">
        ແຫຼ່ງຂໍ້ມູນ: ຕິດຕັ້ງ = ບິນຂາຍ ERP ທີ່ຜູກໃບງານ (ນັບຕາມວັນປິດງານ — ຕົງກັບ{" "}
        <Link href="/install-revenue" className="text-brand-800 underline print:hidden">ລາຍຮັບງານຕິດຕັ້ງ</Link>) +
        ບິນຍັງບໍ່ຜູກໃບງານ (ນັບຕາມວັນທີບິນ) · ສ້ອມ = ໃບສະເໜີລາຄາທີ່ລູກຄ້າຮັບແລ້ວ · ອື່ນໆ = ໂຄງການ · ໄລຍະທາງ · ບຳລຸງຮັກສາ ·
        ໃບຕະກູນ HSV ປ້ອນເປັນກີບ ຈຶ່ງແປງດ້ວຍອັດຕາ tb_bill_rate ກ່ອນລວມ · ສ້າງໂດຍລະບົບ ODS
      </p>
    </div>
  );
}
