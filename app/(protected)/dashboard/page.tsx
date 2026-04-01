/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState, useEffect, useRef, cloneElement, isValidElement } from "react";
import {
  Loader2, AlertCircle, RefreshCw, Sun, Moon, Filter,
  Clock, Zap, AlertTriangle, TrendingUp,
} from "lucide-react";
import api from "@/service/api";
import {
  AreaChart, Area, XAxis, YAxis,
  Tooltip, CartesianGrid, BarChart, Bar, PieChart, Pie, Cell,
} from "recharts";
import { useDashboard, currency, readSessionCache, writeSessionCache } from "@/hooks/useDashboard";
import { useTheme } from "@/context/ThemeContext";
import { useLanguage } from "@/context/LanguageContext";

/* ── Chart colors ── */
const C = { blue: "#3b82f6", emerald: "#10b981", amber: "#f59e0b", rose: "#ef4444", violet: "#8b5cf6", cyan: "#06b6d4", slate: "#94a3b8" };
const PIE = [C.blue, C.emerald, C.amber, C.rose, C.violet, C.cyan, "#ec4899", "#f97316"];
const SIDECAR_TTL = 300_000;

/* ── Theme classes ── */
const tw = {
  blue: "text-blue-600 dark:text-blue-400",
  green: "text-emerald-600 dark:text-emerald-400",
  amber: "text-amber-600 dark:text-amber-400",
  red: "text-rose-600 dark:text-rose-400",
  head: "text-slate-900 dark:text-white",
  sub: "text-slate-500 dark:text-slate-400",
  card: "rounded-xl border border-slate-200/70 bg-white shadow-sm dark:border-slate-800/70 dark:bg-slate-900",
};

/* ── Helpers ── */
const fmt = (v: any) => currency(v);
const pct = (v: any) => `${Number(v || 0).toFixed(1)}%`;
const compact = (v: any) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(v || 0));

function Tip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-800">
      <p className="mb-1 font-semibold text-slate-600 dark:text-slate-300">{label}</p>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />{p.name}</span>
          <span className="font-semibold text-slate-900 dark:text-white">{fmt(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

function ChartFrame({
  className,
  children,
}: {
  className: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;

    const update = () => {
      const { width, height } = node.getBoundingClientRect();
      setSize({
        width: Math.max(Math.floor(width), 0),
        height: Math.max(Math.floor(height), 0),
      });
    };

    update();
    const frame = window.requestAnimationFrame(update);
    const observer = new ResizeObserver(update);
    observer.observe(node);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={ref} className={`${className} min-h-0 min-w-0`}>
      {isValidElement(children) && size.width > 0 && size.height > 0
        ? cloneElement(children as any, { width: size.width, height: size.height } as any)
        : null}
    </div>
  );
}

function buildBuChannelMatrix(rows: any[] = []) {
  const pivot = new Map<string, Map<string, number>>();
  const buSet = new Set<string>();
  const channelSet = new Set<string>();
  let heatMax = 0;

  rows.forEach((row: any) => {
    const bu = String(row.bu || "UNKNOWN");
    const channel = String(row.channel || "UNKNOWN");
    const amount = Number(row.amount || 0);

    buSet.add(bu);
    channelSet.add(channel);
    if (!pivot.has(bu)) pivot.set(bu, new Map<string, number>());
    pivot.get(bu)?.set(channel, amount);
    if (amount > heatMax) heatMax = amount;
  });

  return {
    buList: [...buSet],
    channelList: [...channelSet],
    pivot,
    heatMax,
  };
}

function buildFocusActions({
  label,
  actual,
  target,
  lastYear,
  gap,
  requiredPerDay = 0,
  daysLeft = 0,
  t,
}: {
  label: string;
  actual: number;
  target: number;
  lastYear: number;
  gap: number;
  requiredPerDay?: number;
  daysLeft?: number;
  t: (key: string) => string;
}) {
  const ach = target > 0 ? (actual / target) * 100 : 0;
  const yoy = lastYear > 0 ? ((actual / lastYear) - 1) * 100 : 0;
  const items: Array<{ level: string; title: string; detail: string }> = [];

  if (ach < 90) {
    items.push({
      level: "high",
      title: `${label} ${t("dash.belowTarget")}`,
      detail: `Gap ${fmt(Math.max(gap, 0))} • Achievement ${pct(ach)}`,
    });
  }

  if (lastYear > 0 && actual < lastYear) {
    items.push({
      level: "medium",
      title: `${label} ${t("dash.belowLY")}`,
      detail: `YoY ${yoy >= 0 ? "+" : ""}${yoy.toFixed(1)}% • ${t("kpi.lastYear")} ${fmt(lastYear)}`,
    });
  }

  if (daysLeft > 0 && requiredPerDay > 0 && gap > 0) {
    items.push({
      level: "medium",
      title: t("dash.runRate"),
      detail: `${t("dash.daysRemain")} ${daysLeft} ${t("momentum.daysLeft")} • ${t("dash.requiredPerDay")} ${fmt(requiredPerDay)} ${t("dash.perDay")}`,
    });
  }

  if (!items.length) {
    items.push({
      level: "low",
      title: `${label} ${t("dash.onGoodTrack")}`,
      detail: `Actual ${fmt(actual)} • Target ${fmt(target)}`,
    });
  }

  return items;
}

/* ════════════════════════════════════════════════════════════════════════ */
export default function Dashboard() {
  const d = useDashboard();
  const { data, loading, error } = d;
  const { isDark, toggleTheme } = useTheme();
  const { t } = useLanguage();
  const [showFilter, setShowFilter] = useState(false);
  const [tab, setTab] = useState<"overview" | "lastMonth" | "thisMonth">("overview");
  const [exec, setExec] = useState<any>(null);
  const [analytics, setAnalytics] = useState<any>(null);
  const [managerInsights, setManagerInsights] = useState<any>(null);
  const [ownerInsights, setOwnerInsights] = useState<any>(null);
  const [thisMonthSnapshot, setThisMonthSnapshot] = useState<any>(null);
  const [lastMonthSnapshot, setLastMonthSnapshot] = useState<any>(null);
  const overviewKeyRef = useRef("");
  const overviewInsightsKeyRef = useRef("");
  const thisMonthSnapshotKeyRef = useRef("");
  const lastMonthSnapshotKeyRef = useRef("");
  const font = { fontFamily: '"Noto Sans Lao","Noto Sans",system-ui,sans-serif' };

  useEffect(() => {
    if (d.year) {
      let cancelled = false;
      let hydrateFrame = 0;
      const p = { year: d.year, bu: d.bu, channel: !d.channel.length || d.channel.includes("ALL") ? "ALL" : d.channel.join(","), province: !d.province.length || d.province.includes("ALL") ? "ALL" : d.province.join(",") };
      const key = JSON.stringify(p);
      if (overviewKeyRef.current === key) return undefined;
      overviewKeyRef.current = key;
      overviewInsightsKeyRef.current = "";
      thisMonthSnapshotKeyRef.current = "";
      lastMonthSnapshotKeyRef.current = "";
      const cacheKey = `dashboard:overview-sidecar:${key}`;
      const cached = readSessionCache<any>(cacheKey, SIDECAR_TTL);
      if (cached?.exec || cached?.analytics) {
        hydrateFrame = window.requestAnimationFrame(() => {
          if (cancelled) return;
          if (cached?.exec) setExec(cached.exec);
          if (cached?.analytics) setAnalytics(cached.analytics);
        });
      }
      if (cached?.exec && cached?.analytics) {
        return () => {
          cancelled = true;
          if (hydrateFrame) window.cancelAnimationFrame(hydrateFrame);
        };
      }
      // Fetch the above-the-fold overview data first.
      Promise.allSettled([
        api.get("/dashboard/executive", { params: p }),
        api.get("/dashboard/analytics", { params: p }),
      ]).then(([execResult, analyticsResult]) => {
        if (cancelled) return;
        const nextCache: Record<string, any> = {};

        if (execResult.status === "fulfilled") {
          setExec(execResult.value.data);
          nextCache.exec = execResult.value.data;
        }
        if (analyticsResult.status === "fulfilled") {
          setAnalytics(analyticsResult.value.data);
          nextCache.analytics = analyticsResult.value.data;
        }
        if (Object.keys(nextCache).length) {
          writeSessionCache(cacheKey, nextCache);
        }
      });

      return () => {
        cancelled = true;
        if (hydrateFrame) window.cancelAnimationFrame(hydrateFrame);
      };
    }
    return undefined;
  }, [d.year, d.bu, d.channel, d.province]);

  useEffect(() => {
    if (!d.year || tab !== "overview") return;

    const p = {
      year: d.year,
      bu: d.bu,
      channel: !d.channel.length || d.channel.includes("ALL") ? "ALL" : d.channel.join(","),
      province: !d.province.length || d.province.includes("ALL") ? "ALL" : d.province.join(","),
    };
    const key = JSON.stringify(p);
    if (overviewInsightsKeyRef.current === key) return undefined;
    overviewInsightsKeyRef.current = key;
    const cacheKey = `dashboard:insights-sidecar:${key}`;
    const cached = readSessionCache<any>(cacheKey, SIDECAR_TTL);
    let cancelled = false;
    let hydrateFrame = 0;
    if (cached?.managerInsights || cached?.ownerInsights) {
      hydrateFrame = window.requestAnimationFrame(() => {
        if (cancelled) return;
        if (cached?.managerInsights) setManagerInsights(cached.managerInsights);
        if (cached?.ownerInsights) setOwnerInsights(cached.ownerInsights);
      });
    }
    if (cached?.managerInsights && cached?.ownerInsights) {
      return () => {
        cancelled = true;
        if (hydrateFrame) window.cancelAnimationFrame(hydrateFrame);
      };
    }

    const loadInsights = () => {
      if (cancelled) return;
      Promise.allSettled([
        api.get("/dashboard/manager-insights", { params: p }),
        api.get("/dashboard/owner-insights", { params: p }),
      ]).then(([managerResult, ownerResult]) => {
        if (cancelled) return;
        const nextCache: Record<string, any> = {};

        if (managerResult.status === "fulfilled") {
          setManagerInsights(managerResult.value.data);
          nextCache.managerInsights = managerResult.value.data;
        }
        if (ownerResult.status === "fulfilled") {
          setOwnerInsights(ownerResult.value.data);
          nextCache.ownerInsights = ownerResult.value.data;
        }
        if (Object.keys(nextCache).length) {
          writeSessionCache(cacheKey, nextCache);
        }
      });
    };

    const idle =
      typeof window !== "undefined" && "requestIdleCallback" in window
        ? (window as any).requestIdleCallback(loadInsights, { timeout: 500 })
        : globalThis.setTimeout(loadInsights, 250);

    return () => {
      cancelled = true;
      if (hydrateFrame) window.cancelAnimationFrame(hydrateFrame);
      if (typeof window !== "undefined" && "cancelIdleCallback" in window) {
        (window as any).cancelIdleCallback(idle);
      } else {
        globalThis.clearTimeout(idle);
      }
    };
  }, [tab, d.year, d.bu, d.channel, d.province]);

  useEffect(() => {
    if (!d.year || tab === "overview") return undefined;

    const p = {
      year: d.year,
      bu: d.bu,
      channel: !d.channel.length || d.channel.includes("ALL") ? "ALL" : d.channel.join(","),
      province: !d.province.length || d.province.includes("ALL") ? "ALL" : d.province.join(","),
    };
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    let previousMonth = currentMonth - 1;
    let previousMonthYear = Number(d.year);
    if (previousMonth <= 0) {
      previousMonth = 12;
      previousMonthYear -= 1;
    }

    const thisMonthKey = JSON.stringify({ ...p, month: currentMonth });
    const lastMonthKey = JSON.stringify({ ...p, year: previousMonthYear, month: previousMonth });
    const thisMonthCacheKey = `dashboard:snapshot:${thisMonthKey}`;
    const lastMonthCacheKey = `dashboard:snapshot:${lastMonthKey}`;
    const cachedThisMonth = readSessionCache<any>(thisMonthCacheKey, SIDECAR_TTL);
    const cachedLastMonth = readSessionCache<any>(lastMonthCacheKey, SIDECAR_TTL);
    let cancelled = false;
    let thisMonthFrame = 0;
    let lastMonthFrame = 0;

    if (thisMonthSnapshotKeyRef.current !== thisMonthKey) {
      thisMonthSnapshotKeyRef.current = thisMonthKey;
      if (cachedThisMonth) {
        thisMonthFrame = window.requestAnimationFrame(() => {
          if (!cancelled) setThisMonthSnapshot(cachedThisMonth);
        });
      } else {
        api.get("/dashboard/owner-sales", { params: { ...p, month: currentMonth } }).then((r: any) => {
          if (cancelled) return;
          setThisMonthSnapshot(r.data);
          writeSessionCache(thisMonthCacheKey, r.data);
        }).catch(() => setThisMonthSnapshot(null));
      }
    }

    if (lastMonthSnapshotKeyRef.current !== lastMonthKey) {
      lastMonthSnapshotKeyRef.current = lastMonthKey;
      if (cachedLastMonth) {
        lastMonthFrame = window.requestAnimationFrame(() => {
          if (!cancelled) setLastMonthSnapshot(cachedLastMonth);
        });
      } else {
        api.get("/dashboard/owner-sales", { params: { ...p, year: previousMonthYear, month: previousMonth } }).then((r: any) => {
          if (cancelled) return;
          setLastMonthSnapshot(r.data);
          writeSessionCache(lastMonthCacheKey, r.data);
        }).catch(() => setLastMonthSnapshot(null));
      }
    }

    return () => {
      cancelled = true;
      if (thisMonthFrame) window.cancelAnimationFrame(thisMonthFrame);
      if (lastMonthFrame) window.cancelAnimationFrame(lastMonthFrame);
    };
  }, [tab, d.year, d.bu, d.channel, d.province]);

  if (loading && !data) return (
    <div style={font} className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950">
      <div className="text-center"><Loader2 className="mx-auto h-8 w-8 animate-spin text-blue-500" /><p className="mt-3 text-sm text-slate-400">{t("app.loading")}</p></div>
    </div>
  );
  if (error && !data) return (
    <div style={font} className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <div className="w-full max-w-sm rounded-xl border bg-white p-6 text-center shadow dark:border-slate-800 dark:bg-slate-900">
        <AlertCircle className="mx-auto mb-3 h-8 w-8 text-rose-500" /><p className="font-semibold text-slate-900 dark:text-white">{t("app.error")}</p><p className="mt-1 text-sm text-slate-500">{error}</p>
        <button onClick={() => window.location.reload()} className="mt-4 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 dark:bg-blue-500">{t("app.retry")}</button>
      </div>
    </div>
  );

  /* ── Extract all data ── */
  const kpi = data?.kpi || {};
  const trend = data?.trend || [];
  const structure = data?.structure || {};
  const diagnose = data?.diagnose || {};
  const stock = data?.stock || {};
  const actions = data?.actions || [];
  const payment = data?.payment || {};
  const product = data?.product || {};
  const arAging = data?.ar_aging || {};
  const territory = data?.territory || {};
  const buList = data?.buList || [];
  const channelList = data?.channelList || [];
  const pivot = data?.pivot || new Map();
  const team = diagnose.team || [];
  const buProfit = structure.buProfit || [];
  const topRevenue = product.topRevenue || [];
  const topMargin = product.topMargin || [];
  const groupProfit = product.groupProfit || [];
  const quality = product.quality || {};
  const riskZones = territory.risk || [];
  const oppZones = territory.opportunity || [];
  const manager = managerInsights || {};
  const managerSummary = manager.summary || {};
  const repPerformance = manager.repPerformance || [];
  const topPerformers = manager.coaching?.topPerformers || [];
  const needSupport = manager.coaching?.needSupport || [];
  const customerSegments = manager.customerCapacity?.segments || [];
  const topBuyers = manager.customerCapacity?.topBuyers || [];
  const growthOpportunities = manager.customerCapacity?.growthOpportunities || [];
  const salesperson360 = manager.salesperson360 || [];
  const branchPerformance = manager.branchPerformance || [];
  const dayTimeHeatmap = manager.dayTimeHeatmap || {};
  const heatmapDays = dayTimeHeatmap.days || [];
  const heatmapHours = dayTimeHeatmap.hours || [];
  const heatmapCells = dayTimeHeatmap.cells || [];
  const peakWindows = dayTimeHeatmap.peakWindows || [];
  const lineOa = manager.lineOa || {};
  const lineOaTop = lineOa.topUnregistered || [];
  const heatmapMap = new Map<string, any>(
    heatmapCells.map((item: any) => [`${item.day}|${item.hour}`, item]),
  );
  const heatmapMax = heatmapCells.reduce(
    (max: number, item: any) => Math.max(max, Number(item.revenue || 0)),
    0,
  );
  const managerRecommendations = manager.recommendations || [];
  const owner = ownerInsights || {};
  const ownerFocus = owner.focus || {};
  const whitespaceProvinces = owner.whitespaceProvinces || [];
  const lostCustomers = owner.customerMovement?.lostCustomers || [];
  const reactivatedCustomers = owner.customerMovement?.reactivatedCustomers || [];
  const channelStrategy = owner.channelStrategy || [];
  const recommendations = owner.recommendations || [];
  const bestChannel = ownerFocus.bestChannel || null;

  const ytdAch = Number(data?.ytdAch || 0);
  const thisMonthAch = Number(data?.thisMonthAch || 0);
  const lastMonthAch = Number(data?.lastMonthAch || 0);
  const yoy = Number(data?.yoy || 0);
  const monthGap = Number(data?.gapThisMonth || 0);
  const onTrack = monthGap <= 0;
  const cashVal = Number(payment.cash || 0);
  const creditVal = Number(payment.credit || 0);
  const provinces = (structure.province || []).slice().sort((a: any, b: any) => b.actual - a.actual).slice(0, 8);
  const thisMonthTeam = thisMonthSnapshot?.diagnose?.team || [];
  const lastMonthTeam = lastMonthSnapshot?.diagnose?.team || [];
  const thisMonthProvinces = (thisMonthSnapshot?.structure?.province || []).slice().sort((a: any, b: any) => b.actual - a.actual).slice(0, 8);
  const lastMonthProvinces = (lastMonthSnapshot?.structure?.province || []).slice().sort((a: any, b: any) => b.actual - a.actual).slice(0, 8);
  const lastMonthTopCustomers = lastMonthSnapshot?.diagnose?.topCustomers || [];
  const thisMonthTopCustomers = thisMonthSnapshot?.diagnose?.topCustomers || [];
  const thisMonthGroupProfit = thisMonthSnapshot?.product?.groupProfit || [];
  const lastMonthGroupProfit = lastMonthSnapshot?.product?.groupProfit || [];
  const thisMonthTopRevenue = thisMonthSnapshot?.product?.topRevenue || [];
  const lastMonthTopRevenue = lastMonthSnapshot?.product?.topRevenue || [];
  const thisMonthTopMargin = thisMonthSnapshot?.product?.topMargin || [];
  const lastMonthTopMargin = lastMonthSnapshot?.product?.topMargin || [];
  const thisMonthBuProfit = thisMonthSnapshot?.structure?.buProfit || [];
  const lastMonthBuProfit = lastMonthSnapshot?.structure?.buProfit || [];
  const thisMonthQuality = thisMonthSnapshot?.product?.quality || {};
  const lastMonthQuality = lastMonthSnapshot?.product?.quality || {};
  const thisMonthRiskZones = thisMonthSnapshot?.territory?.risk || [];
  const lastMonthRiskZones = lastMonthSnapshot?.territory?.risk || [];
  const thisMonthOppZones = thisMonthSnapshot?.territory?.opportunity || [];
  const lastMonthOppZones = lastMonthSnapshot?.territory?.opportunity || [];
  const thisMonthStock = thisMonthSnapshot?.stock || {};
  const lastMonthStock = lastMonthSnapshot?.stock || {};
  const thisMonthArAging = thisMonthSnapshot?.ar_aging || {};
  const lastMonthArAging = lastMonthSnapshot?.ar_aging || {};
  const thisMonthMatrix = buildBuChannelMatrix(thisMonthSnapshot?.structure?.buChannel || []);
  const lastMonthMatrix = buildBuChannelMatrix(lastMonthSnapshot?.structure?.buChannel || []);
  const thisMonthCash = Number(kpi.this_month_cash || 0);
  const thisMonthCredit = Number(kpi.this_month_credit || 0);
  const lastMonthCash = Number(kpi.last_month_cash || 0);
  const lastMonthCredit = Number(kpi.last_month_credit || 0);
  const thisMonthGap = Math.max(0, monthGap);
  const lastMonthGap = Math.max(0, Number(kpi.last_month_target || 0) - Number(kpi.last_month_actual || 0));
  let heatMax = 0;
  buList.forEach((b: string) => { const r = pivot.get(b); channelList.forEach((ch: string) => { const v = r?.get(ch) || 0; if (v > heatMax) heatMax = v; }); });

  // BU profit pie
  const buPie = buProfit.slice(0, 6).map((b: any) => ({ name: d.buNameMap?.[String(b.bu)] || b.bu, value: Math.max(Number(b.revenue || 0), 0) }));
  // Group profit pie
  const gpPie = groupProfit.slice(0, 6).map((g: any) => ({ name: g.group, value: Math.max(Number(g.revenue || 0), 0) }));

  // Monthly comparison data
  const curMonthIdx = new Date().getMonth(); // 0-based
  const prevMonthIdx = curMonthIdx === 0 ? 11 : curMonthIdx - 1;
  const curTrend = trend[curMonthIdx] || {};
  const prevTrend = trend[prevMonthIdx] || {};
  const sameMonthLY = Number(kpi.this_month_last_year || 0);
  const prevMonthLYActual = prevMonthIdx < trend.length ? Number(trend[prevMonthIdx]?.lastYear || 0) : 0;
  const thisMonthActions = buildFocusActions({
    label: curTrend.name || "ເດືອນນີ້",
    actual: Number(kpi.this_month_actual || 0),
    target: Number(kpi.this_month_target || 0),
    lastYear: sameMonthLY,
    gap: thisMonthGap,
    requiredPerDay: Number(data?.requiredPerDay || 0),
    daysLeft: Number(data?.daysLeft || 0),
    t,
  });
  const lastMonthActions = buildFocusActions({
    label: prevTrend.name || "ເດືອນກ່ອນ",
    actual: Number(kpi.last_month_actual || 0),
    target: Number(kpi.last_month_target || 0),
    lastYear: prevMonthLYActual,
    gap: lastMonthGap,
    t,
  });

  const renderFocusSummary = (ach: number, cash: number, credit: number, qualityData: any) => {
    const totalPayment = cash + credit;
    return (
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={t("section.achievement")}>
          <Progress label={t("dash.achievement")} v={ach} />
          <Progress label={t("dash.cashShare")} v={totalPayment > 0 ? (cash / totalPayment) * 100 : 0} />
          <Progress label={t("label.repeatCustomer")} v={Number(qualityData.repeatPct || 0)} />
        </Card>
        <Card title={t("section.payment")}>
          <div className="flex items-center gap-4">
            <ChartFrame className="h-28 w-28 shrink-0">
              <PieChart>
                <Pie data={[{ name: "Cash", value: cash }, { name: "Credit", value: credit }]} dataKey="value" cx="50%" cy="50%" innerRadius={28} outerRadius={48} strokeWidth={0}>
                  <Cell fill={C.emerald} />
                  <Cell fill={C.amber} />
                </Pie>
              </PieChart>
            </ChartFrame>
            <div className="space-y-2">
              <div><p className={`text-xs ${tw.sub}`}>{t("dash.cash")}</p><p className={`text-lg font-bold ${tw.green}`}>{fmt(cash)}</p></div>
              <div><p className={`text-xs ${tw.sub}`}>{t("dash.credit")}</p><p className={`text-lg font-bold ${tw.amber}`}>{fmt(credit)}</p></div>
            </div>
          </div>
        </Card>
        <Card title={t("dash.custQuality")}>
          <div className="grid grid-cols-2 gap-2">
            <Mini label={t("label.repeatCustomer")} value={pct(qualityData.repeatPct)} cls={tw.green} />
            <Mini label={t("label.newCustomer")} value={pct(qualityData.newCustomerPct)} cls={tw.blue} />
            <Mini label="Discount Rate" value={pct(qualityData.discountRatePct)} cls={tw.amber} />
            <Mini label="Reactive (2M+)" value={String(qualityData.reactiveCustomers || 0)} cls="text-violet-600 dark:text-violet-400" />
          </div>
        </Card>
      </div>
    );
  };

  const renderRevenueMatrix = (matrix: any) => {
    if (!matrix.buList.length || !matrix.channelList.length) return null;
    return (
      <Card title={t("dash.revenueMatrix")}>
        <div className="overflow-x-auto"><table className="w-full text-xs">
          <thead><tr className={tw.sub}>
            <th className="px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wider">BU</th>
            {matrix.channelList.map((ch: string) => <th key={ch} className="px-1 py-2 text-center text-[10px] font-semibold uppercase tracking-wider">{ch}</th>)}
            <th className="px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wider">Total</th>
          </tr></thead>
          <tbody>{matrix.buList.map((b: string) => {
            const rm = matrix.pivot.get(b) || new Map();
            const tot = matrix.channelList.reduce((s: number, ch: string) => s + (rm.get(ch) || 0), 0);
            return (
              <tr key={b} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                <td className={`whitespace-nowrap px-2 py-1.5 font-medium ${tw.head}`}>{d.buNameMap?.[String(b)] || b}</td>
                {matrix.channelList.map((ch: string) => {
                  const v = rm.get(ch) || 0;
                  const op = matrix.heatMax > 0 ? Math.max((v / matrix.heatMax) * 0.85, 0.04) : 0.04;
                  return (
                    <td key={ch} className="p-0.5 text-center">
                      <div className="rounded px-1.5 py-1 tabular-nums font-medium" style={{ backgroundColor: `rgba(59,130,246,${op})`, color: op > 0.45 ? "#fff" : undefined }}>
                        {v > 0 ? fmt(v) : "–"}
                      </div>
                    </td>
                  );
                })}
                <td className={`whitespace-nowrap px-2 py-1.5 text-right font-bold tabular-nums ${tw.head}`}>{fmt(tot)}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </Card>
    );
  };

  const renderBuAndGroupSections = (buProfitRows: any[], groupRows: any[]) => {
    const localBuPie = buProfitRows.slice(0, 6).map((b: any) => ({ name: d.buNameMap?.[String(b.bu)] || b.bu, value: Math.max(Number(b.revenue || 0), 0) }));
    const localGpPie = groupRows.slice(0, 6).map((g: any) => ({ name: g.group, value: Math.max(Number(g.revenue || 0), 0) }));

    return (
      <>
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title={t("section.buRevenue")}>
            <ChartFrame className="h-44"><PieChart><Pie data={localBuPie} dataKey="value" cx="50%" cy="50%" outerRadius={65} strokeWidth={1} stroke={isDark ? "#1e293b" : "#fff"} label={({ name, percent }: any) => `${name} ${(percent*100).toFixed(0)}%`} labelLine={false} fontSize={10}>
              {localBuPie.map((_: any, i: number) => <Cell key={i} fill={PIE[i % PIE.length]} />)}
            </Pie></PieChart></ChartFrame>
          </Card>
          <Card title={t("section.groupProfit")}>
            <ChartFrame className="h-44"><PieChart><Pie data={localGpPie} dataKey="value" cx="50%" cy="50%" outerRadius={65} strokeWidth={1} stroke={isDark ? "#1e293b" : "#fff"} label={({ name, percent }: any) => `${(name||"").slice(0,8)} ${(percent*100).toFixed(0)}%`} labelLine={false} fontSize={10}>
              {localGpPie.map((_: any, i: number) => <Cell key={i} fill={PIE[i % PIE.length]} />)}
            </Pie></PieChart></ChartFrame>
          </Card>
          <Card title={t("dash.buProfit")}>
            <div className="space-y-1.5">{buProfitRows.slice(0, 6).map((b: any, i: number) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className={`font-medium ${tw.head}`}>{d.buNameMap?.[String(b.bu)] || b.bu}</span>
                <div className="flex gap-3 tabular-nums">
                  <span className={tw.sub}>Rev {compact(b.revenue)}</span>
                  <span className={`font-bold ${Number(b.profit_thb || 0) >= 0 ? tw.green : tw.red}`}>{Number(b.profit_thb || 0) >= 0 ? "+" : ""}{compact(b.profit_thb)}</span>
                </div>
              </div>
            ))}</div>
          </Card>
        </div>

        {groupRows.length > 0 && (
          <Card title={t("dash.groupDetail")}>
            <div className="space-y-3">
              {groupRows.slice(0, 8).map((g: any, gi: number) => (
                <div key={gi}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold" style={{ backgroundColor: PIE[gi % PIE.length] + "20", color: PIE[gi % PIE.length] }}>{gi + 1}</span>
                      <span className={`text-xs font-semibold ${tw.head}`}>{g.group}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs tabular-nums">
                      <span className={tw.sub}>Rev {compact(g.revenue)}</span>
                      <span className={`font-bold ${Number(g.profit_thb || 0) >= 0 ? tw.green : tw.red}`}>{Number(g.profit_thb || 0) >= 0 ? "+" : ""}{compact(g.profit_thb)}</span>
                      {g.profit_pct != null && <span className={tw.sub}>{Number(g.profit_pct).toFixed(1)}%</span>}
                    </div>
                  </div>
                  {(g.subgroups || []).length > 0 && (
                    <div className="ml-7 mt-1 space-y-0.5">
                      {g.subgroups.slice(0, 5).map((sg: any, si: number) => (
                        <div key={si} className="flex items-center justify-between text-[11px]">
                          <span className={tw.sub}>{sg.subgroup}</span>
                          <div className="flex gap-3 tabular-nums">
                            <span className={tw.sub}>Rev {compact(sg.revenue)}</span>
                            <span className={`font-medium ${Number(sg.profit_thb || 0) >= 0 ? tw.green : tw.red}`}>{Number(sg.profit_thb || 0) >= 0 ? "+" : ""}{compact(sg.profit_thb)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}

        {buProfitRows.some((b: any) => b.brands && b.brands.length > 0) && (
          <Card title={t("dash.brandsByBu")}>
            <div className="space-y-4">
              {buProfitRows.filter((b: any) => b.brands && b.brands.length > 0).slice(0, 6).map((b: any, bi: number) => (
                <div key={bi}>
                  <p className={`text-xs font-semibold ${tw.head}`}>{d.buNameMap?.[String(b.bu)] || b.bu}</p>
                  <div className="mt-1.5 overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead><tr className={tw.sub}>
                        <th className="pb-1 pr-3 text-left font-medium">Brand</th>
                        <th className="pb-1 px-2 text-right font-medium">Revenue</th>
                        <th className="pb-1 px-2 text-right font-medium">Cost</th>
                        <th className="pb-1 pl-2 text-right font-medium">Profit</th>
                      </tr></thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {b.brands.slice(0, 8).map((br: any, bri: number) => (
                          <tr key={bri} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                            <td className={`py-1 pr-3 font-medium ${tw.head}`}>{br.brand}</td>
                            <td className="py-1 px-2 text-right tabular-nums">{compact(br.revenue)}</td>
                            <td className={`py-1 px-2 text-right tabular-nums ${tw.sub}`}>{compact(br.cost_thb)}</td>
                            <td className={`py-1 pl-2 text-right tabular-nums font-semibold ${Number(br.profit_thb || 0) >= 0 ? tw.green : tw.red}`}>{Number(br.profit_thb || 0) >= 0 ? "+" : ""}{compact(br.profit_thb)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </>
    );
  };

  const renderProductCards = (topRevenueRows: any[], topMarginRows: any[], revenueTitle: string, marginTitle: string) => (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={revenueTitle}>
        {topRevenueRows.map((p: any, i: number) => (
          <div key={i} className="flex items-center justify-between border-b border-slate-100 py-2 last:border-0 dark:border-slate-800">
            <div className="min-w-0 flex-1"><p className={`truncate text-xs font-medium ${tw.head}`}>{p.name || p.code}</p><p className="text-[10px] text-slate-400">{p.code}</p></div>
            <span className={`ml-3 text-xs font-bold tabular-nums ${tw.blue}`}>{fmt(p.revenue)}</span>
          </div>
        ))}
        {topRevenueRows.length === 0 && <Empty text={t("label.noData")} />}
      </Card>
      <Card title={marginTitle}>
        {topMarginRows.map((p: any, i: number) => (
          <div key={i} className="flex items-center justify-between border-b border-slate-100 py-2 last:border-0 dark:border-slate-800">
            <div className="min-w-0 flex-1"><p className={`truncate text-xs font-medium ${tw.head}`}>{p.name || p.code}</p><p className="text-[10px] text-slate-400">GP {(Number(p.gp || 0) * 100).toFixed(1)}%</p></div>
            <span className={`ml-3 text-xs font-bold tabular-nums ${tw.green}`}>{fmt(p.revenue)}</span>
          </div>
        ))}
        {topMarginRows.length === 0 && <Empty text={t("label.noData")} />}
      </Card>
    </div>
  );

  const renderTerritoryCards = (risk: any[], opp: any[]) => {
    if (!risk.length && !opp.length) return null;
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`⚠ ${t("dash.riskZones")}`}>
          {risk.map((p: any, i: number) => (
            <div key={i} className="flex items-center justify-between border-b border-slate-100 py-1.5 text-xs last:border-0 dark:border-slate-800">
              <span className={`font-medium ${tw.head}`}>{p.label}</span>
              <div className="flex gap-3 tabular-nums"><span className={tw.sub}>Actual {fmt(p.actual)}</span><span className={`font-bold ${tw.red}`}>{pct(p.achPct)}</span></div>
            </div>
          ))}
          {risk.length === 0 && <Empty text={t("label.noData")} />}
        </Card>
        <Card title={`✦ ${t("dash.oppZones")}`}>
          {opp.map((p: any, i: number) => (
            <div key={i} className="flex items-center justify-between border-b border-slate-100 py-1.5 text-xs last:border-0 dark:border-slate-800">
              <span className={`font-medium ${tw.head}`}>{p.label}</span>
              <div className="flex gap-3 tabular-nums"><span className={tw.sub}>Actual {fmt(p.actual)}</span><span className={`font-bold ${tw.green}`}>{pct(p.achPct)}</span></div>
            </div>
          ))}
          {opp.length === 0 && <Empty text={t("label.noData")} />}
        </Card>
      </div>
    );
  };

  const renderStockArActions = (stockData: any, arData: any, actionList: any[]) => (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title={t("section.stock")}>
        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
          <Mini label={t("label.qty")} value={compact(stockData.total_qty)} />
          <Mini label={t("label.value")} value={compact(stockData.total_value)} />
          <Mini label="Avg Cost" value={compact(stockData.avg_cost)} />
          <Mini label="Warehouses" value={String(stockData.warehouse_count || 0)} />
          <Mini label="Avg / Day" value={compact(stockData.avg_sales_per_day)} />
        </div>
        <p className={`mb-1 text-[10px] font-semibold uppercase tracking-wider ${tw.sub}`}>{t("dash.byWarehouse")}</p>
        {(stockData.by_warehouse || []).slice(0, 5).map((w: any, i: number) => (
          <div key={i} className="flex justify-between py-0.5 text-xs"><span className={tw.sub}>{w.warehouse}</span><span className={`font-medium tabular-nums ${tw.head}`}>{fmt(w.value)}</span></div>
        ))}
        {(stockData.by_group || []).length > 0 && <>
          <p className={`mb-1 mt-2 text-[10px] font-semibold uppercase tracking-wider ${tw.sub}`}>{t("dash.byGroup")}</p>
          {(stockData.by_group || []).slice(0, 4).map((g: any, i: number) => (
            <div key={i} className="flex justify-between py-0.5 text-xs"><span className={tw.sub}>{g.group_main_name}</span><span className={`font-medium tabular-nums ${tw.head}`}>{fmt(g.value)}</span></div>
          ))}
        </>}
      </Card>

      <Card title={t("dash.arAging")}>
        <p className={`text-2xl font-bold ${tw.head}`}>{fmt(arData.total)}</p>
        <div className="mt-3 space-y-1.5">
          {(arData.buckets || []).map((b: any, i: number) => {
            const maxB = Math.max(...(arData.buckets || []).map((x: any) => Number(x.balance || 0)), 1);
            return (
              <div key={i}>
                <div className="flex justify-between text-xs"><span className={tw.sub}>{b.overdue_group}</span><span className={`font-semibold tabular-nums ${tw.head}`}>{fmt(b.balance)}</span></div>
                <div className="mt-0.5 h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800">
                  <div className={`h-full rounded-full transition-all duration-500 ${i < 2 ? "bg-emerald-500" : i < 4 ? "bg-amber-500" : "bg-rose-500"}`} style={{ width: `${(Number(b.balance || 0) / maxB) * 100}%` }} />
                </div>
              </div>
            );
          })}
        </div>
        {(arData.by_department || []).length > 0 && <>
          <p className={`mb-1 mt-3 text-[10px] font-semibold uppercase tracking-wider ${tw.sub}`}>{t("dash.byDept")}</p>
          {(arData.by_department || []).slice(0, 4).map((dpt: any, i: number) => (
            <div key={i} className="flex justify-between py-0.5 text-xs"><span className={tw.sub}>{dpt.department}</span><span className={`font-medium tabular-nums ${tw.head}`}>{fmt(dpt.balance)}</span></div>
          ))}
        </>}
      </Card>

      <Card title={`${t("dash.actionPlan")} (${actionList.length})`}>
        <div className="space-y-2">{actionList.map((a: any, i: number) => (
          <div key={i} className={`rounded-lg border-l-[3px] py-2 pl-3 pr-2 ${a.level === "high" ? "border-l-rose-500 bg-rose-50/50 dark:bg-rose-900/10" : a.level === "medium" ? "border-l-amber-500 bg-amber-50/50 dark:bg-amber-900/10" : "border-l-slate-300 bg-slate-50 dark:bg-slate-800/30"}`}>
            <p className={`text-xs font-semibold ${tw.head}`}>{a.title}</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{a.detail}</p>
          </div>
        ))}</div>
      </Card>
    </div>
  );

  return (
    <div style={font} className="min-h-screen bg-slate-50 dark:bg-slate-950">

      {/* ══════ HEADER ══════ */}
      <header className="sticky top-0 z-40 border-b border-slate-200/50 bg-white/80 backdrop-blur-xl dark:border-slate-800/50 dark:bg-slate-950/80">
        <div className="flex items-center justify-between px-5 py-3 lg:px-6">
          <div>
            <h1 className={`text-base font-semibold ${tw.head}`}>{t("app.title")}</h1>
            <p className={`text-xs ${tw.sub}`}>{t("app.subtitle")} — FY {d.year}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={() => setShowFilter(!showFilter)} className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${showFilter ? "bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400" : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"}`}><Filter size={12} /> {t("app.filters")}</button>
            <button onClick={() => d.load()} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><RefreshCw size={14} className={d.loading || d.refreshing ? "animate-spin" : ""} /></button>
            <button onClick={toggleTheme} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">{isDark ? <Sun size={14} /> : <Moon size={14} />}</button>
          </div>
        </div>
        {showFilter && (
          <div className="grid grid-cols-2 gap-3 border-t border-slate-100 px-5 py-3 lg:grid-cols-4 lg:px-6 dark:border-slate-800">
            {[
              { l: t("filter.year"), v: d.year, fn: (v: string) => d.setYear(v), opts: d.yearOptions.map((y: any) => ({ v: y, l: y })), noAll: true },
              { l: t("filter.bu"), v: d.bu, fn: (v: string) => d.setBu(v), opts: d.buOptions.map((o: any) => ({ v: o.value, l: o.label })) },
              { l: t("filter.channel"), v: d.channel[0] || "ALL", fn: (v: string) => d.setChannel([v]), opts: d.channelOptions.map((o: any) => ({ v: o.value, l: o.label })) },
              { l: t("filter.province"), v: d.province[0] || "ALL", fn: (v: string) => d.setProvince([v]), opts: d.provinceOptions.map((o: any) => ({ v: o.value, l: o.label })) },
            ].map((f, i) => (
              <div key={i}><label className={`mb-1 block text-[10px] font-semibold uppercase tracking-wider ${tw.sub}`}>{f.l}</label>
                <select value={f.v} onChange={e => f.fn(e.target.value)} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                  {!f.noAll && <option value="ALL">{t("app.all")}</option>}
                  {f.opts.map((o: any) => <option key={o.v} value={o.v}>{o.l}</option>)}
                </select>
              </div>
            ))}
          </div>
        )}
        {/* Tab bar */}
        <div className="flex gap-1 border-t border-slate-100 px-5 lg:px-6 dark:border-slate-800">
          {([
            { key: "overview" as const, label: `📊 ${t("dash.tab.overview")}` },
            { key: "lastMonth" as const, label: `📅 ${t("dash.tab.lastMonth")} (${trend[kpi.last_month_actual ? new Date().getMonth() : 0]?.name || "Prev"})` },
            { key: "thisMonth" as const, label: `🔥 ${t("dash.tab.thisMonth")} (${trend[new Date().getMonth()]?.name || "Now"})` },
          ]).map(tb => (
            <button key={tb.key} onClick={() => setTab(tb.key)} className={`border-b-2 px-4 py-2.5 text-xs font-medium transition-colors ${tab === tb.key ? "border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400" : "border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"}`}>
              {tb.label}
            </button>
          ))}
        </div>
      </header>

      <main className="mx-auto max-w-[1480px] space-y-5 px-5 py-5 lg:px-6">

        {/* ══════════════════════════════════════════════════════════════
            TAB: OVERVIEW (ພາບລວມ YTD)
        ══════════════════════════════════════════════════════════════ */}
        {tab === "overview" && (<>

        {/* ═══════════════════════════════════════════════════════════
            SECTION 1: EXECUTIVE KPI STRIP
        ═══════════════════════════════════════════════════════════ */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <Kpi label={t("kpi.ytd")} value={fmt(kpi.ytd_actual)} sub={`${t("kpi.target")} ${fmt(kpi.ytd_target)}`} ach={ytdAch} color="blue" />
          <Kpi label={t("kpi.thisMonth")} value={fmt(kpi.this_month_actual)} sub={`${t("kpi.target")} ${fmt(kpi.this_month_target)}`} ach={thisMonthAch} color="violet" />
          <Kpi label="YoY" value={`${yoy >= 0 ? "+" : ""}${yoy.toFixed(1)}%`} sub={`${t("kpi.lastYear")} ${fmt(kpi.ytd_last_year)}`} ach={yoy >= 0 ? 100 : 0} color={yoy >= 0 ? "emerald" : "rose"} />
          <Kpi label="Forecast EOY" value={compact(data?.forecastEOY)} sub={`Gap ${compact(data?.eoyGap)}`} ach={ytdAch} color="amber" />
          <Kpi label="GP %" value={exec ? `${Number(exec.grossProfit?.gpPct || 0).toFixed(1)}%` : "..."} sub={`${t("kpi.profit")} ${exec ? fmt(exec.grossProfit?.profit) : "..."}`} ach={Number(exec?.grossProfit?.gpPct || 0) >= 20 ? 100 : 50} color="emerald" />
          <Kpi label="Collection" value={exec ? `${Number(exec.collection?.rate || 0).toFixed(0)}%` : "..."} sub={`${t("kpi.collected")} ${exec ? fmt(exec.collection?.collected) : "..."}`} ach={Number(exec?.collection?.rate || 0) >= 50 ? 100 : 30} color="cyan" />
        </div>

        {/* ═══════════════════════════════════════════════════════════
            SECTION 2: TODAY / WEEK / MOMENTUM
        ═══════════════════════════════════════════════════════════ */}
        <div className={`${tw.card} flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4`}>
          <div className="flex items-center gap-2.5">
            <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${onTrack ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20" : "bg-amber-50 text-amber-600 dark:bg-amber-900/20"}`}>
              {onTrack ? <TrendingUp size={18} /> : <AlertTriangle size={18} />}
            </div>
            <div><p className={`text-sm font-semibold ${tw.head}`}>{onTrack ? t("momentum.onTrack") : t("momentum.behind")}</p><p className={`text-[11px] ${tw.sub}`}>{data?.daysLeft || 0} {t("momentum.daysLeft")}</p></div>
          </div>
          <Sep />
          {exec && <><Pill icon={<Zap size={11} />} label={t("momentum.today")} value={fmt(exec.today?.sales)} accent="blue" /><Pill icon={<Clock size={11} />} label={t("momentum.week")} value={fmt(exec.week?.sales)} accent="blue" /><Sep /></>}
          <Pill label={t("momentum.gapMonth")} value={fmt(monthGap)} /><Pill label={t("momentum.perDay")} value={fmt(data?.requiredPerDay)} />
          <Sep />
          <Pill label={t("momentum.cash")} value={fmt(cashVal)} accent="emerald" /><Pill label={t("momentum.credit")} value={fmt(creditVal)} accent="amber" />
          {exec && <><Sep /><Pill label={t("momentum.ordersToday")} value={String(exec.today?.orders || 0)} accent="blue" /></>}
        </div>

        {/* ═══════════════════════════════════════════════════════════
            SECTION 3: ACHIEVEMENT + PAYMENT PIE + CUSTOMER QUALITY
        ═══════════════════════════════════════════════════════════ */}
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title={t("section.achievement")}><Progress label="YTD" v={ytdAch} /><Progress label={t("kpi.thisMonth")} v={thisMonthAch} /><Progress label={t("kpi.lastMonth")} v={lastMonthAch} /></Card>
          <Card title={t("section.payment")}>
            <div className="flex items-center gap-4">
              <ChartFrame className="h-28 w-28 shrink-0"><PieChart><Pie data={[{ name: "Cash", value: cashVal }, { name: "Credit", value: creditVal }]} dataKey="value" cx="50%" cy="50%" innerRadius={28} outerRadius={48} strokeWidth={0}><Cell fill={C.emerald} /><Cell fill={C.amber} /></Pie></PieChart></ChartFrame>
              <div className="space-y-2"><div><p className={`text-xs ${tw.sub}`}>{t("dash.cash")}</p><p className={`text-lg font-bold ${tw.green}`}>{fmt(cashVal)}</p></div><div><p className={`text-xs ${tw.sub}`}>{t("dash.credit")}</p><p className={`text-lg font-bold ${tw.amber}`}>{fmt(creditVal)}</p></div></div>
            </div>
          </Card>
          <Card title={t("dash.custQuality")}>
            <div className="grid grid-cols-2 gap-2">
              <Mini label={t("label.repeatCustomer")} value={pct(quality.repeatPct)} cls={tw.green} />
              <Mini label={t("label.newCustomer")} value={pct(quality.newCustomerPct)} cls={tw.blue} />
              <Mini label="Discount Rate" value={pct(quality.discountRatePct)} cls={tw.amber} />
              <Mini label="Reactive (2M+)" value={String(quality.reactiveCustomers || 0)} cls="text-violet-600 dark:text-violet-400" />
            </div>
          </Card>
        </div>

        {/* ═══════════════════════════════════════════════════════════
            SECTION 4: REVENUE TREND
        ═══════════════════════════════════════════════════════════ */}
        <Card title={t("section.revenueTrend")}>
          <div className="mb-2 flex gap-4 text-[11px] text-slate-400">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-blue-500" />{t("label.actual")}</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-slate-300" />{t("kpi.target")}</span>
            <span className="flex items-center gap-1"><span className="h-0.5 w-3 border-b-2 border-dashed border-emerald-400" />{t("kpi.lastYear")}</span>
          </div>
          <ChartFrame className="h-64">
            <AreaChart data={trend} margin={{ top: 5, right: 5, bottom: 0, left: -15 }}>
              <defs><linearGradient id="gA" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.blue} stopOpacity={0.2} /><stop offset="100%" stopColor={C.blue} stopOpacity={0} /></linearGradient></defs>
              <CartesianGrid strokeDasharray="3 3" stroke={isDark ? "#1e293b" : "#f1f5f9"} />
              <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "#94a3b8" }} />
              <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "#94a3b8" }} tickFormatter={(v: number) => compact(v)} />
              <Tooltip content={<Tip />} />
              <Area type="monotone" dataKey="target" name={t("kpi.target")} stroke="#cbd5e1" strokeWidth={1.5} fill="#f8fafc" fillOpacity={isDark ? 0.05 : 0.3} />
              <Area type="monotone" dataKey="actual" name={t("label.actual")} stroke={C.blue} strokeWidth={2.5} fill="url(#gA)" />
              <Area type="monotone" dataKey="lastYear" name={t("kpi.lastYear")} stroke={C.emerald} strokeWidth={1.5} fill="none" strokeDasharray="5 5" />
            </AreaChart>
          </ChartFrame>
        </Card>

        {/* ═══════════════════════════════════════════════════════════
            SECTION 5: DAILY TREND (14 days) + CASH/CREDIT BY MONTH
        ═══════════════════════════════════════════════════════════ */}
        {exec && (exec.dailyTrend || []).length > 0 && (
          <Card title={t("section.dailySales")}>
            <ChartFrame className="h-48">
              <BarChart data={exec.dailyTrend} barSize={14}>
                <CartesianGrid strokeDasharray="3 3" stroke={isDark ? "#1e293b" : "#f1f5f9"} />
                <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v: string) => { const dt = new Date(v); return `${dt.getDate()}/${dt.getMonth()+1}`; }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v: number) => compact(v)} />
                <Tooltip content={<Tip />} /><Bar dataKey="amount" name={t("label.actual")} fill={C.blue} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ChartFrame>
          </Card>
        )}
        <Card title={t("dash.cashVsCredit")}>
          <ChartFrame className="h-56">
            <BarChart data={trend} barGap={4} barSize={18}>
              <CartesianGrid strokeDasharray="3 3" stroke={isDark ? "#1e293b" : "#f1f5f9"} />
              <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} />
              <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v: number) => compact(v)} />
              <Tooltip content={<Tip />} /><Bar dataKey="cash" name={t("momentum.cash")} fill={C.emerald} radius={[4, 4, 0, 0]} /><Bar dataKey="credit" name={t("momentum.credit")} fill={C.amber} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ChartFrame>
        </Card>

        {/* ═══════════════════════════════════════════════════════════
            SECTION 6: REVENUE MATRIX (BU × Channel)
        ═══════════════════════════════════════════════════════════ */}
        {buList.length > 0 && channelList.length > 0 && (
          <Card title={t("dash.revenueMatrix")}>
            <div className="overflow-x-auto"><table className="w-full text-xs">
              <thead><tr className={tw.sub}>
                <th className="px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wider">BU</th>
                {channelList.map((ch: string) => <th key={ch} className="px-1 py-2 text-center text-[10px] font-semibold uppercase tracking-wider">{ch}</th>)}
                <th className="px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wider">Total</th>
              </tr></thead>
              <tbody>{buList.map((b: string) => {
                const rm = pivot.get(b) || new Map();
                const tot = channelList.reduce((s: number, ch: string) => s + (rm.get(ch) || 0), 0);
                return (<tr key={b} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className={`whitespace-nowrap px-2 py-1.5 font-medium ${tw.head}`}>{d.buNameMap?.[String(b)] || b}</td>
                  {channelList.map((ch: string) => { const v = rm.get(ch) || 0; const op = heatMax > 0 ? Math.max((v / heatMax) * 0.85, 0.04) : 0.04; return (
                    <td key={ch} className="p-0.5 text-center"><div className="rounded px-1.5 py-1 tabular-nums font-medium" style={{ backgroundColor: `rgba(59,130,246,${op})`, color: op > 0.45 ? "#fff" : undefined }}>{v > 0 ? fmt(v) : "–"}</div></td>
                  ); })}
                  <td className={`whitespace-nowrap px-2 py-1.5 text-right font-bold tabular-nums ${tw.head}`}>{fmt(tot)}</td>
                </tr>);
              })}</tbody>
            </table></div>
          </Card>
        )}

        {/* ═══════════════════════════════════════════════════════════
            SECTION 7: BU PROFIT PIE + PRODUCT GROUP PIE + BU TABLE
        ═══════════════════════════════════════════════════════════ */}
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title={t("section.buRevenue")}>
            <ChartFrame className="h-44"><PieChart><Pie data={buPie} dataKey="value" cx="50%" cy="50%" outerRadius={65} strokeWidth={1} stroke={isDark ? "#1e293b" : "#fff"} label={({ name, percent }: any) => `${name} ${(percent*100).toFixed(0)}%`} labelLine={false} fontSize={10}>
              {buPie.map((_: any, i: number) => <Cell key={i} fill={PIE[i % PIE.length]} />)}
            </Pie></PieChart></ChartFrame>
          </Card>
          <Card title={t("section.groupProfit")}>
            <ChartFrame className="h-44"><PieChart><Pie data={gpPie} dataKey="value" cx="50%" cy="50%" outerRadius={65} strokeWidth={1} stroke={isDark ? "#1e293b" : "#fff"} label={({ name, percent }: any) => `${(name||"").slice(0,8)} ${(percent*100).toFixed(0)}%`} labelLine={false} fontSize={10}>
              {gpPie.map((_: any, i: number) => <Cell key={i} fill={PIE[i % PIE.length]} />)}
            </Pie></PieChart></ChartFrame>
          </Card>
          <Card title={t("dash.buProfit")}>
            <div className="space-y-1.5">{buProfit.slice(0, 6).map((b: any, i: number) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className={`font-medium ${tw.head}`}>{d.buNameMap?.[String(b.bu)] || b.bu}</span>
                <div className="flex gap-3 tabular-nums">
                  <span className={tw.sub}>Rev {compact(b.revenue)}</span>
                  <span className={`font-bold ${Number(b.profit_thb || 0) >= 0 ? tw.green : tw.red}`}>{Number(b.profit_thb || 0) >= 0 ? "+" : ""}{compact(b.profit_thb)}</span>
                </div>
              </div>
            ))}</div>
          </Card>
        </div>

        {/* ═══════════════════════════════════════════════════════════
            SECTION 7B: PRODUCT GROUP DETAIL (ໝວດ + Sub-group)
        ═══════════════════════════════════════════════════════════ */}
        {groupProfit.length > 0 && (
          <Card title={t("dash.groupDetail")}>
            <div className="space-y-3">
              {groupProfit.slice(0, 8).map((g: any, gi: number) => (
                <div key={gi}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold" style={{ backgroundColor: PIE[gi % PIE.length] + "20", color: PIE[gi % PIE.length] }}>{gi + 1}</span>
                      <span className={`text-xs font-semibold ${tw.head}`}>{g.group}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs tabular-nums">
                      <span className={tw.sub}>Rev {compact(g.revenue)}</span>
                      <span className={`font-bold ${Number(g.profit_thb || 0) >= 0 ? tw.green : tw.red}`}>{Number(g.profit_thb || 0) >= 0 ? "+" : ""}{compact(g.profit_thb)}</span>
                      {g.profit_pct != null && <span className={tw.sub}>{Number(g.profit_pct).toFixed(1)}%</span>}
                    </div>
                  </div>
                  {/* Sub-groups */}
                  {(g.subgroups || []).length > 0 && (
                    <div className="ml-7 mt-1 space-y-0.5">
                      {g.subgroups.slice(0, 5).map((sg: any, si: number) => (
                        <div key={si} className="flex items-center justify-between text-[11px]">
                          <span className={tw.sub}>{sg.subgroup}</span>
                          <div className="flex gap-3 tabular-nums">
                            <span className={tw.sub}>{compact(sg.revenue)}</span>
                            <span className={`font-medium ${Number(sg.profit_thb || 0) >= 0 ? tw.green : tw.red}`}>{compact(sg.profit_thb)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* ═══════════════════════════════════════════════════════════
            SECTION 7C: BRANDS BY BU (ຍີ່ຫໍ້)
        ═══════════════════════════════════════════════════════════ */}
        {buProfit.some((b: any) => b.brands && b.brands.length > 0) && (
          <Card title={t("dash.brandsByBu")}>
            <div className="space-y-4">
              {buProfit.filter((b: any) => b.brands && b.brands.length > 0).slice(0, 6).map((b: any, bi: number) => (
                <div key={bi}>
                  <p className={`text-xs font-semibold ${tw.head}`}>{d.buNameMap?.[String(b.bu)] || b.bu}</p>
                  <div className="mt-1.5 overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className={tw.sub}>
                          <th className="pb-1 pr-3 text-left font-medium">Brand</th>
                          <th className="pb-1 px-2 text-right font-medium">Revenue</th>
                          <th className="pb-1 px-2 text-right font-medium">Cost</th>
                          <th className="pb-1 pl-2 text-right font-medium">Profit</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {b.brands.slice(0, 8).map((br: any, bri: number) => (
                          <tr key={bri} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                            <td className={`py-1 pr-3 font-medium ${tw.head}`}>{br.brand}</td>
                            <td className="py-1 px-2 text-right tabular-nums">{compact(br.revenue)}</td>
                            <td className={`py-1 px-2 text-right tabular-nums ${tw.sub}`}>{compact(br.cost_thb)}</td>
                            <td className={`py-1 pl-2 text-right tabular-nums font-semibold ${Number(br.profit_thb || 0) >= 0 ? tw.green : tw.red}`}>{Number(br.profit_thb || 0) >= 0 ? "+" : ""}{compact(br.profit_thb)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* ═══════════════════════════════════════════════════════════
            SECTION 8: TOP PRODUCTS + TOP MARGIN
        ═══════════════════════════════════════════════════════════ */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={t("dash.topRevProducts")}>
            {topRevenue.map((p: any, i: number) => (
              <div key={i} className="flex items-center justify-between border-b border-slate-100 py-2 last:border-0 dark:border-slate-800">
                <div className="min-w-0 flex-1"><p className={`truncate text-xs font-medium ${tw.head}`}>{p.name || p.code}</p><p className="text-[10px] text-slate-400">{p.code}</p></div>
                <span className={`ml-3 text-xs font-bold tabular-nums ${tw.blue}`}>{fmt(p.revenue)}</span>
              </div>
            ))}
            {topRevenue.length === 0 && <Empty text={t("label.noData")} />}
          </Card>
          <Card title={t("dash.topMarginProducts")}>
            {topMargin.map((p: any, i: number) => (
              <div key={i} className="flex items-center justify-between border-b border-slate-100 py-2 last:border-0 dark:border-slate-800">
                <div className="min-w-0 flex-1"><p className={`truncate text-xs font-medium ${tw.head}`}>{p.name || p.code}</p><p className="text-[10px] text-slate-400">GP {(Number(p.gp || 0) * 100).toFixed(1)}%</p></div>
                <span className={`ml-3 text-xs font-bold tabular-nums ${tw.green}`}>{fmt(p.revenue)}</span>
              </div>
            ))}
            {topMargin.length === 0 && <Empty text={t("label.noData")} />}
          </Card>
        </div>

        {/* ═══════════════════════════════════════════════════════════
            SECTION 9: TEAM LEADERBOARD + PROVINCE RANKING
        ═══════════════════════════════════════════════════════════ */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={`ທີມຂາຍ (${team.length})`}>{team.map((m: any, i: number) => <Rank key={i} i={i} label={m.name} value={fmt(m.actual)} ach={m.achPct} />)}{team.length === 0 && <Empty text={t("label.noData")} />}</Card>
          <Card title={`ແຂວງ Top (${provinces.length})`}>{provinces.map((p: any, i: number) => <Rank key={i} i={i} label={p.label} value={fmt(p.actual)} ach={p.achPct} />)}{provinces.length === 0 && <Empty text={t("label.noData")} />}</Card>
        </div>

        {/* ═══════════════════════════════════════════════════════════
            SECTION 10: TERRITORY RISK / OPPORTUNITY
        ═══════════════════════════════════════════════════════════ */}
        {(riskZones.length > 0 || oppZones.length > 0) && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={`⚠ ${t("dash.riskZones")}`}>
              {riskZones.map((p: any, i: number) => (
                <div key={i} className="flex items-center justify-between border-b border-slate-100 py-1.5 last:border-0 dark:border-slate-800 text-xs">
                  <span className={`font-medium ${tw.head}`}>{p.label}</span>
                  <div className="flex gap-3 tabular-nums"><span className={tw.sub}>Actual {fmt(p.actual)}</span><span className={`font-bold ${tw.red}`}>{pct(p.achPct)}</span></div>
                </div>
              ))}
              {riskZones.length === 0 && <Empty text={t("label.noData")} />}
            </Card>
            <Card title={`✦ ${t("dash.oppZones")}`}>
              {oppZones.map((p: any, i: number) => (
                <div key={i} className="flex items-center justify-between border-b border-slate-100 py-1.5 last:border-0 dark:border-slate-800 text-xs">
                  <span className={`font-medium ${tw.head}`}>{p.label}</span>
                  <div className="flex gap-3 tabular-nums"><span className={tw.sub}>Actual {fmt(p.actual)}</span><span className={`font-bold ${tw.green}`}>{pct(p.achPct)}</span></div>
                </div>
              ))}
              {oppZones.length === 0 && <Empty text={t("label.noData")} />}
            </Card>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════
            SECTION 11: TOP / BOTTOM CUSTOMERS
        ═══════════════════════════════════════════════════════════ */}
        {exec && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={`${t("dash.topCustomers")} (YTD)`}>
              <TBL heads={["#", t("label.customer"), t("label.actual"), "Orders"]}>{(exec.topCustomers || []).map((c: any, i: number) => (
                <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="px-2 py-1.5 text-xs text-slate-400">{i + 1}</td>
                  <td className="px-2 py-1.5 text-xs"><p className={`font-medium ${tw.head}`}>{c.name}</p><p className="text-[10px] text-slate-400">{c.code}</p></td>
                  <td className={`px-2 py-1.5 text-right text-xs font-bold tabular-nums ${tw.blue}`}>{fmt(c.revenue)}</td>
                  <td className="px-2 py-1.5 text-right text-xs tabular-nums text-slate-500">{c.orders}</td>
                </tr>
              ))}</TBL>
            </Card>
            <Card title={`${t("dash.bottomCustomers")} (${t("kpi.thisMonth")})`}>
              <TBL heads={["#", t("label.customer"), t("label.actual"), "Orders"]}>{(exec.bottomCustomers || []).map((c: any, i: number) => (
                <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="px-2 py-1.5 text-xs text-slate-400">{i + 1}</td>
                  <td className="px-2 py-1.5 text-xs"><p className={`font-medium ${tw.head}`}>{c.name}</p><p className="text-[10px] text-slate-400">{c.code}</p></td>
                  <td className={`px-2 py-1.5 text-right text-xs font-bold tabular-nums ${tw.red}`}>{fmt(c.revenue)}</td>
                  <td className="px-2 py-1.5 text-right text-xs tabular-nums text-slate-500">{c.orders}</td>
                </tr>
              ))}</TBL>
            </Card>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════
            SECTION 12: STOCK + AR AGING + ACTIONS
        ═══════════════════════════════════════════════════════════ */}
        <div className="grid gap-4 lg:grid-cols-3">
          {/* Stock */}
          <Card title={t("section.stock")}>
            <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
              <Mini label={t("label.qty")} value={compact(stock.total_qty)} />
              <Mini label={t("label.value")} value={compact(stock.total_value)} />
              <Mini label="Avg Cost" value={compact(stock.avg_cost)} />
              <Mini label="Warehouses" value={String(stock.warehouse_count || 0)} />
              <Mini label="Avg / Day" value={compact(stock.avg_sales_per_day)} />
            </div>
            <p className={`mb-1 text-[10px] font-semibold uppercase tracking-wider ${tw.sub}`}>{t("dash.byWarehouse")}</p>
            {(stock.by_warehouse || []).slice(0, 5).map((w: any, i: number) => (
              <div key={i} className="flex justify-between text-xs py-0.5"><span className={tw.sub}>{w.warehouse}</span><span className={`font-medium tabular-nums ${tw.head}`}>{fmt(w.value)}</span></div>
            ))}
            {(stock.by_group || []).length > 0 && <>
              <p className={`mt-2 mb-1 text-[10px] font-semibold uppercase tracking-wider ${tw.sub}`}>{t("dash.byGroup")}</p>
              {(stock.by_group || []).slice(0, 4).map((g: any, i: number) => (
                <div key={i} className="flex justify-between text-xs py-0.5"><span className={tw.sub}>{g.group_main_name}</span><span className={`font-medium tabular-nums ${tw.head}`}>{fmt(g.value)}</span></div>
              ))}
            </>}
          </Card>

          {/* AR Aging */}
          <Card title={t("dash.arAging")}>
            <p className={`text-2xl font-bold ${tw.head}`}>{fmt(arAging.total)}</p>
            <div className="mt-3 space-y-1.5">
              {(arAging.buckets || []).map((b: any, i: number) => {
                const maxB = Math.max(...(arAging.buckets || []).map((x: any) => Number(x.balance || 0)), 1);
                return (<div key={i}>
                  <div className="flex justify-between text-xs"><span className={tw.sub}>{b.overdue_group}</span><span className={`font-semibold tabular-nums ${tw.head}`}>{fmt(b.balance)}</span></div>
                  <div className="mt-0.5 h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800">
                    <div className={`h-full rounded-full transition-all duration-500 ${i < 2 ? "bg-emerald-500" : i < 4 ? "bg-amber-500" : "bg-rose-500"}`} style={{ width: `${(Number(b.balance || 0) / maxB) * 100}%` }} />
                  </div>
                </div>);
              })}
            </div>
            {(arAging.by_department || []).length > 0 && <>
              <p className={`mt-3 mb-1 text-[10px] font-semibold uppercase tracking-wider ${tw.sub}`}>{t("dash.byDept")}</p>
              {(arAging.by_department || []).slice(0, 4).map((d: any, i: number) => (
                <div key={i} className="flex justify-between text-xs py-0.5"><span className={tw.sub}>{d.department}</span><span className={`font-medium tabular-nums ${tw.head}`}>{fmt(d.balance)}</span></div>
              ))}
            </>}
          </Card>

          {/* Actions */}
          <Card title={`${t("dash.actionPlan")} (${actions.length})`}>
            <div className="space-y-2">{actions.map((a: any, i: number) => (
              <div key={i} className={`rounded-lg border-l-[3px] py-2 pl-3 pr-2 ${a.level === "high" ? "border-l-rose-500 bg-rose-50/50 dark:bg-rose-900/10" : a.level === "medium" ? "border-l-amber-500 bg-amber-50/50 dark:bg-amber-900/10" : "border-l-slate-300 bg-slate-50 dark:bg-slate-800/30"}`}>
                <p className={`text-xs font-semibold ${tw.head}`}>{a.title}</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{a.detail}</p>
              </div>
            ))}</div>
            {actions.length === 0 && <Empty text={t("label.noData")} />}
          </Card>
        </div>

        {/* ═══════════════════════════════════════════════════════════
            SECTION 13: BUSINESS ANALYTICS (from /api/dashboard/analytics)
        ═══════════════════════════════════════════════════════════ */}
        {analytics && (<>

          {/* MoM Growth + DSO + Concentration + AOV + Churn */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            <Kpi label="MoM Growth" value={`${Number(analytics.momGrowth?.growthPct || 0) >= 0 ? "+" : ""}${Number(analytics.momGrowth?.growthPct || 0).toFixed(1)}%`} sub={`${t("kpi.lastMonth")} ${fmt(analytics.momGrowth?.lastMonth)}`} ach={Number(analytics.momGrowth?.growthPct || 0) >= 0 ? 100 : 0} color={Number(analytics.momGrowth?.growthPct || 0) >= 0 ? "emerald" : "rose"} />
            <Kpi label="DSO (ມື້)" value={`${analytics.dso?.value || 0} ມື້`} sub={`AR ${fmt(analytics.dso?.arTotal)} ÷ ${fmt(analytics.dso?.dailyRevenue)}/ມື້`} ach={Number(analytics.dso?.value || 0) <= 45 ? 100 : 50} color={Number(analytics.dso?.value || 0) <= 45 ? "emerald" : "amber"} />
            <Kpi label="Top10 ລູກຄ້າ %" value={`${Number(analytics.concentration?.top10Pct || 0).toFixed(1)}%`} sub={`${fmt(analytics.concentration?.top10Revenue)} / ${fmt(analytics.concentration?.ytdTotal)}`} ach={Number(analytics.concentration?.top10Pct || 0) <= 50 ? 100 : 40} color={Number(analytics.concentration?.top10Pct || 0) <= 50 ? "emerald" : "rose"} />
            <Kpi label="AOV ເດືອນນີ້" value={fmt(analytics.aov?.thisMonth)} sub={`${t("kpi.lastMonth")} ${fmt(analytics.aov?.lastMonth)} (${Number(analytics.aov?.changePct || 0) >= 0 ? "+" : ""}${Number(analytics.aov?.changePct || 0).toFixed(1)}%)`} ach={Number(analytics.aov?.changePct || 0) >= 0 ? 100 : 50} color="blue" />
            <Kpi label="Retention Rate" value={`${Number(analytics.churn?.retentionRate || 0).toFixed(1)}%`} sub={`Churn ${analytics.churn?.churned || 0} / ໃໝ່ +${analytics.churn?.newAcquired || 0}`} ach={Number(analytics.churn?.retentionRate || 0) >= 80 ? 100 : 50} color={Number(analytics.churn?.retentionRate || 0) >= 80 ? "emerald" : "amber"} />
          </div>

          {/* Channel Profitability + New vs Return Revenue */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={t("dash.channelProfit")}>
              <div className="overflow-x-auto"><table className="w-full text-xs">
                <thead><tr className={tw.sub}>
                  <th className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider">Channel</th>
                  <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider">Revenue</th>
                  <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider">Profit</th>
                  <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider">Margin %</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {(analytics.channelProfit || []).map((ch: any, i: number) => (
                    <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className={`px-2 py-1.5 font-medium ${tw.head}`}>{ch.channel}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmt(ch.revenue)}</td>
                      <td className={`px-2 py-1.5 text-right tabular-nums font-semibold ${Number(ch.profit) >= 0 ? tw.green : tw.red}`}>{fmt(ch.profit)}</td>
                      <td className="px-2 py-1.5 text-right"><span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${Number(ch.marginPct) >= 20 ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400" : Number(ch.marginPct) >= 10 ? "bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400" : "bg-rose-50 text-rose-600 dark:bg-rose-900/20 dark:text-rose-400"}`}>{Number(ch.marginPct).toFixed(1)}%</span></td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </Card>

            <Card title={t("dash.newVsReturn")}>
              <div className="flex items-center gap-4">
                <ChartFrame className="h-32 w-32 shrink-0"><PieChart>
                  <Pie data={[{ name: "ເກົ່າ", value: Number(analytics.newVsReturn?.returningRevenue || 0) }, { name: "ໃໝ່", value: Number(analytics.newVsReturn?.newRevenue || 0) }]} dataKey="value" cx="50%" cy="50%" innerRadius={30} outerRadius={52} strokeWidth={0}>
                    <Cell fill={C.blue} /><Cell fill={C.emerald} />
                  </Pie>
                </PieChart></ChartFrame>
                <div className="flex-1 space-y-3">
                  <div>
                    <div className={`flex items-center gap-1.5 text-xs ${tw.sub}`}><span className="h-2 w-2 rounded-full bg-blue-500" />{t("dash.oldCust")} ({analytics.newVsReturn?.returningCustomers || 0} ຄົນ)</div>
                    <p className={`text-lg font-bold ${tw.blue}`}>{fmt(analytics.newVsReturn?.returningRevenue)}</p>
                    <p className="text-[10px] text-slate-400">{pct(analytics.newVsReturn?.returnPct)}</p>
                  </div>
                  <div>
                    <div className={`flex items-center gap-1.5 text-xs ${tw.sub}`}><span className="h-2 w-2 rounded-full bg-emerald-500" />{t("dash.newCust")} ({analytics.newVsReturn?.newCustomers || 0} ຄົນ)</div>
                    <p className={`text-lg font-bold ${tw.green}`}>{fmt(analytics.newVsReturn?.newRevenue)}</p>
                    <p className="text-[10px] text-slate-400">{pct(analytics.newVsReturn?.newPct)}</p>
                  </div>
                </div>
              </div>
            </Card>
          </div>

          {/* AOV Trend + Customer Churn Detail */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={t("dash.aovTrend")}>
              <ChartFrame className="h-48">
                <BarChart data={analytics.aovTrend || []} barSize={16}>
                  <CartesianGrid strokeDasharray="3 3" stroke={isDark ? "#1e293b" : "#f1f5f9"} />
                  <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(m: number) => ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m] || ""} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v: number) => compact(v)} />
                  <Tooltip content={<Tip />} />
                  <Bar dataKey="aov" name="AOV" fill={C.violet} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ChartFrame>
            </Card>

            <Card title={t("dash.retentionChurn")}>
              <div className="grid grid-cols-3 gap-3 mb-3">
                <Mini label="ລູກຄ້າເດືອນກ່ອນ" value={String(analytics.churn?.lastMonthCustomers || 0)} cls={tw.head} />
                <Mini label="ອອກ (Churned)" value={String(analytics.churn?.churned || 0)} cls={tw.red} />
                <Mini label="ເຂົ້າໃໝ່" value={`+${analytics.churn?.newAcquired || 0}`} cls={tw.green} />
              </div>
              {/* Retention bar */}
              <div>
                <div className="flex justify-between text-xs mb-1"><span className={tw.sub}>{t("dash.retentionRate")}</span><span className={`font-bold ${Number(analytics.churn?.retentionRate || 0) >= 80 ? tw.green : tw.red}`}>{pct(analytics.churn?.retentionRate)}</span></div>
                <div className="h-3 w-full rounded-full bg-slate-100 dark:bg-slate-800">
                  <div className={`h-full rounded-full transition-all duration-700 ${Number(analytics.churn?.retentionRate || 0) >= 80 ? "bg-emerald-500" : Number(analytics.churn?.retentionRate || 0) >= 60 ? "bg-amber-500" : "bg-rose-500"}`} style={{ width: `${Math.min(Number(analytics.churn?.retentionRate || 0), 100)}%` }} />
                </div>
              </div>
              <div className="mt-3">
                <div className="flex justify-between text-xs mb-1"><span className={tw.sub}>{t("dash.churnRate")}</span><span className={`font-bold ${tw.red}`}>{pct(analytics.churn?.churnRate)}</span></div>
                <div className="h-3 w-full rounded-full bg-slate-100 dark:bg-slate-800">
                  <div className="h-full rounded-full bg-rose-500 transition-all duration-700" style={{ width: `${Math.min(Number(analytics.churn?.churnRate || 0), 100)}%` }} />
                </div>
              </div>
            </Card>
          </div>

        </>)}
        {/* ═══════════════════════════════════════════════════════════
            SECTION 14: SALES MANAGER VIEW
        ═══════════════════════════════════════════════════════════ */}
        {managerInsights && (<>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi label="Team Avg Ach" value={pct(managerSummary.avgAchievement)} sub={`${managerSummary.teamCount || 0} sales reps • month`} ach={Number(managerSummary.avgAchievement || 0)} color={Number(managerSummary.avgAchievement || 0) >= 100 ? "emerald" : Number(managerSummary.avgAchievement || 0) >= 90 ? "blue" : "amber"} />
            <Kpi label="On Track Reps" value={String(managerSummary.onTrackReps || 0)} sub={`Risk ${managerSummary.riskReps || 0} ຄົນ • month`} ach={Number(managerSummary.teamCount || 0) > 0 ? (Number(managerSummary.onTrackReps || 0) / Number(managerSummary.teamCount || 1)) * 100 : 0} color="emerald" />
            <Kpi label="Avg Order Value" value={fmt(managerSummary.avgOrderValue)} sub={`Month Rev/Rep ${fmt(managerSummary.avgRevenuePerRep)}`} ach={100} color="violet" />
            <Kpi label="Active Customers" value={String(managerSummary.activeCustomers || 0)} sub="customer base ເດືອນນີ້" ach={100} color="blue" />
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <div className="xl:col-span-2">
              <Card title={t("dash.teamCapability")}>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-800">
                        {["Sales", "M Actual", "M Target", "M Ach", "YTD Ach", "Customers", "Orders", "AOV"].map((head) => (
                          <th key={head} className={`px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 ${head === "Sales" ? "text-left" : "text-right"}`}>{head}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {repPerformance.slice(0, 8).map((item: any, i: number) => (
                        <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                          <td className="px-2 py-2">
                            <p className={`text-xs font-semibold ${tw.head}`}>{item.saleName}</p>
                            <p className="text-[10px] text-slate-400">Month Gap {fmt(item.gap)}</p>
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">{fmt(item.actual)}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-slate-500">{fmt(item.target)}</td>
                          <td className="px-2 py-2 text-right"><TonePill label={pct(item.achPct)} tone={Number(item.achPct || 0) >= 100 ? "emerald" : Number(item.achPct || 0) >= 90 ? "blue" : "rose"} /></td>
                          <td className="px-2 py-2 text-right"><span className={`font-semibold ${Number(item.ytdAchPct || 0) >= 100 ? tw.green : Number(item.ytdAchPct || 0) >= 90 ? tw.amber : tw.red}`}>{pct(item.ytdAchPct)}</span></td>
                          <td className="px-2 py-2 text-right tabular-nums">{item.customers}</td>
                          <td className="px-2 py-2 text-right tabular-nums">{item.orders}</td>
                          <td className="px-2 py-2 text-right tabular-nums font-semibold">{fmt(item.avgOrderValue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>

            <Card title={t("dash.coachingFocus")}>
              <div className="space-y-3">
                <div>
                  <p className={`mb-2 text-[10px] font-semibold uppercase tracking-wider ${tw.sub}`}>{t("dash.needSupport")}</p>
                  <div className="space-y-2">
                    {needSupport.map((item: any, i: number) => (
                        <div key={i} className="rounded-lg border border-rose-100 bg-rose-50/60 p-3 dark:border-rose-900/30 dark:bg-rose-900/10">
                          <div className="flex items-center justify-between gap-3">
                            <p className={`text-sm font-semibold ${tw.head}`}>{item.saleName}</p>
                            <TonePill label={pct(item.achPct)} tone="rose" />
                          </div>
                        <p className="mt-1 text-[11px] text-slate-500">Month Gap {fmt(item.gap)} • Orders {item.orders} • AOV {fmt(item.avgOrderValue)}</p>
                        </div>
                      ))}
                    {needSupport.length === 0 && <Empty text={t("label.noData")} />}
                  </div>
                </div>
                <div>
                  <p className={`mb-2 text-[10px] font-semibold uppercase tracking-wider ${tw.sub}`}>{t("dash.topPerformers")}</p>
                  <div className="space-y-2">
                    {topPerformers.map((item: any, i: number) => (
                        <div key={i} className="rounded-lg border border-emerald-100 bg-emerald-50/60 p-3 dark:border-emerald-900/30 dark:bg-emerald-900/10">
                          <div className="flex items-center justify-between gap-3">
                            <p className={`text-sm font-semibold ${tw.head}`}>{item.saleName}</p>
                            <TonePill label={pct(item.achPct)} tone="emerald" />
                          </div>
                        <p className="mt-1 text-[11px] text-slate-500">Month Actual {fmt(item.actual)} • Customers {item.customers} • Orders {item.orders}</p>
                        </div>
                      ))}
                    {topPerformers.length === 0 && <Empty text={t("label.noData")} />}
                  </div>
                </div>
              </div>
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card title={t("dash.salesperson360")}>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-800">
                      {["Sales", "Revenue", "GP%", "Disc%", "Customers", "Orders", "AOV"].map((head) => (
                        <th key={head} className={`px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 ${head === "Sales" ? "text-left" : "text-right"}`}>{head}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {salesperson360.slice(0, 8).map((item: any, i: number) => (
                      <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="px-2 py-2">
                          <p className={`text-xs font-semibold ${tw.head}`}>{item.saleName}</p>
                          <p className="text-[10px] text-slate-400">Customer value {fmt(item.avgCustomerValue)}</p>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums font-semibold">{fmt(item.revenue)}</td>
                        <td className="px-2 py-2 text-right"><TonePill label={pct(item.marginPct)} tone={Number(item.marginPct || 0) >= 18 ? "emerald" : Number(item.marginPct || 0) >= 10 ? "amber" : "rose"} /></td>
                        <td className="px-2 py-2 text-right"><span className={`font-semibold ${Number(item.discountPct || 0) <= 3 ? tw.green : Number(item.discountPct || 0) <= 6 ? tw.amber : tw.red}`}>{pct(item.discountPct)}</span></td>
                        <td className="px-2 py-2 text-right tabular-nums">{item.customers}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{item.orders}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{fmt(item.avgOrderValue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {salesperson360.length === 0 && <Empty text={t("label.noData")} />}
            </Card>

            <Card title={t("dash.branchPerf")}>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-800">
                      {["Branch", "Revenue", "GP%", "Customers", "Orders", "AOV"].map((head) => (
                        <th key={head} className={`px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 ${head === "Branch" ? "text-left" : "text-right"}`}>{head}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {branchPerformance.slice(0, 8).map((item: any, i: number) => (
                      <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="px-2 py-2">
                          <p className={`text-xs font-semibold ${tw.head}`}>{item.branchName}</p>
                          <p className="text-[10px] text-slate-400">Profit {fmt(item.profit)}</p>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums font-semibold">{fmt(item.revenue)}</td>
                        <td className="px-2 py-2 text-right"><TonePill label={pct(item.marginPct)} tone={Number(item.marginPct || 0) >= 18 ? "emerald" : Number(item.marginPct || 0) >= 10 ? "amber" : "rose"} /></td>
                        <td className="px-2 py-2 text-right tabular-nums">{item.customers}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{item.orders}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{fmt(item.avgOrderValue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {branchPerformance.length === 0 && <Empty text={t("label.noData")} />}
            </Card>
          </div>

          <Card title={t("dash.heatmap")}>
            <div className="mb-3 flex flex-wrap gap-2">
              {peakWindows.map((item: any, i: number) => (
                <Pill key={i} label={`${item.day} ${item.hour}`} value={fmt(item.revenue)} accent="amber" />
              ))}
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-[820px] w-full text-xs">
                <thead>
                  <tr>
                    <th className="px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-400">Day</th>
                    {heatmapHours.map((hour: string) => (
                      <th key={hour} className="px-1 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">{hour}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {heatmapDays.map((day: string) => (
                    <tr key={day}>
                      <td className={`whitespace-nowrap px-2 py-1.5 font-semibold ${tw.head}`}>{day}</td>
                      {heatmapHours.map((hour: string) => {
                        const cell = heatmapMap.get(`${day}|${hour}`);
                        const revenue = Number(cell?.revenue || 0);
                        const orders = Number(cell?.orders || 0);
                        const opacity = heatmapMax > 0 ? Math.max(revenue / heatmapMax, 0.06) : 0.06;
                        return (
                          <td key={`${day}-${hour}`} className="p-1 align-top">
                            <div
                              className="min-w-[68px] rounded-lg px-2 py-2 text-center"
                              style={{ backgroundColor: `rgba(245,158,11,${opacity})`, color: opacity > 0.45 ? "#fff" : undefined }}
                            >
                              <p className="text-[11px] font-bold">{revenue > 0 ? compact(revenue) : "-"}</p>
                              <p className="text-[9px] opacity-80">{orders} ord</p>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {heatmapDays.length === 0 && <Empty text={t("label.noData")} />}
          </Card>

          <div className="grid gap-4 xl:grid-cols-4">
            <Card title={t("dash.custBuyingPower")}>
              <div className="grid grid-cols-2 gap-2">
                {customerSegments.map((item: any, i: number) => (
                  <div key={i} className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/40">
                    <div className="flex items-center justify-between gap-2">
                      <p className={`text-xs font-semibold ${tw.head}`}>{item.segment}</p>
                      <TonePill label={`${Number(item.sharePct || 0).toFixed(0)}%`} tone={item.segment === "VIP" ? "emerald" : item.segment === "Growth" ? "blue" : item.segment === "Core" ? "amber" : "rose"} />
                    </div>
                    <p className="mt-2 text-lg font-bold text-slate-900 dark:text-white">{item.customers}</p>
                    <p className="text-[10px] text-slate-400">Revenue {fmt(item.revenue)}</p>
                  </div>
                ))}
              </div>
              {customerSegments.length === 0 && <Empty text={t("label.noData")} />}
            </Card>

            <Card title={t("dash.topBuyers")}>
              <div className="space-y-2">
                {topBuyers.map((item: any, i: number) => (
                  <div key={i} className="rounded-lg border border-slate-100 p-3 dark:border-slate-800">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className={`truncate text-sm font-semibold ${tw.head}`}>{item.customerName}</p>
                        <p className="text-[10px] text-slate-400">{item.customerCode} • {item.orders} orders • {item.activeMonths} months</p>
                      </div>
                      <TonePill label={item.segment} tone={item.segment === "VIP" ? "emerald" : item.segment === "Growth" ? "blue" : item.segment === "Core" ? "amber" : "rose"} />
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs">
                      <span className={tw.sub}>Avg Basket {fmt(item.avgOrderValue)}</span>
                      <span className={`font-bold tabular-nums ${tw.blue}`}>{fmt(item.revenue)}</span>
                    </div>
                  </div>
                ))}
                {topBuyers.length === 0 && <Empty text={t("label.noData")} />}
              </div>
            </Card>

            <Card title={t("dash.growthOpp")}>
              <div className="space-y-2">
                {growthOpportunities.map((item: any, i: number) => (
                  <div key={i} className="rounded-lg border border-amber-100 bg-amber-50/60 p-3 dark:border-amber-900/30 dark:bg-amber-900/10">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className={`truncate text-sm font-semibold ${tw.head}`}>{item.customerName}</p>
                        <p className="text-[10px] text-slate-400">{item.segment} • Avg/Month {fmt(item.avgMonthlyRevenue)}</p>
                      </div>
                      <span className={`text-sm font-bold tabular-nums ${tw.amber}`}>{fmt(item.potentialGap)}</span>
                    </div>
                    <p className="mt-2 text-[11px] text-slate-500">Current month {fmt(item.currentMonthRevenue)} • follow-up ເພື່ອດຶງ spend ກັບຄືນ</p>
                  </div>
                ))}
                {growthOpportunities.length === 0 && <Empty text={t("label.noData")} />}
              </div>
            </Card>

            <Card title={t("dash.lineOa")}>
              <div className="grid grid-cols-2 gap-2">
                <Mini label="Registered" value={String(lineOa.registeredCustomers || 0)} cls={tw.green} />
                <Mini label="Unregistered" value={String(lineOa.unregisteredCustomers || 0)} cls={tw.red} />
                <Mini label="Revenue Share" value={`${Number(lineOa.registeredRevenuePct || 0).toFixed(1)}%`} cls={tw.blue} />
                <Mini label="Repeat Rate" value={`${Number(lineOa.repeatRateRegistered || 0).toFixed(1)}%`} cls={tw.amber} />
              </div>
              <div className="mt-3 space-y-2">
                <p className={`text-[10px] font-semibold uppercase tracking-wider ${tw.sub}`}>{t("dash.topUnregistered")}</p>
                {lineOaTop.map((item: any, i: number) => (
                  <div key={i} className="rounded-lg border border-slate-100 p-3 dark:border-slate-800">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className={`truncate text-sm font-semibold ${tw.head}`}>{item.customerName}</p>
                        <p className="text-[10px] text-slate-400">{item.segment} • Avg/Month {fmt(item.avgMonthlyRevenue)}</p>
                      </div>
                      <span className={`text-sm font-bold tabular-nums ${tw.red}`}>{fmt(item.revenue)}</span>
                    </div>
                  </div>
                ))}
                {lineOaTop.length === 0 && <Empty text={t("label.noData")} />}
              </div>
            </Card>
          </div>

          <Card title={t("dash.managerPlaybook")}>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {managerRecommendations.map((item: any, i: number) => (
                <div key={i} className={`rounded-xl border p-4 ${item.priority === "high" ? "border-rose-200 bg-rose-50/70 dark:border-rose-900/40 dark:bg-rose-900/10" : "border-blue-200 bg-blue-50/70 dark:border-blue-900/40 dark:bg-blue-900/10"}`}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className={`text-sm font-semibold ${tw.head}`}>{item.title}</p>
                    <TonePill label={item.priority === "high" ? "High" : "Medium"} tone={item.priority === "high" ? "rose" : "blue"} />
                  </div>
                  <p className="text-xs leading-relaxed text-slate-500">{item.detail}</p>
                </div>
              ))}
              {managerRecommendations.length === 0 && <Empty text={t("label.noData")} />}
            </div>
          </Card>
        </>)}

        {/* ═══════════════════════════════════════════════════════════
            SECTION 15: OWNER GROWTH PLAN
        ═══════════════════════════════════════════════════════════ */}
        {ownerInsights && (<>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi label="Growth Gap" value={fmt(ownerFocus.whitespaceGap)} sub={`${ownerFocus.opportunityProvinces || 0} ແຂວງຍັງຕ່ຳກວ່າເປົ້າ`} ach={Number(ownerFocus.whitespaceGap || 0) <= 0 ? 100 : 45} color={Number(ownerFocus.whitespaceGap || 0) <= 0 ? "emerald" : "amber"} />
            <Kpi label="Revenue At Risk" value={fmt(ownerFocus.lostRevenue)} sub={`${ownerFocus.lostCustomers || 0} ລູກຄ້າຢຸດຊື້ເດືອນນີ້`} ach={Number(ownerFocus.lostRevenue || 0) <= Number(ownerFocus.reactivatedRevenue || 0) ? 100 : 35} color={Number(ownerFocus.lostRevenue || 0) <= Number(ownerFocus.reactivatedRevenue || 0) ? "emerald" : "rose"} />
            <Kpi label="Reactivated Rev" value={fmt(ownerFocus.reactivatedRevenue)} sub={`${ownerFocus.reactivatedCustomers || 0} ລູກຄ້າກັບຄືນ`} ach={Number(ownerFocus.reactivatedRevenue || 0) > 0 ? 100 : 40} color="emerald" />
            <Kpi label="Best Channel" value={bestChannel ? `${Number(bestChannel.marginPct || 0).toFixed(1)}%` : "-"} sub={bestChannel ? `${bestChannel.channel} • share ${Number(bestChannel.sharePct || 0).toFixed(1)}%` : "-"} ach={Number(bestChannel?.marginPct || 0) >= 18 ? 100 : 60} color="blue" />
          </div>

          <div className="grid gap-4 xl:grid-cols-4">
            <Card title={t("dash.whitespace")}>
              <div className="space-y-3">
                {whitespaceProvinces.map((item: any, i: number) => (
                  <div key={i} className="rounded-lg border border-slate-100 p-3 dark:border-slate-800">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className={`truncate text-sm font-semibold ${tw.head}`}>{item.province}</p>
                        <p className="text-[10px] text-slate-400">Actual {fmt(item.actual)} / Target {fmt(item.target)}</p>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${Number(item.achPct || 0) >= 90 ? "bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400" : "bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400"}`}>{pct(item.achPct)}</span>
                    </div>
                    <div className="mt-2 h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800">
                      <div className="h-full rounded-full bg-gradient-to-r from-amber-500 to-rose-500" style={{ width: `${Math.min(Number(item.achPct || 0), 100)}%` }} />
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs">
                      <span className={tw.sub}>{t("dash.gapToClose")}</span>
                      <span className={`font-bold tabular-nums ${tw.red}`}>{fmt(item.gap)}</span>
                    </div>
                  </div>
                ))}
                {whitespaceProvinces.length === 0 && <Empty text={t("label.noData")} />}
              </div>
            </Card>

            <Card title={t("dash.lostCust")}>
              <div className="space-y-2">
                {lostCustomers.map((item: any, i: number) => (
                  <div key={i} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/40">
                    <div className="min-w-0">
                      <p className={`truncate text-sm font-semibold ${tw.head}`}>{item.customerName}</p>
                      <p className="text-[10px] text-slate-400">{item.customerCode} • {item.orders} orders ເດືອນກ່ອນ</p>
                    </div>
                    <span className={`shrink-0 text-sm font-bold tabular-nums ${tw.red}`}>{fmt(item.revenue)}</span>
                  </div>
                ))}
                {lostCustomers.length === 0 && <Empty text={t("label.noData")} />}
              </div>
            </Card>

            <Card title={t("dash.reactivatedCust")}>
              <div className="space-y-2">
                {reactivatedCustomers.map((item: any, i: number) => (
                  <div key={i} className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/40">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className={`truncate text-sm font-semibold ${tw.head}`}>{item.customerName}</p>
                        <p className="text-[10px] text-slate-400">{item.customerCode} • ຫາຍໄປ {item.idleMonths} ເດືອນ</p>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400`}>Return</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs">
                      <span className={tw.sub}>{item.orders} orders</span>
                      <span className={`font-bold tabular-nums ${tw.green}`}>{fmt(item.revenue)}</span>
                    </div>
                  </div>
                ))}
                {reactivatedCustomers.length === 0 && <Empty text={t("label.noData")} />}
              </div>
            </Card>

            <Card title={t("dash.channelStrategy")}>
              <div className="space-y-2">
                {channelStrategy.map((item: any, i: number) => (
                  <div key={i} className="rounded-lg border border-slate-100 p-3 dark:border-slate-800">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className={`truncate text-sm font-semibold ${tw.head}`}>{item.channel}</p>
                        <p className="text-[10px] text-slate-400">Revenue {fmt(item.revenue)} • Share {Number(item.sharePct || 0).toFixed(1)}%</p>
                      </div>
                      <TonePill label={item.strategy} tone={item.tone} />
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs">
                      <span className={tw.sub}>Profit {fmt(item.profit)}</span>
                      <span className={`font-bold tabular-nums ${Number(item.marginPct || 0) >= 18 ? tw.green : Number(item.marginPct || 0) >= 10 ? tw.amber : tw.red}`}>{Number(item.marginPct || 0).toFixed(1)}%</span>
                    </div>
                  </div>
                ))}
                {channelStrategy.length === 0 && <Empty text={t("label.noData")} />}
              </div>
            </Card>
          </div>

          <Card title={t("dash.ownerPlaybook")}>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {recommendations.map((item: any, i: number) => (
                <div key={i} className={`rounded-xl border p-4 ${item.priority === "high" ? "border-rose-200 bg-rose-50/70 dark:border-rose-900/40 dark:bg-rose-900/10" : "border-blue-200 bg-blue-50/70 dark:border-blue-900/40 dark:bg-blue-900/10"}`}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className={`text-sm font-semibold ${tw.head}`}>{item.title}</p>
                    <TonePill label={item.priority === "high" ? "High" : "Medium"} tone={item.priority === "high" ? "rose" : "blue"} />
                  </div>
                  <p className="text-xs leading-relaxed text-slate-500">{item.detail}</p>
                </div>
              ))}
              {recommendations.length === 0 && <Empty text={t("label.noData")} />}
            </div>
          </Card>
        </>)}

        </>)}

        {/* ══════════════════════════════════════════════════════════════
            TAB: LAST MONTH (ເດືອນກ່ອນ)
        ══════════════════════════════════════════════════════════════ */}
        {tab === "lastMonth" && (<>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label={`${prevTrend.name || "Prev"} ຍອດຂາຍ`} value={fmt(kpi.last_month_actual)} sub={`${t("kpi.target")} ${fmt(kpi.last_month_target)}`} ach={lastMonthAch} color="blue" />
            <Kpi label={`${prevTrend.name || "Prev"} ປີກ່ອນ`} value={fmt(prevMonthLYActual)} sub={`ທຽບ: ${prevMonthLYActual > 0 ? ((Number(kpi.last_month_actual || 0) / prevMonthLYActual - 1) * 100).toFixed(1) : "0"}%`} ach={Number(kpi.last_month_actual || 0) >= prevMonthLYActual ? 100 : 50} color={Number(kpi.last_month_actual || 0) >= prevMonthLYActual ? "emerald" : "rose"} />
            <Kpi label="Achievement" value={pct(lastMonthAch)} sub={`Gap ${fmt(Math.max(0, Number(kpi.last_month_target || 0) - Number(kpi.last_month_actual || 0)))}`} ach={lastMonthAch} color={lastMonthAch >= 100 ? "emerald" : "amber"} />
            <Kpi label="Cash / Credit" value={fmt(Number(kpi.last_month_cash || 0))} sub={`${t("momentum.credit")} ${fmt(Number(kpi.last_month_credit || 0))}`} ach={Number(kpi.last_month_cash || 0) >= Number(kpi.last_month_credit || 0) ? 100 : 60} color="cyan" />
          </div>

          {renderFocusSummary(lastMonthAch, lastMonthCash, lastMonthCredit, lastMonthQuality)}

          {/* Comparison table: Last month vs Same month last year */}
          <Card title={`${prevTrend.name || "ເດືອນກ່ອນ"} — ທຽບກັບເດືອນດຽວກັນປີກ່ອນ`}>
            <div className="overflow-x-auto"><table className="w-full text-xs">
              <thead><tr className={tw.sub}>
                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider">Metric</th>
                <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wider">{prevTrend.name} {Number(d.year)}</th>
                <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wider">{prevTrend.name} {Number(d.year) - 1}</th>
                <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wider">Change</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {[
                  { label: t("label.actual"), cur: Number(kpi.last_month_actual || 0), prev: prevMonthLYActual },
                  { label: t("kpi.target"), cur: Number(kpi.last_month_target || 0), prev: 0 },
                  { label: t("momentum.cash"), cur: Number(kpi.last_month_cash || 0), prev: 0 },
                  { label: t("momentum.credit"), cur: Number(kpi.last_month_credit || 0), prev: 0 },
                ].map((r, i) => {
                  const chg = r.prev > 0 ? ((r.cur / r.prev - 1) * 100) : 0;
                  return (
                    <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className={`px-3 py-2 font-medium ${tw.head}`}>{r.label}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900 dark:text-white">{fmt(r.cur)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${tw.sub}`}>{r.prev > 0 ? fmt(r.prev) : "–"}</td>
                      <td className={`px-3 py-2 text-right tabular-nums font-semibold ${chg >= 0 ? tw.green : tw.red}`}>{r.prev > 0 ? `${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%` : "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          </Card>

          {/* Trend chart highlighting last month */}
          <Card title={`ແນວໂນ້ມ — ${prevTrend.name || "ເດືອນກ່ອນ"} ທຽບປີກ່ອນ`}>
            <ChartFrame className="h-56">
              <BarChart data={trend.map((t: any, i: number) => ({ ...t, highlight: i === prevMonthIdx ? Number(t.actual || 0) : 0 }))} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke={isDark ? "#1e293b" : "#f1f5f9"} />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v: number) => compact(v)} />
                <Tooltip content={<Tip />} />
                <Bar dataKey="actual" name={`${d.year}`} fill="#cbd5e1" radius={[3, 3, 0, 0]} />
                <Bar dataKey="highlight" name={prevTrend.name || "Focus"} fill={C.blue} radius={[3, 3, 0, 0]} />
                <Bar dataKey="lastYear" name={`${Number(d.year) - 1}`} fill={C.amber} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ChartFrame>
          </Card>

          {renderRevenueMatrix(lastMonthMatrix)}

          {renderBuAndGroupSections(lastMonthBuProfit, lastMonthGroupProfit)}

          {renderProductCards(lastMonthTopRevenue, lastMonthTopMargin, `${t("dash.topRevProducts")} — ${prevTrend.name || t("kpi.lastMonth")}`, `${t("dash.topMarginProducts")} — ${prevTrend.name || t("kpi.lastMonth")}`)}

          {/* Team + Province for last month */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={`${t("section.team")} — ${prevTrend.name || "ເດືອນກ່ອນ"}`}>
              {lastMonthTeam.length > 0 ? lastMonthTeam.map((m: any, i: number) => <Rank key={i} i={i} label={m.name} value={fmt(m.actual)} ach={m.achPct} />) : <Empty text={t("label.noData")} />}
            </Card>
            <Card title={`${t("section.province")} — ${prevTrend.name || "ເດືອນກ່ອນ"}`}>
              {lastMonthProvinces.length > 0 ? lastMonthProvinces.map((p: any, i: number) => <Rank key={i} i={i} label={p.label} value={fmt(p.actual)} ach={p.achPct} />) : <Empty text={t("label.noData")} />}
            </Card>
          </div>

          {lastMonthTopCustomers.length > 0 && (
            <Card title={`${t("dash.topCustomers")} — ${prevTrend.name || t("kpi.lastMonth")}`}>
              <TBL heads={["#", t("label.customer"), t("label.actual"), "Orders"]}>{lastMonthTopCustomers.map((c: any, i: number) => (
                <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="px-2 py-1.5 text-xs text-slate-400">{i + 1}</td>
                  <td className="px-2 py-1.5 text-xs"><p className={`font-medium ${tw.head}`}>{c.name}</p><p className="text-[10px] text-slate-400">{c.code}</p></td>
                  <td className={`px-2 py-1.5 text-right text-xs font-bold tabular-nums ${tw.blue}`}>{fmt(c.revenue)}</td>
                  <td className="px-2 py-1.5 text-right text-xs tabular-nums text-slate-500">{c.orders}</td>
                </tr>
              ))}</TBL>
            </Card>
          )}

          {renderTerritoryCards(lastMonthRiskZones, lastMonthOppZones)}

          {renderStockArActions(lastMonthStock, lastMonthArAging, lastMonthActions)}
        </>)}

        {/* ══════════════════════════════════════════════════════════════
            TAB: THIS MONTH (ເດືອນປະຈຸບັນ)
        ══════════════════════════════════════════════════════════════ */}
        {tab === "thisMonth" && (<>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Kpi label={`${curTrend.name || "Now"} ຍອດຂາຍ`} value={fmt(kpi.this_month_actual)} sub={`${t("kpi.target")} ${fmt(kpi.this_month_target)}`} ach={thisMonthAch} color="blue" />
            <Kpi label={`${curTrend.name || "Now"} ປີກ່ອນ`} value={fmt(sameMonthLY)} sub={`ທຽບ: ${sameMonthLY > 0 ? ((Number(kpi.this_month_actual || 0) / sameMonthLY - 1) * 100).toFixed(1) : "0"}%`} ach={Number(kpi.this_month_actual || 0) >= sameMonthLY ? 100 : 50} color={Number(kpi.this_month_actual || 0) >= sameMonthLY ? "emerald" : "rose"} />
            <Kpi label="Achievement" value={pct(thisMonthAch)} sub={`Gap ${fmt(monthGap)}`} ach={thisMonthAch} color={thisMonthAch >= 100 ? "emerald" : "amber"} />
            <Kpi label={t("momentum.perDay")} value={fmt(data?.requiredPerDay)} sub={`${data?.daysLeft || 0} ${t("momentum.daysLeft")}`} ach={onTrack ? 100 : 40} color={onTrack ? "emerald" : "rose"} />
            <Kpi label="Cash / Credit" value={fmt(Number(kpi.this_month_cash || 0))} sub={`${t("momentum.credit")} ${fmt(Number(kpi.this_month_credit || 0))}`} ach={Number(kpi.this_month_cash || 0) >= Number(kpi.this_month_credit || 0) ? 100 : 60} color="cyan" />
          </div>

          {/* Momentum strip */}
          <div className={`${tw.card} flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4`}>
            <div className="flex items-center gap-2.5">
              <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${onTrack ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20" : "bg-amber-50 text-amber-600 dark:bg-amber-900/20"}`}>
                {onTrack ? <TrendingUp size={18} /> : <AlertTriangle size={18} />}
              </div>
              <div><p className={`text-sm font-semibold ${tw.head}`}>{onTrack ? t("momentum.onTrack") : t("momentum.behind")}</p><p className={`text-[11px] ${tw.sub}`}>{data?.daysLeft || 0} {t("momentum.daysLeft")}</p></div>
            </div>
            <Sep />
            {exec && <><Pill icon={<Zap size={11} />} label={t("momentum.today")} value={fmt(exec.today?.sales)} accent="blue" /><Sep /></>}
            <Pill label={t("momentum.gapMonth")} value={fmt(monthGap)} />
            <Pill label={t("momentum.perDay")} value={fmt(data?.requiredPerDay)} />
            <Sep />
            <Pill label={t("momentum.cash")} value={fmt(Number(kpi.this_month_cash || 0))} accent="emerald" />
            <Pill label={t("momentum.credit")} value={fmt(Number(kpi.this_month_credit || 0))} accent="amber" />
          </div>

          {renderFocusSummary(thisMonthAch, thisMonthCash, thisMonthCredit, thisMonthQuality)}

          {/* Comparison table: This month vs Same month last year */}
          <Card title={`${curTrend.name || "ເດືອນນີ້"} — ທຽບກັບເດືອນດຽວກັນປີກ່ອນ`}>
            <div className="overflow-x-auto"><table className="w-full text-xs">
              <thead><tr className={tw.sub}>
                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider">Metric</th>
                <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wider">{curTrend.name} {Number(d.year)}</th>
                <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wider">{curTrend.name} {Number(d.year) - 1}</th>
                <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wider">Change</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {[
                  { label: t("label.actual"), cur: Number(kpi.this_month_actual || 0), prev: sameMonthLY },
                  { label: t("kpi.target"), cur: Number(kpi.this_month_target || 0), prev: 0 },
                  { label: t("momentum.cash"), cur: Number(kpi.this_month_cash || 0), prev: 0 },
                  { label: t("momentum.credit"), cur: Number(kpi.this_month_credit || 0), prev: 0 },
                ].map((r, i) => {
                  const chg = r.prev > 0 ? ((r.cur / r.prev - 1) * 100) : 0;
                  return (
                    <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className={`px-3 py-2 font-medium ${tw.head}`}>{r.label}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900 dark:text-white">{fmt(r.cur)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${tw.sub}`}>{r.prev > 0 ? fmt(r.prev) : "–"}</td>
                      <td className={`px-3 py-2 text-right tabular-nums font-semibold ${chg >= 0 ? tw.green : tw.red}`}>{r.prev > 0 ? `${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%` : "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          </Card>

          {/* Daily trend if available */}
          {exec && (exec.dailyTrend || []).length > 0 && (
            <Card title={`${t("section.dailySales")} — ${curTrend.name || "ເດືອນນີ້"}`}>
              <ChartFrame className="h-48">
                <BarChart data={exec.dailyTrend} barSize={14}>
                  <CartesianGrid strokeDasharray="3 3" stroke={isDark ? "#1e293b" : "#f1f5f9"} />
                  <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v: string) => { const dt = new Date(v); return `${dt.getDate()}/${dt.getMonth()+1}`; }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v: number) => compact(v)} />
                  <Tooltip content={<Tip />} /><Bar dataKey="amount" name={t("label.actual")} fill={C.blue} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ChartFrame>
            </Card>
          )}

          {/* Trend chart highlighting this month */}
          <Card title={`ແນວໂນ້ມ — ${curTrend.name || "ເດືອນນີ້"} ທຽບປີກ່ອນ`}>
            <ChartFrame className="h-56">
              <BarChart data={trend.map((tr: any, i: number) => ({ ...tr, highlight: i === curMonthIdx ? Number(tr.actual || 0) : 0 }))} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke={isDark ? "#1e293b" : "#f1f5f9"} />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v: number) => compact(v)} />
                <Tooltip content={<Tip />} />
                <Bar dataKey="actual" name={`${d.year}`} fill="#cbd5e1" radius={[3, 3, 0, 0]} />
                <Bar dataKey="highlight" name={curTrend.name || "Focus"} fill={C.blue} radius={[3, 3, 0, 0]} />
                <Bar dataKey="lastYear" name={`${Number(d.year) - 1}`} fill={C.amber} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ChartFrame>
          </Card>

          {renderRevenueMatrix(thisMonthMatrix)}

          {renderBuAndGroupSections(thisMonthBuProfit, thisMonthGroupProfit)}

          {renderProductCards(thisMonthTopRevenue, thisMonthTopMargin, `${t("dash.topRevProducts")} — ${curTrend.name || t("kpi.thisMonth")}`, `${t("dash.topMarginProducts")} — ${curTrend.name || t("kpi.thisMonth")}`)}

          {/* Team + Province + Top customers */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={`${t("section.team")} — ${curTrend.name || "ເດືອນນີ້"}`}>
              {thisMonthTeam.length > 0 ? thisMonthTeam.map((m: any, i: number) => <Rank key={i} i={i} label={m.name} value={fmt(m.actual)} ach={m.achPct} />) : <Empty text={t("label.noData")} />}
            </Card>
            <Card title={`${t("section.province")} — ${curTrend.name || "ເດືອນນີ້"}`}>
              {thisMonthProvinces.length > 0 ? thisMonthProvinces.map((p: any, i: number) => <Rank key={i} i={i} label={p.label} value={fmt(p.actual)} ach={p.achPct} />) : <Empty text={t("label.noData")} />}
            </Card>
          </div>

          {/* Top 10 customers this month */}
          {thisMonthTopCustomers.length > 0 && (
            <Card title={`${t("dash.topCustomers")} — ${curTrend.name || t("kpi.thisMonth")}`}>
              <TBL heads={["#", t("label.customer"), t("label.actual"), "Orders"]}>{thisMonthTopCustomers.map((c: any, i: number) => (
                <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="px-2 py-1.5 text-xs text-slate-400">{i + 1}</td>
                  <td className="px-2 py-1.5 text-xs"><p className={`font-medium ${tw.head}`}>{c.name}</p><p className="text-[10px] text-slate-400">{c.code}</p></td>
                  <td className={`px-2 py-1.5 text-right text-xs font-bold tabular-nums ${tw.blue}`}>{fmt(c.revenue)}</td>
                  <td className="px-2 py-1.5 text-right text-xs tabular-nums text-slate-500">{c.orders}</td>
                </tr>
              ))}</TBL>
            </Card>
          )}

          {renderTerritoryCards(thisMonthRiskZones, thisMonthOppZones)}

          {renderStockArActions(thisMonthStock, thisMonthArAging, thisMonthActions)}
        </>)}

        <div className="pb-4" />
      </main>
    </div>
  );
}

/* ─── Inline Components ─── */

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (<div className={`${tw.card} min-h-0 min-w-0`}><div className="border-b border-slate-100 px-4 py-2.5 dark:border-slate-800"><h3 className={`text-xs font-bold uppercase tracking-wider ${tw.sub}`}>{title}</h3></div><div className="min-w-0 p-4">{children}</div></div>);
}

function Kpi({ label, value, sub, ach, color }: { label: string; value: string; sub: string; ach: number; color: string }) {
  const colors: Record<string, { text: string; bg: string }> = {
    blue: { text: "text-blue-600 dark:text-blue-400", bg: "from-blue-500 to-blue-600" },
    violet: { text: "text-violet-600 dark:text-violet-400", bg: "from-violet-500 to-violet-600" },
    emerald: { text: "text-emerald-600 dark:text-emerald-400", bg: "from-emerald-500 to-emerald-600" },
    rose: { text: "text-rose-600 dark:text-rose-400", bg: "from-rose-500 to-rose-600" },
    amber: { text: "text-amber-600 dark:text-amber-400", bg: "from-amber-500 to-amber-600" },
    cyan: { text: "text-cyan-600 dark:text-cyan-400", bg: "from-cyan-500 to-cyan-600" },
  };
  const c = colors[color] || colors.blue;
  const st = ach >= 100 ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" : ach >= 90 ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" : "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300";
  return (
    <div className={`group relative overflow-hidden ${tw.card} p-4 transition-shadow hover:shadow-md`}>
      <div className={`absolute -right-3 -top-3 h-16 w-16 rounded-full bg-gradient-to-br ${c.bg} opacity-[0.06] transition-transform group-hover:scale-150`} />
      <div className="relative">
        <div className="flex items-center justify-between"><span className={`text-[10px] font-semibold uppercase tracking-wider ${tw.sub}`}>{label}</span><span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${st}`}>{pct(ach)}</span></div>
        <p className={`mt-1.5 text-xl font-bold tracking-tight ${c.text}`}>{value}</p>
        <p className="mt-0.5 text-[10px] text-slate-400">{sub}</p>
        <div className="mt-2 h-1 w-full rounded-full bg-slate-100 dark:bg-slate-800"><div className={`h-full rounded-full bg-gradient-to-r ${c.bg} transition-all duration-700`} style={{ width: `${Math.min(Math.abs(ach), 100)}%` }} /></div>
      </div>
    </div>
  );
}

function Progress({ label, v }: { label: string; v: number }) {
  const c = v >= 100 ? "bg-emerald-500" : v >= 90 ? "bg-blue-500" : v >= 80 ? "bg-amber-500" : "bg-rose-500";
  return (<div className="mb-2.5"><div className="flex justify-between text-xs"><span className={tw.sub}>{label}</span><span className={`font-bold ${tw.head}`}>{v.toFixed(1)}%</span></div><div className="mt-1 h-2 w-full rounded-full bg-slate-100 dark:bg-slate-800"><div className={`h-full rounded-full ${c} transition-all duration-500`} style={{ width: `${Math.min(v, 100)}%` }} /></div></div>);
}

function Rank({ i, label, value, ach }: { i: number; label: string; value: string; ach: number }) {
  const badge = ach >= 100 ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400" : ach >= 80 ? "bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400" : "bg-rose-50 text-rose-600 dark:bg-rose-900/20 dark:text-rose-400";
  return (
    <div className="flex items-center gap-3 py-1">
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold ${i === 0 ? "bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400" : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"}`}>{i < 3 ? ["🥇","🥈","🥉"][i] : i + 1}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between">
          <span className={`truncate text-sm font-medium ${tw.head}`}>{label}</span>
          <div className="ml-2 flex items-center gap-2"><span className="text-xs tabular-nums text-slate-500">{value}</span><span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${badge}`}>{pct(ach)}</span></div>
        </div>
        <div className="mt-1 h-1 w-full rounded-full bg-slate-100 dark:bg-slate-800"><div className={`h-full rounded-full transition-all duration-700 ${ach >= 100 ? "bg-emerald-500" : ach >= 80 ? "bg-blue-500" : "bg-rose-400"}`} style={{ width: `${Math.min(ach, 100)}%` }} /></div>
      </div>
    </div>
  );
}

function Mini({ label, value, cls = "" }: { label: string; value: string; cls?: string }) {
  return (<div className="rounded-lg bg-slate-50 p-2.5 dark:bg-slate-800/40"><p className="text-[10px] text-slate-400">{label}</p><p className={`mt-0.5 text-sm font-bold ${cls || tw.head}`}>{value}</p></div>);
}

function Pill({ label, value, accent, icon }: { label: string; value: string; accent?: string; icon?: React.ReactNode }) {
  const cls = accent === "emerald" ? tw.green : accent === "amber" ? tw.amber : accent === "blue" ? tw.blue : accent === "red" ? tw.red : tw.head;
  return (<div className="flex items-center gap-1 text-xs">{icon && <span className="text-slate-400">{icon}</span>}<span className={tw.sub}>{label}</span><span className={`ml-0.5 font-semibold ${cls}`}>{value}</span></div>);
}

function Sep() { return <div className="hidden h-6 w-px bg-slate-200 dark:bg-slate-800 sm:block" />; }

function Empty({ text = "No data" }: { text?: string }) { return <p className="py-4 text-center text-xs text-slate-400">{text}</p>; }

function TBL({ heads, children }: { heads: string[]; children: React.ReactNode }) {
  return (<table className="w-full text-xs"><thead><tr className="bg-slate-50 dark:bg-slate-800">{heads.map((h, i) => <th key={i} className={`px-2 py-1.5 ${i < 2 ? "text-left" : "text-right"} text-[10px] font-semibold uppercase tracking-wider text-slate-400`}>{h}</th>)}</tr></thead><tbody className="divide-y divide-slate-100 dark:divide-slate-800">{children}</tbody></table>);
}

function TonePill({ label, tone = "blue" }: { label: string; tone?: string }) {
  const cls =
    tone === "emerald"
      ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400"
      : tone === "rose"
        ? "bg-rose-50 text-rose-600 dark:bg-rose-900/20 dark:text-rose-400"
        : tone === "amber"
          ? "bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400"
          : "bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400";
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${cls}`}>{label}</span>;
}
