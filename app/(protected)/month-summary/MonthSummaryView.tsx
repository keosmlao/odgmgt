"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  MoveHorizontal,
  RefreshCw,
} from "lucide-react";
import api from "@/service/api";
import { downloadCsv } from "@/lib/csv";
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
  /** ກິບທີ່ບໍ່ມີຄໍລຳຮັບ — ນັບຢູ່ໜ້າພາບລວມການຂາຍ ແຕ່ບໍ່ຢູ່ໃນຕາຕະລາງນີ້. */
  outside: number | null;
};

type Column = { key: string; group: string; label: string };
type Group = { key: string; label: string };

type Payload = {
  meta: {
    year: number;
    month: number;
    last_year: number;
    /** Latest sale date behind the numbers — blank if the source is empty. */
    data_through?: string | null;
  };
  groups: Group[];
  columns: Column[];
  sections: Section[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Excel-like: thousands separated, negatives in parentheses, blank on zero. */
const fmt = (value: number) => {
  const n = Number(value || 0);
  if (!n) return "–";
  const text = Math.abs(Math.round(n)).toLocaleString("en-US");
  return n < 0 ? `(${text})` : text;
};

const pctText = (value: number) => `${Math.round(Number(value || 0))}%`;

/**
 * Three bands rather than two. Hit-or-missed is the wrong question for a month
 * still being closed: 96% of plan is not the same news as 44%, and painting
 * both of them the same red left nothing on the sheet to steer by.
 */
const tone = (value: number) => {
  const n = Number(value || 0);
  if (!n) return "muted";
  if (n >= 100) return "pos";
  if (n >= 90) return "warn";
  return "neg";
};

const TONE_PILL: Record<string, string> = {
  pos: "pill-pos",
  warn: "pill-warn",
  neg: "pill-neg",
  muted: "pill-muted",
};

const TONE_INK: Record<string, string> = {
  pos: "text-[var(--pos)]",
  warn: "text-[var(--warn)]",
  neg: "text-[var(--neg)]",
  muted: "text-[var(--muted)]",
};

/** ເດືອນ/ປີ ທີ່ເລືອກຄ້າງໄວ້ ເມື່ອ refresh ໜ້າ. */
const PERIOD_KEY = "odg_month_summary_period";
const DENSITY_KEY = "odg_month_summary_density";

/**
 * ທັງບໍລິສັດ · ພາກໃຕ້ (ສະຫວັນນະເຂດລົງໄປ) · ສຳນັກງານໃຫ່ຍ (ສ່ວນທີ່ເຫຼືອ).
 * One sheet, three menu entries: the region only changes which rows the API
 * counts, so the page under it is the same page.
 */
export type Region = "all" | "south" | "hq";

const REGION_LABEL: Record<Region, string> = {
  all: "",
  south: "monthSummary.regionSouth",
  hq: "monthSummary.regionHq",
};

export default function MonthSummaryView({ region = "all" }: { region?: Region }) {
  const { t } = useLanguage();
  const now = new Date();
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [year, setYear] = useState(String(previous.getFullYear()));
  const [month, setMonth] = useState(String(previous.getMonth() + 1));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<Payload | null>(null);
  const [compact, setCompact] = useState(false);

  const [restored, setRestored] = useState(false);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PERIOD_KEY) || "null");
      if (saved && saved.year && saved.month) {
        setYear(String(saved.year));
        setMonth(String(saved.month));
      }
    } catch {
      localStorage.removeItem(PERIOD_KEY);
    }
    setCompact(localStorage.getItem(DENSITY_KEY) === "compact");
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    localStorage.setItem(PERIOD_KEY, JSON.stringify({ year, month }));
  }, [restored, year, month]);

  useEffect(() => {
    if (!restored) return;
    localStorage.setItem(DENSITY_KEY, compact ? "compact" : "roomy");
  }, [restored, compact]);

  /**
   * Opening the page recomputes from whatever odg_sale_detail holds now; the
   * Refresh button skips the server's cache, so a number can always be cleared
   * by hand rather than waited out.
   */
  const load = async (force = false) => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/month-summary", {
        params: {
          year,
          month,
          ...(region === "all" ? {} : { region }),
          ...(force ? { refresh: 1 } : {}),
        },
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
  }, [restored, year, month, region]);

  const years = useMemo(() => {
    const current = new Date().getFullYear();
    return [current + 1, current, current - 1, current - 2].map(String);
  }, []);

  /** ‹ › walk the calendar, so December steps back into the year before it. */
  const step = (delta: number) => {
    const index = Number(year) * 12 + (Number(month) - 1) + delta;
    const nextYear = Math.floor(index / 12);
    if (!years.includes(String(nextYear))) return;
    setYear(String(nextYear));
    setMonth(String((index % 12) + 1));
  };
  const canStep = (delta: number) => {
    const index = Number(year) * 12 + (Number(month) - 1) + delta;
    return years.includes(String(Math.floor(index / 12)));
  };

  const groupSpans = useMemo(() => {
    if (!data) return [];
    return data.groups
      .map((group) => ({
        ...group,
        span: data.columns.filter((column) => column.group === group.key).length,
      }))
      .filter((group) => group.span > 0);
  }, [data]);

  /** True where a column opens a new group — the sheet's only vertical rules. */
  const groupStart = (index: number) =>
    index === 0 || data?.columns[index - 1]?.group !== data?.columns[index]?.group;

  /**
   * Short titles for the screen. The API keeps the spreadsheet's own wording
   * ("PreviousMonth_7/2026") and the CSV still exports it, but a tile is two
   * inches wide and a month name reads faster than a slug.
   */
  const shortLabel = (section: Section) => {
    if (!data) return section.label;
    const { month: m, year: y } = data.meta;
    if (section.key === "month") return `${MONTHS[m - 1]} ${y}`;
    if (section.key === "ytd") return `YTD 1–${m}`;
    if (section.key === "roy") return m >= 12 ? "ROY –" : `ROY ${m + 1}–12`;
    return "ACT + ROY";
  };

  /** One row per section × metric, columns spread wide like the table. */
  const exportCsv = () => {
    if (!data) return;
    const headers = ["section", "metric", t("monthSummary.totalCompany"), ...data.columns.map((c) => c.label)];
    const rows: (string | number)[][] = [];
    data.sections.forEach((section) => {
      const metrics: [string, (c: Cell) => number, number][] = [
        ["Target", (c) => c.target, section.total.target],
        [section.value_label, (c) => c.value, section.total.value],
        ["%", (c) => c.pct, section.total.pct],
        ["Last year", (c) => c.last_year, section.total.last_year],
        ["Growth", (c) => c.growth, section.total.growth],
      ];
      metrics.forEach(([metric, pick, totalValue]) => {
        rows.push([
          section.label,
          metric,
          Math.round(totalValue * 100) / 100,
          ...data.columns.map((column) => {
            const cell = section.cells[column.key];
            return cell ? Math.round(pick(cell) * 100) / 100 : 0;
          }),
        ]);
      });
    });
    const suffix = region === "all" ? "" : `-${region}`;
    downloadCsv(
      `month-summary${suffix}-${data.meta.year}-${String(data.meta.month).padStart(2, "0")}`,
      headers,
      rows,
    );
  };

  /** ── Headline tile: the block's number, how far into plan, and versus last year. */
  const renderTile = (section: Section, featured: boolean) => {
    const { total } = section;
    const forecast = section.value_label !== "ACT";
    const achieved = tone(total.pct);
    const grew = Number(total.growth || 0) >= 100;

    return (
      <div key={section.key} className={`card stat ms-kpi ${featured ? "stat-featured" : ""}`}>
        <div className="ms-kpi-top">
          <div>
            <p className="stat-label">{shortLabel(section)}</p>
            <p className="stat-value">{fmt(total.value)}</p>
          </div>
          <span className={`pill ${forecast ? "pill-warn" : "pill-muted"}`}>
            {forecast ? t("monthSummary.forecast") : "ACT"}
          </span>
        </div>

        <div className="bar" title={pctText(total.pct)}>
          <div
            className={`bar-fill is-${achieved === "muted" ? "warn" : achieved}`}
            style={{ width: `${Math.max(2, Math.min(100, Number(total.pct || 0)))}%` }}
          />
        </div>

        <div className="ms-kpi-foot">
          <span>
            {t("kpi.target")} {fmt(total.target)} ·{" "}
            <b className={featured ? "" : TONE_INK[achieved]}>{pctText(total.pct)}</b>
          </span>
          <span className={`pill ${featured ? "" : grew ? "pill-pos" : "pill-neg"}`}>
            {grew ? "▲" : "▼"} {pctText(total.growth)}
          </span>
        </div>
      </div>
    );
  };

  /** One report block: target, actual/forecast, %, last year, growth. */
  const renderSection = (section: Section) => {
    const columns = data?.columns || [];

    const row = (
      key: string,
      label: string,
      pick: (cell: Cell) => number,
      pickTotal: () => number,
      opts: { percent?: boolean; act?: boolean; staff?: number | null } = {},
    ) => {
      const render = (value: number) => {
        if (!opts.percent) return fmt(value);
        const toned = tone(value);
        return key === "pct" ? (
          <span className={`pill ${TONE_PILL[toned]}`}>{pctText(value)}</span>
        ) : (
          <span className={TONE_INK[toned]}>
            {value ? (value >= 100 ? "▲ " : "▼ ") : ""}
            {value ? pctText(value) : "–"}
          </span>
        );
      };

      return (
        <tr key={`${section.key}-${key}`} className={opts.act ? "ms-row-act" : ""}>
          <td className="ms-c1">{label}</td>
          <td className="ms-c2">{render(pickTotal())}</td>
          {columns.map((column, index) => {
            const cell = section.cells[column.key];
            return (
              <td
                key={column.key}
                className={`g-${column.group} ${groupStart(index) ? "is-gstart" : ""}`}
              >
                {render(cell ? pick(cell) : 0)}
              </td>
            );
          })}
          <td className="is-gstart text-[var(--muted)]">
            {opts.staff == null ? "" : fmt(opts.staff)}
          </td>
        </tr>
      );
    };

    return (
      <tbody key={section.key}>
        {/* The spreadsheet's own wording stays on the row as its title — the band
            itself carries the short name and the block's achievement, both in the
            frozen columns, so they survive a sideways scroll. */}
        <tr className={`ms-band is-${section.key}`} title={section.label}>
          <td className="ms-c1">
            <div className="ms-band-cell">{shortLabel(section)}</div>
          </td>
          <td className="ms-c2">
            <div className="ms-band-cell justify-end">
              <span className="pill">{pctText(section.total.pct)}</span>
            </div>
          </td>
          <td colSpan={columns.length + 1}>
            <div className="ms-band-cell" />
          </td>
        </tr>
        {row("target", t("kpi.target"), (c) => c.target, () => section.total.target)}
        {row("value", section.value_label, (c) => c.value, () => section.total.value, {
          act: true,
          staff: section.staff,
        })}
        {row("pct", t("dash.achievement"), (c) => c.pct, () => section.total.pct, { percent: true })}
        {row("ly", t("kpi.lastYear"), (c) => c.last_year, () => section.total.last_year)}
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
    <div className="min-h-screen bg-transparent">
      {/* ══ Header ══ */}
      <header className="page-hd">
        <div>
          <p className="eyebrow">Monthly close</p>
          <h1 className="page-title">
            {t("monthSummary.title")}
            {region !== "all" && <span className="ms-region">{t(REGION_LABEL[region])}</span>}
          </h1>
          <div className="page-sub mt-0.5 flex flex-wrap items-center gap-1.5">
            {data ? (
              <>
                <span>
                  {MONTHS[data.meta.month - 1]} {data.meta.year} · vs {data.meta.last_year}
                </span>
                {data.meta.data_through && (
                  <span className="pill pill-muted">
                    <Clock3 size={10} /> {t("monthSummary.dataThrough")} {data.meta.data_through}
                  </span>
                )}
              </>
            ) : (
              t("app.loading")
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="ms-controls">
            <button
              onClick={() => step(-1)}
              disabled={!canStep(-1)}
              className="btn btn-icon"
              aria-label={t("monthSummary.prevMonth")}
              title={t("monthSummary.prevMonth")}
            >
              <ChevronLeft size={15} />
            </button>
            <select value={month} onChange={(e) => setMonth(e.target.value)} className="select" aria-label={t("monthSummary.month")}>
              {MONTHS.map((label, index) => (
                <option key={label} value={String(index + 1)}>
                  {label}
                </option>
              ))}
            </select>
            <span className="ms-sep" />
            <select value={year} onChange={(e) => setYear(e.target.value)} className="select" aria-label={t("filter.year")}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <button
              onClick={() => step(1)}
              disabled={!canStep(1)}
              className="btn btn-icon"
              aria-label={t("monthSummary.nextMonth")}
              title={t("monthSummary.nextMonth")}
            >
              <ChevronRight size={15} />
            </button>
          </div>

          <button onClick={exportCsv} className="btn" disabled={!data}>
            <Download size={13} /> {t("app.exportCsv")}
          </button>
          <button onClick={() => load(true)} className="btn btn-primary" disabled={loading}>
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />{" "}
            {t("monthSummary.refresh")}
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

        {/* First paint: the shape of the page arrives before the numbers do. */}
        {loading && !data && (
          <>
            <div className="ms-kpis">
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className="skeleton h-[7.5rem]" />
              ))}
            </div>
            <div className="skeleton mt-3 h-[26rem]" />
          </>
        )}

        {data && (
          <div className={loading ? "ms-busy" : ""}>
            <section className="ms-kpis">
              {data.sections.map((section) => renderTile(section, section.key === "month"))}
            </section>

            <div className="card mt-3">
              <div className="card-hd">
                <span className="card-title">{t("monthSummary.sheet")}</span>
                <div className="flex items-center gap-2">
                  <span className="pill pill-muted ms-swipe">
                    <MoveHorizontal size={10} /> {t("monthSummary.swipe")}
                  </span>
                  <div className="tabs">
                    <button
                      onClick={() => setCompact(false)}
                      className={`tab ${compact ? "" : "is-active"}`}
                    >
                      {t("monthSummary.roomy")}
                    </button>
                    <button
                      onClick={() => setCompact(true)}
                      className={`tab ${compact ? "is-active" : ""}`}
                    >
                      {t("monthSummary.compact")}
                    </button>
                  </div>
                </div>
              </div>

              <div className="ms-scroll">
                <table className={`ms-sheet ${compact ? "is-compact" : ""}`}>
                  <thead>
                    <tr>
                      <th className="ms-c1" rowSpan={2} />
                      <th className="ms-c2" rowSpan={2}>
                        {t("monthSummary.totalCompany")}
                      </th>
                      {groupSpans.map((group) => (
                        <th
                          key={group.key}
                          colSpan={group.span}
                          className={`ms-group g-${group.key} is-gstart`}
                        >
                          {group.label}
                        </th>
                      ))}
                      <th className="is-gstart" rowSpan={2}>
                        {t("monthSummary.staff")}
                      </th>
                    </tr>
                    <tr>
                      {data.columns.map((column, index) => (
                        <th
                          key={column.key}
                          className={`ms-col g-${column.group} ${groupStart(index) ? "is-gstart" : ""}`}
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

            <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">
              {t("monthSummary.note")}
              {data.sections
                .filter((section) => section.outside)
                .map(
                  (section) =>
                    ` · ${t("monthSummary.outside")} ${shortLabel(section)} ${fmt(section.outside || 0)}`,
                )
                .join("")}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
