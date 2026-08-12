"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Award, ChevronRight, Coins, Gift, Package, RefreshCw, Target, TriangleAlert } from "lucide-react";
import api from "@/service/api";
import { useLanguage } from "@/context/LanguageContext";

type Brand = { group: string; brand: string; qty: number; amount: number; target: number };
type UnitLine = { code: string; description: string; group: string; brand: string | null; qty: number; rate: number; amount: number };

type Person = {
  employee_code: string | null;
  name: string;
  bills: number;
  amount: number;
  target: number;
  ach_pct: number;
  points: number;
  band: string;
  multiplier: number;
  point_reward: number;
  unit_reward: number;
  unit_reward_lines: UnitLine[];
  reward: number;
  target_groups: { group: string; target: number }[];
  brands: Brand[];
  point_categories: { category: string; points: number }[];
  no_point: { amount: number; lines: number };
  unmatched?: boolean;
};

type Special = {
  code: string;
  description: string;
  group: string;
  target_amount: number;
  reward_amount: number;
  split_by_share: boolean;
  achieved: boolean;
  actual_amount: number;
  ach_pct: number;
  shares: { employee_code: string | null; name: string; share_pct: number; amount: number }[];
};

type Payload = {
  meta: {
    year: number;
    month: number;
    currency: string;
    point_value: number;
    bands: { low: { max_ratio: number; multiplier: number }; standard: { max_ratio: number; multiplier: number }; high: { multiplier: number } };
    branch: string;
    excluded_bu: string[];
    people_count: number;
    unmatched_count: number;
  };
  totals: {
    bills: number; amount: number; target: number; points: number; ach_pct: number;
    point_reward: number; unit_reward: number; reward: number; special_reward: number; grand_total: number;
  };
  people: Person[];
  unit_rules: { code: string; description: string; group: string; brand: string | null; low_min_qty: number; low_reward: number; high_min_qty: number; high_reward: number }[];
  special_rewards: Special[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (value: number) => Math.round(Number(value || 0)).toLocaleString("en-US");
const pct = (value: number) => `${Math.round(Number(value || 0))}%`;
const achColor = (value: number) => (value >= 100 ? "var(--pos)" : value >= 90 ? "var(--warn)" : "var(--neg)");
const bandTone = (band: string) =>
  band === "high" ? "pill-pos" : band === "low" ? "pill-neg" : band === "no_target" ? "pill-muted" : "pill-warn";

export default function RetailIncentivePage() {
  const { t } = useLanguage();
  const now = new Date();
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [year, setYear] = useState(String(previous.getFullYear()));
  const [month, setMonth] = useState(String(previous.getMonth() + 1));
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/retail-incentive", { params: { year, month } });
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
    return [current, current - 1, current - 2].map(String);
  }, []);

  const currency = data?.meta.currency || "THB";

  return (
    <div className="min-h-screen">
      <header className="page-hd">
        <div className="min-w-0">
          <p className="eyebrow">Retail incentive</p>
          <h1 className="page-title">{t("incentive.title")}</h1>
          <p className="page-sub">
            {data
              ? `${MONTHS[data.meta.month - 1]} ${data.meta.year} · ${t("incentive.branch")} ${data.meta.branch} · ${data.meta.people_count} ${t("incentive.people")}`
              : t("app.loading")}
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <label className="field-label">{t("filter.year")}</label>
            <select className="select w-24" value={year} onChange={(e) => setYear(e.target.value)}>
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label">{t("monthSummary.month")}</label>
            <select className="select w-24" value={month} onChange={(e) => setMonth(e.target.value)}>
              {MONTHS.map((label, index) => (
                <option key={label} value={String(index + 1)}>{label}</option>
              ))}
            </select>
          </div>
          <button onClick={load} className="btn">
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

        {data && (
          <>
            {/* ── Reward summary ── */}
            <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              <div className="card stat stat-featured p-3.5 sm:col-span-2 lg:col-span-3 xl:col-span-2">
                <span className="stat-label flex items-center gap-1.5"><Coins size={12} /> {t("incentive.grandTotal")}</span>
                <p className="stat-value">{fmt(data.totals.grand_total)} <span className="text-sm font-semibold opacity-70">{currency}</span></p>
                <p className="stat-sub">
                  {t("incentive.points")} {fmt(data.totals.point_reward)} + {t("incentive.unitReward")} {fmt(data.totals.unit_reward)} + {t("incentive.specialShort")} {fmt(data.totals.special_reward)}
                </p>
              </div>
              <div className="card stat p-3.5">
                <span className="stat-label flex items-center gap-1.5"><Award size={12} /> {t("incentive.points")}</span>
                <p className="stat-value">{fmt(data.totals.points)}</p>
                <p className="stat-sub">× {data.meta.point_value} {currency} = {fmt(data.totals.point_reward)}</p>
              </div>
              <div className="card stat p-3.5">
                <span className="stat-label flex items-center gap-1.5"><Package size={12} /> {t("incentive.unitReward")}</span>
                <p className="stat-value">{fmt(data.totals.unit_reward)}</p>
                <p className="stat-sub">{data.unit_rules.length} {t("incentive.rules")}</p>
              </div>
              <div className="card stat p-3.5">
                <span className="stat-label flex items-center gap-1.5"><Target size={12} /> {t("incentive.salesVsTarget")}</span>
                <p className="stat-value">{fmt(data.totals.amount)}</p>
                <p className="stat-sub">{t("kpi.target")} {fmt(data.totals.target)} · {pct(data.totals.ach_pct)}</p>
                <div className="bar mt-2.5">
                  <div className={`bar-fill ${data.totals.ach_pct >= 100 ? "is-pos" : data.totals.ach_pct >= 90 ? "is-warn" : "is-neg"}`}
                       style={{ width: `${Math.min(Math.abs(data.totals.ach_pct), 100)}%` }} />
                </div>
              </div>
            </div>

            {/* ── Per person, expandable ── */}
            <section className="card">
              <div className="card-hd">
                <h3 className="card-title"><Award size={14} /> {t("incentive.byPerson")}</h3>
                <span className="page-sub">
                  {`≤${Math.round(data.meta.bands.low.max_ratio * 100)}% ×${data.meta.bands.low.multiplier} · ≤${Math.round(data.meta.bands.standard.max_ratio * 100)}% ×${data.meta.bands.standard.multiplier} · >${Math.round(data.meta.bands.standard.max_ratio * 100)}% ×${data.meta.bands.high.multiplier}`}
                </span>
              </div>
              <div className="card-bd-flush tbl-scroll">
                <table className="tbl" style={{ minWidth: 900 }}>
                  <thead>
                    <tr>
                      <th>{t("access.employee")}</th>
                      <th>{t("incentive.bills")}</th>
                      <th>{t("incentive.sales")}</th>
                      <th>{t("kpi.target")}</th>
                      <th>%</th>
                      <th>{t("incentive.points")}</th>
                      <th>{t("incentive.band")}</th>
                      <th>{t("incentive.pointReward")}</th>
                      <th>{t("incentive.unitReward")}</th>
                      <th>{t("incentive.reward")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.people.map((row) => {
                      const key = row.employee_code || row.name;
                      const expanded = open === key;
                      return (
                        <Fragment key={key}>
                          <tr onClick={() => setOpen(expanded ? null : key)} style={{ cursor: "pointer" }}>
                            <td>
                              <span className="inline-flex items-center gap-1.5">
                                <ChevronRight size={13} style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s", color: "var(--muted)" }} />
                                <span className="font-semibold" style={{ color: "var(--ink)" }}>{row.employee_code || "—"}</span>
                                <span style={{ color: "var(--muted)" }}>{row.name}</span>
                              </span>
                            </td>
                            <td>{fmt(row.bills)}</td>
                            <td>{fmt(row.amount)}</td>
                            <td>{row.target ? fmt(row.target) : "—"}</td>
                            <td style={{ color: row.target ? achColor(row.ach_pct) : "var(--muted)", fontWeight: 600 }}>
                              {row.target ? pct(row.ach_pct) : "—"}
                            </td>
                            <td>{fmt(row.points)}</td>
                            <td><span className={`pill ${bandTone(row.band)}`}>×{row.multiplier}</span></td>
                            <td>{fmt(row.point_reward)}</td>
                            <td>{row.unit_reward ? fmt(row.unit_reward) : "—"}</td>
                            <td style={{ color: "var(--ink)", fontWeight: 700 }}>{fmt(row.reward)}</td>
                          </tr>

                          {expanded && (
                            <tr>
                              <td colSpan={10} style={{ background: "var(--surface-2)", padding: "0.75rem" }}>
                                <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
                                  {/* group targets */}
                                  <div>
                                    <p className="field-label">{t("incentive.byGroup")}</p>
                                    {row.target_groups.length ? row.target_groups.map((group) => (
                                      <p key={group.group} className="num text-[11.5px]" style={{ color: "var(--ink-soft)" }}>
                                        {group.group}: {fmt(group.target)}
                                      </p>
                                    )) : <p className="page-sub">—</p>}
                                  </div>

                                  {/* brands */}
                                  <div>
                                    <p className="field-label">{t("incentive.byBrand")}</p>
                                    {row.brands.length ? row.brands.slice(0, 8).map((brand) => (
                                      <p key={`${brand.group}-${brand.brand}`} className="num text-[11.5px]" style={{ color: "var(--ink-soft)" }}>
                                        {brand.brand} · {fmt(brand.qty)} {t("incentive.units")} · {fmt(brand.amount)}
                                        {brand.target ? ` / ${fmt(brand.target)}` : ""}
                                      </p>
                                    )) : <p className="page-sub">—</p>}
                                  </div>

                                  {/* point categories */}
                                  <div>
                                    <p className="field-label">{t("incentive.byCategory")}</p>
                                    {row.point_categories.length ? row.point_categories.slice(0, 8).map((category) => (
                                      <p key={category.category} className="num text-[11.5px]" style={{ color: "var(--ink-soft)" }}>
                                        {category.category}: {fmt(category.points)}
                                      </p>
                                    )) : <p className="page-sub">—</p>}
                                  </div>

                                  {/* unit rewards + no-point lines */}
                                  <div>
                                    <p className="field-label">{t("incentive.unitReward")}</p>
                                    {row.unit_reward_lines.length ? row.unit_reward_lines.map((line) => (
                                      <p key={line.code} className="num text-[11.5px]" style={{ color: "var(--ink-soft)" }}>
                                        {line.brand || line.group}: {fmt(line.qty)} × {fmt(line.rate)} = {fmt(line.amount)}
                                      </p>
                                    )) : <p className="page-sub">—</p>}
                                    {row.no_point.lines > 0 && (
                                      <p className="mt-1.5 inline-flex items-center gap-1 text-[11px]" style={{ color: "var(--warn)" }}>
                                        <TriangleAlert size={11} /> {t("incentive.noPoint")}: {fmt(row.no_point.lines)} {t("incentive.lines")}
                                      </p>
                                    )}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: "var(--surface-2)", fontWeight: 700 }}>
                      <td style={{ color: "var(--ink)" }}>{t("incentive.total")}</td>
                      <td>{fmt(data.totals.bills)}</td>
                      <td>{fmt(data.totals.amount)}</td>
                      <td>{fmt(data.totals.target)}</td>
                      <td>{pct(data.totals.ach_pct)}</td>
                      <td>{fmt(data.totals.points)}</td>
                      <td />
                      <td>{fmt(data.totals.point_reward)}</td>
                      <td>{fmt(data.totals.unit_reward)}</td>
                      <td style={{ color: "var(--ink)" }}>{fmt(data.totals.reward)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>

            {/* ── Special rewards ── */}
            {data.special_rewards.length > 0 && (
              <section className="card mt-3">
                <div className="card-hd">
                  <h3 className="card-title"><Gift size={14} /> {t("incentive.special")}</h3>
                </div>
                <div className="card-bd-flush tbl-scroll">
                  <table className="tbl" style={{ minWidth: 640 }}>
                    <thead>
                      <tr>
                        <th>{t("incentive.condition")}</th>
                        <th>{t("kpi.target")}</th>
                        <th>{t("incentive.sales")}</th>
                        <th>%</th>
                        <th>{t("incentive.reward")}</th>
                        <th>{t("access.status")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.special_rewards.map((row) => (
                        <tr key={row.code}>
                          <td>{row.description || row.code}</td>
                          <td>{fmt(row.target_amount)}</td>
                          <td>{fmt(row.actual_amount)}</td>
                          <td style={{ color: achColor(row.ach_pct), fontWeight: 600 }}>{pct(row.ach_pct)}</td>
                          <td>{fmt(row.reward_amount)}</td>
                          <td>
                            <span className={`pill ${row.achieved ? "pill-pos" : "pill-muted"}`}>
                              {row.achieved ? t("incentive.achieved") : t("incentive.notAchieved")}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* ── Unit reward rules ── */}
            {data.unit_rules.length > 0 && (
              <section className="card mt-3">
                <div className="card-hd">
                  <h3 className="card-title"><Package size={14} /> {t("incentive.rules")}</h3>
                </div>
                <div className="card-bd-flush tbl-scroll">
                  <table className="tbl" style={{ minWidth: 640 }}>
                    <thead>
                      <tr>
                        <th>{t("incentive.condition")}</th>
                        <th>Group</th>
                        <th>Brand</th>
                        <th>{t("incentive.tierLow")}</th>
                        <th>{t("incentive.tierHigh")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.unit_rules.map((rule) => (
                        <tr key={rule.code}>
                          <td>{rule.description || rule.code}</td>
                          <td>{rule.group}</td>
                          <td>{rule.brand || "—"}</td>
                          <td>≥{fmt(rule.low_min_qty)} → {fmt(rule.low_reward)}</td>
                          <td>≥{fmt(rule.high_min_qty)} → {fmt(rule.high_reward)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <p className="mt-3 text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
              {t("incentive.note")}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
