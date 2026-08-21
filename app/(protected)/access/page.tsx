"use client";

import { useEffect, useMemo, useState } from "react";
import { Building2, Check, ChevronDown, KeyRound, Plus, RefreshCw, RotateCcw, ShieldCheck, Trash2, UserCheck, UserPlus, Users, X } from "lucide-react";
import ReactSelect from "react-select";
import api from "@/service/api";
import { useAuth } from "@/context/AuthContext";
import { useLanguage } from "@/context/LanguageContext";

type Approved = {
  employee_code: string;
  app_role: string;
  is_active: boolean;
  bu_code?: string | null;
  channel_codes?: string[] | null;
  missing_employee?: boolean;
  updated_at?: string;
  updated_by?: string;
  fullname_lo?: string;
  fullname_en?: string;
  employment_status?: string;
  no_password?: boolean;
  hashed_password?: boolean;
};

type Candidate = {
  employee_code: string;
  fullname_lo?: string;
  fullname_en?: string;
  employment_status?: string;
};

function ChannelPicker({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string[];
  options: { code: string; name_1?: string }[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  const selected = new Set(value.map(String));
  const labels = options.filter((item) => selected.has(String(item.code))).map((item) => item.name_1 || item.code);

  return (
    <details className="group relative min-w-44">
      <summary className={`flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-xs shadow-sm transition hover:border-[#4ac7f0] dark:bg-[var(--surface-2)] ${disabled ? "pointer-events-none opacity-50" : ""}`}>
        <span className="flex min-w-0 flex-1 flex-wrap gap-1">
          {labels.length ? labels.slice(0, 2).map((label) => <span key={label} className="rounded-md bg-[#2b70b5]/10 px-1.5 py-0.5 font-semibold text-[#2b70b5]">{label}</span>) : <span className="text-[var(--muted)]">Select channels</span>}
          {labels.length > 2 && <span className="rounded-md bg-[var(--surface-2)] px-1.5 py-0.5 font-semibold text-[var(--muted)]">+{labels.length - 2}</span>}
        </span>
        <ChevronDown size={14} className="shrink-0 text-[var(--muted)] transition group-open:rotate-180" />
      </summary>
      <div className="absolute right-0 z-30 mt-2 w-60 overflow-hidden rounded-xl border border-[var(--line)] bg-white p-1.5 shadow-xl dark:bg-[var(--surface)]">
        <p className="px-2 py-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">Sales channels</p>
        <div className="max-h-56 overflow-y-auto">
          {options.map((item) => {
            const code = String(item.code);
            const active = selected.has(code);
            return (
              <button key={code} type="button" onClick={() => onChange(active ? value.filter((v) => String(v) !== code) : [...value, code])} className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition ${active ? "bg-[#2b70b5]/8 font-semibold text-[#2b70b5]" : "text-[var(--ink-soft)] hover:bg-[var(--surface-2)]"}`}>
                <span className={`flex h-4 w-4 items-center justify-center rounded border ${active ? "border-[#2b70b5] bg-[#2b70b5] text-white" : "border-[var(--line-strong)]"}`}>{active && <Check size={11} />}</span>
                <span className="flex-1">{item.name_1 || item.code}</span>
              </button>
            );
          })}
        </div>
      </div>
    </details>
  );
}

export default function AccessPage() {
  const { t } = useLanguage();
  const { user } = useAuth() as any;

  const [approved, setApproved] = useState<Approved[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [owners, setOwners] = useState<string[]>([]);
  const [buList, setBuList] = useState<{ code: string; name_1?: string }[]>([]);
  const [channelList, setChannelList] = useState<{ code: string; name_1?: string }[]>([]);
  const [pick, setPick] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  /** Which row has its password editor open, and what is typed in it. */
  const [pwFor, setPwFor] = useState("");
  const [pwValue, setPwValue] = useState("");
  const [okMessage, setOkMessage] = useState("");

  const load = async (q = "") => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/access", { params: q ? { q } : {} });
      if (res.data?.success) {
        setApproved(res.data.data.approved || []);
        setCandidates(res.data.data.candidates || []);
        setOwners(res.data.data.owners || []);
        setBuList(res.data.data.bu || []);
        setChannelList(res.data.data.channels || []);
      } else {
        setError(res.data?.message || t("app.error"));
      }
    } catch (err: any) {
      setError(err?.response?.data?.message === "forbidden" ? t("access.forbidden") : t("app.error"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (payload: any, key: string) => {
    setBusy(key);
    try {
      await api.post("/access", payload);
      await load();
    } catch {
      setError(t("app.error"));
    } finally {
      setBusy("");
    }
  };

  /**
   * Sets an employee's sign-in password. There was no way to do this anywhere
   * in the app, so an employee whose stored password nobody knew — a hash set
   * by another system, or a blank — simply could not be let back in.
   */
  const setPassword = async (code: string) => {
    const value = pwValue.trim();
    if (value.length < 4) {
      setError(t("access.passwordTooShort"));
      return;
    }
    setBusy(code);
    setError("");
    try {
      const res = await api.patch("/access", { employee_code: code, password: value });
      if (res.data?.success) {
        setOkMessage(`${t("access.passwordSet")} · ${code}`);
        setPwFor("");
        setPwValue("");
        await load();
      } else {
        setError(res.data?.message || t("app.error"));
      }
    } catch (err) {
      const message = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setError(message || t("app.error"));
    } finally {
      setBusy("");
    }
  };

  const remove = async (code: string) => {
    setBusy(code);
    try {
      await api.delete("/access", { params: { employee_code: code } });
      await load();
    } catch {
      setError(t("app.error"));
    } finally {
      setBusy("");
    }
  };

  const activeCount = useMemo(() => approved.filter((row) => row.is_active).length, [approved]);
  const name = (row: { fullname_lo?: string; fullname_en?: string; employee_code: string }) =>
    row.fullname_lo || row.fullname_en || row.employee_code;

  return (
    <div className="min-h-screen">
      <header className="page-hd">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-[var(--r-md)] bg-[var(--brand-deep)] text-white">
            <ShieldCheck size={19} />
          </span>
          <div>
            <p className="eyebrow">Access control</p>
            <h1 className="page-title">{t("access.title")}</h1>
            <p className="page-sub">
              {t("access.subtitle")} · {activeCount}/{approved.length}
            </p>
          </div>
        </div>
        <button onClick={() => load()} className="btn">
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> {t("monthSummary.refresh")}
        </button>
      </header>

      <div className="page mx-auto max-w-6xl">
        {okMessage && (
          <div
            className="mb-3 flex items-center gap-2 rounded-[var(--r-md)] border px-3 py-2 text-[12px] font-medium"
            style={{ borderColor: "var(--pos)", background: "var(--pos-bg)", color: "var(--pos)" }}
          >
            <Check size={14} /> {okMessage}
          </div>
        )}

        {error && (
          <div
            className="mb-3 rounded-[var(--r-md)] border px-3 py-2 text-[12px] font-medium"
            style={{ borderColor: "var(--neg)", background: "var(--neg-bg)", color: "var(--neg)" }}
          >
            {error}
          </div>
        )}

        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { icon: Users, label: "Total access", value: approved.length, tone: "#2b70b5", bg: "#edf6ff" },
            { icon: UserCheck, label: "Active users", value: activeCount, tone: "#15966b", bg: "#ecfdf5" },
            { icon: Building2, label: "Business units", value: buList.length, tone: "#f5911f", bg: "#fff7e8" },
            { icon: ShieldCheck, label: "System owners", value: owners.length, tone: "#003361", bg: "#eef3f8" },
          ].map(({ icon: Icon, label, value, tone, bg }) => (
            <div key={label} className="flex items-center gap-3 rounded-2xl border border-[var(--line)] bg-white p-4 shadow-[var(--shadow-sm)] dark:bg-[var(--surface)]">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ color: tone, background: bg }}><Icon size={18} /></span>
              <div><p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">{label}</p><p className="mt-0.5 text-xl font-bold tabular-nums text-[var(--ink)]">{value}</p></div>
            </div>
          ))}
        </div>

        <div className="grid items-start gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
        {/* ── Grant access ── */}
        <section className="card overflow-hidden lg:sticky lg:top-28">
          <div className="bg-gradient-to-br from-[#003361] to-[#2b70b5] px-5 py-5 text-white">
            <span className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-white/12 ring-1 ring-white/15"><UserPlus size={18} /></span>
            <h3 className="text-base font-bold">{t("access.add")}</h3>
            <p className="mt-1 text-xs leading-5 text-sky-100/65">Search for an employee, select their account and grant system access.</p>
          </div>
          <div className="card-bd grid gap-3">
            <div>
              <label className="field-label">Employee</label>
              <ReactSelect
                instanceId="access-employee"
                value={candidates.map((c) => ({ value: c.employee_code, label: `${c.employee_code} · ${name(c)}` })).find((option) => option.value === pick) || null}
                onChange={(option) => setPick(option?.value || "")}
                options={candidates.map((c) => ({ value: c.employee_code, label: `${c.employee_code} · ${name(c)}` }))}
                placeholder={t("access.searchPlaceholder")}
                isClearable
                menuPortalTarget={typeof document !== "undefined" ? document.body : undefined}
                menuPosition="fixed"
                noOptionsMessage={() => t("label.noData")}
                styles={{
                  control: (base, state) => ({ ...base, minHeight: 44, borderRadius: 12, borderColor: state.isFocused ? "#2b70b5" : "rgba(0,51,97,.14)", boxShadow: state.isFocused ? "0 0 0 3px rgba(74,199,240,.18)" : "none", fontSize: 12, ':hover': { borderColor: "#4ac7f0" } }),
                  menu: (base) => ({ ...base, zIndex: 50, borderRadius: 12, overflow: "hidden", boxShadow: "0 14px 36px rgba(0,51,97,.16)" }),
                  menuPortal: (base) => ({ ...base, zIndex: 9999 }),
                  option: (base, state) => ({ ...base, fontSize: 12, backgroundColor: state.isSelected ? "#2b70b5" : state.isFocused ? "#edf7fd" : "white", color: state.isSelected ? "white" : "#003361" }),
                  placeholder: (base) => ({ ...base, color: "#8b9bae" }),
                }}
              />
            </div>
            <button
              className="btn btn-primary w-full justify-center py-2.5"
              disabled={!pick || busy === pick}
              onClick={() => save({ employee_code: pick, app_role: "sale", is_active: true }, pick).then(() => setPick(""))}
            >
              <Plus size={13} /> {t("access.grant")}
            </button>
          </div>
        </section>

        {/* ── Current list ── */}
        <section className="card min-w-0 !overflow-visible">
          <div className="card-hd">
            <div><h3 className="card-title">{t("access.current")}</h3><p className="mt-1 text-[11px] text-[var(--muted)]">Manage business scope, sales channels and account status.</p></div>
            <span className="pill pill-muted">{approved.length} users</span>
          </div>
          <div className="card-bd-flush">
            <table className="tbl" style={{ minWidth: 650 }}>
              <thead>
                <tr>
                  <th>{t("access.employee")}</th>
                  <th>{t("filter.bu")}</th>
                  <th>{t("filter.channel")}</th>
                  <th>{t("access.status")}</th>
                  <th>{t("access.password")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {approved.map((row) => {
                  const isOwner = owners.includes(row.employee_code);
                  const isSelf = String(user?.username || "") === row.employee_code;
                  return (
                    <tr key={row.employee_code}>
                      <td>
                        <span className="font-semibold" style={{ color: "var(--ink)" }}>
                          {row.employee_code}
                        </span>
                        <span className="ml-2" style={{ color: "var(--muted)" }}>
                          {name(row)}
                        </span>
                        {isOwner && <span className="pill ml-2">owner</span>}
                        {isSelf && !isOwner && <span className="pill pill-muted ml-2">{t("access.you")}</span>}
                      </td>
                      <td>
                        <select
                          className="select w-28"
                          value={row.bu_code || ""}
                          disabled={busy === row.employee_code}
                          onChange={(e) =>
                            save(
                              {
                                employee_code: row.employee_code,
                                app_role: row.app_role,
                                is_active: row.is_active,
                                bu_code: e.target.value || null,
                              },
                              row.employee_code,
                            )
                          }
                        >
                          <option value="">{t("app.all")}</option>
                          {buList.map((b) => (
                            <option key={b.code} value={b.code}>
                              {b.name_1 || b.code}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <ChannelPicker
                          value={(row.channel_codes || []).map(String)}
                          options={channelList}
                          disabled={busy === row.employee_code}
                          onChange={(channelCodes) =>
                            save(
                              {
                                employee_code: row.employee_code,
                                app_role: row.app_role,
                                is_active: row.is_active,
                                bu_code: row.bu_code || null,
                                channel_codes: channelCodes,
                              },
                              row.employee_code,
                            )
                          }
                        />
                      </td>
                      <td>
                        <button
                          className={`pill ${row.is_active ? "pill-pos" : "pill-muted"}`}
                          disabled={isOwner || busy === row.employee_code}
                          onClick={() =>
                            save(
                              { employee_code: row.employee_code, app_role: row.app_role, is_active: !row.is_active },
                              row.employee_code,
                            )
                          }
                        >
                          {row.is_active ? t("access.active") : t("access.disabled")}
                        </button>
                      </td>
                      <td>
                        {pwFor === row.employee_code ? (
                          <span className="flex items-center gap-1">
                            <input
                              className="input"
                              style={{ width: "9rem" }}
                              autoFocus
                              value={pwValue}
                              placeholder={t("access.newPassword")}
                              onChange={(e) => setPwValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") setPassword(row.employee_code);
                                if (e.key === "Escape") setPwFor("");
                              }}
                            />
                            {/* The house convention: everyone's password is their own code. */}
                            <button
                              type="button"
                              className="btn btn-ghost !px-1.5"
                              title={t("access.useEmployeeCode")}
                              onClick={() => setPwValue(row.employee_code)}
                            >
                              #
                            </button>
                            <button
                              type="button"
                              className="btn btn-primary btn-icon"
                              disabled={busy === row.employee_code}
                              onClick={() => setPassword(row.employee_code)}
                            >
                              <Check size={13} />
                            </button>
                            <button type="button" className="btn btn-ghost btn-icon" onClick={() => setPwFor("")}>
                              <X size={13} />
                            </button>
                          </span>
                        ) : (
                          <span className="flex items-center gap-1.5">
                            {row.no_password ? (
                              <span className="pill pill-neg">
                                <KeyRound size={10} /> {t("access.noPassword")}
                              </span>
                            ) : row.hashed_password ? (
                              <span className="pill pill-warn">
                                <KeyRound size={10} /> {t("access.hashed")}
                              </span>
                            ) : (
                              <span className="pill pill-muted">OK</span>
                            )}
                            <button
                              type="button"
                              className="btn btn-ghost btn-icon"
                              title={t("access.resetPassword")}
                              onClick={() => {
                                setPwFor(row.employee_code);
                                setPwValue(row.employee_code);
                                setOkMessage("");
                              }}
                            >
                              <RotateCcw size={13} />
                            </button>
                          </span>
                        )}
                      </td>
                      <td>
                        <button
                          className="btn btn-ghost btn-icon"
                          title={t("access.revoke")}
                          disabled={isOwner || busy === row.employee_code}
                          onClick={() => remove(row.employee_code)}
                          style={{ color: isOwner ? "var(--muted)" : "var(--neg)" }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {!approved.length && !loading && (
                  <tr>
                    <td colSpan={6} style={{ textAlign: "center", color: "var(--muted)", padding: "1.5rem" }}>
                      {t("label.noData")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
        </div>

        <div className="mt-4 flex items-start gap-2 rounded-xl border border-[#2b70b5]/10 bg-[#2b70b5]/5 px-4 py-3 text-[11px] leading-5 text-[var(--muted)]"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-[#2b70b5]" /><p>{t("access.note")}</p></div>
      </div>
    </div>
  );
}
