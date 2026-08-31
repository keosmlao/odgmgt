"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Clock3, Download, Loader2, RefreshCw } from "lucide-react";
import api from "@/service/api";
import { downloadCsv } from "@/lib/csv";
import { useLanguage } from "@/context/LanguageContext";
import SaleSyncBadge from "@/components/SaleSyncBadge";

/**
 * ຄາດການຍອດຂາຍ — the month read forward instead of backward.
 *
 * Every other sales page answers "how much has been sold". Mid-month that is
 * only half the question: the plan covers the whole month and the kip on the
 * screen covers the days gone by. This page finishes the sentence — pace,
 * where the month lands, what it misses by, and what has to be sold per day
 * for the rest of it to still make plan. /api/sales-forecast is where the
 * method lives; it is the one /sales-overview forecasts with.
 */

type Line = {
  key?: string;
  label: string;
  target: number;
  actual: number;
  pct: number;
  pace: number;
  projected: number;
  adjusted: number;
  projected_pct: number;
  shortfall: number;
  required_per_day: number;
  last_year: number;
  growth: number;
  ytd_target: number;
  ytd_actual: number;
  ytd_pct: number;
  ytd_last_year: number;
  ytd_growth: number;
  children?: Line[];
};

type Payload = {
  meta: {
    year: number;
    month: number;
    last_year: number;
    data_through: string | null;
    cut_day: number;
    running: boolean;
    selling_days: { total: number; elapsed: number; remaining: number };
    bias_pct: number;
    bias_months: number;
  };
  total: Line;
  rows: Line[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const num = (value: unknown) => Number(value || 0);
const fmt = (value: unknown) => {
  const n = num(value);
  if (!n) return "–";
  const text = Math.abs(Math.round(n)).toLocaleString("en-US");
  return n < 0 ? `(${text})` : text;
};
const pct = (value: unknown) => `${Math.round(num(value))}%`;
const asLaoDate = (iso: string) => iso.split("-").reverse().join("-");

/** Same three bands as the month sheet: 96% of plan is not the news 44% is. */
const tone = (value: number) => {
  const n = num(value);
  if (!n) return "pill-muted";
  if (n >= 100) return "pill-pos";
  if (n >= 90) return "pill-warn";
  return "pill-neg";
};

const PERIOD_KEY = "odg_sales_forecast_period";

export default function SalesForecastPage() {
  const { t } = useLanguage();
  const now = new Date();

  const [year, setYear] = useState(String(now.getFullYear()));
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [scope, setScope] = useState<"month" | "ytd">("month");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<Payload | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const [restored, setRestored] = useState(false);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PERIOD_KEY) || "null");
      if (saved?.year && saved?.month) {
        setYear(String(saved.year));
        setMonth(String(saved.month));
      }
    } catch {
      localStorage.removeItem(PERIOD_KEY);
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    localStorage.setItem(PERIOD_KEY, JSON.stringify({ year, month }));
  }, [restored, year, month]);

  const load = async (force = false) => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/sales-forecast", {
        params: { year, month, ...(force ? { refresh: 1 } : {}) },
      });
      if (res.data?.success) setData(res.data.data);
      else {
        setData(null);
        setError(res.data?.error || t("app.error"));
      }
    } catch {
      setData(null);
      setError(t("app.error"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!restored) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored, year, month]);

  const years = useMemo(() => {
    const current = new Date().getFullYear();
    return [current + 1, current, current - 1].map(String);
  }, []);

  const meta = data?.meta;
  const total = data?.total;

  /** ຂາຍແລ້ວ ແລະ ຄາດການ, drawn against the plan on one track. */
  const bar = useMemo(() => {
    if (!total) return null;
    const scale = Math.max(total.target, total.adjusted, 1);
    return {
      booked: Math.min(100, (total.actual / scale) * 100),
      pace: Math.min(100, (Math.max(0, total.adjusted - total.actual) / scale) * 100),
      target: Math.min(100, (total.target / scale) * 100),
    };
  }, [total]);

  const exportCsv = () => {
    if (!data) return;
    const headers = [
      "level", "name",
      "target", "actual_to_date", "pct",
      "pace_per_day", "projected_month_end", "projected_pct", "shortfall", "required_per_day",
      "last_year_same_days", "growth_pct",
      "ytd_target", "ytd_actual", "ytd_pct", "ytd_last_year", "ytd_growth_pct",
    ];
    const line = (row: Line, level: string) => [
      level, row.label,
      Math.round(row.target), Math.round(row.actual), Math.round(row.pct),
      Math.round(row.pace), Math.round(row.adjusted), Math.round(row.projected_pct),
      Math.round(row.shortfall), Math.round(row.required_per_day),
      Math.round(row.last_year), Math.round(row.growth),
      Math.round(row.ytd_target), Math.round(row.ytd_actual), Math.round(row.ytd_pct),
      Math.round(row.ytd_last_year), Math.round(row.ytd_growth),
    ];
    const out: (string | number)[][] = [line(data.total, "TOTAL")];
    for (const row of data.rows) {
      out.push(line(row, "BU"));
      for (const child of row.children || []) out.push(line(child, "CHANNEL"));
    }
    downloadCsv(
      `sales-forecast-${data.meta.year}-${String(data.meta.month).padStart(2, "0")}`,
      headers,
      out,
    );
  };

  /** One line of the table; children are indented under their BU. */
  const renderRow = (row: Line, depth: number, extra = "") => {
    const id = row.key || row.label;
    const hasChildren = !!row.children?.length;
    const isOpen = !!open[id];
    const monthCells = (
      <>
        <td className="fc-n">{fmt(row.target)}</td>
        <td className="fc-n fc-strong">{fmt(row.actual)}</td>
        <td className="fc-n"><span className={`pill ${tone(row.pct)}`}>{pct(row.pct)}</span></td>
        <td className="fc-n">{fmt(row.pace)}</td>
        <td className="fc-n fc-strong">{fmt(row.adjusted)}</td>
        <td className="fc-n">
          <span className={`pill ${tone(row.projected_pct)}`}>{pct(row.projected_pct)}</span>
        </td>
        <td className="fc-n">
          {row.shortfall ? (
            <span className="text-[var(--neg)]">{fmt(row.shortfall)}</span>
          ) : (
            <span className="text-[var(--pos)]">{fmt(row.adjusted - row.target)}</span>
          )}
        </td>
        <td className="fc-n">{fmt(row.required_per_day)}</td>
        <td className="fc-n">{fmt(row.last_year)}</td>
        <td className="fc-n">
          <span className={num(row.growth) >= 100 ? "text-[var(--pos)]" : "text-[var(--neg)]"}>
            {row.growth ? `${num(row.growth) >= 100 ? "▲" : "▼"} ${pct(row.growth)}` : "–"}
          </span>
        </td>
      </>
    );
    const ytdCells = (
      <>
        <td className="fc-n">{fmt(row.ytd_target)}</td>
        <td className="fc-n fc-strong">{fmt(row.ytd_actual)}</td>
        <td className="fc-n"><span className={`pill ${tone(row.ytd_pct)}`}>{pct(row.ytd_pct)}</span></td>
        <td className="fc-n">{fmt(row.ytd_target - row.ytd_actual)}</td>
        <td className="fc-n">{fmt(row.ytd_last_year)}</td>
        <td className="fc-n">
          <span className={num(row.ytd_growth) >= 100 ? "text-[var(--pos)]" : "text-[var(--neg)]"}>
            {row.ytd_growth ? `${num(row.ytd_growth) >= 100 ? "▲" : "▼"} ${pct(row.ytd_growth)}` : "–"}
          </span>
        </td>
      </>
    );

    return (
      <tr key={id} className={`${depth ? "fc-child" : ""} ${extra}`}>
        <td className="fc-name">
          <div style={{ paddingLeft: `${depth * 16}px` }} className="flex items-center gap-1.5">
            {hasChildren ? (
              <button
                onClick={() => setOpen((prev) => ({ ...prev, [id]: !prev[id] }))}
                className="text-[var(--muted)] hover:text-[var(--ink)]"
                aria-label={row.label}
              >
                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
            ) : (
              <span className="w-[13px]" />
            )}
            <span className={depth ? "text-[var(--ink-soft)]" : "font-semibold text-[var(--ink)]"}>
              {row.label}
            </span>
          </div>
        </td>
        {scope === "month" ? monthCells : ytdCells}
      </tr>
    );
  };

  const visible = (rows: Line[]): { row: Line; depth: number }[] =>
    rows.flatMap((row) => [
      { row, depth: 0 },
      ...(open[row.key || row.label] ? (row.children || []).map((c) => ({ row: c, depth: 1 })) : []),
    ]);

  return (
    <div className="min-h-screen bg-transparent">
      {/* ══ Header ══ */}
      <header className="page-hd">
        <div>
          <p className="eyebrow">Sales forecast</p>
          <h1 className="page-title">{t("salesForecast.title")}</h1>
          <div className="page-sub mt-0.5 flex flex-wrap items-center gap-1.5">
            {meta ? (
              <>
                <span>
                  {MONTHS[meta.month - 1]} {meta.year}
                  {meta.running ? ` · 1–${meta.cut_day}` : ""} · vs {meta.last_year}
                </span>
                {meta.data_through && (
                  <span className="pill pill-muted">
                    <Clock3 size={10} /> {t("monthSummary.dataThrough")} {asLaoDate(meta.data_through)}
                  </span>
                )}
                {/* ເວລາອັບເດດ ແລະ ນັບຖອຍຫຼັງຮອບຕໍ່ໄປ. */}
                <SaleSyncBadge onUpdated={() => load(true)} />
                <span className="pill pill-muted">
                  {t("salesForecast.sellingDays")} {meta.selling_days.elapsed}/{meta.selling_days.total}
                  {meta.selling_days.remaining
                    ? ` · ${t("salesForecast.daysLeft")} ${meta.selling_days.remaining}`
                    : ""}
                </span>
              </>
            ) : (
              t("app.loading")
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="select"
            aria-label={t("monthSummary.month")}
          >
            {MONTHS.map((label, index) => (
              <option key={label} value={String(index + 1)}>{label}</option>
            ))}
          </select>
          <select
            value={year}
            onChange={(e) => setYear(e.target.value)}
            className="select"
            aria-label={t("filter.year")}
          >
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={exportCsv} className="btn" disabled={!data}>
            <Download size={13} /> {t("app.exportCsv")}
          </button>
          <button onClick={() => load(true)} className="btn btn-primary" disabled={loading}>
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> {t("monthSummary.refresh")}
          </button>
        </div>
      </header>

      <main className="page">
        {error && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--r-md)] border border-[var(--neg)] bg-[var(--neg-bg)] px-4 py-3 text-sm text-[var(--neg)]">
            <span>{error}</span>
            <button onClick={() => load(true)} className="btn">
              <RefreshCw size={13} /> {t("app.retry")}
            </button>
          </div>
        )}

        {loading && !data && (
          <div className="flex items-center justify-center rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface)] py-20">
            <Loader2 className="h-7 w-7 animate-spin text-[var(--brand)]" />
          </div>
        )}

        {data && total && meta && (
          <div className={loading ? "ms-busy" : ""}>
            {/* ══ Where the month lands ══ */}
            <section className="ms-kpis fc-kpis">
              {[
                { label: t("kpi.target"), value: total.target, note: `${MONTHS[meta.month - 1]} ${meta.year}` },
                {
                  label: `${t("salesForecast.sold")} 1–${meta.cut_day}`,
                  value: total.actual,
                  note: `${pct(total.pct)} ${t("salesForecast.ofTarget")}`,
                },
                {
                  label: t("salesForecast.projected"),
                  value: total.adjusted,
                  note: `${pct(total.projected_pct)} ${t("salesForecast.ofTarget")}`,
                  featured: true,
                },
                {
                  label: total.shortfall ? t("salesForecast.shortfall") : t("salesForecast.surplus"),
                  value: total.shortfall || total.adjusted - total.target,
                  note: t("salesForecast.ifPaceHolds"),
                },
                {
                  label: t("salesForecast.requiredPerDay"),
                  value: total.required_per_day,
                  note: `${meta.selling_days.remaining} ${t("salesForecast.daysLeft")}`,
                },
              ].map((card) => (
                <div key={card.label} className={`card stat ms-kpi ${card.featured ? "stat-featured" : ""}`}>
                  <p className="stat-label">{card.label}</p>
                  <p className="stat-value">{fmt(card.value)}</p>
                  <p className="mt-1 text-[11px] text-[var(--muted)]">{card.note}</p>
                </div>
              ))}
            </section>

            {/* ຂາຍແລ້ວ + ສ່ວນທີ່ຄວາມໄວຈະພາໄປ, ທຽບກັບເປົ້າ */}
            {bar && (
              <div className="card mt-3 px-5 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="card-title">{t("salesForecast.paceTitle")}</span>
                  <span className="text-[11px] text-[var(--muted)]">
                    {t("kpi.target")} {fmt(total.target)} · {t("salesForecast.projected")}{" "}
                    <b className="text-[var(--ink-soft)]">{fmt(total.adjusted)}</b>
                  </span>
                </div>
                <div className="fc-bar mt-3">
                  <div className="fc-bar-booked" style={{ width: `${bar.booked}%` }} />
                  <div className="fc-bar-pace" style={{ width: `${bar.pace}%` }} />
                  <div className="fc-bar-target" style={{ left: `${bar.target}%` }} />
                </div>
                <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-[var(--muted)]">
                  <span className="fc-key fc-key-booked">
                    {t("salesForecast.sold")} {fmt(total.actual)}
                  </span>
                  <span className="fc-key fc-key-pace">
                    {t("salesForecast.fromPace")} {fmt(Math.max(0, total.adjusted - total.actual))}
                  </span>
                  <span className="fc-key fc-key-target">{t("kpi.target")} {fmt(total.target)}</span>
                </div>
              </div>
            )}

            {/* ══ ແຍກຕາມ BU ══ */}
            <div className="card mt-3">
              <div className="card-hd">
                <span className="card-title">{t("salesForecast.byBu")}</span>
                <div className="tabs">
                  <button
                    onClick={() => setScope("month")}
                    className={`tab ${scope === "month" ? "is-active" : ""}`}
                  >
                    {MONTHS[meta.month - 1]} {meta.running ? `1–${meta.cut_day}` : ""}
                  </button>
                  <button
                    onClick={() => setScope("ytd")}
                    className={`tab ${scope === "ytd" ? "is-active" : ""}`}
                  >
                    YTD 1–{meta.month}
                  </button>
                </div>
              </div>

              <div className="fc-scroll">
                <table className="fc-sheet">
                  <thead>
                    <tr>
                      <th className="fc-name">{t("salesForecast.line")}</th>
                      {scope === "month" ? (
                        <>
                          <th>{t("kpi.target")}</th>
                          <th>{t("salesForecast.sold")} 1–{meta.cut_day}</th>
                          <th>%</th>
                          <th>{t("salesForecast.perDay")}</th>
                          <th>{t("salesForecast.projected")}</th>
                          <th>%</th>
                          <th>{t("salesForecast.gap")}</th>
                          <th>{t("salesForecast.requiredPerDay")}</th>
                          <th>{t("kpi.lastYear")} 1–{meta.cut_day}</th>
                          <th>{meta.year}/{meta.last_year}</th>
                        </>
                      ) : (
                        <>
                          <th>{t("kpi.target")} YTD</th>
                          <th>ACT YTD</th>
                          <th>%</th>
                          <th>{t("salesForecast.gap")}</th>
                          <th>{t("kpi.lastYear")} YTD</th>
                          <th>{meta.year}/{meta.last_year}</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {renderRow({ ...total, key: "TOTAL", children: [] }, 0, "fc-total")}
                    {visible(data.rows).map(({ row, depth }) => renderRow(row, depth))}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">
              {t("salesForecast.note")}
              {meta.bias_months
                ? ` · ${t("salesForecast.bias")} ${meta.bias_pct >= 0 ? "+" : ""}${Math.round(meta.bias_pct)}% (${meta.bias_months} ${t("salesForecast.months")})`
                : ""}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
