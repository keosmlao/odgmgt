"use client";

import { useEffect, useState } from "react";
import { BadgePercent, CalendarRange, History, Layers, RefreshCw } from "lucide-react";
import api from "@/service/api";
import { useLanguage } from "@/context/LanguageContext";
import { fmtDate } from "@/components/ui";

type Tier = { from_pct: number; mode: string; round_step: number };

type Row = {
  position_code: string;
  position_name: string | null;
  amounts: Record<string, number>;
  tiers: Tier[];
};

type Payload = {
  period: { from: string; to: string; source: string };
  config: {
    currency: string;
    commission_base: number;
    commission_min_pct: number;
    commission_pivot_pct: number;
    commission_round_step: number;
  };
  groups: string[];
  matrix: Row[];
  audit: {
    position_code: string;
    group_code: string;
    old_amount: number;
    new_amount: number;
    changed_by: string;
    changed_at: string;
  }[];
};

const fmt = (value: number) => Math.round(Number(value || 0)).toLocaleString("en-US");

/** app_incentive_config / _commission_tier store fractions (0.8 = 80%). */
const asPct = (value: number) => `${(Number(value || 0) * 100).toFixed(0)}%`;

/** How a tier rounds the achievement before it is paid. */
const MODE_LABEL: Record<string, string> = {
  zero: "ບໍ່ຈ່າຍ",
  round_down: "ປັດລົງ",
  round_up: "ປັດຂຶ້ນ",
};

export default function CommissionPage() {
  const { t } = useLanguage();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/commission");
      if (res.data?.success) setData(res.data.data);
      else {
        setData(null);
        setError(res.data?.message || res.data?.error || t("app.error"));
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
  }, []);

  const currency = data?.config.currency || "THB";

  return (
    <div className="min-h-screen">
      <header className="page-hd">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-[var(--r-md)] bg-[var(--brand-deep)] text-white">
            <BadgePercent size={19} />
          </span>
          <div>
            <p className="eyebrow">Commission</p>
            <h1 className="page-title">{t("commission.title")}</h1>
            <p className="page-sub">{t("commission.subtitle")}</p>
            {data && (
              <p className="mt-0.5 inline-flex items-center gap-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
                <CalendarRange size={11} />
                {t("commission.period")} {fmtDate(data.period.from)} → {fmtDate(data.period.to)}
                {data.period.source === "default" && (
                  <span className="pill pill-warn">{t("commission.periodDefault")}</span>
                )}
              </p>
            )}
          </div>
        </div>
        <button onClick={load} className="btn">
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> {t("monthSummary.refresh")}
        </button>
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
            {/* ── The rule in one line ── */}
            <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <div className="card stat stat-featured p-3.5">
                <span className="stat-label">{t("incentiveCfg.commissionBase")}</span>
                <p className="stat-value">
                  {fmt(data.config.commission_base)} <span className="text-sm font-semibold opacity-70">{currency}</span>
                </p>
                <p className="stat-sub">{t("commission.baseHint")}</p>
              </div>
              <div className="card stat p-3.5">
                <span className="stat-label">{t("incentiveCfg.commissionMin")}</span>
                <p className="stat-value">{asPct(data.config.commission_min_pct)}</p>
                <p className="stat-sub">{t("commission.minHint")}</p>
              </div>
              <div className="card stat p-3.5">
                <span className="stat-label">{t("incentiveCfg.commissionPivot")}</span>
                <p className="stat-value">{asPct(data.config.commission_pivot_pct)}</p>
                <p className="stat-sub">{t("commission.pivotHint")}</p>
              </div>
              <div className="card stat p-3.5">
                <span className="stat-label">{t("incentiveCfg.roundStep")}</span>
                <p className="stat-value">{data.config.commission_round_step}</p>
                <p className="stat-sub">{t("commission.stepHint")}</p>
              </div>
            </div>

            {/* ── Base amount per position × group ── */}
            <section className="card mb-3">
              <div className="card-hd">
                <h3 className="card-title"><Layers size={14} /> {t("commission.byPosition")}</h3>
                <span className="page-sub">{t("commission.byPositionHint")}</span>
              </div>
              <div className="card-bd-flush tbl-scroll">
                <table className="tbl" style={{ minWidth: 420 + data.groups.length * 120 }}>
                  <thead>
                    <tr>
                      <th style={{ minWidth: 190 }}>{t("commission.position")}</th>
                      {data.groups.map((group) => (
                        <th key={group}>{group}</th>
                      ))}
                      <th style={{ minWidth: 240 }}>{t("commission.tiers")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.matrix.map((row) => (
                      <tr key={row.position_code}>
                        <td>
                          <span className="font-semibold" style={{ color: "var(--ink)" }}>
                            {row.position_name || row.position_code}
                          </span>
                          <span className="num ml-2" style={{ color: "var(--muted)" }}>{row.position_code}</span>
                        </td>
                        {data.groups.map((group) => {
                          const value = row.amounts[group] || 0;
                          return (
                            <td key={group} style={{ fontWeight: value ? 700 : 400, color: value ? "var(--ink)" : "var(--muted)" }}>
                              {value ? fmt(value) : "—"}
                            </td>
                          );
                        })}
                        <td>
                          <span className="flex flex-wrap gap-1">
                            {row.tiers.length ? row.tiers.map((tier) => (
                              <span
                                key={`${row.position_code}-${tier.from_pct}`}
                                className={`pill ${tier.mode === "zero" ? "pill-neg" : tier.mode === "round_up" ? "pill-pos" : "pill-warn"}`}
                              >
                                ≥{asPct(tier.from_pct)} {MODE_LABEL[tier.mode] || tier.mode}
                                {tier.round_step ? ` ${tier.round_step}` : ""}
                              </span>
                            )) : <span style={{ color: "var(--muted)" }}>—</span>}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <div>
              {/* ── Change history ── */}
              <section className="card">
                <div className="card-hd">
                  <h3 className="card-title"><History size={14} /> {t("commission.history")}</h3>
                </div>
                <div className="card-bd-flush tbl-scroll" style={{ maxHeight: 320, overflowY: "auto" }}>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>{t("commission.position")}</th>
                        <th>Group</th>
                        <th>{t("commission.change")}</th>
                        <th>{t("commission.by")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.audit.map((row, index) => (
                        <tr key={index}>
                          <td>{row.position_code}</td>
                          <td>{row.group_code}</td>
                          <td>
                            <span style={{ color: "var(--muted)" }}>{fmt(row.old_amount)}</span>
                            <span style={{ color: "var(--muted)" }}> → </span>
                            <span style={{ fontWeight: 700, color: row.new_amount >= row.old_amount ? "var(--pos)" : "var(--neg)" }}>
                              {fmt(row.new_amount)}
                            </span>
                          </td>
                          <td>
                            {row.changed_by}
                            <span className="ml-1.5" style={{ color: "var(--muted)" }}>{fmtDate(row.changed_at)}</span>
                          </td>
                        </tr>
                      ))}
                      {!data.audit.length && (
                        <tr>
                          <td colSpan={4} style={{ textAlign: "center", color: "var(--muted)", padding: "1.25rem" }}>
                            {t("label.noData")}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>

            <p className="mt-3 text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
              {t("commission.note")}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
