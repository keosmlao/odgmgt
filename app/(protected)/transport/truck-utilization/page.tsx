"use client";

import { useEffect, useState } from "react";
import { FaExclamationTriangle, FaSpinner, FaTruckLoading } from "react-icons/fa";
// Copied from tms — only the data call is swapped for the REST proxy, which
// forwards to TMS so the calculation stays in one place.
import api from "@/service/api";
import { StatusPageHeader, StatusTableShell } from "@/components/status-page-shell";
import { addDays, getLaoToday } from "@/lib/lao-date";

interface Row {
  docNo: string;
  docDate: string;
  car: string;
  bills: number;
  m3: number;
  usableM3: number | null;
  utilizationPct: number | null;
  freeM3: number | null;
  coveragePct: number;
  linesUnknown: number;
  dataSufficient: boolean;
  suspect: boolean;
}

interface Summary {
  total: number;
  scored: number;
  suspect: number;
  noData: number;
  noCapacity: number;
  medianPct: number | null;
  avgPct: number | null;
  totalFreeM3: number;
  bands: Array<{ label: string; trips: number }>;
}

const today = () => getLaoToday();
const daysAgo = (n: number) => addDays(getLaoToday(), -n);

export default function TruckUtilizationPage() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlyScored, setOnlyScored] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = (await api.get("/transport/truck-utilization", { params: { from: from, to: to } }).then((r) => r.data?.data)) as {
        trips: Row[];
        summary: Summary | null;
      };
      setRows(data.trips ?? []);
      setSummary(data.summary ?? null);
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : "ໂຫຼດບໍ່ສຳເລັດ");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // ໂຫຼດເທື່ອດຽວຕອນເປີດ — ຫຼັງຈາກນັ້ນກົດປຸ່ມເອງ ເພາະ query ໜັກ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Management view shows only the 10 most recent trips — TMS lists the whole
   * range for operations to work through, which is not what this screen is for.
   * The summary above still covers the full range, so the headline numbers do
   * not change.
   */
  const RECENT_TRIPS = 10;
  const visible = (onlyScored
    ? rows.filter((r) => r.utilizationPct !== null && !r.suspect)
    : rows)
    .slice()
    .sort((a, b) => String(b.docDate).localeCompare(String(a.docDate)) || String(b.docNo).localeCompare(String(a.docNo)))
    .slice(0, RECENT_TRIPS);
  const maxBand = Math.max(1, ...(summary?.bands.map((b) => b.trips) ?? [1]));

  const tone = (pct: number) =>
    pct > 90 ? "text-rose-600 dark:text-rose-400"
      : pct > 70 ? "text-amber-600 dark:text-amber-400"
        : pct < 25 ? "text-sky-600 dark:text-sky-400"
          : "text-emerald-600 dark:text-emerald-400";

  return (
    <div className="space-y-5">
      <StatusPageHeader
        title="ອັດຕາໃຊ້ພື້ນທີ່ລົດ"
        subtitle="ແຕ່ລະຖ້ຽວໃຊ້ພື້ນທີ່ລົດຈັກສ່ວນຮ້ອຍ ແລະ ເຫຼືອວ່າງເທົ່າໃດ"
        icon={<FaTruckLoading />}
        tone="teal"
      />

      <div className="glass flex flex-wrap items-end gap-3 rounded-lg p-4">
        <div>
          <label className="block text-[10px] font-semibold text-slate-500">ແຕ່ວັນ</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="glass-input mt-1 h-9 rounded-lg px-3 text-xs"
          />
        </div>
        <div>
          <label className="block text-[10px] font-semibold text-slate-500">ຫາວັນ</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="glass-input mt-1 h-9 rounded-lg px-3 text-xs"
          />
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="h-9 rounded-lg bg-teal-700 px-4 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
        >
          {loading ? <FaSpinner className="animate-spin" /> : "ເບິ່ງ"}
        </button>
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={onlyScored}
            onChange={(e) => setOnlyScored(e.target.checked)}
          />
          ສະແດງສະເພາະຖ້ຽວທີ່ຄິດ % ໄດ້
        </label>
      </div>

      {error && <p className="text-[11px] text-rose-500">{error}</p>}

      {summary && (
        <div className="glass rounded-lg p-4">
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">ຄ່າກາງ</p>
              <p className="text-2xl font-bold tabular-nums text-teal-700 dark:text-teal-400">
                {summary.medianPct !== null ? `${summary.medianPct.toFixed(0)}%` : "—"}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">ພື້ນທີ່ວ່າງລວມ</p>
              <p className="text-2xl font-bold tabular-nums text-sky-700 dark:text-sky-400">
                {summary.totalFreeM3.toFixed(0)} m³
              </p>
              <p className="text-[9px] text-slate-400">ຈາກ {summary.scored} ຖ້ຽວທີ່ຄິດໄດ້</p>
            </div>
            <div className="min-w-[240px] flex-1">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                ການແຈກແຈງ
              </p>
              {summary.bands.map((b) => (
                <div key={b.label} className="flex items-center gap-2">
                  <span className="w-16 text-right text-[10px] tabular-nums text-slate-500">{b.label}</span>
                  <div className="h-2 flex-1 rounded-full bg-slate-500/10">
                    <div
                      className="h-full rounded-full bg-teal-500/70"
                      style={{ width: `${(b.trips / maxBand) * 100}%` }}
                    />
                  </div>
                  <span className="w-10 text-right text-[10px] tabular-nums text-slate-600 dark:text-slate-300">
                    {b.trips}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <p className="mt-3 border-t border-slate-200/40 pt-2 text-[10px] leading-relaxed text-slate-400 dark:border-white/5">
            ຖ້ຽວທັງໝົດ {summary.total} · ຄິດ % ໄດ້ {summary.scored} · ຂໍ້ມູນສິນຄ້າບໍ່ພໍ{" "}
            {summary.noData} · ລົດບໍ່ມີຄວາມຈຸ {summary.noCapacity}
            {summary.suspect > 0 && (
              <span className="ml-1 text-amber-600 dark:text-amber-400">
                · <FaExclamationTriangle className="inline" size={9} /> ຕ້ອງກວດຂໍ້ມູນ {summary.suspect}
              </span>
            )}
          </p>
          {summary.suspect > 0 && (
            <p className="mt-1 rounded bg-amber-500/10 px-2 py-1.5 text-[10px] leading-relaxed text-amber-700 dark:text-amber-400">
              ຖ້ຽວທີ່ເກີນ 100% ບໍ່ໄດ້ນັບເຂົ້າຄ່າກາງ — ສ່ວນຫຼາຍແມ່ນບິນດຽວກັນຖືກຜູກໃສ່ຫຼາຍຖ້ຽວ
              ໂດຍເລືອກຈຳນວນເຕັມທຸກເທື່ອ ເຊິ່ງເປັນບັນຫາການບັນທຶກຖ້ຽວ ບໍ່ແມ່ນບັນທຸກເກີນຈິງ.
            </p>
          )}
        </div>
      )}

      <StatusTableShell count={visible.length}>
        {loading ? (
          <div className="flex items-center justify-center py-14 text-sm text-slate-400">
            <FaSpinner className="mr-2 animate-spin" /> ກຳລັງຄິດໄລ່...
          </div>
        ) : visible.length === 0 ? (
          <div className="py-14 text-center text-sm text-slate-400">ບໍ່ພົບຖ້ຽວໃນຊ່ວງນີ້</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200/30 bg-white/30 dark:border-white/5 dark:bg-white/5">
                  <th className="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300">ວັນ</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300">ຖ້ຽວ</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-300">ລົດ</th>
                  <th className="px-3 py-2.5 text-center font-semibold text-slate-600 dark:text-slate-300">ບິນ</th>
                  <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300">m³</th>
                  <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300">ຈຸໄດ້</th>
                  <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300">ໃຊ້</th>
                  <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300">ວ່າງ</th>
                  <th className="px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-300">ຄິດຈາກ</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr
                    key={r.docNo}
                    className="border-b border-slate-200/20 hover:bg-white/30 dark:border-white/5 dark:hover:bg-white/5"
                  >
                    <td className="px-3 py-2 text-slate-500">{r.docDate}</td>
                    <td className="px-3 py-2 font-mono text-[10px] text-slate-700 dark:text-slate-200">
                      {r.docNo}
                      {r.suspect && (
                        <span
                          className="ml-1 text-amber-600 dark:text-amber-400"
                          title="ເກີນ 100% — ຄວນກວດຂໍ້ມູນຖ້ຽວ"
                        >
                          ⚠
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{r.car || "—"}</td>
                    <td className="px-3 py-2 text-center tabular-nums text-slate-500">{r.bills}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">
                      {r.m3.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                      {r.usableM3?.toFixed(1) ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.utilizationPct === null ? (
                        <span className="text-[10px] text-slate-400">
                          {r.usableM3 === null ? "ບໍ່ມີຄວາມຈຸ" : "ຂໍ້ມູນບໍ່ພໍ"}
                        </span>
                      ) : (
                        <span className={`font-bold tabular-nums ${tone(r.utilizationPct)}`}>
                          {r.utilizationPct.toFixed(0)}%
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-sky-700 dark:text-sky-400">
                      {r.freeM3 !== null ? `${r.freeM3.toFixed(1)}` : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                      {r.coveragePct.toFixed(0)}%
                      {r.linesUnknown > 0 && (
                        <span className="ml-1 text-amber-600 dark:text-amber-400">
                          −{r.linesUnknown}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </StatusTableShell>
    </div>
  );
}
