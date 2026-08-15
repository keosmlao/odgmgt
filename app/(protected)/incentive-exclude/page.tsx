"use client";

import { useEffect, useMemo, useState } from "react";
import { Ban, Check, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import api from "@/service/api";
import { useLanguage } from "@/context/LanguageContext";

type Status = { status_code: string; multiplier: number };
type Rule = {
  item_code: string;
  item_name: string;
  brand: string;
  category: string;
  status_code: string;
  multiplier: number;
  note: string | null;
  effective_from: string;
  effective_to: string;
  /** Whether this rule governs the month on screen, or is a past decision. */
  in_force: boolean;
  qty: number;
  amount: number;
};
type Payload = {
  year: number;
  month: number;
  statuses: Status[];
  items: Rule[];
  totals: { items: number; inForce: number; withheld: number };
};
type Found = { item_code: string; item_name: string; brand: string; category: string };

const MONTHS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
/** Shared with the other incentive screens, so they settle on one month. */
const PERIOD_KEY = "odg_incentive_period";

const fmt = (value: number) =>
  Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/**
 * A multiplier said in words.
 *
 * "×0" is exact and tells nobody what it means. The three that matter are worth
 * naming, because the difference between "earns nothing" and "earns less" is
 * the whole reason this screen exists.
 */
const toneOf = (multiplier: number) =>
  multiplier === 0 ? "pill-neg" : multiplier < 1 ? "pill-warn" : multiplier > 1 ? "pill-pos" : "pill-muted";

export default function IncentiveExcludePage() {
  const { t } = useLanguage();
  /**
   * A status code in the reader's language.
   *
   * The codes are what the scoring query matches on and cannot change, but
   * nobody deciding whether a fridge earns points thinks in
   * "special_no_bonus". A code with no translation keeps the code, so a status
   * added to the table later still appears rather than vanishing.
   */
  const statusLabel = (code: string) => {
    const key = `exclude.code.${code}`;
    const name = t(key);
    return name === key ? code : name;
  };
  const now = new Date();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  /** Which status is being looked at; "" is all of them. */
  const [tab, setTab] = useState("");

  /** The "add" panel: the product searched for, and what to do with it. */
  const [form, setForm] = useState<null | {
    item: Found | null;
    status: string;
    note: string;
    /** Most exclusions are permanent; a promotion's is not. */
    forever: boolean;
  }>(null);
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<Found[]>([]);
  const [searching, setSearching] = useState(false);

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
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    localStorage.setItem(PERIOD_KEY, JSON.stringify({ year, month }));
  }, [restored, year, month]);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/incentive-exclude", { params: { year, month } });
      if (res.data?.success) setData(res.data.data);
      else setError(res.data?.message || t("app.error"));
    } catch {
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

  /**
   * The catalogue is searched on the server, a moment after typing stops.
   *
   * Tens of thousands of item codes is not a list to ship to the browser, and a
   * request per keystroke is not one to ship to the database.
   */
  useEffect(() => {
    const text = search.trim();
    if (text.length < 2) { setFound([]); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      api.get("/incentive-exclude", { params: { q: text } })
        .then((res) => setFound(res.data?.success ? res.data.data.items : []))
        .catch(() => setFound([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const save = async () => {
    if (!form?.item || busy) return;
    setBusy("save");
    setError("");
    try {
      await api.post("/incentive-exclude", {
        item_code: form.item.item_code,
        status_code: form.status,
        note: form.note,
        forever: form.forever,
        year, month,
      });
      setForm(null);
      setSearch("");
      setFound([]);
      await load();
    } catch (err: unknown) {
      const response = (err as { response?: { data?: { message?: string } } }).response;
      setError(response?.data?.message || t("app.error"));
    } finally {
      setBusy("");
    }
  };

  const remove = async (rule: Rule) => {
    if (busy) return;
    if (!window.confirm(`${t("exclude.confirmRemove")} ${rule.item_name}`)) return;
    setBusy(`${rule.item_code} ${rule.effective_from}`);
    setError("");
    try {
      await api.delete("/incentive-exclude", {
        data: { item_code: rule.item_code, effective_from: rule.effective_from },
      });
      await load();
    } catch (err: unknown) {
      const response = (err as { response?: { data?: { message?: string } } }).response;
      setError(response?.data?.message || t("app.error"));
    } finally {
      setBusy("");
    }
  };

  const shown = useMemo(() => {
    const text = filter.trim().toLowerCase();
    return (data?.items ?? []).filter((rule) => {
      if (tab && rule.status_code !== tab) return false;
      if (!text) return true;
      return [rule.item_code, rule.item_name, rule.brand, rule.category, rule.note ?? ""]
        .some((field) => String(field).toLowerCase().includes(text));
    });
  }, [data, filter, tab]);

  /**
   * One tab per status, and only for the statuses actually in use.
   *
   * Built from the rules rather than from the status table: a status nobody has
   * given a product to is an empty tab, and an empty tab is a thing to click
   * and be disappointed by. The status list is still complete in the add
   * dialog, which is where a new one is chosen.
   */
  const tabs = useMemo(() => {
    const counts = new Map<string, { total: number; inForce: number; multiplier: number }>();
    for (const rule of data?.items ?? []) {
      const seen = counts.get(rule.status_code)
        ?? { total: 0, inForce: 0, multiplier: rule.multiplier };
      seen.total += 1;
      if (rule.in_force) seen.inForce += 1;
      counts.set(rule.status_code, seen);
    }
    return [...counts.entries()]
      .map(([code, seen]) => ({ code, ...seen }))
      .sort((left, right) => left.multiplier - right.multiplier || left.code.localeCompare(right.code));
  }, [data]);

  const openForm = () => {
    const zero = data?.statuses.find((status) => status.multiplier === 0);
    setForm({ item: null, status: zero?.status_code ?? data?.statuses[0]?.status_code ?? "", note: "", forever: true });
    setSearch("");
    setFound([]);
  };

  return (
    <div className="min-h-screen">
      <header className="page-hd">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-[var(--r-md)] bg-[var(--brand-deep)] text-white">
            <Ban size={19} />
          </span>
          <div>
            <h1 className="page-title">{t("exclude.title")}</h1>
            <p className="page-sub">{t("exclude.subtitle")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="field-label">{t("incentiveCfg.effective")}</label>
            <div className="flex gap-1.5">
              <select className="select w-20" value={year} onChange={(event) => setYear(event.target.value)}>
                {[0, 1, 2].map((back) => {
                  const value = String(now.getFullYear() - back);
                  return <option key={value} value={value}>{value}</option>;
                })}
              </select>
              <select className="select w-20" value={month} onChange={(event) => setMonth(event.target.value)}>
                {MONTHS.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>
          </div>
          <button className="btn" onClick={load}>
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> {t("monthSummary.refresh")}
          </button>
          <button className="btn btn-primary" onClick={openForm} disabled={!!busy}>
            <Plus size={13} /> {t("exclude.add")}
          </button>
        </div>
      </header>

      <div className="page">
        {error && (
          <div className="mb-3 rounded-[var(--r-md)] border px-3 py-2 text-[12px] font-medium"
               style={{ borderColor: "var(--neg)", background: "var(--neg-bg)", color: "var(--neg)" }}>
            {error}
          </div>
        )}

        {/* By status, because the three of them are three different decisions:
            held out of the scheme, paid less, paid more. The count is how many
            products carry it. */}
        {tabs.length > 1 && (
          <div className="tabs mb-3">
            <button className={`tab ${tab === "" ? "is-active" : ""}`} onClick={() => setTab("")}>
              {t("exclude.allStatuses")}
              <span className="pill pill-muted">{fmt(data?.items.length ?? 0)}</span>
            </button>
            {tabs.map((item) => (
              <button key={item.code} className={`tab ${tab === item.code ? "is-active" : ""}`}
                      onClick={() => setTab(item.code)}>
                {statusLabel(item.code)}
                <span className={`pill ${toneOf(item.multiplier)}`}>×{fmt(item.multiplier)}</span>
                <span className="pill pill-muted">{fmt(item.total)}</span>
              </button>
            ))}
          </div>
        )}

        {data && (
          <div className="card">
            <div className="card-hd">
              <p className="page-sub min-w-0">{t("exclude.hint")}</p>
              <span className="ml-auto flex flex-wrap items-center gap-2">
                <span className="pill pill-muted">{fmt(data.totals.inForce)} / {fmt(data.totals.items)}</span>
                {data.totals.withheld > 0 && (
                  <span className="pill pill-neg" title={t("exclude.withheldHint")}>
                    {t("exclude.withheld")} {fmt(data.totals.withheld)}
                  </span>
                )}
                <span className="relative">
                  <Search size={13} style={{ position: "absolute", left: 8, top: 9, color: "var(--muted)" }} />
                  <input
                    className="input"
                    style={{ paddingLeft: 26, maxWidth: 220 }}
                    placeholder={t("incentiveCfg.search")}
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                </span>
              </span>
            </div>

            <div className="card-bd-flush" style={{ overflowX: "auto" }}>
              <table className="tbl" style={{ minWidth: 900 }}>
                <thead>
                  <tr>
                    <th className="text-left">{t("incentiveCfg.product")}</th>
                    <th className="text-left">{t("incentiveCfg.brandShort")}</th>
                    <th className="text-left">{t("exclude.status")}</th>
                    <th className="text-left">{t("exclude.window")}</th>
                    <th className="text-left">{t("exclude.note")}</th>
                    <th>{t("incentiveCfg.units")}</th>
                    <th>{t("incentiveCfg.sold")}</th>
                    <th className="text-left" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((rule) => (
                    <tr key={`${rule.item_code} ${rule.effective_from}`}
                        style={rule.in_force ? undefined : { opacity: 0.45 }}>
                      <td className="text-left" style={{ whiteSpace: "normal", minWidth: 220 }}>
                        {rule.item_name}
                        <span className="block" style={{ color: "var(--muted)", fontSize: 10.5 }}>
                          {rule.item_code}{rule.category ? ` · ${rule.category}` : ""}
                        </span>
                      </td>
                      <td className="text-left">{rule.brand || "—"}</td>
                      <td className="text-left">
                        <span className={`pill ${toneOf(rule.multiplier)}`}>
                          {statusLabel(rule.status_code)} ×{fmt(rule.multiplier)}
                        </span>
                        <span className="block" style={{ color: "var(--muted)", fontSize: 10.5 }}>{rule.status_code}</span>
                      </td>
                      <td className="text-left" style={{ fontSize: 11 }}>
                        {rule.effective_from} → {rule.effective_to}
                        {!rule.in_force && (
                          <span className="block" style={{ color: "var(--muted)", fontSize: 10 }}>{t("exclude.notThisMonth")}</span>
                        )}
                      </td>
                      <td className="text-left" style={{ whiteSpace: "normal", maxWidth: 260, color: "var(--muted)", fontSize: 11 }}>
                        {rule.note || "—"}
                      </td>
                      <td>{fmt(rule.qty)}</td>
                      {/* Red only where the rule actually withholds: a status
                          that pays MORE is on this list too. */}
                      <td style={rule.in_force && rule.multiplier < 1 && rule.amount > 0 ? { color: "var(--neg)" } : undefined}>
                        {fmt(rule.amount)}
                      </td>
                      <td className="text-left">
                        <button
                          className="btn btn-ghost btn-icon"
                          onClick={() => remove(rule)}
                          disabled={!!busy}
                          title={t("exclude.remove")}
                          style={{ color: "var(--neg)" }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {shown.length === 0 && (
                    <tr><td colSpan={8} className="text-left" style={{ color: "var(--muted)" }}>{t("label.noData")}</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="card-bd">
              <p className="page-sub">{t("exclude.note2")}</p>
            </div>
          </div>
        )}
      </div>

      {/* Find the product first, then say what it earns. The search is over the
          catalogue rather than over what has sold, so a product can be held out
          before its first sale rather than after it. */}
      {form && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 overflow-y-auto"
             onClick={() => setForm(null)}>
          <div className="card w-full my-4" style={{ maxWidth: 620 }} onClick={(event) => event.stopPropagation()}>
            <div className="card-hd">
              <h3 className="card-title">{t("exclude.addTitle")}</h3>
              <button className="btn btn-ghost btn-icon" onClick={() => setForm(null)} aria-label="close">
                <X size={14} />
              </button>
            </div>

            <div className="card-bd">
              <label className="field-label">{t("exclude.findProduct")}</label>
              <input
                autoFocus
                className="input"
                placeholder={t("exclude.findHint")}
                value={search}
                onChange={(event) => { setSearch(event.target.value); setForm({ ...form, item: null }); }}
              />
              {form.item ? (
                <div className="mt-2 flex items-center gap-2 rounded-[var(--r-sm)] border px-2 py-1.5"
                     style={{ borderColor: "var(--brand)", background: "var(--brand-soft)" }}>
                  <span className="min-w-0 text-[12px]">
                    <b>{form.item.item_name}</b>
                    <span className="block" style={{ color: "var(--muted)", fontSize: 10.5 }}>
                      {form.item.item_code}{form.item.brand ? ` · ${form.item.brand}` : ""}
                    </span>
                  </span>
                  <button className="btn btn-ghost btn-icon ml-auto" onClick={() => setForm({ ...form, item: null })}>
                    <X size={13} />
                  </button>
                </div>
              ) : (
                <div className="mt-2" style={{ maxHeight: 200, overflowY: "auto" }}>
                  {searching && <p className="page-sub">…</p>}
                  {!searching && search.trim().length >= 2 && found.length === 0 && (
                    <p className="page-sub">{t("label.noData")}</p>
                  )}
                  {found.map((item) => (
                    <button
                      key={item.item_code}
                      className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[12px] hover:bg-[var(--surface-2)]"
                      onClick={() => setForm({ ...form, item })}
                    >
                      <span className="min-w-0">
                        {item.item_name}
                        <span className="block" style={{ color: "var(--muted)", fontSize: 10.5 }}>
                          {item.item_code}{item.brand ? ` · ${item.brand}` : ""}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="card-bd grid gap-2 sm:grid-cols-2">
              <div>
                <label className="field-label">{t("exclude.status")}</label>
                <select className="select" value={form.status}
                        onChange={(event) => setForm({ ...form, status: event.target.value })}>
                  {(data?.statuses ?? []).map((status) => (
                    <option key={status.status_code} value={status.status_code}>
                      {statusLabel(status.status_code)} — ×{fmt(status.multiplier)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="field-label">{t("exclude.window")}</label>
                <select className="select" value={form.forever ? "forever" : "month"}
                        onChange={(event) => setForm({ ...form, forever: event.target.value === "forever" })}>
                  <option value="forever">{t("exclude.forever")}</option>
                  <option value="month">{t("exclude.thisMonth")} {year}-{String(month).padStart(2, "0")}</option>
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="field-label">{t("exclude.note")}</label>
                <input className="input" placeholder={t("exclude.noteHint")} value={form.note}
                       onChange={(event) => setForm({ ...form, note: event.target.value })} />
              </div>
            </div>

            <div className="card-bd flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setForm(null)}>{t("app.close")}</button>
              <button className="btn btn-primary" onClick={save} disabled={!!busy || !form.item}>
                <Check size={13} /> {t("exclude.add")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
