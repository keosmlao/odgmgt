"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  ArrowRight,
  CalendarClock,
  Check,
  X,
} from "lucide-react";
import api from "@/service/api";
import { useLanguage } from "@/context/LanguageContext";

type Override = {
  doc_no: string;
  report_date: string;
  original_date: string;
  reason: string;
  approved_by: string;
  created_at: string;
  amount: number;
  bu_name: string;
};

type Bill = {
  doc_no: string;
  doc_date: string;
  amount: number;
  lines: number;
  customer_code: string;
  bu_name: string;
  report_date: string | null;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const fmt = (value: number) => Math.round(Number(value || 0)).toLocaleString("en-US");
const signed = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${fmt(Math.abs(value))}`;

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value || "");

/** "2026-08-01" → "1 Aug 2026", the way the bills are read aloud. */
const readDate = (value: string) => {
  if (!isDate(value)) return value || "-";
  const [y, m, d] = value.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
};

/** "2026-08-01" → "Aug 2026". The month is the unit that gets closed. */
const readMonth = (value: string) => {
  if (!isDate(value)) return "-";
  const [y, m] = value.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
};

const monthKey = (value: string) => (value || "").slice(0, 7);

/** The API's own rejection ("bill not found", "31 days from the bill") beats a
 *  generic failure message — it tells the approver what to fix. */
const apiMessage = (error: unknown) => {
  const body = (error as { response?: { data?: { message?: string } } })?.response?.data;
  return body?.message || "";
};

/** The move itself: struck-through origin, arrow, the month it now counts in. */
function MoveArrow({ from, to, size = "sm" }: { from: string; to: string; size?: "sm" | "lg" }) {
  const big = size === "lg";
  return (
    <span className={`inline-flex items-center gap-2 ${big ? "text-sm" : "text-xs"}`}>
      <span className="whitespace-nowrap text-[var(--muted)] line-through">{readDate(from)}</span>
      <ArrowRight size={big ? 15 : 12} className="shrink-0 text-[var(--muted)]" />
      <span className="whitespace-nowrap font-semibold text-[var(--brand)]">{readDate(to)}</span>
    </span>
  );
}

export default function SaleMonthOverride() {
  const { t } = useLanguage();

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [canApprove, setCanApprove] = useState(false);

  const [search, setSearch] = useState("");
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<Bill[]>([]);
  const [picked, setPicked] = useState<Bill | null>(null);
  const [reportDate, setReportDate] = useState("");
  const [reason, setReason] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/sale-month-override");
      if (res.data?.success) {
        setOverrides(res.data.data.overrides || []);
        setCanApprove(Boolean(res.data.data.can_approve));
      } else setError(res.data?.message || t("app.error"));
    } catch {
      setError(t("app.error"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const findBills = async () => {
    const q = search.trim();
    if (!q) return;
    setSearching(true);
    setError("");
    try {
      const res = await api.get("/sale-month-override", { params: { q } });
      setFound(res.data?.success ? res.data.data.bills || [] : []);
      setSearched(true);
    } catch {
      setFound([]);
      setSearched(true);
    } finally {
      setSearching(false);
    }
  };

  const resetPicker = () => {
    setPicked(null);
    setFound([]);
    setSearch("");
    setSearched(false);
  };

  /** Picking a bill proposes the obvious move: the last day of the month before. */
  const pick = (bill: Bill) => {
    setPicked(bill);
    setNotice("");
    const [y, m] = bill.doc_date.split("-").map(Number);
    const previousEnd = new Date(Date.UTC(y, m - 1, 0));
    setReportDate(bill.report_date || previousEnd.toISOString().slice(0, 10));
    setReason("");
  };

  const save = async () => {
    if (!picked) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await api.post("/sale-month-override", {
        doc_no: picked.doc_no,
        report_date: reportDate,
        reason: reason.trim(),
      });
      if (res.data?.success) {
        setNotice(`${picked.doc_no} · ${fmt(picked.amount)} ₭ → ${readMonth(reportDate)}`);
        resetPicker();
        await load();
      } else setError(res.data?.message || t("app.error"));
    } catch (e: unknown) {
      setError(apiMessage(e) || t("app.error"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (docNo: string) => {
    setSaving(true);
    setError("");
    try {
      const res = await api.delete("/sale-month-override", { params: { doc_no: docNo } });
      if (res.data?.success) {
        setNotice(`${docNo} — ${t("saleMonthOverride.removed")}`);
        await load();
      } else setError(res.data?.message || t("app.error"));
    } catch (e: unknown) {
      setError(apiMessage(e) || t("app.error"));
    } finally {
      setSaving(false);
    }
  };

  /**
   * What the moves add up to per month — the number these rows exist to
   * produce. A list of bills does not tell a manager closing July that July is
   * 77,000 heavier than the ERP says; this does.
   */
  const impact = useMemo(() => {
    const byMonth = new Map<string, { key: string; kip: number; bills: number }>();
    const touch = (key: string, kip: number) => {
      const row = byMonth.get(key) || { key, kip: 0, bills: 0 };
      row.kip += kip;
      row.bills += 1;
      byMonth.set(key, row);
    };
    for (const row of overrides) {
      touch(monthKey(row.report_date), Number(row.amount || 0));
      touch(monthKey(row.original_date), -Number(row.amount || 0));
    }
    return [...byMonth.values()].filter((r) => r.key).sort((a, b) => a.key.localeCompare(b.key));
  }, [overrides]);

  /** Grouped by the month they now count in — the way a close is reviewed. */
  const groups = useMemo(() => {
    const byMonth = new Map<string, Override[]>();
    for (const row of overrides) {
      const key = monthKey(row.report_date);
      byMonth.set(key, [...(byMonth.get(key) || []), row]);
    }
    return [...byMonth.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, list]) => ({
        key,
        list,
        kip: list.reduce((sum, r) => sum + Number(r.amount || 0), 0),
      }));
  }, [overrides]);

  /** A move only counts when it lands in a different month. */
  const movesMonth = Boolean(picked && monthKey(reportDate) !== monthKey(picked.doc_date));
  const canSave = Boolean(picked && reason.trim() && isDate(reportDate) && !saving);

  return (
    <div
      className="min-h-screen bg-transparent"
      style={{ fontFamily: '"Noto Sans Lao","Noto Sans",system-ui,sans-serif' }}
    >
      <header className="page-hd">
        <div>
          <p className="eyebrow">Month close</p>
          <h1 className="page-title">{t("saleMonthOverride.title")}</h1>
          <p className="page-sub">{t("saleMonthOverride.sub")}</p>
        </div>
        <button onClick={load} className="btn" disabled={loading}>
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          {t("monthSummary.refresh")}
        </button>
      </header>

      <main className="mx-auto max-w-[1120px] space-y-4 px-5 py-5 lg:px-8">
        {error && (
          <div className="flex items-start gap-2 rounded-[var(--r-md)] border border-[var(--neg)]/35 bg-[var(--neg-bg)] px-4 py-2.5 text-xs text-[var(--neg)]">
            <X size={14} className="mt-px shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {notice && (
          <div className="flex items-start gap-2 rounded-[var(--r-md)] border border-[var(--pos)]/35 bg-[var(--pos-bg)] px-4 py-2.5 text-xs text-[var(--pos)]">
            <Check size={14} className="mt-px shrink-0" />
            <span>{notice}</span>
          </div>
        )}

        {/* ══ What the moves do to each month ══ */}
        {impact.length > 0 && (
          <section>
            <div className="mb-2 flex items-baseline gap-2">
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">
                {t("saleMonthOverride.impact")}
              </h2>
              <span className="text-[11px] text-[var(--muted)]">
                {t("saleMonthOverride.impactHint")}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {impact.map((row) => {
                const positive = row.kip > 0;
                return (
                  <div key={row.key} className="card stat p-3.5">
                    <p className="stat-label">{readMonth(`${row.key}-01`)}</p>
                    <p
                      className={`stat-value !text-[1.15rem] ${
                        positive ? "!text-[var(--pos)]" : "!text-[var(--neg)]"
                      }`}
                    >
                      {signed(row.kip)}
                    </p>
                    <p className="stat-sub">
                      {row.bills} {t("saleMonthOverride.billsMoved")}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ══ Move a bill ══ */}
        {canApprove && (
          <section className="card">
            <div className="card-hd">
              <h2 className="card-title">{t("saleMonthOverride.addTitle")}</h2>
              <span className="hidden text-[11px] text-[var(--muted)] sm:block">
                {t("saleMonthOverride.addHint")}
              </span>
            </div>

            <div className="card-bd space-y-3">
              <div className="flex flex-wrap gap-2">
                <div className="relative min-w-[240px] flex-1">
                  <Search
                    size={14}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]"
                  />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && findBills()}
                    placeholder={t("saleMonthOverride.searchPlaceholder")}
                    className="input w-full !pl-9"
                  />
                </div>
                <button
                  onClick={findBills}
                  className="btn btn-primary"
                  disabled={searching || !search.trim()}
                >
                  {searching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
                  {t("app.search")}
                </button>
                {(found.length > 0 || picked || searched) && (
                  <button onClick={resetPicker} className="btn btn-ghost" disabled={saving}>
                    <X size={13} />
                  </button>
                )}
              </div>

              {searched && !searching && found.length === 0 && (
                <p className="py-2 text-xs text-[var(--muted)]">
                  {t("saleMonthOverride.noBillFound")}
                </p>
              )}

              {found.length > 0 && !picked && (
                <div className="tbl-scroll -mx-1 overflow-hidden rounded-[var(--r-md)] border border-[var(--line)]">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>{t("saleMonthOverride.docNo")}</th>
                        <th className="!text-right">{t("label.actual")}</th>
                        <th>{t("saleMonthOverride.billDate")}</th>
                        <th>BU</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {found.map((bill) => (
                        <tr key={bill.doc_no}>
                          <td className="font-semibold text-[var(--ink)]">{bill.doc_no}</td>
                          <td className="text-right tabular-nums">{fmt(bill.amount)}</td>
                          <td className="text-[var(--ink-soft)]">{readDate(bill.doc_date)}</td>
                          <td className="text-[var(--muted)]">{bill.bu_name || "-"}</td>
                          <td className="!text-right">
                            <button onClick={() => pick(bill)} className="btn !px-2 !py-1">
                              {bill.report_date
                                ? t("saleMonthOverride.edit")
                                : t("saleMonthOverride.move")}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* The move being composed, with its consequence spelled out. */}
              {picked && (
                <div className="rounded-[var(--r-md)] border border-[var(--brand)]/35 bg-[var(--info-bg)] p-4">
                  <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-sm font-bold text-[var(--ink)]">{picked.doc_no}</span>
                    <span className="text-sm font-semibold tabular-nums text-[var(--ink)]">
                      {fmt(picked.amount)} ₭
                    </span>
                    <span className="text-[11px] text-[var(--muted)]">
                      {picked.bu_name} · {picked.lines} {t("saleMonthOverride.lines")}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-end gap-3">
                    <div>
                      <label className="field-label">{t("saleMonthOverride.countsOn")}</label>
                      <input
                        type="date"
                        value={reportDate}
                        onChange={(e) => setReportDate(e.target.value)}
                        className="input"
                      />
                    </div>
                    <div className="min-w-[240px] flex-1">
                      <label className="field-label">{t("saleMonthOverride.reason")}</label>
                      <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder={t("saleMonthOverride.reasonPlaceholder")}
                        className="input w-full"
                      />
                    </div>
                    <button onClick={save} className="btn btn-accent" disabled={!canSave}>
                      {saving ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <CalendarClock size={13} />
                      )}
                      {t("app.save")}
                    </button>
                    <button onClick={() => setPicked(null)} className="btn" disabled={saving}>
                      {t("app.cancel")}
                    </button>
                  </div>

                  <div className="mt-3 border-t border-[var(--brand)]/20 pt-2.5">
                    {movesMonth ? (
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--ink-soft)]">
                        <span className="font-semibold tabular-nums text-[var(--ink)]">
                          {fmt(picked.amount)} ₭
                        </span>
                        <MoveArrow from={picked.doc_date} to={reportDate} />
                        <span className="pill pill-warn">
                          {readMonth(picked.doc_date)} {signed(-picked.amount)}
                        </span>
                        <span className="pill pill-pos">
                          {readMonth(reportDate)} {signed(picked.amount)}
                        </span>
                      </p>
                    ) : (
                      <p className="text-[11px] text-[var(--warn)]">
                        {t("saleMonthOverride.sameMonthWarn")}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {/* ══ Bills already moved, grouped by the month they now land in ══ */}
        <section className="card">
          <div className="card-hd">
            <h2 className="card-title">{t("saleMonthOverride.listTitle")}</h2>
            <span className="pill pill-muted">
              {overrides.length} {t("saleMonthOverride.billsMoved")}
            </span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-14">
              <Loader2 className="h-6 w-6 animate-spin text-[var(--brand)]" />
            </div>
          ) : overrides.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
              <CalendarClock size={26} className="text-[var(--muted)] opacity-50" />
              <p className="text-sm font-semibold text-[var(--ink-soft)]">
                {t("saleMonthOverride.emptyTitle")}
              </p>
              <p className="max-w-[420px] text-[11px] leading-relaxed text-[var(--muted)]">
                {t("saleMonthOverride.emptyHint")}
              </p>
            </div>
          ) : (
            <div className="card-bd-flush">
              {groups.map((group) => (
                <div key={group.key}>
                  <div className="flex items-center justify-between gap-3 border-b border-[var(--line-soft)] bg-[var(--surface-2)] px-4 py-2">
                    <span className="text-xs font-bold text-[var(--ink)]">
                      {readMonth(`${group.key}-01`)}
                    </span>
                    <span className="text-xs font-semibold tabular-nums text-[var(--pos)]">
                      {signed(group.kip)} ₭
                    </span>
                  </div>

                  <ul className="divide-y divide-[var(--line-soft)]">
                    {group.list.map((row) => (
                      <li
                        key={row.doc_no}
                        className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3 hover:bg-[var(--surface-2)]"
                      >
                        <div className="min-w-[150px]">
                          <p className="text-xs font-bold text-[var(--ink)]">{row.doc_no}</p>
                          <p className="text-sm font-semibold tabular-nums text-[var(--ink)]">
                            {fmt(row.amount)} ₭
                          </p>
                        </div>

                        <div className="min-w-[190px] pt-0.5">
                          <MoveArrow from={row.original_date} to={row.report_date} />
                          {row.bu_name && (
                            <p className="mt-1 text-[11px] text-[var(--muted)]">{row.bu_name}</p>
                          )}
                        </div>

                        <div className="min-w-[200px] flex-1">
                          <p className="text-xs leading-relaxed text-[var(--ink-soft)]">
                            {row.reason}
                          </p>
                          <p className="mt-1 text-[11px] text-[var(--muted)]">
                            {t("saleMonthOverride.approvedBy")}: {row.approved_by}
                          </p>
                        </div>

                        {canApprove && (
                          <button
                            onClick={() => remove(row.doc_no)}
                            className="btn btn-ghost btn-icon shrink-0 text-[var(--muted)] hover:text-[var(--neg)]"
                            disabled={saving}
                            title={t("saleMonthOverride.remove")}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>

        <p className="px-1 text-[11px] leading-relaxed text-[var(--muted)]">
          {t("saleMonthOverride.note")}
        </p>
      </main>
    </div>
  );
}
