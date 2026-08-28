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
  block_totals: Record<string, Cell>;
  /** ລວມ = ສຳນັກງານໃຫ່ຍ + ພາກໃຕ້, ບໍ່ມີສ່ວນໃດຕົກນອກ. */
  total: Cell;
};

type Column = { key: string; block: string; product: string; label: string; is_sum?: boolean };
type Block = { key: string; label: string };

type Payload = {
  meta: {
    year: number;
    month: number;
    last_year: number;
    data_through?: string | null;
  };
  blocks: Block[];
  products: { key: string; label: string }[];
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

/** Same three bands as the month sheet: 96% of plan is not the news 44% is. */
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

const PERIOD_KEY = "odg_wholesale_region_period";
const DENSITY_KEY = "odg_wholesale_region_density";

export default function WholesaleRegionView() {
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

  const load = async (force = false) => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/wholesale-region", {
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
    return [current + 1, current, current - 1, current - 2].map(String);
  }, []);

  /** ‹ › walk the calendar, so January steps back into the year before it. */
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

  const blockSpans = useMemo(() => {
    if (!data) return [];
    return data.blocks
      .map((block) => ({
        ...block,
        span: data.columns.filter((column) => column.block === block.key).length,
      }))
      .filter((block) => block.span > 0);
  }, [data]);

  /** True where a column opens a new block — the sheet's only vertical rules. */
  const blockStart = (index: number) =>
    index === 0 || data?.columns[index - 1]?.block !== data?.columns[index]?.block;

  /** Short titles for the screen; the API keeps the spreadsheet's own wording. */
  const shortLabel = (section: Section) => {
    if (!data) return section.label;
    const { month: m, year: y } = data.meta;
    return section.key === "month" ? `${MONTHS[m - 1]} ${y}` : `YTD 1–${m}`;
  };

  /** The sheet as it stands: one row per section × metric, columns spread wide. */
  const exportCsv = () => {
    if (!data) return;
    const headers = [
      "section",
      "metric",
      t("wholesaleRegion.total"),
      ...data.columns.map(
        (column) =>
          `${data.blocks.find((block) => block.key === column.block)?.label ?? column.block} ${column.label}`,
      ),
    ];
    const rows: (string | number)[][] = [];
    data.sections.forEach((section) => {
      const metrics: [string, (c: Cell) => number][] = [
        ["Target", (c) => c.target],
        [section.value_label, (c) => c.value],
        ["%", (c) => c.pct],
        ["Last year", (c) => c.last_year],
        [`${data.meta.year}/${data.meta.last_year}`, (c) => c.growth],
      ];
      metrics.forEach(([metric, pick]) => {
        rows.push([
          section.label,
          metric,
          Math.round(pick(section.total) * 100) / 100,
          ...data.columns.map((column) => {
            const cell = section.cells[column.key];
            return cell ? Math.round(pick(cell) * 100) / 100 : 0;
          }),
        ]);
      });
    });
    downloadCsv(
      `wholesale-region-${data.meta.year}-${String(data.meta.month).padStart(2, "0")}`,
      headers,
      rows,
    );
  };

  /** ── Headline tile: a block's wholesale kip, how far into plan, versus last year. */
  const renderTile = (
    key: string,
    label: string,
    caption: string,
    cell: Cell,
    featured: boolean,
  ) => {
    const achieved = tone(cell.pct);
    const grew = Number(cell.growth || 0) >= 100;

    return (
      <div key={key} className={`card stat ms-kpi ${featured ? "stat-featured" : ""}`}>
        <div className="ms-kpi-top">
          <div>
            <p className="stat-label">{label}</p>
            <p className="stat-value">{fmt(cell.value)}</p>
          </div>
          <span className="pill pill-muted">{caption}</span>
        </div>

        <div className="bar" title={pctText(cell.pct)}>
          <div
            className={`bar-fill is-${achieved === "muted" ? "warn" : achieved}`}
            style={{ width: `${Math.max(2, Math.min(100, Number(cell.pct || 0)))}%` }}
          />
        </div>

        <div className="ms-kpi-foot">
          <span>
            {t("kpi.target")} {fmt(cell.target)} ·{" "}
            <b className={featured ? "" : TONE_INK[achieved]}>{pctText(cell.pct)}</b>
          </span>
          <span className={`pill ${featured ? "" : grew ? "pill-pos" : "pill-neg"}`}>
            {grew ? "▲" : "▼"} {pctText(cell.growth)}
          </span>
        </div>
      </div>
    );
  };

  /** One report block: Target, ACT, %, last year, this year over last. */
  const renderSection = (section: Section) => {
    const columns = data?.columns || [];

    const row = (
      key: string,
      label: string,
      pick: (cell: Cell) => number,
      opts: { percent?: boolean; act?: boolean } = {},
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
          <td className="ms-c2">{render(pick(section.total))}</td>
          {columns.map((column, index) => {
            const cell = section.cells[column.key];
            return (
              <td
                key={column.key}
                className={`g-${column.block} ${blockStart(index) ? "is-gstart" : ""} ${
                  column.is_sum ? "is-bsum" : ""
                }`}
              >
                {render(cell ? pick(cell) : 0)}
              </td>
            );
          })}
        </tr>
      );
    };

    return (
      <tbody key={section.key}>
        {/* The band carries the short name and the block's achievement, both in
            the frozen columns, so they survive a sideways scroll. The
            spreadsheet's own wording stays on the row as its title. */}
        <tr className={`ms-band is-${section.key}`} title={section.label}>
          <td className="ms-c1">
            <div className="ms-band-cell">{shortLabel(section)}</div>
          </td>
          <td className="ms-c2">
            <div className="ms-band-cell justify-end">
              <span className="pill">{pctText(section.total.pct)}</span>
            </div>
          </td>
          <td colSpan={columns.length}>
            <div className="ms-band-cell" />
          </td>
        </tr>
        {row("target", t("kpi.target"), (c) => c.target)}
        {row("value", section.value_label, (c) => c.value, { act: true })}
        {row("pct", t("dash.achievement"), (c) => c.pct, { percent: true })}
        {row("ly", t("kpi.lastYear"), (c) => c.last_year)}
        {row(
          "growth",
          `${data?.meta.year}/${data?.meta.last_year}`,
          (c) => c.growth,
          { percent: true },
        )}
      </tbody>
    );
  };

  const monthSection = data?.sections.find((section) => section.key === "month") || null;

  return (
    <div className="min-h-screen bg-transparent">
      {/* ══ Header ══ */}
      <header className="page-hd">
        <div>
          <p className="eyebrow">Wholesale by region</p>
          <h1 className="page-title">{t("wholesaleRegion.title")}</h1>
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
            <select
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="select"
              aria-label={t("monthSummary.month")}
            >
              {MONTHS.map((label, index) => (
                <option key={label} value={String(index + 1)}>
                  {label}
                </option>
              ))}
            </select>
            <span className="ms-sep" />
            <select
              value={year}
              onChange={(e) => setYear(e.target.value)}
              className="select"
              aria-label={t("filter.year")}
            >
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
            <div className="ms-kpis ws-kpis">
              {[0, 1, 2].map((index) => (
                <div key={index} className="skeleton h-[7.5rem]" />
              ))}
            </div>
            <div className="skeleton mt-3 h-[22rem]" />
          </>
        )}

        {data && (
          <div className={loading ? "ms-busy" : ""}>
            {/* The month, block by block — which side is behind is the first
                question asked of this sheet, and it should not need a scroll. */}
            {monthSection && (
              <section className="ms-kpis ws-kpis">
                {data.blocks.map((block) =>
                  renderTile(
                    block.key,
                    block.key === "total" ? t("wholesaleRegion.total") : block.label,
                    block.key === "total" ? shortLabel(monthSection) : "ACT",
                    monthSection.block_totals[block.key] || {
                      target: 0,
                      value: 0,
                      pct: 0,
                      last_year: 0,
                      growth: 0,
                    },
                    block.key === "total",
                  ),
                )}
              </section>
            )}

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
                        {t("wholesaleRegion.total")}
                      </th>
                      {blockSpans.map((block) => (
                        <th
                          key={block.key}
                          colSpan={block.span}
                          className={`ms-group g-${block.key} is-gstart`}
                        >
                          {block.label}
                        </th>
                      ))}
                    </tr>
                    <tr>
                      {data.columns.map((column, index) => (
                        <th
                          key={column.key}
                          className={`ms-col g-${column.block} ${blockStart(index) ? "is-gstart" : ""} ${
                            column.is_sum ? "is-bsum" : ""
                          }`}
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
              {t("wholesaleRegion.note")}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
