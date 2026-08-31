"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, ChevronDown, ChevronRight, Download } from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import api from "@/service/api";
import { downloadCsv } from "@/lib/csv";
import { useLanguage } from "@/context/LanguageContext";
import SaleSyncBadge from "@/components/SaleSyncBadge";

const C = { blue: "#2b70b5", emerald: "#17876d", amber: "#f5911f", rose: "#d0453f" };
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
    <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-semibold text-[var(--ink-soft)]">{label}</p>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />{p.name}</span>
          <span className="font-semibold text-[var(--ink)]">{fmt(p.value)}</span>
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

  /** Flattens every visible section (rows + totals) into one CSV. */
  const exportCsv = () => {
    if (!data) return;
    const sections: [string, any][] = [
      ["overall", data.overall],
      ["by_area", data.by_area],
      ["collection", data.collection],
    ];
    const headers = ["section", "label", "target", "actual", "ach_pct", "days_left", "req_per_day", "ytd_target", "ytd_actual", "ytd_ach_pct"];
    const rows: (string | number)[][] = [];
    const pushRow = (section: string, label: string, r: any) => {
      rows.push([section, displayLabel(label), num(r.target), num(r.actual), num(r.ach_pct), num(r.working_days_left), num(r.daily_remind), num(r.ytd_target), num(r.ytd_actual), num(r.ytd_ach_pct)]);
    };
    sections.forEach(([name, section]) => {
      if (!section?.rows?.length) return;
      section.rows.forEach((r: any) => pushRow(name, r.label, r));
      if (section.total) pushRow(`${name} · total`, "TOTAL", section.total);
    });
    if (!rows.length) return;
    downloadCsv(`sales-summary-${year}-${month}`, headers, rows);
  };

  const sel = "select";

  return (
    <div className="min-h-screen bg-transparent" style={{ fontFamily: '"Noto Sans Lao","Noto Sans",system-ui,sans-serif' }}>

      {/* ══ Header ══ */}
      <header className="page-hd flex-col !items-stretch !gap-0 !p-0">
        <div className="flex items-center justify-between px-5 py-3 lg:px-6">
          <div>
            <p className="eyebrow">Performance report</p>
            <h1 className="page-title">Sales Summary</h1>
            <p className="page-sub flex flex-wrap items-center gap-1.5">
              {data?.meta ? `${data.meta.month_label} ${year} — ${data.meta.date_range}` : t("app.loading")}
              {/* ເວລາອັບເດດ ແລະ ນັບຖອຍຫຼັງ — ໜ້ານີ້ອ່ານສຳເນົາຂອງ ERP ຄືກັນ. */}
              <SaleSyncBadge onUpdated={load} />
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={exportCsv} className="btn" disabled={!data}>
              <Download size={13} /> {t("app.exportCsv")}
            </button>
            <button onClick={load} className="btn">
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="grid grid-cols-2 gap-3 border-t border-[var(--line-soft)] px-5 py-3 md:grid-cols-5 lg:px-6">
          <div>
            <label className="field-label">{t("filter.year")}</label>
            <select value={year} onChange={e => setYear(e.target.value)} className={sel}>
              {[String(now.getFullYear()), String(now.getFullYear() - 1), String(now.getFullYear() + 1)].sort().reverse().map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label">Month</label>
            <select value={month} onChange={e => setMonth(e.target.value)} className={sel}>
              {months.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label">{t("filter.bu")}</label>
            <select value={bu} onChange={e => setBu(e.target.value)} className={sel}>
              <option value="ALL">{t("app.all")}</option>
              {buOptions.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label">{t("filter.channel")}</label>
            <select value={channel} onChange={e => setChannel(e.target.value)} className={sel}>
              <option value="ALL">{t("app.all")}</option>
              {["RETAIL","WHOLESALE","TECH","PROJECT","ONLINE"].map(c => <option key={c} value={c}>{displayLabel(c)}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label">{t("filter.province")}</label>
            <select value={province} onChange={e => setProvince(e.target.value)} className={sel}>
              <option value="ALL">{t("app.all")}</option>
              {provinceOptions.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1480px] space-y-5 px-5 py-6 lg:px-8">

        {/* ══ Loading ══ */}
        {loading && (
          <div className="flex items-center justify-center rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface)] py-20">
            <Loader2 className="h-7 w-7 animate-spin text-[var(--brand)]" />
          </div>
        )}

        {/* ══ Stats Cards ══ */}
        {!loading && stats && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { label: t("kpi.target"), value: fmt(stats.target), badge: `${stats.daysLeft} ${t("momentum.daysLeft")}`, color: "blue" },
              { label: t("label.actual"), value: fmt(stats.actual), badge: pct(stats.ach), color: stats.ach >= 100 ? "emerald" : stats.ach >= 90 ? "amber" : "rose" },
              { label: `${t("momentum.perDay")}`, value: fmt(stats.dailyReq), badge: `${stats.daysLeft}d`, color: "amber" },
              { label: "YTD", value: fmt(stats.ytdActual), badge: pct(stats.ytdAch), color: "blue" },
            ].map((s, i) => (
              <div key={i} className="rounded-[var(--r-md)] border border-[var(--line)]/70 bg-[var(--surface)] p-4 shadow-sm /70">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">{s.label}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
 s.color === "emerald" ? "bg-[var(--pos-bg)] text-[var(--pos)] " :
 s.color === "amber" ? "bg-[var(--warn-bg)] text-[var(--warn)] " :
 s.color === "rose" ? "bg-[var(--neg-bg)] text-[var(--neg)] " :
 "bg-[var(--info-bg)] text-[var(--brand)] "
 }`}>{s.badge}</span>
                </div>
                <p className="mt-2 text-xl font-bold text-[var(--ink)]">{s.value}</p>
              </div>
            ))}
          </div>
        )}

        {/* ══ Area Chart ══ */}
        {!loading && areaChart.length > 0 && (
          <div className="rounded-[var(--r-md)] border border-[var(--line)]/70 bg-[var(--surface)] p-5 shadow-sm /70">
            <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-[var(--muted)]">Target vs Actual by Area</h2>
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
                <div key={key} className="overflow-hidden rounded-[var(--r-md)] border border-[var(--line)]/70 bg-[var(--surface)] shadow-sm /70">
                  {/* Section header */}
                  <button onClick={() => toggle(key)} className="flex w-full items-center justify-between px-5 py-3 text-left hover:bg-[var(--surface-2)]">
                    <div>
                      <h3 className="text-sm font-semibold text-[var(--ink)]">{title}</h3>
                      <p className="text-[11px] text-[var(--muted)]">{sub}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {tableData.total && (
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
 num(tableData.total.ach_pct) >= 100 ? "bg-[var(--pos-bg)] text-[var(--pos)] " :
 num(tableData.total.ach_pct) >= 90 ? "bg-[var(--warn-bg)] text-[var(--warn)] " :
 "bg-[var(--neg-bg)] text-[var(--neg)] "
 }`}>{pct(tableData.total.ach_pct)}</span>
                      )}
                      {open ? <ChevronDown size={16} className="text-[var(--muted)]" /> : <ChevronRight size={16} className="text-[var(--muted)]" />}
                    </div>
                  </button>

                  {/* Table */}
                  {open && (
                    <div className="overflow-x-auto border-t border-[var(--line-soft)]">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-[var(--surface-2)] text-[var(--muted)]">
                            <th className="sticky left-0 z-10 bg-[var(--surface-2)] px-4 py-2 text-left font-semibold">Area</th>
                            <th className="px-3 py-2 text-right font-semibold">{t("kpi.target")}</th>
                            <th className="px-3 py-2 text-right font-semibold">{t("label.actual")}</th>
                            <th className="px-3 py-2 text-center font-semibold">Ach%</th>
                            <th className="px-3 py-2 text-center font-semibold">Days</th>
                            <th className="px-3 py-2 text-right font-semibold">Req/Day</th>
                            <th className="px-3 py-2 text-right font-semibold text-[var(--muted)]">YTD Target</th>
                            <th className="px-3 py-2 text-right font-semibold text-[var(--muted)]">YTD Actual</th>
                            <th className="px-3 py-2 text-center font-semibold">YTD%</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--line-soft)] dark:divide-slate-800">
                          {(tableData.rows || []).map((row: any, idx: number) => {
                            const achPct = num(row.ach_pct);
                            return (
                              <tr key={idx} className="hover:bg-[var(--surface-2)]">
                                <td className="sticky left-0 z-10 bg-[var(--surface)] px-4 py-2.5 font-medium text-[var(--ink)]">{displayLabel(row.label)}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-[var(--muted)]">{fmt(row.target)}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-[var(--ink)]">{fmt(row.actual)}</td>
                                <td className="px-3 py-2.5 text-center">
                                  <span className={`inline-block min-w-[48px] rounded-full px-2 py-0.5 text-center text-[10px] font-bold ${
 achPct >= 100 ? "bg-[var(--pos-bg)] text-[var(--pos)] " :
 achPct >= 90 ? "bg-[var(--warn-bg)] text-[var(--warn)] " :
 "bg-[var(--neg-bg)] text-[var(--neg)] "
 }`}>{pct(achPct)}</span>
                                </td>
                                <td className="px-3 py-2.5 text-center tabular-nums text-[var(--muted)]">{row.working_days_left}</td>
                                <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${num(row.daily_remind) > 0 ? "text-[var(--brand)]" : "text-[var(--pos)]"}`}>{fmt(row.daily_remind)}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-[var(--muted)]">{fmt(row.ytd_target)}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-[var(--muted)]">{fmt(row.ytd_actual)}</td>
                                <td className="px-3 py-2.5 text-center tabular-nums font-medium text-[var(--ink-soft)]">{num(row.ytd_ach_pct).toFixed(0)}%</td>
                              </tr>
                            );
                          })}
                          {/* Total row */}
                          {tableData.total && (
                            <tr className="border-t-2 border-[var(--line)] bg-[var(--surface-2)] font-semibold">
                              <td className="sticky left-0 z-10 bg-[var(--surface-2)] px-4 py-3 text-[var(--ink)]">TOTAL</td>
                              <td className="px-3 py-3 text-right tabular-nums text-[var(--ink-soft)]">{fmt(tableData.total.target)}</td>
                              <td className="px-3 py-3 text-right tabular-nums text-[var(--ink)]">{fmt(tableData.total.actual)}</td>
                              <td className="px-3 py-3 text-center">
                                <span className={`inline-block min-w-[48px] rounded-full px-2 py-0.5 text-center text-[10px] font-bold ${
 num(tableData.total.ach_pct) >= 100 ? "bg-[var(--pos-bg)] text-[var(--pos)] dark:text-emerald-300" :
 num(tableData.total.ach_pct) >= 90 ? "bg-[var(--warn-bg)] text-[var(--warn)] dark:text-amber-300" :
 "bg-[var(--neg-bg)] text-[var(--neg)] dark:text-rose-300"
 }`}>{pct(tableData.total.ach_pct)}</span>
                              </td>
                              <td className="px-3 py-3 text-center tabular-nums">{tableData.total.working_days_left}</td>
                              <td className={`px-3 py-3 text-right tabular-nums ${num(tableData.total.daily_remind) > 0 ? "text-[var(--brand)]" : "text-[var(--pos)]"}`}>{fmt(tableData.total.daily_remind)}</td>
                              <td className="px-3 py-3 text-right tabular-nums text-[var(--muted)]">{fmt(tableData.total.ytd_target)}</td>
                              <td className="px-3 py-3 text-right tabular-nums text-[var(--muted)]">{fmt(tableData.total.ytd_actual)}</td>
                              <td className="px-3 py-3 text-center tabular-nums text-[var(--ink-soft)]">{num(tableData.total.ytd_ach_pct).toFixed(0)}%</td>
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
          <div className="flex items-center justify-center rounded-[var(--r-md)] border border-dashed border-[var(--line)] py-20">
            <p className="text-sm text-[var(--muted)]">{t("label.noData")}</p>
          </div>
        )}

      </main>
    </div>
  );
}
