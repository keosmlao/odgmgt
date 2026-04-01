"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import api from "@/service/api";
import { useLanguage } from "@/context/LanguageContext";

const C = { blue: "#3b82f6", emerald: "#10b981", amber: "#f59e0b", rose: "#ef4444" };
const num = (v: any) => Number(v || 0);
const fmt = (v: any) => num(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
const pct = (v: any) => `${num(v).toFixed(1)}%`;
const displayLabel = (value: any) => {
  const label = String(value || "");
  if (label === "PROJECT" || label === "ຂາຍໂຄງການ") return "ໂຄງການ";
  return label;
};

function Tip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-800">
      <p className="mb-1 font-semibold text-slate-600 dark:text-slate-300">{label}</p>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />{p.name}</span>
          <span className="font-semibold text-slate-900 dark:text-white">{fmt(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

export default function SalesSummary() {
  const { t } = useLanguage();
  const now = new Date();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [bu, setBu] = useState("ALL");
  const [channel, setChannel] = useState("ALL");
  const [province, setProvince] = useState("ALL");
  const [buOptions, setBuOptions] = useState<any[]>([]);
  const [provinceOptions, setProvinceOptions] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({ overall: true, area: true, collection: false });

  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  useEffect(() => {
    Promise.all([api.get("/bu"), api.get("/provinces")]).then(([b, p]) => {
      setBuOptions((b.data?.data || []).map((r: any) => ({ v: r.code || r.bu_code || r.id, l: r.name_1 || r.name || r.code })));
      setProvinceOptions((p.data?.data || []).map((r: any) => ({ v: r.code || r.id, l: r.name_1 || r.name })));
    }).catch(() => {});
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get("/sales-summary", { params: { year, month, bu, channel, province } });
      setData(res.data?.success ? res.data.data : res.data || null);
    } catch { setData(null); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [year, month, bu, channel, province]);

  const stats = useMemo(() => {
    if (!data?.meta || !data?.overall?.total) return null;
    const tot = data.overall.total;
    return {
      daysLeft: data.meta.working_days_left ?? 0,
      target: tot.target || 0,
      actual: tot.actual || 0,
      ach: tot.ach_pct || 0,
      dailyReq: tot.daily_remind || 0,
      ytdTarget: tot.ytd_target || 0,
      ytdActual: tot.ytd_actual || 0,
      ytdAch: tot.ytd_ach_pct || 0,
    };
  }, [data]);

  // Chart data from area rows
  const areaChart = useMemo(() => {
    return (data?.by_area?.rows || []).map((r: any) => ({
      name: displayLabel(r.label)?.length > 12 ? displayLabel(r.label).slice(0, 12) + "…" : displayLabel(r.label),
      target: num(r.target),
      actual: num(r.actual),
    }));
  }, [data]);

  const toggle = (key: string) => setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));

  const sel = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200";

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950" style={{ fontFamily: '"Noto Sans Lao","Noto Sans",system-ui,sans-serif' }}>

      {/* ══ Header ══ */}
      <header className="sticky top-0 z-30 border-b border-slate-200/50 bg-white/80 backdrop-blur-xl dark:border-slate-800/50 dark:bg-slate-950/80">
        <div className="flex items-center justify-between px-5 py-3 lg:px-6">
          <div>
            <h1 className="text-base font-semibold text-slate-900 dark:text-white">Sales Summary</h1>
            <p className="text-xs text-slate-500">
              {data?.meta ? `${data.meta.month_label} ${year} — ${data.meta.date_range}` : t("app.loading")}
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={load} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="grid grid-cols-2 gap-3 border-t border-slate-100 px-5 py-3 md:grid-cols-5 lg:px-6 dark:border-slate-800">
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-400">{t("filter.year")}</label>
            <select value={year} onChange={e => setYear(e.target.value)} className={sel}>
              {[String(now.getFullYear()), String(now.getFullYear() - 1), String(now.getFullYear() + 1)].sort().reverse().map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-400">Month</label>
            <select value={month} onChange={e => setMonth(e.target.value)} className={sel}>
              {months.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-400">{t("filter.bu")}</label>
            <select value={bu} onChange={e => setBu(e.target.value)} className={sel}>
              <option value="ALL">{t("app.all")}</option>
              {buOptions.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-400">{t("filter.channel")}</label>
            <select value={channel} onChange={e => setChannel(e.target.value)} className={sel}>
              <option value="ALL">{t("app.all")}</option>
              {["RETAIL","WHOLESALE","TECH","PROJECT","ONLINE"].map(c => <option key={c} value={c}>{displayLabel(c)}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-400">{t("filter.province")}</label>
            <select value={province} onChange={e => setProvince(e.target.value)} className={sel}>
              <option value="ALL">{t("app.all")}</option>
              {provinceOptions.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1480px] space-y-5 px-5 py-5 lg:px-6">

        {/* ══ Loading ══ */}
        {loading && (
          <div className="flex items-center justify-center rounded-xl border border-slate-200 bg-white py-20 dark:border-slate-800 dark:bg-slate-900">
            <Loader2 className="h-7 w-7 animate-spin text-blue-500" />
          </div>
        )}

        {/* ══ Stats Cards ══ */}
        {!loading && stats && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: t("kpi.target"), value: fmt(stats.target), badge: `${stats.daysLeft} ${t("momentum.daysLeft")}`, color: "blue" },
              { label: t("label.actual"), value: fmt(stats.actual), badge: pct(stats.ach), color: stats.ach >= 100 ? "emerald" : stats.ach >= 90 ? "amber" : "rose" },
              { label: `${t("momentum.perDay")}`, value: fmt(stats.dailyReq), badge: `${stats.daysLeft}d`, color: "amber" },
              { label: "YTD", value: fmt(stats.ytdActual), badge: pct(stats.ytdAch), color: "blue" },
            ].map((s, i) => (
              <div key={i} className="rounded-xl border border-slate-200/70 bg-white p-4 shadow-sm dark:border-slate-800/70 dark:bg-slate-900">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{s.label}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    s.color === "emerald" ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400" :
                    s.color === "amber" ? "bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400" :
                    s.color === "rose" ? "bg-rose-50 text-rose-600 dark:bg-rose-900/20 dark:text-rose-400" :
                    "bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400"
                  }`}>{s.badge}</span>
                </div>
                <p className="mt-2 text-xl font-bold text-slate-900 dark:text-white">{s.value}</p>
              </div>
            ))}
          </div>
        )}

        {/* ══ Area Chart ══ */}
        {!loading && areaChart.length > 0 && (
          <div className="rounded-xl border border-slate-200/70 bg-white p-5 shadow-sm dark:border-slate-800/70 dark:bg-slate-900">
            <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">Target vs Actual by Area</h2>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={areaChart} barGap={2} barSize={14}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v: number) => new Intl.NumberFormat("en-US", { notation: "compact" }).format(v)} />
                  <Tooltip content={<Tip />} />
                  <Bar dataKey="target" name={t("kpi.target")} fill="#cbd5e1" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="actual" name={t("label.actual")} fill={C.blue} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* ══ Data Tables ══ */}
        {!loading && data && (
          <div className="space-y-4">
            {[
              { key: "overall", title: "Overall Performance", sub: "ພາບລວມທັງໝົດ", tableData: data.overall },
              { key: "area", title: "By Area / Channel", sub: "ຕາມພື້ນທີ່", tableData: data.by_area },
              { key: "collection", title: "Collection Summary", sub: "ການເກັບເງິນ", tableData: data.collection },
            ].map(({ key, title, sub, tableData }) => {
              if (!tableData) return null;
              const open = expandedSections[key];
              return (
                <div key={key} className="overflow-hidden rounded-xl border border-slate-200/70 bg-white shadow-sm dark:border-slate-800/70 dark:bg-slate-900">
                  {/* Section header */}
                  <button onClick={() => toggle(key)} className="flex w-full items-center justify-between px-5 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-white">{title}</h3>
                      <p className="text-[11px] text-slate-400">{sub}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {tableData.total && (
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          num(tableData.total.ach_pct) >= 100 ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400" :
                          num(tableData.total.ach_pct) >= 90 ? "bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400" :
                          "bg-rose-50 text-rose-600 dark:bg-rose-900/20 dark:text-rose-400"
                        }`}>{pct(tableData.total.ach_pct)}</span>
                      )}
                      {open ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />}
                    </div>
                  </button>

                  {/* Table */}
                  {open && (
                    <div className="overflow-x-auto border-t border-slate-100 dark:border-slate-800">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-slate-50 text-slate-400 dark:bg-slate-800">
                            <th className="sticky left-0 z-10 bg-slate-50 px-4 py-2 text-left font-semibold dark:bg-slate-800">Area</th>
                            <th className="px-3 py-2 text-right font-semibold">{t("kpi.target")}</th>
                            <th className="px-3 py-2 text-right font-semibold">{t("label.actual")}</th>
                            <th className="px-3 py-2 text-center font-semibold">Ach%</th>
                            <th className="px-3 py-2 text-center font-semibold">Days</th>
                            <th className="px-3 py-2 text-right font-semibold">Req/Day</th>
                            <th className="px-3 py-2 text-right font-semibold text-slate-300">YTD Target</th>
                            <th className="px-3 py-2 text-right font-semibold text-slate-300">YTD Actual</th>
                            <th className="px-3 py-2 text-center font-semibold">YTD%</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {(tableData.rows || []).map((row: any, idx: number) => {
                            const achPct = num(row.ach_pct);
                            return (
                              <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                                <td className="sticky left-0 z-10 bg-white px-4 py-2.5 font-medium text-slate-800 dark:bg-slate-900 dark:text-slate-200">{displayLabel(row.label)}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{fmt(row.target)}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-slate-900 dark:text-white">{fmt(row.actual)}</td>
                                <td className="px-3 py-2.5 text-center">
                                  <span className={`inline-block min-w-[48px] rounded-full px-2 py-0.5 text-center text-[10px] font-bold ${
                                    achPct >= 100 ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400" :
                                    achPct >= 90 ? "bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400" :
                                    "bg-rose-50 text-rose-600 dark:bg-rose-900/20 dark:text-rose-400"
                                  }`}>{pct(achPct)}</span>
                                </td>
                                <td className="px-3 py-2.5 text-center tabular-nums text-slate-500">{row.working_days_left}</td>
                                <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${num(row.daily_remind) > 0 ? "text-blue-600 dark:text-blue-400" : "text-emerald-600 dark:text-emerald-400"}`}>{fmt(row.daily_remind)}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">{fmt(row.ytd_target)}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">{fmt(row.ytd_actual)}</td>
                                <td className="px-3 py-2.5 text-center tabular-nums font-medium text-slate-600 dark:text-slate-300">{num(row.ytd_ach_pct).toFixed(0)}%</td>
                              </tr>
                            );
                          })}
                          {/* Total row */}
                          {tableData.total && (
                            <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold dark:border-slate-700 dark:bg-slate-800">
                              <td className="sticky left-0 z-10 bg-slate-50 px-4 py-3 text-slate-900 dark:bg-slate-800 dark:text-white">TOTAL</td>
                              <td className="px-3 py-3 text-right tabular-nums text-slate-700 dark:text-slate-300">{fmt(tableData.total.target)}</td>
                              <td className="px-3 py-3 text-right tabular-nums text-slate-900 dark:text-white">{fmt(tableData.total.actual)}</td>
                              <td className="px-3 py-3 text-center">
                                <span className={`inline-block min-w-[48px] rounded-full px-2 py-0.5 text-center text-[10px] font-bold ${
                                  num(tableData.total.ach_pct) >= 100 ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" :
                                  num(tableData.total.ach_pct) >= 90 ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" :
                                  "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300"
                                }`}>{pct(tableData.total.ach_pct)}</span>
                              </td>
                              <td className="px-3 py-3 text-center tabular-nums">{tableData.total.working_days_left}</td>
                              <td className={`px-3 py-3 text-right tabular-nums ${num(tableData.total.daily_remind) > 0 ? "text-blue-600" : "text-emerald-600"}`}>{fmt(tableData.total.daily_remind)}</td>
                              <td className="px-3 py-3 text-right tabular-nums text-slate-500">{fmt(tableData.total.ytd_target)}</td>
                              <td className="px-3 py-3 text-right tabular-nums text-slate-500">{fmt(tableData.total.ytd_actual)}</td>
                              <td className="px-3 py-3 text-center tabular-nums text-slate-700 dark:text-slate-300">{num(tableData.total.ytd_ach_pct).toFixed(0)}%</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ══ No Data ══ */}
        {!loading && !data && (
          <div className="flex items-center justify-center rounded-xl border border-dashed border-slate-300 py-20 dark:border-slate-700">
            <p className="text-sm text-slate-400">{t("label.noData")}</p>
          </div>
        )}

      </main>
    </div>
  );
}
