/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState, useEffect, useRef, cloneElement, isValidElement } from "react";
import {
  Users, Package, Wallet, Loader2, UserPlus, UserMinus, TrendingDown, PieChart as PieIcon, Download,
} from "lucide-react";
import api from "@/service/api";
import { downloadCsv } from "@/lib/csv";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
} from "recharts";
import { currency, readSessionCache, writeSessionCache } from "@/hooks/useDashboard";
import { useLanguage } from "@/context/LanguageContext";
import { fmtDate } from "@/components/ui";

const C = { blue: "#2b70b5", emerald: "#17876d", amber: "#f5911f", rose: "#d0453f", violet: "#003361", slate: "#8ba6bd" };
const TTL = 300_000;
const NO_ANIM = { isAnimationActive: false as const };

const tw = {
  head: "text-[var(--ink)]",
  sub: "text-[var(--muted)]",
  card: "card",
};

const fmt = (v: any) => currency(v);
const compact = (v: any) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(v || 0));
const pctTxt = (v: any) => `${Number(v || 0).toFixed(1)}%`;
const dateTxt = (v: any) => {
  if (!v) return "-";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "-" : fmtDate(d);
};

function Tip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-xs shadow-lg">
      <p className="mb-1 font-semibold text-[var(--ink-soft)]">{label}</p>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />{p.name}</span>
          <span className="font-semibold text-[var(--ink)]">{fmt(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

function ChartFrame({ className, children }: { className: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const update = () => {
      const { width, height } = node.getBoundingClientRect();
      setSize({ width: Math.max(Math.floor(width), 0), height: Math.max(Math.floor(height), 0) });
    };
    update();
    const frame = window.requestAnimationFrame(update);
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => { window.cancelAnimationFrame(frame); observer.disconnect(); };
  }, []);

  return (
    <div ref={ref} className={`${className} min-h-0 min-w-0`}>
      {isValidElement(children) && size.width > 0 && size.height > 0
        ? cloneElement(children as any, { width: size.width, height: size.height } as any)
        : null}
    </div>
  );
}

function KpiTile({ icon, label, value, hint, tone = "blue" }: {
  icon: React.ReactNode; label: string; value: string; hint?: string; tone?: string;
}) {
  const tones: Record<string, string> = {
    blue: "bg-[var(--info-bg)] text-[var(--brand)] dark:bg-[var(--info-bg)]0/10 ",
    emerald: "bg-[var(--pos-bg)] text-[var(--pos)] ",
    rose: "bg-[var(--neg-bg)] text-[var(--neg)] dark:bg-[var(--neg-bg)]0/10 ",
    amber: "bg-[var(--warn-bg)] text-[var(--warn)] dark:bg-[var(--warn-bg)]0/10 ",
    violet: "bg-violet-50 text-[var(--brand-deep)] dark:bg-[var(--brand-deep)]/10 dark:text-violet-400",
  };
  return (
    <div className={`${tw.card} flex items-center gap-3 p-4`}>
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--r-md)] ${tones[tone] || tones.blue}`}>{icon}</div>
      <div className="min-w-0">
        <p className={`truncate text-xs ${tw.sub}`}>{label}</p>
        <p className={`text-lg font-bold ${tw.head}`}>{value}</p>
        {hint ? <p className={`truncate text-[11px] ${tw.sub}`}>{hint}</p> : null}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={`${tw.card} p-4`}>
      <h3 className={`mb-3 text-sm font-bold ${tw.head}`}>{title}</h3>
      {children}
    </div>
  );
}

function DataTable({ columns, rows, empty }: {
  columns: Array<{ key: string; label: string; align?: "right"; render?: (row: any) => React.ReactNode }>;
  rows: any[];
  empty: string;
}) {
  if (!rows?.length) return <p className={`py-6 text-center text-xs ${tw.sub}`}>{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-xs">
        <thead>
          <tr className="border-b border-[var(--line)]">
            {columns.map((col) => (
              <th key={col.key} className={`px-2 py-2 font-semibold ${tw.sub} ${col.align === "right" ? "text-right" : "text-left"}`}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-[var(--line-soft)] last:border-0">
              {columns.map((col) => (
                <td key={col.key} className={`px-2 py-2 ${tw.head} ${col.align === "right" ? "text-right tabular-nums" : "text-left"}`}>
                  {col.render ? col.render(row) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Fetch JSON with a sessionStorage cache. `paramsKey` is a JSON-encoded params object. */
function useCachedGet(url: string | null, paramsKey: string) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const keyRef = useRef("");

  useEffect(() => {
    if (!url) return undefined;
    const key = `analytics:${url}:${paramsKey}`;
    if (keyRef.current === key) return undefined;
    keyRef.current = key;

    let cancelled = false;
    const cached = readSessionCache<any>(key, TTL);
    if (cached) {
      setData(cached);
      setLoading(false);
      return () => { cancelled = true; };
    }

    setLoading(true);
    setError("");
    api.get(url, { params: JSON.parse(paramsKey) })
      .then((res: any) => {
        if (cancelled) return;
        setData(res.data);
        writeSessionCache(key, res.data);
      })
      .catch((err: any) => {
        if (cancelled) return;
        setError(err?.response?.data?.error || "Failed to load");
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [url, paramsKey]);

  return { data, loading, error };
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <Loader2 className="h-6 w-6 animate-spin text-[var(--brand)]" />
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════ */
export default function AnalyticsPage() {
  const { t } = useLanguage();
  const font = { fontFamily: '"Noto Sans Lao","Noto Sans",system-ui,sans-serif' };
  const [tab, setTab] = useState<"customers" | "products" | "ar">("customers");

  // Filters (year / BU / channel / province) — options cached like the dashboard.
  const [filters, setFilters] = useState<any>(() => readSessionCache<any>("dashboard:filters", 600_000));
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [bu, setBu] = useState("ALL");
  const [channel, setChannel] = useState("ALL");
  const [province, setProvince] = useState("ALL");

  useEffect(() => {
    if (filters) return undefined;
    let cancelled = false;
    api.get("/dashboard/filters").then((res: any) => {
      if (cancelled) return;
      writeSessionCache("dashboard:filters", res.data || {});
      setFilters(res.data || {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [filters]);

  const years: string[] = (filters?.years || []).map(String);
  const buOptions: any[] = filters?.bu || [];
  const channelOptions: any[] = filters?.channels || [];
  const provinceOptions: any[] = filters?.provinces || [];

  const paramsKey = JSON.stringify({ year, bu, channel, province });
  const customers = useCachedGet(tab === "customers" ? "/analytics/customers" : null, paramsKey);
  const products = useCachedGet(tab === "products" ? "/analytics/products" : null, paramsKey);
  const ar = useCachedGet(tab === "ar" ? "/analytics/ar" : null, "{}");

  const selectCls = "select w-[9.5rem]";
  const tabs = [
    { key: "customers" as const, label: t("an.tabCustomers"), icon: <Users size={14} /> },
    { key: "products" as const, label: t("an.tabProducts"), icon: <Package size={14} /> },
    { key: "ar" as const, label: t("an.tabAr"), icon: <Wallet size={14} /> },
  ];

  const cs = customers.data?.summary;
  const cmpMonth = customers.data?.cmp_month || products.data?.cmp_month || new Date().getMonth() + 1;

  /** Exports whatever the active tab currently shows. */
  const exportCsv = () => {
    const stamp = `${year}-b${bu}-c${channel}-p${province}`;
    if (tab === "customers" && customers.data) {
      const d = customers.data;
      const headers = ["list", "customer", "cur_rev", "prev_rev", "orders", "share_pct", "last_buy"];
      const rows: (string | number)[][] = [];
      (d.lost || []).forEach((r: any) => rows.push(["lost", r.name, "", r.prev_rev ?? 0, "", "", r.last_buy || ""]));
      (d.declining || []).forEach((r: any) => rows.push(["declining", r.name, r.cur_rev ?? 0, r.prev_rev ?? 0, "", "", ""]));
      (d.topCustomers || []).forEach((r: any) => rows.push(["top", r.name, r.cur_rev ?? 0, "", "", r.share_pct ?? 0, ""]));
      (d.newCustomers || []).forEach((r: any) => rows.push(["new", r.name, r.cur_rev ?? 0, "", r.orders ?? 0, "", r.last_buy || ""]));
      downloadCsv(`analytics-customers-${stamp}`, headers, rows);
    } else if (tab === "products" && products.data) {
      const d = products.data;
      const headers = ["list", "name", "group", "cur_rev", "prev_rev", "profit", "margin_pct"];
      const rows: (string | number)[][] = [];
      (d.groups || []).forEach((r: any) => rows.push(["group", r.grp, "", r.cur_rev ?? 0, r.prev_rev ?? 0, "", ""]));
      (d.brands || []).forEach((r: any) => rows.push(["brand", r.brand, "", r.revenue ?? 0, "", r.profit ?? 0, r.margin_pct ?? 0]));
      (d.dropped || []).forEach((r: any) => rows.push(["dropped", r.name, "", r.cur_rev ?? 0, r.prev_rev ?? 0, "", ""]));
      (d.topProfit || []).forEach((r: any) => rows.push(["top_profit", r.name, r.brand || "", "", "", r.profit ?? 0, r.margin_pct ?? 0]));
      downloadCsv(`analytics-products-${stamp}`, headers, rows);
    } else if (tab === "ar" && ar.data) {
      const headers = ["list", "name", "bucket", "balance", "bills", "salesperson", "max_overdue_days"];
      const rows: (string | number)[][] = [];
      (ar.data.buckets || []).forEach((b: any) => rows.push(["bucket", "", b.bucket, b.balance ?? 0, b.bills ?? 0, "", ""]));
      (ar.data.topDebtors || []).forEach((r: any) => rows.push(["debtor", r.name, "", r.balance ?? 0, r.bills ?? 0, r.sale_name || "", r.max_overdue_days ?? 0]));
      downloadCsv("analytics-ar", headers, rows);
    }
  };

  return (
    <div className="min-h-screen px-4 pb-10 md:px-8" style={font}>
      {/* Header */}
      <div className="page-hd -mx-4 mb-4 md:-mx-8">
        <div>
          <p className="eyebrow">Business intelligence</p>
          <h1 className="page-title">{t("sidebar.analytics")}</h1>
          <p className="page-sub">{t("an.subtitle")}</p>
        </div>
        {tab !== "ar" && (
          <div className="flex flex-wrap items-end gap-2">
            <select className={selectCls} value={year} onChange={(e) => setYear(e.target.value)}>
              {(years.length ? years : [year]).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <select className={selectCls} value={bu} onChange={(e) => setBu(e.target.value)}>
              <option value="ALL">{t("filter.bu")}: {t("app.all")}</option>
              {buOptions.map((o: any) => <option key={o.code} value={o.code}>{o.name_1 || o.code}</option>)}
            </select>
            <select className={selectCls} value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="ALL">{t("filter.channel")}: {t("app.all")}</option>
              {channelOptions.map((o: any) => <option key={o.code} value={o.code}>{o.name_1 || o.code}</option>)}
            </select>
            <select className={selectCls} value={province} onChange={(e) => setProvince(e.target.value)}>
              <option value="ALL">{t("filter.province")}: {t("app.all")}</option>
              {provinceOptions.map((o: any) => <option key={o.code} value={o.code}>{o.name_1 || o.code}</option>)}
            </select>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="tabs">
          {tabs.map((item) => (
            <button
              key={item.key}
              onClick={() => setTab(item.key)}
              className={`tab ${tab === item.key ? "is-active" : ""}`}
            >
              {item.icon}{item.label}
            </button>
          ))}
        </div>
        <button onClick={exportCsv} className="btn">
          <Download size={13} /> {t("app.exportCsv")}
        </button>
      </div>

      {/* ── Customers ── */}
      {tab === "customers" && (
        customers.loading && !customers.data ? <Spinner /> : (
          <div className="space-y-4">
            <p className={`text-[11px] ${tw.sub}`}>{t("an.samePeriod")}–{cmpMonth})</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <KpiTile icon={<Users size={18} />} label={t("an.activeCustomers")} value={fmt(cs?.active)} tone="blue" />
              <KpiTile icon={<UserPlus size={18} />} label={t("an.newCustomers")} value={fmt(cs?.new_count)} tone="emerald" />
              <KpiTile icon={<UserMinus size={18} />} label={t("an.lostCustomers")} value={fmt(cs?.lost_count)} tone="rose" />
              <KpiTile icon={<TrendingDown size={18} />} label={t("an.declining")} value={fmt(cs?.declining_count)} tone="amber" />
              <KpiTile icon={<PieIcon size={18} />} label={t("an.top10Share")} value={pctTxt(cs?.top10_share_pct)} tone="violet" />
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <Section title={t("an.lostList")}>
                <DataTable
                  empty={t("an.noData")}
                  columns={[
                    { key: "name", label: t("label.customer") },
                    { key: "prev_rev", label: t("an.prevRev"), align: "right", render: (r) => fmt(r.prev_rev) },
                    { key: "last_buy", label: t("an.lastBuy"), align: "right", render: (r) => dateTxt(r.last_buy) },
                  ]}
                  rows={customers.data?.lost || []}
                />
              </Section>
              <Section title={t("an.decliningList")}>
                <DataTable
                  empty={t("an.noData")}
                  columns={[
                    { key: "name", label: t("label.customer") },
                    { key: "cur_rev", label: t("an.curRev"), align: "right", render: (r) => fmt(r.cur_rev) },
                    { key: "prev_rev", label: t("an.prevRev"), align: "right", render: (r) => fmt(r.prev_rev) },
                    {
                      key: "change", label: t("an.change"), align: "right",
                      render: (r) => {
                        const pct = r.prev_rev > 0 ? ((r.cur_rev - r.prev_rev) / r.prev_rev) * 100 : 0;
                        return <span className="font-semibold text-[var(--neg)]">{pct.toFixed(0)}%</span>;
                      },
                    },
                  ]}
                  rows={customers.data?.declining || []}
                />
              </Section>
              <Section title={t("an.topCustomers")}>
                <DataTable
                  empty={t("an.noData")}
                  columns={[
                    { key: "name", label: t("label.customer") },
                    { key: "cur_rev", label: t("label.revenue"), align: "right", render: (r) => fmt(r.cur_rev) },
                    {
                      key: "share_pct", label: t("an.share"), align: "right",
                      render: (r) => (
                        <span className="inline-flex items-center gap-2">
                          <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-[var(--surface-2)] sm:block">
                            <span className="block h-full rounded-full bg-[var(--info-bg)]0" style={{ width: `${Math.min(Number(r.share_pct || 0) * 4, 100)}%` }} />
                          </span>
                          {pctTxt(r.share_pct)}
                        </span>
                      ),
                    },
                  ]}
                  rows={customers.data?.topCustomers || []}
                />
              </Section>
              <Section title={t("an.newList")}>
                <DataTable
                  empty={t("an.noData")}
                  columns={[
                    { key: "name", label: t("label.customer") },
                    { key: "cur_rev", label: t("label.revenue"), align: "right", render: (r) => fmt(r.cur_rev) },
                    { key: "orders", label: t("label.orders"), align: "right" },
                    { key: "last_buy", label: t("an.lastBuy"), align: "right", render: (r) => dateTxt(r.last_buy) },
                  ]}
                  rows={customers.data?.newCustomers || []}
                />
              </Section>
            </div>
          </div>
        )
      )}

      {/* ── Products ── */}
      {tab === "products" && (
        products.loading && !products.data ? <Spinner /> : (
          <div className="space-y-4">
            <div className="grid gap-4 xl:grid-cols-2">
              <Section title={t("an.groupYoY")}>
                <ChartFrame className="h-72 w-full">
                  <BarChart data={products.data?.groups || []} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#94a3b833" vertical={false} />
                    <XAxis dataKey="grp" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={60} />
                    <YAxis tickFormatter={compact} tick={{ fontSize: 10 }} width={48} />
                    <Tooltip content={<Tip />} />
                    <Bar dataKey="prev_rev" name={t("an.prevRev")} fill={C.slate} radius={[3, 3, 0, 0]} {...NO_ANIM} />
                    <Bar dataKey="cur_rev" name={t("an.curRev")} fill={C.blue} radius={[3, 3, 0, 0]} {...NO_ANIM} />
                  </BarChart>
                </ChartFrame>
              </Section>
              <Section title={t("an.brandProfit")}>
                <DataTable
                  empty={t("an.noData")}
                  columns={[
                    { key: "brand", label: t("an.brand") },
                    { key: "revenue", label: t("label.revenue"), align: "right", render: (r) => fmt(r.revenue) },
                    { key: "profit", label: t("label.profit"), align: "right", render: (r) => fmt(r.profit) },
                    {
                      key: "margin_pct", label: t("label.margin"), align: "right",
                      render: (r) => (
                        <span className={`font-semibold ${Number(r.margin_pct) < 5 ? "text-[var(--neg)]" : "text-[var(--pos)]"}`}>
                          {pctTxt(r.margin_pct)}
                        </span>
                      ),
                    },
                  ]}
                  rows={products.data?.brands || []}
                />
              </Section>
              <Section title={t("an.droppedItems")}>
                <DataTable
                  empty={t("an.noData")}
                  columns={[
                    { key: "name", label: t("an.item") },
                    { key: "cur_rev", label: t("an.curRev"), align: "right", render: (r) => fmt(r.cur_rev) },
                    { key: "prev_rev", label: t("an.prevRev"), align: "right", render: (r) => fmt(r.prev_rev) },
                    {
                      key: "change", label: t("an.change"), align: "right",
                      render: (r) => <span className="font-semibold text-[var(--neg)]">{fmt(r.change)}</span>,
                    },
                  ]}
                  rows={products.data?.dropped || []}
                />
              </Section>
              <Section title={t("an.topProfitItems")}>
                <DataTable
                  empty={t("an.noData")}
                  columns={[
                    { key: "name", label: t("an.item") },
                    { key: "brand", label: t("an.brand") },
                    { key: "profit", label: t("label.profit"), align: "right", render: (r) => fmt(r.profit) },
                    { key: "margin_pct", label: t("label.margin"), align: "right", render: (r) => pctTxt(r.margin_pct) },
                  ]}
                  rows={products.data?.topProfit || []}
                />
              </Section>
            </div>
          </div>
        )
      )}

      {/* ── AR ── */}
      {tab === "ar" && (
        ar.loading && !ar.data ? <Spinner /> : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <KpiTile icon={<Wallet size={18} />} label={t("an.arTotal")} value={compact(ar.data?.summary?.total_balance)} hint={fmt(ar.data?.summary?.total_balance)} tone="blue" />
              <KpiTile icon={<TrendingDown size={18} />} label={t("an.arOverdue")} value={compact(ar.data?.summary?.overdue_balance)} hint={pctTxt(ar.data?.summary?.overdue_pct)} tone="rose" />
              <KpiTile icon={<PieIcon size={18} />} label={t("analytics.dso")} value={Number(ar.data?.summary?.dso || 0).toFixed(0)} tone="amber" />
              <KpiTile icon={<Users size={18} />} label={t("an.bills")} value={fmt((ar.data?.buckets || []).reduce((s: number, b: any) => s + Number(b.bills || 0), 0))} tone="violet" />
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <Section title={t("an.arBuckets")}>
                <ChartFrame className="h-72 w-full">
                  <BarChart data={ar.data?.buckets || []} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#94a3b833" vertical={false} />
                    <XAxis dataKey="bucket" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={56} />
                    <YAxis tickFormatter={compact} tick={{ fontSize: 10 }} width={48} />
                    <Tooltip content={<Tip />} />
                    <Bar dataKey="balance" name={t("an.balance")} radius={[3, 3, 0, 0]} {...NO_ANIM}>
                      {(ar.data?.buckets || []).map((b: any, i: number) => (
                        <Cell key={i} fill={b.bucket === "Ondue" ? C.emerald : i < 3 ? C.amber : C.rose} />
                      ))}
                    </Bar>
                  </BarChart>
                </ChartFrame>
              </Section>
              <Section title={t("an.topDebtors")}>
                <DataTable
                  empty={t("an.noData")}
                  columns={[
                    { key: "name", label: t("label.customer") },
                    { key: "sale_name", label: t("an.salesperson") },
                    { key: "balance", label: t("an.balance"), align: "right", render: (r) => fmt(r.balance) },
                    { key: "bills", label: t("an.bills"), align: "right" },
                    {
                      key: "max_overdue_days", label: t("an.maxOverdue"), align: "right",
                      render: (r) => (
                        <span className={`font-semibold ${r.max_overdue_days > 90 ? "text-[var(--neg)]" : tw.head}`}>
                          {r.max_overdue_days}
                        </span>
                      ),
                    },
                  ]}
                  rows={ar.data?.topDebtors || []}
                />
              </Section>
            </div>
          </div>
        )
      )}
    </div>
  );
}
