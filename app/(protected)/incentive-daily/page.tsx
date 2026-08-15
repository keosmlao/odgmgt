"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarCheck, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Coins,
  RefreshCw, Sparkles, TrendingUp, UserX,
} from "lucide-react";
import api from "@/service/api";
import { useLanguage } from "@/context/LanguageContext";

type Rule = { category_code: string | null; brand_code: string | null; design_token: string; size_token: string };

type DailyLine = {
  item_code: string; item_name: string; category_name: string;
  pcat: string | null; brand: string;
  qty: number; amount: number; price: number;
  unit_points: number; points: number;
  in_scheme: boolean; no_rule: boolean;
  rule: Rule;
};

type Flag = "no_rule" | "no_seller" | "outlier" | "new_dimension";

type DailyBill = {
  doc_no: string; doc_date: string; employee_code: string | null;
  /** Employee name, or the spelling on the bill when it resolved to nobody. */
  seller: string; salename: string;
  qty: number; amount: number; points: number;
  flags: Flag[];
  lines: DailyLine[];
};

type GapItem = {
  doc_no: string; item_code: string; item_name: string; dimension: string;
  qty: number; amount: number; rule: Rule;
};
type FreshItem = {
  dimension: string; category_code: string; brand_code: string;
  design_token: string; size_token: string;
  qty: number; points: number; has_rule: boolean;
};
type OutlierItem = {
  doc_no: string; item_code: string; item_name: string; dimension: string;
  unit_points: number; median: number; ratio: number;
};

type Payload = {
  date: string;
  meta: { branch: string; year: number; month: number };
  totals: { bills: number; lines: number; qty: number; amount: number; points: number };
  checks: {
    no_rule: { lines: number; qty: number; amount: number; items: GapItem[] };
    no_seller: {
      lines: number; qty: number; amount: number; points: number;
      items: { salename: string; bills: string[]; qty: number; amount: number }[];
    };
    new_dimension: { lines: number; items: FreshItem[] };
    outlier: { lines: number; items: OutlierItem[] };
  };
  sellers: { employee_code: string | null; name: string; bills: number; qty: number; amount: number; points: number }[];
  bills: DailyBill[];
};

const fmt = (value: number) =>
  Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Today in Vientiane — the day the shop is actually having. */
const laoToday = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Vientiane", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

const shiftDay = (day: string, by: number) => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + by);
  return date.toISOString().slice(0, 10);
};

type CheckKey = "no_rule" | "no_seller" | "new_dimension" | "outlier";

const CHECKS: { key: CheckKey; label: string; hint: string; icon: React.ReactNode }[] = [
  { key: "no_rule", label: "daily.checkNoRule", hint: "daily.checkNoRuleHint", icon: <CircleAlert size={15} /> },
  { key: "no_seller", label: "daily.checkNoSeller", hint: "daily.checkNoSellerHint", icon: <UserX size={15} /> },
  { key: "new_dimension", label: "daily.checkNew", hint: "daily.checkNewHint", icon: <Sparkles size={15} /> },
  { key: "outlier", label: "daily.checkOutlier", hint: "daily.checkOutlierHint", icon: <TrendingUp size={15} /> },
];

export default function IncentiveDailyPage() {
  const { t } = useLanguage();
  const [day, setDay] = useState(laoToday);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<CheckKey | "">("");
  const [open, setOpen] = useState<string | null>(null);

  /** Only the newest request may write: day flicking is faster than the query. */
  const requestId = useRef(0);

  const load = async (fresh = false) => {
    const id = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/incentive-daily", {
        params: { date: day, ...(fresh ? { nocache: 1 } : {}) },
      });
      if (id !== requestId.current) return;
      if (res.data?.success) setData(res.data.data);
      else {
        if (!fresh) setData(null);
        setError(res.data?.error || t("app.error"));
      }
    } catch {
      if (id !== requestId.current) return;
      if (!fresh) setData(null);
      setError(t("app.error"));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  };

  useEffect(() => {
    load();
    setOpen(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  const counts = useMemo(() => ({
    no_rule: data?.checks.no_rule.lines ?? 0,
    no_seller: data?.checks.no_seller.lines ?? 0,
    new_dimension: data?.checks.new_dimension.lines ?? 0,
    outlier: data?.checks.outlier.lines ?? 0,
  }), [data]);

  const allClear = data && Object.values(counts).every((value) => value === 0);
  const isToday = day === laoToday();

  return (
    <div className="min-h-screen">
      <header className="page-hd">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-[var(--r-md)] bg-[var(--brand-deep)] text-white">
            <CalendarCheck size={19} />
          </span>
          <div>
            <p className="eyebrow">{t("daily.eyebrow")}</p>
            <h1 className="page-title">{t("daily.title")}</h1>
            <p className="page-sub">{t("daily.subtitle")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <button className="btn btn-icon" onClick={() => setDay(shiftDay(day, -1))} aria-label="previous day">
              <ChevronLeft size={14} />
            </button>
            <input
              className="input w-36"
              type="date"
              value={day}
              max={laoToday()}
              onChange={(event) => event.target.value && setDay(event.target.value)}
            />
            <button
              className="btn btn-icon"
              onClick={() => setDay(shiftDay(day, 1))}
              disabled={isToday}
              aria-label="next day"
            >
              <ChevronRight size={14} />
            </button>
          </div>
          {!isToday && (
            <button className="btn" onClick={() => setDay(laoToday())}>{t("daily.today")}</button>
          )}
          <button className="btn" onClick={() => load(true)}>
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
            {/* ── The day in five numbers ── */}
            <div className="mb-3 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <div className="card stat stat-featured p-3.5">
                <span className="stat-label flex items-center gap-1.5"><Coins size={12} /> {t("incentive.points")}</span>
                <p className="stat-value">{fmt(data.totals.points)}</p>
                <p className="stat-sub">{data.date}</p>
              </div>
              {[
                { label: t("incentive.invoiceCount"), value: fmt(data.totals.bills) },
                { label: t("incentive.lines"), value: fmt(data.totals.lines) },
                { label: t("incentive.units"), value: fmt(data.totals.qty) },
                { label: t("incentive.sales"), value: fmt(data.totals.amount) },
              ].map((tile) => (
                <div key={tile.label} className="card stat p-3.5">
                  <span className="stat-label">{tile.label}</span>
                  <p className="stat-value">{tile.value}</p>
                </div>
              ))}
            </div>

            {/* ── The checks, which are the reason this page exists ── */}
            <div className="mb-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {CHECKS.map((check) => {
                const count = counts[check.key];
                const isSelected = view === check.key;
                return (
                  <button
                    key={check.key}
                    type="button"
                    className={`card check-card p-3.5 text-left ${isSelected ? "is-selected" : ""} ${count ? "is-flagged" : "is-clear"}`}
                    onClick={() => setView(isSelected ? "" : check.key)}
                    disabled={!count}
                  >
                    <span className="stat-label flex items-center gap-1.5">
                      {count ? check.icon : <CircleCheck size={15} />} {t(check.label)}
                    </span>
                    <p className="stat-value" style={{ color: count ? "var(--neg)" : "var(--pos)" }}>
                      {count ? fmt(count) : "0"}
                    </p>
                    <p className="stat-sub">{t(check.hint)}</p>
                  </button>
                );
              })}
            </div>

            {allClear && (
              <p className="mb-3 flex items-center gap-2 rounded-[var(--r-md)] px-3 py-2 text-[12px] font-semibold"
                 style={{ background: "var(--pos-bg)", color: "var(--pos)" }}>
                <CircleCheck size={14} /> {t("daily.allClear")}
              </p>
            )}

            <section className="card">
              <div className="card-hd">
                <h3 className="card-title">
                  {view ? t(CHECKS.find((check) => check.key === view)!.label) : t("daily.bills")}
                </h3>
                <div className="tabs" role="tablist" aria-label={t("daily.bills")}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={!view}
                    className={`tab ${!view ? "is-active" : ""}`}
                    onClick={() => setView("")}
                  >
                    {t("daily.bills")}
                    <span className={`pill ${!view ? "" : "pill-muted"}`}>{data.bills.length}</span>
                  </button>
                  {CHECKS.filter((check) => counts[check.key] > 0).map((check) => (
                    <button
                      key={check.key}
                      type="button"
                      role="tab"
                      aria-selected={view === check.key}
                      className={`tab ${view === check.key ? "is-active" : ""}`}
                      onClick={() => setView(check.key)}
                    >
                      {t(check.label)}
                      <span className={`pill ${view === check.key ? "" : "pill-neg"}`}>{counts[check.key]}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Bills of the day, each expandable to the lines that scored them. */}
              {!view && (
                <div className="card-bd-flush tbl-scroll" style={{ maxHeight: 560, overflowY: "auto" }}>
                  <table className="tbl" style={{ minWidth: 760 }}>
                    <thead>
                      <tr>
                        <th style={{ width: 24 }} />
                        <th style={{ textAlign: "left" }}>{t("incentive.invoiceNo")}</th>
                        <th style={{ textAlign: "left" }}>{t("incentive.byPerson")}</th>
                        <th style={{ textAlign: "left" }}>{t("app.status")}</th>
                        <th>{t("incentive.lines")}</th>
                        <th>{t("incentive.units")}</th>
                        <th>{t("incentive.sales")}</th>
                        <th>{t("incentive.points")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.bills.map((bill) => {
                        const isOpen = open === bill.doc_no;
                        return (
                          <Fragment key={bill.doc_no}>
                            <tr style={{ cursor: "pointer" }} onClick={() => setOpen(isOpen ? null : bill.doc_no)}>
                              <td>
                                <ChevronRight
                                  size={13}
                                  style={{ transform: isOpen ? "rotate(90deg)" : undefined, transition: "120ms ease", color: "var(--muted)" }}
                                />
                              </td>
                              <td className="num" style={{ textAlign: "left", fontWeight: 700, color: "var(--ink)" }}>{bill.doc_no}</td>
                              <td style={{ textAlign: "left" }} title={bill.salename}>
                                {bill.employee_code ? (
                                  <>
                                    <span className="num mr-1.5" style={{ color: "var(--muted)" }}>{bill.employee_code}</span>
                                    {bill.seller}
                                  </>
                                ) : (
                                  <span style={{ color: "var(--neg)" }}>{bill.salename || "—"}</span>
                                )}
                              </td>
                              <td style={{ textAlign: "left" }}>
                                {bill.flags.map((flag) => (
                                  <span key={flag} className="pill pill-neg mr-1">
                                    {t(`daily.check${flag === "no_rule" ? "NoRule" : flag === "no_seller" ? "NoSeller" : flag === "outlier" ? "Outlier" : "New"}`)}
                                  </span>
                                ))}
                              </td>
                              <td className="num">{bill.lines.length}</td>
                              <td className="num">{fmt(bill.qty)}</td>
                              <td className="num">{fmt(bill.amount)}</td>
                              <td className="num" style={{ fontWeight: 700, color: bill.points ? "var(--pos)" : "var(--muted)" }}>
                                {fmt(bill.points)}
                              </td>
                            </tr>
                            {isOpen && bill.lines.map((line, index) => (
                              <tr key={`${bill.doc_no}-${line.item_code}-${index}`} style={{ background: "var(--surface-2)" }}>
                                <td />
                                {/* Four, not three: the item name runs under the
                                    bill, the seller, the status AND the line
                                    count, so the three figures that follow land
                                    beneath ໜ່ວຍ · ຍອດຂາຍ · ຄະແນນ. */}
                                <td colSpan={4} style={{ textAlign: "left" }} title={line.item_name}>
                                  <span className="num mr-1.5" style={{ color: "var(--muted)" }}>{line.item_code}</span>
                                  {line.item_name}
                                  {!line.in_scheme && <span className="pill pill-muted ml-1.5">{t("daily.outOfScheme")}</span>}
                                  {line.no_rule && <span className="pill pill-neg ml-1.5">{t("daily.checkNoRule")}</span>}
                                </td>
                                <td className="num">{fmt(line.qty)}</td>
                                <td className="num">{fmt(line.amount)}</td>
                                <td className="num" style={{ color: line.points ? "var(--ink)" : "var(--neg)" }}>
                                  {fmt(line.points)}
                                </td>
                              </tr>
                            ))}
                          </Fragment>
                        );
                      })}
                      {!data.bills.length && (
                        <tr>
                          <td colSpan={8} style={{ textAlign: "center", color: "var(--muted)", padding: "1.25rem" }}>
                            {t("label.noData")}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Sold inside the scheme with nothing to price it. */}
              {view === "no_rule" && (
                <div className="card-bd-flush tbl-scroll" style={{ maxHeight: 560, overflowY: "auto" }}>
                  <table className="tbl" style={{ minWidth: 760 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left" }}>{t("incentive.invoiceNo")}</th>
                        <th style={{ textAlign: "left" }}>{t("incentive.product")}</th>
                        <th style={{ textAlign: "left" }}>{t("daily.dimension")}</th>
                        <th>{t("incentive.units")}</th>
                        <th>{t("incentive.sales")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.checks.no_rule.items.map((item, index) => (
                        <tr key={`${item.doc_no}-${item.item_code}-${index}`}>
                          <td className="num" style={{ textAlign: "left" }}>{item.doc_no}</td>
                          <td style={{ textAlign: "left", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis" }} title={item.item_name}>
                            {item.item_name}
                          </td>
                          <td style={{ textAlign: "left", color: "var(--warn)" }}>{item.dimension}</td>
                          <td className="num">{fmt(item.qty)}</td>
                          <td className="num">{fmt(item.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Points that landed on nobody. */}
              {view === "no_seller" && (
                <div className="card-bd">
                  <p className="page-sub mb-2">
                    {fmt(data.checks.no_seller.lines)} {t("incentive.lines")} ·{" "}
                    {fmt(data.checks.no_seller.points)} {t("incentive.points")} ·{" "}
                    {fmt(data.checks.no_seller.amount)}
                  </p>
                  {/* Grouped by the spelling that failed: one alias row fixes
                      every bill under it, so that is the unit worth showing. */}
                  <div className="cfg-rows">
                    {data.checks.no_seller.items.map((item) => (
                      <div key={item.salename} className="cfg-row">
                        <span className="cfg-row-name" style={{ color: "var(--neg)" }}>{item.salename}</span>
                        <span className="cfg-row-note">{fmt(item.qty)} {t("incentive.units")}</span>
                        <span className="cfg-row-note">{fmt(item.amount)}</span>
                        <span className="flex flex-wrap justify-end gap-1" style={{ maxWidth: "45%" }}>
                          {item.bills.map((docNo) => (
                            <span key={docNo} className="pill pill-muted num">{docNo}</span>
                          ))}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="page-sub mt-3">{t("daily.noSellerFix")}</p>
                </div>
              )}

              {/* Rule dimensions sold today for the first time. */}
              {view === "new_dimension" && (
                <div className="card-bd-flush tbl-scroll" style={{ maxHeight: 560, overflowY: "auto" }}>
                  <table className="tbl" style={{ minWidth: 640 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left" }}>{t("daily.dimension")}</th>
                        <th>{t("incentive.units")}</th>
                        <th>{t("incentive.points")}</th>
                        <th style={{ textAlign: "left" }}>{t("app.status")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.checks.new_dimension.items.map((item) => (
                        <tr key={item.dimension}>
                          <td style={{ textAlign: "left" }}>{item.dimension}</td>
                          <td className="num">{fmt(item.qty)}</td>
                          <td className="num">{fmt(item.points)}</td>
                          <td style={{ textAlign: "left" }}>
                            {item.has_rule
                              ? <span className="pill pill-pos">{t("daily.hasRule")}</span>
                              : <span className="pill pill-neg">{t("daily.checkNoRule")}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* A rate far off what the same band pays everywhere else. */}
              {view === "outlier" && (
                <div className="card-bd-flush tbl-scroll" style={{ maxHeight: 560, overflowY: "auto" }}>
                  <table className="tbl" style={{ minWidth: 760 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left" }}>{t("incentive.invoiceNo")}</th>
                        <th style={{ textAlign: "left" }}>{t("incentive.product")}</th>
                        <th style={{ textAlign: "left" }}>{t("daily.dimension")}</th>
                        <th>{t("incentive.pointsPerUnit")}</th>
                        <th>{t("daily.median")}</th>
                        <th>{t("daily.times")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.checks.outlier.items.map((item, index) => (
                        <tr key={`${item.doc_no}-${item.item_code}-${index}`}>
                          <td className="num" style={{ textAlign: "left" }}>{item.doc_no}</td>
                          <td style={{ textAlign: "left", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis" }} title={item.item_name}>
                            {item.item_name}
                          </td>
                          <td style={{ textAlign: "left" }}>{item.dimension}</td>
                          <td className="num" style={{ fontWeight: 700, color: "var(--warn)" }}>{fmt(item.unit_points)}</td>
                          <td className="num">{fmt(item.median)}</td>
                          <td className="num">×{item.ratio.toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* ── Who sold what today ── */}
            <section className="card mt-3">
              <div className="card-hd">
                <h3 className="card-title">{t("daily.sellers")}</h3>
                <span className="pill pill-muted num">{data.sellers.length}</span>
              </div>
              <div className="card-bd-flush tbl-scroll">
                <table className="tbl" style={{ minWidth: 520 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>{t("incentive.byPerson")}</th>
                      <th>{t("incentive.invoiceCount")}</th>
                      <th>{t("incentive.units")}</th>
                      <th>{t("incentive.sales")}</th>
                      <th>{t("incentive.points")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sellers.map((seller) => (
                      <tr key={seller.employee_code ?? `name:${seller.name}`}>
                        <td style={{ textAlign: "left" }}>
                          {seller.employee_code ? (
                            <>
                              <span className="num mr-1.5" style={{ color: "var(--muted)" }}>{seller.employee_code}</span>
                              <span style={{ color: "var(--ink)", fontWeight: 600 }}>{seller.name}</span>
                            </>
                          ) : (
                            <>
                              <span style={{ color: "var(--neg)" }}>{seller.name}</span>
                              <span className="pill pill-neg ml-1.5">{t("daily.checkNoSeller")}</span>
                            </>
                          )}
                        </td>
                        <td className="num">{seller.bills}</td>
                        <td className="num">{fmt(seller.qty)}</td>
                        <td className="num">{fmt(seller.amount)}</td>
                        {/* Bills but no points is the shape worth catching here. */}
                        <td className="num" style={{ fontWeight: 700, color: seller.points ? "var(--pos)" : "var(--neg)" }}>
                          {fmt(seller.points)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <p className="mt-3 text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
              {t("daily.note")}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
