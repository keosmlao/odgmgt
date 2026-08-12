"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import api from "@/service/api";
import { useLanguage } from "@/context/LanguageContext";

type Cell = {
  target: number;
  value: number;
  pct: number;
  last_year: number;
  growth: number;
};

type Section = {
  key: string;
  label: string;
  value_label: string;
  cells: Record<string, Cell>;
  total: { target: number; value: number; last_year: number; pct: number; growth: number };
  staff: number | null;
};

type Column = { key: string; group: string; label: string };
type Group = { key: string; label: string };

type Payload = {
  meta: { year: number; month: number; last_year: number };
  groups: Group[];
  columns: Column[];
  sections: Section[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Excel-like: thousands separated, negatives in parentheses, blank on zero. */
const fmt = (value: number) => {
  const n = Number(value || 0);
  if (!n) return "-";
  const text = Math.abs(Math.round(n)).toLocaleString("en-US");
  return n < 0 ? `(${text})` : text;
};

const pctText = (value: number) => `${Math.round(Number(value || 0))}%`;
const pctClass = (value: number) =>
  Number(value || 0) >= 100 ? "text-[var(--pos)]" : "text-[var(--neg)]";

/** Header tint per column group, mirroring the spreadsheet's colour blocks. */
const GROUP_TINT: Record<string, string> = {
  ws: "bg-[var(--info-bg)]",
  retail: "bg-[var(--warn-bg)]",
  project: "bg-[var(--pos-bg)]",
  service: "bg-[var(--surface-2)]",
};

/** Left-hand block colour per report section. */
const SECTION_TINT: Record<string, string> = {
  month: "",
  ytd: "",
  roy: "",
  full: "",
};

const SECTION_HEAD: Record<string, string> = {
  month: "bg-[#003361] text-white",
  ytd: "bg-[#2b70b5] text-white",
  roy: "bg-[#f5911f] text-white",
  full: "bg-[#00243f] text-white",
};

export default function MonthSummary() {
  const { t } = useLanguage();
  const now = new Date();
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [year, setYear] = useState(String(previous.getFullYear()));
  const [month, setMonth] = useState(String(previous.getMonth() + 1));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<Payload | null>(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/month-summary", { params: { year, month } });
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
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month]);

  const years = useMemo(() => {
    const current = new Date().getFullYear();
    return [current + 1, current, current - 1, current - 2].map(String);
  }, []);

  const groupSpans = useMemo(() => {
    if (!data) return [];
    return data.groups
      .map((group) => ({
        ...group,
        span: data.columns.filter((column) => column.group === group.key).length,
      }))
      .filter((group) => group.span > 0);
  }, [data]);

  const sel =
    "rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--brand)]   ";
  const cellCls = "whitespace-nowrap border-l border-[var(--line)] px-3 py-1.5 text-right tabular-nums ";
  const labelCls =
    "sticky left-0 z-10 whitespace-nowrap px-3 py-1.5 text-left text-xs font-medium text-[var(--ink-soft)]";

  /** One report block: target, actual/forecast, %, last year, growth. */
  const renderSection = (section: Section) => {
    const tint = SECTION_TINT[section.key] || "";
    const columns = data?.columns || [];

    const row = (
      key: string,
      label: string,
      pick: (cell: Cell) => number,
      pickTotal: () => number,
      opts: { percent?: boolean; strong?: boolean; staff?: number | null } = {},
    ) => (
      <tr key={`${section.key}-${key}`} className={`${tint} border-t border-[var(--line)]/70 /70`}>
        <td className={`${labelCls} ${tint}`}>{label}</td>
        <td className={`${cellCls} ${opts.strong ? "font-semibold" : ""} ${opts.percent ? pctClass(pickTotal()) : "text-[var(--ink)]"}`}>
          {opts.percent ? pctText(pickTotal()) : fmt(pickTotal())}
        </td>
        {columns.map((column) => {
          const cell = section.cells[column.key];
          const value = cell ? pick(cell) : 0;
          return (
            <td
              key={column.key}
              className={`${cellCls} ${opts.strong ? "font-semibold" : ""} ${
 opts.percent ? pctClass(value) : "text-[var(--ink-soft)]"
 }`}
            >
              {opts.percent ? pctText(value) : fmt(value)}
            </td>
          );
        })}
        <td className={`${cellCls} text-[var(--muted)]`}>
          {opts.staff == null ? "" : fmt(opts.staff)}
        </td>
      </tr>
    );

    return (
      <tbody key={section.key} className="text-xs">
        <tr>
          <td
            className={`sticky left-0 z-10 whitespace-nowrap px-3 py-2 text-left text-xs font-bold ${SECTION_HEAD[section.key] || ""}`}
          >
            {section.label}
          </td>
          <td className={`${SECTION_HEAD[section.key] || ""} border-l border-white/20`} colSpan={(data?.columns.length || 0) + 2} />
        </tr>
        {row("target", "Target", (c) => c.target, () => section.total.target)}
        {row(
          "value",
          section.value_label,
          (c) => c.value,
          () => section.total.value,
          { strong: true, staff: section.staff },
        )}
        {row("pct", "%", (c) => c.pct, () => section.total.pct, { percent: true })}
        {row("ly", "lats year", (c) => c.last_year, () => section.total.last_year)}
        {row(
          "growth",
          `${data?.meta.year}/${data?.meta.last_year}`,
          (c) => c.growth,
          () => section.total.growth,
          { percent: true },
        )}
      </tbody>
    );
  };

  return (
    <div className="min-h-screen bg-transparent" style={{ fontFamily: '"Noto Sans Lao","Noto Sans",system-ui,sans-serif' }}>
      {/* ══ Header ══ */}
      <header className="page-hd flex-col !items-stretch !gap-0 !p-0">
        <div className="flex flex-wrap items-end justify-between gap-3 px-5 py-3 lg:px-6">
          <div>
            <p className="eyebrow">Monthly close</p>
            <h1 className="page-title">
              {t("monthSummary.title")}
            </h1>
            <p className="page-sub">
              {data ? `${MONTHS[data.meta.month - 1]} ${data.meta.year} · vs ${data.meta.last_year}` : t("app.loading")}
            </p>
          </div>
          <div className="flex items-end gap-2">
            <div>
              <label className="field-label">
                {t("filter.year")}
              </label>
              <select value={year} onChange={(e) => setYear(e.target.value)} className={sel}>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label">
                {t("monthSummary.month")}
              </label>
              <select value={month} onChange={(e) => setMonth(e.target.value)} className={sel}>
                {MONTHS.map((label, index) => (
                  <option key={label} value={String(index + 1)}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={load}
              className="btn"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> {t("monthSummary.refresh")}
            </button>
          </div>
        </div>
      </header>

      <main className="px-5 py-5 lg:px-6">
        {loading && !data && (
          <div className="flex items-center justify-center gap-2 py-20 text-sm text-[var(--muted)]">
            <Loader2 size={16} className="animate-spin" /> {t("app.loading")}
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-[var(--r-md)] border border-[var(--neg)] bg-[var(--neg-bg)] px-4 py-3 text-sm text-[var(--neg)] dark:border-rose-800">
            {error}
          </div>
        )}

        {data && (
          <div className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--line)] bg-[var(--surface)] shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-[var(--line)]">
                    <th className="sticky left-0 z-20 bg-[var(--surface)] px-3 py-2 text-left" rowSpan={2} />
                    <th
                      className="whitespace-nowrap border-l border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-right font-semibold text-[var(--ink-soft)]"
                      rowSpan={2}
                    >
                      {t("monthSummary.totalCompany")}
                    </th>
                    {groupSpans.map((group) => (
                      <th
                        key={group.key}
                        colSpan={group.span}
                        className={`whitespace-nowrap border-l border-[var(--line)] px-3 py-2 text-center font-semibold text-[var(--ink)] ${GROUP_TINT[group.key] || ""}`}
                      >
                        {group.label}
                      </th>
                    ))}
                    <th
                      className="whitespace-nowrap border-l border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-right font-semibold text-[var(--ink-soft)]"
                      rowSpan={2}
                    >
                      {t("monthSummary.staff")}
                    </th>
                  </tr>
                  <tr className="border-b border-[var(--line)]">
                    {data.columns.map((column) => (
                      <th
                        key={column.key}
                        className={`whitespace-nowrap border-l border-[var(--line)] px-3 py-1.5 text-right font-semibold text-[var(--ink-soft)] ${GROUP_TINT[column.group] || ""}`}
                      >
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                {data.sections.map(renderSection)}
              </table>
            </div>
          </div>
        )}

        {data && (
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">
            {t("monthSummary.note")}
          </p>
        )}
      </main>
    </div>
  );
}
