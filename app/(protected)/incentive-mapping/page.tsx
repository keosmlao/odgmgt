"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, RefreshCw, Trash2, TriangleAlert, Waypoints, X } from "lucide-react";
import api from "@/service/api";
import { useLanguage } from "@/context/LanguageContext";

type Kind = "category" | "size" | "design" | "seller";

type CategoryRow = {
  category_code: string;
  category_name: string | null;
  erp_name: string;
  pointmap_category: string | null;
  sda_subtype: string | null;
  is_active: boolean;
};
type PairRow = { key: string; value: string; label?: string };
type Gap = { name: string; code?: string; pcat?: string | null; unlisted?: boolean; qty: number; amount: number };
type Payload = {
  year: number;
  month: number;
  groups: { code: string; label: string }[];
  employees: { employee_code: string; name: string }[];
  category: { rows: CategoryRow[]; gaps: Gap[] };
  size: { rows: { size_name: string; size_token: string }[]; gaps: Gap[] };
  design: { rows: { design_name: string; design_token: string }[]; gaps: Gap[] };
  seller: { rows: { salename: string; employee_code: string; employee_name: string }[]; gaps: Gap[] };
};

const MONTHS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
const PERIOD_KEY = "odg_incentive_period";
const KINDS: Kind[] = ["category", "size", "design", "seller"];

const fmt = (value: number) =>
  Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export default function IncentiveMappingPage() {
  const { t } = useLanguage();
  const now = new Date();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [data, setData] = useState<Payload | null>(null);
  const [kind, setKind] = useState<Kind>("category");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  /** The row being written: its key, and the value being chosen for it. */
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState("");
  const [draftSub, setDraftSub] = useState("");

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
      const res = await api.get("/incentive-mapping", { params: { year, month } });
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

  const save = async (key: string, value: string, sub = "") => {
    if (busy) return;
    setBusy(key);
    setError("");
    try {
      await api.post("/incentive-mapping", kind === "category"
        ? { kind, key, pointmap_category: value, sda_subtype: sub }
        : { kind, key, value });
      setEditing("");
      await load();
    } catch (err: unknown) {
      const response = (err as { response?: { data?: { message?: string } } }).response;
      setError(response?.data?.message || t("app.error"));
    } finally {
      setBusy("");
    }
  };

  const remove = async (key: string, label: string) => {
    if (busy) return;
    if (!window.confirm(`${t(kind === "category" ? "mapping.confirmOff" : "mapping.confirmRemove")} ${label}`)) return;
    setBusy(key);
    setError("");
    try {
      await api.delete("/incentive-mapping", { data: { kind, key } });
      await load();
    } catch (err: unknown) {
      const response = (err as { response?: { data?: { message?: string } } }).response;
      setError(response?.data?.message || t("app.error"));
    } finally {
      setBusy("");
    }
  };

  /** The four tabs, flattened to one shape so the table is written once. */
  const view = useMemo(() => {
    if (!data) return { rows: [] as PairRow[], gaps: [] as Gap[] };
    if (kind === "category") {
      return {
        rows: data.category.rows
          .filter((row) => row.is_active)
          .map((row): PairRow => ({
            key: row.category_code,
            value: row.pointmap_category ?? "",
            label: `${row.erp_name}${row.sda_subtype ? ` · ${row.sda_subtype}` : ""}`,
          })),
        gaps: data.category.gaps,
      };
    }
    if (kind === "size") {
      return {
        rows: data.size.rows.map((row): PairRow => ({ key: row.size_name, value: row.size_token })),
        gaps: data.size.gaps,
      };
    }
    if (kind === "design") {
      return {
        rows: data.design.rows.map((row): PairRow => ({ key: row.design_name, value: row.design_token })),
        gaps: data.design.gaps,
      };
    }
    return {
      rows: data.seller.rows.map((row): PairRow => ({
        key: row.salename, value: row.employee_code, label: row.employee_name,
      })),
      gaps: data.seller.gaps,
    };
  }, [data, kind]);

  const gapValue = (kinds: Kind) => (kinds === "category" ? "" : "");

  /** The editor a tab needs: a picker where the target is a fixed list. */
  const editor = (key: string) => {
    if (kind === "category") {
      return (
        <span className="flex items-center gap-1">
          <select className="select" style={{ width: "8rem" }} value={draft}
                  onChange={(event) => setDraft(event.target.value)}>
            <option value="">—</option>
            {(data?.groups ?? []).map((group) => (
              <option key={group.code} value={group.code}>{group.code}</option>
            ))}
          </select>
          {/* Only a small appliance carries one, and it IS its design token. */}
          {draft === "SDA" && (
            <input className="input" style={{ width: "6rem" }} placeholder={t("mapping.subtype")}
                   value={draftSub} onChange={(event) => setDraftSub(event.target.value)} />
          )}
          <button className="btn btn-icon" onClick={() => save(key, draft, draftSub)} disabled={!!busy}>
            <Check size={13} />
          </button>
          <button className="btn btn-icon btn-ghost" onClick={() => setEditing("")}>
            <X size={13} />
          </button>
        </span>
      );
    }
    if (kind === "seller") {
      return (
        <span className="flex items-center gap-1">
          <select className="select" style={{ width: "12rem" }} value={draft}
                  onChange={(event) => setDraft(event.target.value)}>
            <option value="">—</option>
            {(data?.employees ?? []).map((person) => (
              <option key={person.employee_code} value={person.employee_code}>
                {person.name} · {person.employee_code}
              </option>
            ))}
          </select>
          <button className="btn btn-icon" onClick={() => save(key, draft)} disabled={!!busy || !draft}>
            <Check size={13} />
          </button>
          <button className="btn btn-icon btn-ghost" onClick={() => setEditing("")}>
            <X size={13} />
          </button>
        </span>
      );
    }
    return (
      <span className="flex items-center gap-1">
        <input autoFocus className="input" style={{ width: "9rem" }} value={draft}
               placeholder={t(kind === "size" ? "mapping.sizeTokenHint" : "mapping.designTokenHint")}
               onChange={(event) => setDraft(event.target.value)}
               onKeyDown={(event) => {
                 if (event.key === "Enter") save(key, draft);
                 if (event.key === "Escape") setEditing("");
               }} />
        <button className="btn btn-icon" onClick={() => save(key, draft)} disabled={!!busy || !draft.trim()}>
          <Check size={13} />
        </button>
        <button className="btn btn-icon btn-ghost" onClick={() => setEditing("")}>
          <X size={13} />
        </button>
      </span>
    );
  };

  const gapTotal = view.gaps.reduce((sum, gap) => sum + gap.amount, 0);

  return (
    <div className="min-h-screen">
      <header className="page-hd">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-[var(--r-md)] bg-[var(--brand-deep)] text-white">
            <Waypoints size={19} />
          </span>
          <div>
            <h1 className="page-title">{t("mapping.title")}</h1>
            <p className="page-sub">{t("mapping.subtitle")}</p>
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
        </div>
      </header>

      <div className="page">
        {error && (
          <div className="mb-3 rounded-[var(--r-md)] border px-3 py-2 text-[12px] font-medium"
               style={{ borderColor: "var(--neg)", background: "var(--neg-bg)", color: "var(--neg)" }}>
            {error}
          </div>
        )}

        <div className="tabs mb-3">
          {KINDS.map((item) => {
            const gaps = data
              ? (item === "category" ? data.category.gaps
                : item === "size" ? data.size.gaps
                : item === "design" ? data.design.gaps
                : data.seller.gaps).length
              : 0;
            return (
              <button key={item} className={`tab ${item === kind ? "is-active" : ""}`}
                      onClick={() => { setKind(item); setEditing(""); }}>
                {t(`mapping.tab.${item}`)}
                {gaps > 0 && <span className="pill pill-neg">{gaps}</span>}
              </button>
            );
          })}
        </div>

        {/* What sold without a translation. Above the mapped list on purpose:
            these are the lines scoring nothing right now, and every one of them
            is fixed by typing the value the row is missing. */}
        {view.gaps.length > 0 && (
          <div className="card mb-3">
            <div className="card-hd">
              <h3 className="card-title" style={{ color: "var(--neg)" }}>
                <TriangleAlert size={14} /> {t("mapping.gapTitle")}
              </h3>
              <span className="ml-auto pill pill-neg">{fmt(gapTotal)}</span>
            </div>
            <div className="card-bd-flush" style={{ overflowX: "auto" }}>
              <table className="tbl" style={{ minWidth: 620 }}>
                <thead>
                  <tr>
                    <th className="text-left">{t(`mapping.col.${kind}`)}</th>
                    <th className="text-left">{t("mapping.group")}</th>
                    <th>{t("incentiveCfg.units")}</th>
                    <th>{t("incentiveCfg.sold")}</th>
                    <th className="text-left">{t("mapping.mapTo")}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.gaps.map((gap) => {
                    const key = gap.code ?? gap.name;
                    return (
                      <tr key={key} style={{ background: "var(--neg-bg)" }}>
                        <td className="text-left" style={{ whiteSpace: "normal" }}>
                          <b>{gap.name || "—"}</b>
                          {gap.code && (
                            <span className="block" style={{ color: "var(--muted)", fontSize: 10.5 }}>{gap.code}</span>
                          )}
                        </td>
                        <td className="text-left" style={{ color: "var(--muted)" }}>
                          {gap.pcat ?? (gap.unlisted ? t("mapping.unlisted") : "—")}
                        </td>
                        <td>{fmt(gap.qty)}</td>
                        <td style={{ color: "var(--neg)", fontWeight: 700 }}>{fmt(gap.amount)}</td>
                        <td className="text-left">
                          {editing === key ? editor(key) : (
                            <button className="btn" onClick={() => {
                              setEditing(key);
                              setDraft(gapValue(kind));
                              setDraftSub("");
                            }} disabled={!!busy}>
                              <ArrowRight size={13} /> {t("mapping.mapIt")}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-hd">
            <p className="page-sub min-w-0">{t(`mapping.hint.${kind}`)}</p>
            <span className="ml-auto pill pill-muted">{fmt(view.rows.length)}</span>
          </div>
          <div className="card-bd-flush" style={{ overflowX: "auto" }}>
            <table className="tbl" style={{ minWidth: 620 }}>
              <thead>
                <tr>
                  <th className="text-left">{t(`mapping.col.${kind}`)}</th>
                  <th className="text-left">{t(`mapping.to.${kind}`)}</th>
                  <th className="text-left" />
                </tr>
              </thead>
              <tbody>
                {view.rows.map((row) => (
                  <tr key={row.key}>
                    <td className="text-left" style={{ whiteSpace: "normal" }}>
                      <b>{row.key}</b>
                      {row.label && row.label !== row.key && (
                        <span className="block" style={{ color: "var(--muted)", fontSize: 10.5 }}>{row.label}</span>
                      )}
                    </td>
                    <td className="text-left">
                      {editing === row.key ? editor(row.key) : (
                        <button className="btn btn-ghost" onClick={() => {
                          setEditing(row.key);
                          setDraft(row.value);
                          setDraftSub("");
                        }} disabled={!!busy}>
                          {row.value || <span style={{ color: "var(--neg)" }}>{t("incentiveCfg.legendNone")}</span>}
                        </button>
                      )}
                    </td>
                    <td className="text-left">
                      <button className="btn btn-ghost btn-icon" onClick={() => remove(row.key, row.key)}
                              disabled={!!busy} style={{ color: "var(--neg)" }}
                              title={t(kind === "category" ? "mapping.turnOff" : "mapping.remove")}>
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
                {view.rows.length === 0 && (
                  <tr><td colSpan={3} className="text-left" style={{ color: "var(--muted)" }}>{t("label.noData")}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="card-bd">
            <p className="page-sub">{t("mapping.note")}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
