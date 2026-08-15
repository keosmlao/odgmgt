"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Award, CheckCircle2, ChevronRight, Coins, Gift, Lock, Package, RefreshCw, RotateCcw, Target, TriangleAlert, X } from "lucide-react";
import api from "@/service/api";
import { useLanguage } from "@/context/LanguageContext";

type Brand = { group: string; brand: string; qty: number; amount: number; target: number };
type PointLine = {
  doc_no: string; doc_date: string; item_code: string; item_name: string;
  qty: number; amount: number; price: number; unit_points: number; points: number; unmatched_qty: number;
  /** Why the line scored nothing; null when it did score. */
  no_point_reason: string | null;
  /** The rule and multiplier behind the points; null when it scored nothing. */
  point_basis: string | null;
  /** The four dimensions the rule is keyed by, for linking to the config. */
  rule?: {
    category_code: string | null;
    brand_code: string | null;
    design_token: string;
    size_token: string;
  };
};
type PointBrandNode = { brand: string; pcat: string; qty: number; amount: number; points: number; lines: PointLine[] };
/** Top of the drill: the point-map group the rules are actually written against. */
type PointGroup = { pcat: string; qty: number; amount: number; points: number; brands: PointBrandNode[] };
type UnitLine = { code: string; description: string; group: string; brand: string | null; qty: number; rate: number; amount: number };

type Person = {
  employee_code: string | null;
  name: string;
  group: string;
  bills: number;
  amount: number;
  target: number;
  ach_pct: number;
  points: number;
  band: string;
  multiplier: number;
  point_reward: number;
  unit_reward: number;
  commission_base: number;
  commission_rate: number;
  commission: number;
  unit_reward_lines: UnitLine[];
  reward: number;
  target_groups: { group: string; target: number }[];
  brands: Brand[];
  point_categories: { category: string; points: number }[];
  point_tree?: PointGroup[];
  no_point: { amount: number; lines: number };
  unmatched?: boolean;
};

/** Why a line inside the scheme still scored nothing. */
type ZeroKind = "no_rule" | "no_bonus" | "zero_rule" | "other";
type ZeroLine = {
  item_code: string; item_name: string; category_name: string;
  /** The ERP's own wording behind the tokens the rule is looked up by. */
  size_name: string; design_name: string;
  qty: number; amount: number; price: number; points: number;
  /** null on a line that scored normally — the rest of the bill. */
  kind: ZeroKind | null;
  reason: string | null;
  basis: string | null;
  in_scheme: boolean;
  rule: { category_code: string | null; brand_code: string | null; design_token: string; size_token: string };
};
type ZeroBill = {
  doc_no: string; doc_date: string; employee_code: string | null; seller: string;
  /** The unpaid portion; total_* is the whole bill. */
  qty: number; amount: number;
  total_qty: number; total_amount: number; total_points: number; flagged_lines: number;
  kinds: ZeroKind[]; lines: ZeroLine[];
};
type ZeroBills = {
  total: number; lines: number; qty: number; amount: number;
  kinds: Record<ZeroKind, number>;
  bills: ZeroBill[];
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

type Manager = {
  employee_code: string;
  name: string;
  position: string;
  commission: number;
  lines: {
    group: string;
    base: number;
    amount: number;
    target: number;
    ach_pct: number;
    rate: number;
    commission: number;
  }[];
};

type Payout = {
  status: string;
  paid_by: string | null;
  paid_at: string | null;
  note: string | null;
} | null;

type Payload = {
  payout: Payout;
  meta: {
    year: number;
    month: number;
    currency: string;
    point_value: number;
    bands?: { low: { max_ratio: number; multiplier: number }; standard: { max_ratio: number; multiplier: number }; high: { multiplier: number } };
    branch: string;
    excluded_bu: string[];
    people_count: number;
    unmatched_count: number;
    frozen?: boolean;
  };
  totals: {
    bills: number; amount: number; target: number; points: number; ach_pct: number;
    point_reward: number; unit_reward: number; commission: number; reward: number; special_reward: number; grand_total: number;
  };
  people: Person[];
  managers?: Manager[];
  /** Absent on a frozen month, whose figures are the stored payout. */
  zero_bills?: ZeroBills;
  unit_rules: { code: string; description: string; group: string; brand: string | null; low_min_qty: number; low_reward: number; high_min_qty: number; high_reward: number }[];
  special_rewards: Special[];
};

const fmt = (value: number) =>
  Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
const pct = (value: number) => `${Math.round(Number(value || 0))}%`;
const fmtDate = (value: string) => value
  ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Vientiane", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value))
  : "—";
const achColor = (value: number) => (value >= 100 ? "var(--pos)" : value >= 90 ? "var(--warn)" : "var(--neg)");
/**
 * Zero points read red at every level of the drill-down.
 *
 * A sold line that earned nothing is the thing worth finding — it is either a
 * deliberate exclusion or a gap in the point map — and it should stand out
 * without having to read the condition column first.
 */
const COLUMN_ITEM_CODE = "ລະຫັດສິນຄ້າ";
const pointsColor = (points: number) => (Number(points || 0) === 0 ? "var(--neg)" : "var(--ink)");
type RuleRow = {
  id: number;
  category_code: string;
  brand_code: string;
  design_token: string;
  size_token: string;
  points: number;
  is_special: boolean;
  effective_from: string;
  effective_to: string;
  span_days: number;
  exact_band: boolean;
};

/** A rule next door: same design under another brand, or the same brand elsewhere. */
type NearbyRule = {
  brand_code: string;
  design_token: string;
  size_token: string;
  points: number;
  same_brand: boolean;
  same_design: boolean;
  same_band: boolean;
};

/**
 * The rule behind one sold line, opened in place.
 *
 * Navigating to the configuration screen answered the question but lost the
 * reader's place in a drill-down they may be ten rows into, so the answer comes
 * to them. Every rule that could have matched is listed in the report's own
 * precedence order: the first won, the rest say what it beat — which is the
 * part a rate alone can never explain.
 */
function RuleModal({
  line, year, month, onClose,
}: {
  line: PointLine;
  year: string;
  month: string;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const [data, setData] = useState<{
    winner: RuleRow | null;
    candidates: RuleRow[];
    nearby?: NearbyRule[];
    suggestion?: { points: number; from: number } | null;
  } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api.get("/incentive-rule", {
      params: {
        year,
        month,
        category_code: line.rule?.category_code ?? "",
        brand_code: line.rule?.brand_code ?? "",
        design_token: line.rule?.design_token ?? "",
        size_token: line.rule?.size_token ?? "",
      },
    })
      .then((res) => alive && setData(res.data?.data ?? { winner: null, candidates: [] }))
      .catch((err) => alive && setError(err?.response?.data?.message ?? String(err)));
    return () => { alive = false; };
  }, [line, year, month]);

  const rule = line.rule;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full" style={{ maxWidth: 720 }} onClick={(event) => event.stopPropagation()}>
        <div className="card-hd">
          <div className="min-w-0">
            <h3 className="card-title">{t("incentive.pointCondition")}</h3>
            <p className="page-sub ml-3.5" title={line.item_name}>{line.item_name}</p>
          </div>
          <button className="btn btn-ghost" onClick={onClose} aria-label="close"><X size={14} /></button>
        </div>

        <div className="card-bd grid gap-2 sm:grid-cols-4">
          {[
            [t("incentive.byCategory"), rule?.category_code],
            [t("incentive.brand"), rule?.brand_code],
            [t("incentive.design"), rule?.design_token || "—"],
            [t("incentive.size"), rule?.size_token || "—"],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <span className="field-label">{label}</span>
              <p className="num font-semibold" style={{ color: "var(--ink)" }}>{value || "—"}</p>
            </div>
          ))}
        </div>

        {line.no_point_reason && (
          <p className="card-bd" style={{ color: "var(--warn)" }}>{line.no_point_reason}</p>
        )}
        {error && <p className="card-bd" style={{ color: "var(--neg)" }}>{error}</p>}

        <div className="card-bd-flush tbl-scroll" style={{ maxHeight: 300, overflowY: "auto" }}>
          <table className="tbl" style={{ minWidth: 560 }}>
            <thead>
              <tr>
                <th>{t("incentive.size")}</th>
                <th>{t("incentive.points")}</th>
                <th style={{ textAlign: "left" }}>{t("incentiveCfg.effective")}</th>
                <th style={{ textAlign: "left" }}>{t("app.status")}</th>
              </tr>
            </thead>
            <tbody>
              {(data?.candidates ?? []).map((candidate, index) => (
                <tr key={candidate.id} style={index === 0 ? { background: "var(--surface-2)" } : undefined}>
                  <td className="num">{candidate.size_token}</td>
                  <td className="num" style={{ fontWeight: 700, color: pointsColor(candidate.points) }}>{candidate.points}</td>
                  <td className="num" style={{ textAlign: "left", color: "var(--muted)" }}>
                    {candidate.effective_from} → {candidate.effective_to}
                  </td>
                  <td style={{ textAlign: "left" }}>
                    {index === 0
                      ? <span className="pill pill-pos">{t("incentive.ruleUsed")}</span>
                      : <span className="pill pill-muted">{t("incentive.ruleBeaten")}</span>}
                    {!candidate.exact_band && <span className="pill pill-warn ml-1">{t("incentive.ruleCeiling")}</span>}
                    {candidate.span_days < 60 && <span className="pill ml-1">{t("incentiveCfg.legendOverride")}</span>}
                  </td>
                </tr>
              ))}
              {data && data.candidates.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ textAlign: "center", color: "var(--muted)", padding: "1rem" }}>
                    {t("incentive.ruleNone")}
                  </td>
                </tr>
              )}
              {/* Nothing matched, so show what the neighbours pay: the same
                  design under other brands first, then this brand's own other
                  designs. Without it the screen states a problem and leaves the
                  reader to go and find the comparison by hand. */}
              {data && data.candidates.length === 0 && (data.nearby?.length ?? 0) > 0 && (
                <>
                  <tr>
                    <td colSpan={4} className="field-label" style={{ textAlign: "left", background: "var(--surface-2)" }}>
                      {t("incentive.nearby")}
                      {data.suggestion && (
                        <span className="pill pill-warn ml-2">
                          {t("incentive.nearbySuggest")} {data.suggestion.points} · {data.suggestion.from} {t("incentive.brands")}
                        </span>
                      )}
                    </td>
                  </tr>
                  {data.nearby!.map((row, index) => (
                    <tr key={`${row.brand_code}-${row.design_token}-${row.size_token}-${index}`}>
                      <td className="num">{row.size_token}</td>
                      <td className="num" style={{ fontWeight: 700, color: pointsColor(row.points) }}>{row.points}</td>
                      <td style={{ textAlign: "left", color: "var(--ink-soft)" }}>
                        {row.brand_code} · {row.design_token || "—"}
                      </td>
                      <td style={{ textAlign: "left" }}>
                        {row.same_design && row.same_band && <span className="pill pill-pos">{t("incentive.sameBand")}</span>}
                        {row.same_design && !row.same_band && <span className="pill">{t("incentive.sameDesign")}</span>}
                        {row.same_brand && !row.same_design && <span className="pill pill-muted">{t("incentive.sameBrand")}</span>}
                      </td>
                    </tr>
                  ))}
                </>
              )}
              {!data && !error && (
                <tr><td colSpan={4} style={{ textAlign: "center", padding: "1rem" }}>…</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card-bd flex items-center justify-between gap-2">
          <span className="page-sub num">
            {fmt(line.qty)} × {fmt(line.unit_points)} = <b style={{ color: pointsColor(line.points) }}>{fmt(line.points)}</b>
          </span>
          <button className="btn btn-ghost" onClick={onClose}>{t("app.close")}</button>
        </div>
      </div>
    </div>
  );
}

/** The four ways a line inside the scheme can still pay nothing. */
const ZERO_KINDS: { key: ZeroKind; label: string; tone: string }[] = [
  { key: "no_rule", label: "incentive.kindNoRule", tone: "pill-neg" },
  { key: "no_bonus", label: "incentive.kindNoBonus", tone: "pill-warn" },
  { key: "zero_rule", label: "incentive.kindZeroRule", tone: "pill-warn" },
  { key: "other", label: "incentive.kindOther", tone: "pill-muted" },
];

/**
 * The bills that sold something the scheme covers and scored nothing anyway.
 *
 * Every one of these lines was already reachable in the per-person drill-down,
 * three clicks deep and split across sellers — which is another way of saying
 * nobody found them. A missing rule costs the seller their bonus silently, so
 * it belongs on the report, above the payout it quietly reduced.
 */
function ZeroBillsCard({
  data, currency, t, onLine,
}: {
  data: ZeroBills;
  currency: string;
  t: (key: string) => string;
  onLine: (line: PointLine) => void;
}) {
  const [kind, setKind] = useState<ZeroKind | "">("");
  const [open, setOpen] = useState<string | null>(null);

  const bills = kind ? data.bills.filter((bill) => bill.kinds.includes(kind)) : data.bills;
  const kindLabel = (key: ZeroKind) => t(ZERO_KINDS.find((item) => item.key === key)?.label ?? "incentive.kindOther");
  const kindTone = (key: ZeroKind) => ZERO_KINDS.find((item) => item.key === key)?.tone ?? "pill-muted";

  return (
    <section className="card mb-3">
      <div className="card-hd">
        <div className="min-w-0">
          <h3 className="card-title"><TriangleAlert size={14} /> {t("incentive.zeroBills")}</h3>
          <p className="page-sub ml-3.5">{t("incentive.zeroBillsHint")}</p>
        </div>
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="pill pill-neg num">{fmt(data.total)} {t("incentive.invoiceCount")}</span>
          <span className="pill pill-muted num">{fmt(data.qty)} {t("incentive.units")}</span>
          <span className="pill pill-muted num">{fmt(data.amount)} {currency}</span>
        </span>
      </div>

      {data.total > 0 && (
        <div className="border-b px-[var(--pad-card)] py-2" style={{ borderColor: "var(--line-soft)" }}>
          <div className="tabs" role="tablist" aria-label={t("incentive.zeroBills")}>
            <button
              type="button"
              role="tab"
              aria-selected={!kind}
              className={`tab ${!kind ? "is-active" : ""}`}
              onClick={() => setKind("")}
            >
              {t("incentive.total")}
              <span className={`pill ${!kind ? "" : "pill-muted"}`}>{data.total}</span>
            </button>
            {ZERO_KINDS.filter((item) => data.kinds?.[item.key] > 0).map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={kind === item.key}
                className={`tab ${kind === item.key ? "is-active" : ""}`}
                onClick={() => setKind(item.key)}
              >
                {t(item.label)}
                <span className={`pill ${kind === item.key ? "" : item.tone}`}>{data.kinds[item.key]}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card-bd-flush tbl-scroll" style={{ maxHeight: 420, overflowY: "auto" }}>
        <table className="tbl" style={{ minWidth: 760 }}>
          <thead>
            <tr>
              <th style={{ width: 24 }} />
              <th style={{ textAlign: "left" }}>{t("incentive.invoiceNo")}</th>
              <th style={{ textAlign: "left" }}>{t("incentive.date")}</th>
              <th style={{ textAlign: "left" }}>{t("incentive.byPerson")}</th>
              <th style={{ textAlign: "left" }}>{t("app.status")}</th>
              <th>{t("incentive.lines")}</th>
              <th>{t("incentive.units")}</th>
              <th>{t("incentive.sales")}</th>
              <th>{t("incentive.points")}</th>
            </tr>
          </thead>
          <tbody>
            {bills.map((bill) => {
              // Filtering by reason narrows which lines are highlighted, never
              // which lines are shown: a bill is read whole or not at all.
              const lines = bill.lines;
              const isOpen = open === bill.doc_no;
              return (
                <Fragment key={bill.doc_no}>
                  <tr
                    style={{ cursor: "pointer" }}
                    onClick={() => setOpen(isOpen ? null : bill.doc_no)}
                  >
                    <td>
                      <ChevronRight
                        size={13}
                        style={{ transform: isOpen ? "rotate(90deg)" : undefined, transition: "120ms ease", color: "var(--muted)" }}
                      />
                    </td>
                    <td className="num" style={{ textAlign: "left", fontWeight: 700, color: "var(--ink)" }}>{bill.doc_no}</td>
                    <td className="num" style={{ textAlign: "left", color: "var(--muted)" }}>{fmtDate(bill.doc_date)}</td>
                    <td style={{ textAlign: "left" }}>{bill.seller}</td>
                    <td style={{ textAlign: "left" }}>
                      {bill.kinds.map((key) => (
                        <span key={key} className={`pill ${kindTone(key)} mr-1`}>{kindLabel(key)}</span>
                      ))}
                    </td>
                    {/* Unpaid lines out of the whole bill, so the row says how
                        much of this bill is actually the problem. */}
                    <td className="num" title={`${bill.flagged_lines} / ${lines.length}`}>
                      <span style={{ color: "var(--neg)", fontWeight: 700 }}>{bill.flagged_lines}</span>
                      <span style={{ color: "var(--muted)" }}>/{lines.length}</span>
                    </td>
                    <td className="num">{fmt(bill.qty)}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{fmt(bill.amount)}</td>
                    {/* What the bill DID earn. The row above it counts what went
                        unpaid; without this the reader cannot tell a bill that
                        earned nothing at all from one that earned well and had
                        a single line fall through. */}
                    <td className="num" style={{ fontWeight: 700, color: bill.total_points ? "var(--pos)" : "var(--neg)" }}>
                      {fmt(bill.total_points)}
                    </td>
                  </tr>
                  {/* The whole bill, not only its unpaid lines: what else was
                      sold on it is how you tell a genuine gap from a bill that
                      was mostly fine. Unpaid lines are the tinted ones. */}
                  {isOpen && lines.map((line, index) => (
                    <tr
                      key={`${bill.doc_no}-${line.item_code}-${index}`}
                      style={{ background: line.kind ? "var(--neg-bg)" : "var(--surface-2)" }}
                    >
                      <td />
                      <td colSpan={3} style={{ textAlign: "left" }} title={line.item_name}>
                        <span className="num mr-1.5" style={{ color: "var(--muted)" }}>{line.item_code}</span>
                        {line.item_name}
                        {/* What the ERP called the size and design of this item.
                            When the reason is "no matching rule", this is the
                            wording the rule has to be written against. */}
                        {(line.size_name || line.design_name) && (
                          <span className="ml-1.5 inline-flex gap-1">
                            {line.design_name && <span className="pill pill-muted">{line.design_name}</span>}
                            {line.size_name && <span className="pill pill-muted num">{line.size_name}</span>}
                          </span>
                        )}
                      </td>
                      <td colSpan={2} style={{ textAlign: "left" }}>
                        {/* Straight to the rule that priced it — or should have. */}
                        <button
                          type="button"
                          className="rule-link"
                          style={{ color: line.kind ? "var(--warn)" : "var(--muted)" }}
                          onClick={(event) => {
                            event.stopPropagation();
                            onLine({
                              doc_no: bill.doc_no,
                              doc_date: bill.doc_date,
                              item_code: line.item_code,
                              item_name: line.item_name,
                              qty: line.qty,
                              amount: line.amount,
                              price: line.price,
                              unit_points: line.qty ? line.points / line.qty : 0,
                              points: line.points,
                              unmatched_qty: line.kind ? line.qty : 0,
                              no_point_reason: line.reason,
                              point_basis: line.basis,
                              rule: line.rule,
                            });
                          }}
                        >
                          {line.reason ?? line.basis ?? "—"}
                        </button>
                      </td>
                      <td className="num">{fmt(line.qty)}</td>
                      <td className="num">{fmt(line.amount)}</td>
                      <td className="num" style={{ fontWeight: 700, color: line.points ? "var(--pos)" : "var(--neg)" }}>
                        {fmt(line.points)}
                      </td>
                    </tr>
                  ))}
                  {/* The bill's own totals, so the expansion closes on a figure
                      that matches the paper the customer was handed. */}
                  {isOpen && (
                    <tr style={{ background: "var(--surface-2)", fontWeight: 700 }}>
                      <td />
                      <td colSpan={5} style={{ textAlign: "left", color: "var(--ink)" }}>{t("incentive.total")}</td>
                      <td className="num">{fmt(bill.total_qty)}</td>
                      <td className="num">{fmt(bill.total_amount)}</td>
                      <td className="num" style={{ color: bill.total_points ? "var(--pos)" : "var(--neg)" }}>
                        {fmt(bill.total_points)}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {!bills.length && (
              <tr>
                <td colSpan={9} style={{ textAlign: "center", color: "var(--pos)", padding: "1.25rem" }}>
                  {t("incentive.zeroBillsNone")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {data.total > data.bills.length && (
        <p className="card-bd page-sub">
          {t("incentive.showingTop")} {data.bills.length}/{data.total} {t("incentive.invoiceCount")}
        </p>
      )}
    </section>
  );
}

/** One colour per point-map group, so a category reads the same everywhere. */
const PCAT_TONE: Record<string, string> = {
  REF: "pill-pos",
  Washer: "pill-pos",
  AV: "",
  Air: "",
  SDA: "pill-warn",
};
const bandTone = (band: string) =>
  band === "high" ? "pill-pos" : band === "low" ? "pill-neg" : band === "no_target" ? "pill-muted" : "pill-warn";

/**
 * Where the chosen month is remembered, shared with the configuration screen.
 *
 * Reading this report means leaving it — to a bill, to the point map, to fix a
 * band and come back — and being returned to the current month every time is
 * how a rule gets checked against the wrong one. The key is deliberately not
 * page-specific: the month is one decision, and every incentive screen should
 * be looking at the same one.
 */
const PERIOD_KEY = "odg_incentive_period";

export default function RetailIncentivePage() {
  const { t, locale } = useLanguage();
  const now = new Date();

  const [year, setYear] = useState(String(now.getFullYear()));
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  /** The sold line whose point rule is being inspected; null = modal closed. */
  const [ruleLine, setRuleLine] = useState<PointLine | null>(null);

  /**
   * Which request the screen is currently waiting for.
   *
   * Changing the month fires a load, and a refresh fires another; a recompute
   * (nocache) takes seconds while a cached read returns at once, so responses
   * can arrive out of order. Without this the last response to land wins and
   * the screen snaps back to a month the user already left. Only the newest
   * request may write to the screen.
   */
  const requestId = useRef(0);

  /** Restore the month last worked on, before the first load runs. */
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

  /**
   * The month is cached for five minutes and served stale for a day, so a plain
   * reload hands back the same figures — which reads as the screen reverting
   * after a rule was changed. The refresh button therefore recomputes.
   */
  const load = async (fresh = false) => {
    const id = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/retail-incentive", {
        params: { year, month, ...(fresh ? { nocache: 1 } : {}) },
      });
      if (id !== requestId.current) return;
      if (res.data?.success) setData(res.data.data);
      else {
        // A manual refresh should not blank a good screen on a transient error.
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
    if (!restored) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored, year, month]);

  const markPaid = async () => {
    if (!data || !window.confirm(t("incentive.confirmPay"))) return;
    setSaving(true);
    setError("");
    try {
      const res = await api.post("/retail-incentive/payout", {
        year: Number(year),
        month: Number(month),
        currency: data.meta.currency,
        people: data.people,
        managers: data.managers || [],
      });
      if (res.data?.success) await load();
      else setError(res.data?.message || t("app.error"));
    } catch (err: unknown) {
      const message = typeof err === "object" && err !== null && "response" in err
        ? (err as { response?: { data?: { message?: string } } }).response?.data?.message
        : undefined;
      setError(message || t("app.error"));
    } finally {
      setSaving(false);
    }
  };

  const reopen = async () => {
    if (!window.confirm(t("incentive.confirmReopen"))) return;
    setSaving(true);
    try {
      await api.delete("/retail-incentive/payout", { params: { year, month } });
      await load();
    } catch {
      setError(t("app.error"));
    } finally {
      setSaving(false);
    }
  };

  const years = useMemo(() => {
    const current = new Date().getFullYear();
    return [current, current - 1, current - 2].map(String);
  }, []);
  const months = useMemo(
    () => Array.from({ length: 12 }, (_, index) =>
      new Intl.DateTimeFormat(locale === "lo" ? "lo-LA" : locale === "th" ? "th-TH" : "en-US", { month: "long" })
        .format(new Date(2026, index, 1))),
    [locale],
  );

  const currency = data?.meta.currency || "THB";
  const groupLabel = (group: string) =>
    group === "CE_SDA" ? t("incentive.groupCeSda")
      : group === "AIR" ? t("incentive.groupAir")
        : group === "ALL" ? t("incentive.groupAll")
          : group;

  return (
    <div className="min-h-screen">
      <header className="page-hd">
        <div className="min-w-0">
          <p className="eyebrow">{t("incentive.eyebrow")}</p>
          <h1 className="page-title">{t("incentive.title")}</h1>
          <p className="page-sub">
            {data
              ? `${months[data.meta.month - 1]} ${data.meta.year} · ${t("incentive.branch")} ${data.meta.branch} · ${data.meta.people_count} ${t("incentive.people")}`
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
              {months.map((label, index) => (
                <option key={label} value={String(index + 1)}>{label}</option>
              ))}
            </select>
          </div>
          <button onClick={() => load(true)} className="btn">
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> {t("monthSummary.refresh")}
          </button>
          {data && !data.payout && (
            <button onClick={markPaid} className="btn btn-primary" disabled={saving || !data.people.length}>
              <CheckCircle2 size={13} /> {t("incentive.markPaid")}
            </button>
          )}
          {data?.payout && (
            <button onClick={reopen} className="btn" disabled={saving} title={t("incentive.reopenHint")}>
              <RotateCcw size={13} /> {t("incentive.reopen")}
            </button>
          )}
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
            {data.payout && (
              <div
                className="mb-3 flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border px-3 py-2 text-[12px] font-medium"
                style={{ borderColor: "var(--pos)", background: "var(--pos-bg)", color: "var(--pos)" }}
              >
                <Lock size={13} />
                {t("incentive.paidBanner")}
                <span className="pill pill-pos">
                  {t("incentive.paidBy")} {data.payout.paid_by || "-"} · {fmtDate(data.payout.paid_at ?? "")}
                </span>
              </div>
            )}

            {/* ── Reward summary ── */}
            <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <div className="card stat stat-featured p-3.5 sm:col-span-2 lg:col-span-3 xl:col-span-2">
                <span className="stat-label flex items-center gap-1.5"><Coins size={12} /> {t("incentive.grandTotal")}</span>
                <p className="stat-value">{fmt(data.totals.grand_total)} <span className="text-sm font-semibold opacity-70">{currency}</span></p>
                <p className="stat-sub">
                  {t("incentive.points")} {fmt(data.totals.point_reward)} + {t("incentive.unitReward")} {fmt(data.totals.unit_reward)} + {t("incentive.commission")} {fmt(data.totals.commission)} + {t("incentive.specialShort")} {fmt(data.totals.special_reward)}
                </p>
              </div>
              <div className="card stat p-3.5">
                <span className="stat-label flex items-center gap-1.5"><Award size={12} /> {t("incentive.points")}</span>
                <p className="stat-value">{fmt(data.totals.points)}</p>
                <p className="stat-sub">
                  1 {t("incentive.points")} = {data.meta.point_value} {currency} · {t("incentive.reward")} {fmt(data.totals.point_reward)}
                </p>
              </div>
              <div className="card stat p-3.5">
                <span className="stat-label flex items-center gap-1.5"><Package size={12} /> {t("incentive.unitReward")}</span>
                <p className="stat-value">{fmt(data.totals.unit_reward)}</p>
                <p className="stat-sub">{data.unit_rules.length} {t("incentive.rules")}</p>
              </div>
              <div className="card stat p-3.5">
                <span className="stat-label flex items-center gap-1.5"><Coins size={12} /> {t("incentive.commission")}</span>
                <p className="stat-value">{fmt(data.totals.commission)}</p>
                <p className="stat-sub">{t("incentive.commissionHint")}</p>
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

            {(data.managers?.length ?? 0) > 0 && (
              <section className="mb-3 grid gap-3 lg:grid-cols-2">
                {(data.managers ?? []).map((manager) => (
                  <div className="card p-4" key={manager.employee_code}>
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div>
                        <span className="pill pill-warn">
                          {manager.position === "11" ? t("incentive.unitHead") : t("incentive.manager")}
                        </span>
                        <p className="mt-2 font-semibold" style={{ color: "var(--ink)" }}>{manager.name}</p>
                        <p className="page-sub">{manager.employee_code}</p>
                      </div>
                      <div className="text-right">
                        <p className="field-label">{t("incentive.totalCommission")}</p>
                        <p className="stat-value" style={{ color: "var(--pos)" }}>{fmt(manager.commission)}</p>
                        <p className="page-sub">{currency}</p>
                      </div>
                    </div>
                    <div className="tbl-scroll">
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th>{t("incentive.group")}</th>
                            <th>{t("incentive.commissionBase")}</th>
                            <th>{t("incentive.achievedPct")}</th>
                            <th>{t("incentive.commissionRate")}</th>
                            <th>{t("incentive.commission")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {manager.lines.filter((line) => line.group !== "ALL").map((line) => (
                            <tr key={line.group}>
                              <td>{groupLabel(line.group)}</td>
                              <td>{fmt(line.base)}</td>
                              <td>{line.ach_pct.toFixed(4)}%</td>
                              <td>{pct(line.rate * 100)}</td>
                              <td style={{ color: "var(--ink)", fontWeight: 700 }}>{fmt(line.commission)}</td>
                            </tr>
                          ))}
                        </tbody>
                        {manager.lines.some((line) => line.group === "ALL") && (
                          <tfoot>
                            {manager.lines.filter((line) => line.group === "ALL").map((line) => (
                              <tr key={line.group} style={{ background: "var(--surface-2)", fontWeight: 700 }}>
                                <td style={{ color: "var(--ink)" }}>{groupLabel(line.group)}</td>
                                <td>{fmt(line.base)}</td>
                                <td>{line.ach_pct.toFixed(4)}%</td>
                                <td>{pct(line.rate * 100)}</td>
                                <td style={{ color: "var(--ink)" }}>{fmt(line.commission)}</td>
                              </tr>
                            ))}
                          </tfoot>
                        )}
                      </table>
                    </div>
                  </div>
                ))}
              </section>
            )}

            {/* ── Sold inside the scheme, paid nothing ── */}
            {data.zero_bills && data.zero_bills.total > 0 && (
              <ZeroBillsCard
                data={data.zero_bills}
                currency={currency}
                t={t}
                onLine={setRuleLine}
              />
            )}

            {/* ── Per person, expandable ── */}
            <section className="card">
              <div className="card-hd">
                <h3 className="card-title"><Award size={14} /> {t("incentive.byPerson")}</h3>
                {data.meta.bands && (
                  <span className="page-sub">
                    {`≤${Math.round(data.meta.bands.low.max_ratio * 100)}% ×${data.meta.bands.low.multiplier} · ≤${Math.round(data.meta.bands.standard.max_ratio * 100)}% ×${data.meta.bands.standard.multiplier} · >${Math.round(data.meta.bands.standard.max_ratio * 100)}% ×${data.meta.bands.high.multiplier}`}
                  </span>
                )}
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
                      <th>{t("incentive.commission")}</th>
                      <th>{t("incentive.reward")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.people.map((row, index) => {
                      const key = row.employee_code || row.name;
                      const expanded = open === key;
                      const startsGroup = index === 0 || data.people[index - 1]?.group !== row.group;
                      // Each product group is paid on its own target and its own
                      // commission base, so the group's money is a figure a manager
                      // actually settles against — one grand total at the bottom
                      // cannot be split back apart.
                      const endsGroup = index === data.people.length - 1 || data.people[index + 1]?.group !== row.group;
                      const groupTotal = endsGroup
                        ? data.people.filter((person) => person.group === row.group).reduce(
                          (acc, person) => ({
                            bills: acc.bills + person.bills,
                            amount: acc.amount + person.amount,
                            target: acc.target + person.target,
                            points: acc.points + person.points,
                            point_reward: acc.point_reward + person.point_reward,
                            unit_reward: acc.unit_reward + person.unit_reward,
                            commission: acc.commission + person.commission,
                            reward: acc.reward + person.reward,
                          }),
                          { bills: 0, amount: 0, target: 0, points: 0, point_reward: 0, unit_reward: 0, commission: 0, reward: 0 },
                        )
                        : null;
                      const pointGroups = row.point_tree ?? [];
                      return (
                        <Fragment key={key}>
                          {startsGroup && (
                            <tr>
                              <td colSpan={11} style={{ background: "var(--surface-2)", color: "var(--ink)", fontWeight: 700 }}>
                                {groupLabel(row.group)}
                              </td>
                            </tr>
                          )}
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
                            <td title={`${fmt(row.commission_base)} × ${pct(row.commission_rate * 100)}`}>
                              {row.commission ? fmt(row.commission) : "—"}
                            </td>
                            <td style={{ color: "var(--ink)", fontWeight: 700 }}>{fmt(row.reward)}</td>
                          </tr>

                          {groupTotal && (
                            <tr style={{ background: "var(--surface-2)", fontWeight: 700 }}>
                              <td style={{ color: "var(--ink)" }}>{t("incentive.groupTotal")} · {groupLabel(row.group)}</td>
                              <td>{fmt(groupTotal.bills)}</td>
                              <td>{fmt(groupTotal.amount)}</td>
                              <td>{fmt(groupTotal.target)}</td>
                              <td style={{ color: groupTotal.target ? achColor((groupTotal.amount / groupTotal.target) * 100) : "var(--muted)" }}>
                                {groupTotal.target ? pct((groupTotal.amount / groupTotal.target) * 100) : "—"}
                              </td>
                              <td>{fmt(groupTotal.points)}</td>
                              <td />
                              <td>{fmt(groupTotal.point_reward)}</td>
                              <td>{groupTotal.unit_reward ? fmt(groupTotal.unit_reward) : "—"}</td>
                              <td>{groupTotal.commission ? fmt(groupTotal.commission) : "—"}</td>
                              <td style={{ color: "var(--ink)" }}>{fmt(groupTotal.reward)}</td>
                            </tr>
                          )}
                          {expanded && (
                            <tr>
                              <td colSpan={11} style={{ background: "var(--surface-2)", padding: "0.75rem" }}>
                                <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
                                  {/* point categories — the drill-down IS the
                                      per-person breakdown, so the group-target
                                      and brand summaries that used to sit above
                                      it only repeated what it already shows. */}
                                  <details open className="lg:col-span-2 xl:col-span-4">
                                    <summary className="field-label inline-flex cursor-pointer list-none items-center gap-1.5">
                                      <ChevronRight size={12} className="details-chevron" /> {t("incentive.byCategory")}
                                    </summary>
                                    <div className="mt-1.5 space-y-1 pl-5">
                                      {pointGroups.length ? pointGroups.map((group) => (
                                        // Group → brand → the sold lines. The bill is a column on the
                                        // line rather than a level of its own: opening a brand should
                                        // answer "what did I sell and what did it score" in one view.
                                        <details key={group.pcat} className="drill">
                                          <summary className="drill-row">
                                            <ChevronRight size={12} className="details-chevron" />
                                            <span className={`pill ${PCAT_TONE[group.pcat] ?? "pill-muted"}`}>{group.pcat}</span>
                                            <span className="drill-meta num">
                                              {group.brands.length} {t("incentive.brands")} · {fmt(group.qty)} {t("incentive.units")}
                                            </span>
                                            <span className="drill-points num" style={{ color: pointsColor(group.points) }}>{fmt(group.points)} {t("incentive.points")}</span>
                                          </summary>
                                          <div className="drill-body">
                                            {group.brands.map((brand) => {
                                              const billCount = new Set(brand.lines.map((line) => line.doc_no)).size;
                                              return (
                                              <details key={brand.brand} className="drill">
                                                <summary className="drill-row">
                                                  <ChevronRight size={11} className="details-chevron" />
                                                  <span className="font-semibold" style={{ color: "var(--ink)" }}>{brand.brand}</span>
                                                  <span className="drill-meta num">
                                                    {billCount} {t("incentive.invoiceCount")} · {brand.lines.length} {t("incentive.lines")} · {fmt(brand.qty)} {t("incentive.units")}
                                                  </span>
                                                  <span className="drill-points num" style={{ color: pointsColor(brand.points) }}>{fmt(brand.points)} {t("incentive.points")}</span>
                                                </summary>
                                                      <div className="tbl-scroll">
                                                        <table className="tbl" style={{ minWidth: 980 }}>
                                                          <thead>
                                                            <tr>
                                                              <th style={{ textAlign: "left" }}>{t("incentive.date")}</th>
                                                              <th style={{ textAlign: "left" }}>{t("incentive.invoice")}</th>
                                                              <th style={{ textAlign: "left" }}>{COLUMN_ITEM_CODE}</th>
                                                              <th style={{ textAlign: "left" }}>{t("incentive.product")}</th>
                                                              <th>{t("label.qty")}</th>
                                                              <th>{t("incentive.unitPrice")}</th>
                                                              <th>{t("incentive.pointsPerUnit")}</th>
                                                              <th>{t("incentive.points")}</th>
                                                              <th style={{ textAlign: "left" }}>{t("incentive.pointCondition")}</th>
                                                              <th>{t("incentive.sales")}</th>
                                                            </tr>
                                                          </thead>
                                                          <tbody>
                                                            {brand.lines.map((line, lineIndex) => (
                                                              <tr key={`${line.doc_no}:${line.item_code}:${lineIndex}`}>
                                                                <td className="num" style={{ textAlign: "left", color: "var(--muted)", whiteSpace: "nowrap" }}>
                                                                  {fmtDate(line.doc_date)}
                                                                </td>
                                                                <td className="num" style={{ textAlign: "left", fontWeight: 600, whiteSpace: "nowrap" }}>
                                                                  {line.doc_no}
                                                                </td>
                                                                <td className="num" style={{ textAlign: "left", color: "var(--muted)", whiteSpace: "nowrap" }}>
                                                                  {line.item_code || "—"}
                                                                </td>
                                                                <td style={{ textAlign: "left", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }} title={line.item_name}>
                                                                  {line.item_name || line.item_code}
                                                                </td>
                                                                <td>{fmt(line.qty)}</td>
                                                                {/* The price the band was chosen by — not the sale amount,
                                                                    which differs once a discount or qty > 1 is involved. */}
                                                                <td>{line.price ? fmt(line.price) : "—"}</td>
                                                                <td style={{ color: line.unit_points ? undefined : "var(--warn)" }}>
                                                                  {line.unit_points ? fmt(line.unit_points) : "—"}
                                                                </td>
                                                                <td style={{ color: pointsColor(line.points), fontWeight: 700 }}>{fmt(line.points)}</td>
                                                                <td
                                                                  style={{ textAlign: "left", maxWidth: 360, color: line.no_point_reason ? "var(--warn)" : "var(--ink-soft)" }}
                                                                  title={line.no_point_reason ?? line.point_basis ?? undefined}
                                                                >
                                                                  {/* Opens the rule that produced this figure in place —
                                                                      checking one line should not cost the reader their
                                                                      position in the drill-down. */}
                                                                  {line.rule?.category_code
                                                                    ? (
                                                                      <button type="button" className="rule-link" onClick={() => setRuleLine(line)}>
                                                                        {line.no_point_reason ?? line.point_basis}
                                                                      </button>
                                                                    )
                                                                    : (line.no_point_reason ?? line.point_basis ?? "—")}
                                                                </td>
                                                                <td>{fmt(line.amount)}</td>
                                                              </tr>
                                                            ))}
                                                          </tbody>
                                                        </table>
                                                      </div>
                                              </details>
                                              );
                                            })}
                                          </div>
                                        </details>
                                      )) : <p className="page-sub">—</p>}
                                    </div>
                                  </details>

                                  {/* unit rewards + no-point lines */}
                                  <details>
                                    <summary className="field-label inline-flex cursor-pointer list-none items-center gap-1.5">
                                      <ChevronRight size={12} className="details-chevron" /> {t("incentive.unitReward")}
                                    </summary>
                                    <div className="mt-1.5 pl-5">
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
                                  </details>
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
                      <td>{fmt(data.totals.commission)}</td>
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
                        <th>{t("incentive.group")}</th>
                        <th>{t("incentive.brand")}</th>
                        <th>{t("incentive.tierLow")}</th>
                        <th>{t("incentive.tierHigh")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.unit_rules.map((rule) => (
                        <tr key={rule.code}>
                          <td>{rule.description || rule.code}</td>
                          <td>{groupLabel(rule.group)}</td>
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
      {ruleLine && (
        <RuleModal line={ruleLine} year={year} month={month} onClose={() => setRuleLine(null)} />
      )}
    </div>
  );
}
