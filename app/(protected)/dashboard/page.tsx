/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState, useEffect, useRef, cloneElement, isValidElement } from "react";
import Link from "next/link";
import {
  Loader2, AlertCircle, RefreshCw, Sun, Moon, Filter,
  Clock, Zap, AlertTriangle, TrendingUp, RotateCcw, X, ArrowUpRight, ClipboardCheck,
  Target, BarChart3, ChevronRight, LayoutDashboard, DollarSign, Database,
  Printer, Bell, Monitor, Download, MoreVertical,
} from "lucide-react";
import api from "@/service/api";
import {
  AreaChart, Area, XAxis, YAxis,
  Tooltip, CartesianGrid, BarChart, Bar, PieChart, Pie, Cell,
} from "recharts";
import { useDashboard, currency, readSessionCache, writeSessionCache } from "@/hooks/useDashboard";
import { useTheme } from "@/context/ThemeContext";
import { useLanguage } from "@/context/LanguageContext";
import SaleSyncBadge from "@/components/SaleSyncBadge";
import { fmtDate, fmtDayMonth } from "@/components/ui";
import { downloadCsv } from "@/lib/csv";

/* ── Chart colors ── */
const C = { blue: "#2b70b5", emerald: "#17876d", amber: "#f5911f", rose: "#d0453f", violet: "#003361", cyan: "#4ac7f0", slate: "#8ba6bd" };
const PIE = ["#2b70b5", "#f5911f", "#4ac7f0", "#ffd170", "#003361", "#71b6dc", "#e5a353", "#8dd8f3"];
const SIDECAR_TTL = 300_000;
/** Recharts default animations are heavy on large dashboards; disable for snappier UI. */
const CHART_NO_ANIM = { isAnimationActive: false as const };

/* ── Theme classes ── */
const tw = {
  blue: "text-[var(--brand)]",
  green: "text-[var(--pos)]",
  amber: "text-[var(--warn)]",
  red: "text-[var(--neg)]",
  head: "text-[var(--ink)]",
  sub: "text-[var(--muted)]",
  card: "card",
};

/* ── Helpers ── */
const fmt = (v: any) => currency(v);
const pct = (v: any) => `${Number(v || 0).toFixed(1)}%`;
const compact = (v: any) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(v || 0));

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
  const [execFailed, setExecFailed] = useState(false);
  const [analytics, setAnalytics] = useState<any>(null);
  const [managerInsights, setManagerInsights] = useState<any>(null);
  const [ownerInsights, setOwnerInsights] = useState<any>(null);
  const [approvalSummary, setApprovalSummary] = useState<any>(null);
  const [buTargets, setBuTargets] = useState<any>(null);
  const [dataSync, setDataSync] = useState<any>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  /** Lightning condenses its page header once you scroll past it. */
  const [condensed, setCondensed] = useState(false);
  const [tvMode, setTvMode] = useState(false);
  const [thisMonthSnapshot, setThisMonthSnapshot] = useState<any>(null);
  const [lastMonthSnapshot, setLastMonthSnapshot] = useState<any>(null);
  const overviewKeyRef = useRef("");
  const overviewInsightsKeyRef = useRef("");
  const thisMonthSnapshotKeyRef = useRef("");
  const lastMonthSnapshotKeyRef = useRef("");
  const font = { fontFamily: '"Noto Sans Lao","Noto Sans",system-ui,sans-serif' };

  useEffect(() => {
    const onScroll = () => setCondensed(window.scrollY > 140);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const activeFilters = [
    d.bu !== "ALL" ? { key: "bu", label: `${t("filter.bu")}: ${d.buNameMap?.[d.bu] || d.bu}`, clear: () => d.setBu("ALL") } : null,
    !d.channel.includes("ALL") ? { key: "channel", label: `${t("filter.channel")}: ${d.channel.join(", ")}`, clear: () => d.setChannel(["ALL"]) } : null,
    !d.province.includes("ALL") ? { key: "province", label: `${t("filter.province")}: ${d.province.join(", ")}`, clear: () => d.setProvince(["ALL"]) } : null,
  ].filter(Boolean) as Array<{ key: string; label: string; clear: () => void }>;

  useEffect(() => {
    let cancelled = false;
    api.get("/dashboard/approval-summary")
      .then((response) => {
        if (!cancelled && response.data?.success) setApprovalSummary(response.data);
      })
      .catch(() => {
        if (!cancelled) setApprovalSummary({ failed: true });
      });
    api.get("/targets-by-bu", { params: { year: d.year } })
      .then((response) => {
        if (!cancelled && response.data?.success) setBuTargets(response.data.data);
      })
      .catch(() => {});
    api.get("/system/data-sync")
      .then((response) => {
        if (!cancelled && response.data?.success) setDataSync(response.data.data);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [d.year]);

  /* Auto-refresh every 5 minutes (for TV / meeting screens) */
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => d.load(), 5 * 60 * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh]);

  /* Presentation / TV mode: hide chrome, zoom up, go fullscreen. ESC exits. */
  useEffect(() => {
    document.body.classList.toggle("tv-mode", tvMode);
    if (tvMode) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    }
  }, [tvMode]);

  useEffect(() => {
    if (!tvMode) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setTvMode(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tvMode]);

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
          setExecFailed(false);
        } else {
          // Without this the tiles that wait on /executive keep a skeleton for
          // ever. Let the next filter change retry rather than pretend.
          setExecFailed(true);
          overviewKeyRef.current = "";
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
    <div style={font} className="flex min-h-screen items-center justify-center bg-[var(--surface-2)]">
      <div className="text-center"><Loader2 className="mx-auto h-8 w-8 animate-spin text-[var(--brand)]" /><p className="mt-3 text-sm text-[var(--muted)]">{t("app.loading")}</p></div>
    </div>
  );
  if (error && !data) return (
    <div style={font} className="flex min-h-screen items-center justify-center bg-[var(--surface-2)] p-4">
      <div className="w-full max-w-sm rounded-[var(--r-md)] border bg-[var(--surface)] p-6 text-center shadow">
        <AlertCircle className="mx-auto mb-3 h-8 w-8 text-[var(--neg)]" /><p className="font-semibold text-[var(--ink)]">{t("app.error")}</p><p className="mt-1 text-sm text-[var(--muted)]">{error}</p>
        <button onClick={() => window.location.reload()} className="mt-4 w-full rounded-lg bg-[var(--brand-deep)] px-4 py-2 text-sm font-medium text-white hover:brightness-110">{t("app.retry")}</button>
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
  /** Positive = short of the full-year plan, negative = forecast beats it. */
  const eoyGap = Number(data?.eoyGap || 0);
  /** Years with no rows in odg_sales_target cannot be judged against a plan. */
  const hasYtdTarget = Number(kpi.ytd_target || 0) > 0;
  const gpPct = Number(exec?.grossProfit?.gpPct || 0);
  const collectionRate = Number(exec?.collection?.rate || 0);
  const momGrowthPct = Number(analytics?.momGrowth?.growthPct || 0);
  const top10Pct = Number(analytics?.concentration?.top10Pct || 0);
  const retentionRate = Number(analytics?.churn?.retentionRate || 0);
  /** Direction badge for a change that is already a percentage. */
  const trendBadge = (change: number) =>
    ({ text: t(change >= 0 ? "kpi.up" : "kpi.down"), tone: change >= 0 ? ("pos" as const) : ("neg" as const) });
  /** Pass/watch badge for a figure judged against a threshold, not a target. */
  const thresholdBadge = (ok: boolean) =>
    ({ text: t(ok ? "kpi.good" : "kpi.watch"), tone: ok ? ("pos" as const) : ("warn" as const) });
  /**
   * The figures behind the overview as one long-format sheet — section, label,
   * value — so the same file works whatever mix of tables is on screen.
   */
  const exportCsv = () => {
    const rows: (string | number)[][] = [];
    const push = (section: string, label: string, value: string | number) => rows.push([section, label, value]);

    const kpiSection = t("dash.csvKpi");
    push(kpiSection, t("kpi.ytd"), Math.round(Number(kpi.ytd_actual || 0)));
    push(kpiSection, t("kpi.target"), Math.round(Number(kpi.ytd_target || 0)));
    push(kpiSection, t("dash.achievement"), ytdAch.toFixed(1));
    push(kpiSection, t("kpi.lastYear"), Math.round(Number(kpi.ytd_last_year || 0)));
    push(kpiSection, "YoY %", yoy.toFixed(1));
    push(kpiSection, "Forecast EOY", Math.round(Number(data?.forecastEOY || 0)));
    push(kpiSection, "GP %", gpPct.toFixed(1));
    push(kpiSection, t("kpi.collection"), collectionRate.toFixed(1));
    push(kpiSection, t("kpi.thisMonth"), Math.round(Number(kpi.this_month_actual || 0)));
    push(kpiSection, t("momentum.cash"), Math.round(cashVal));
    push(kpiSection, t("momentum.credit"), Math.round(creditVal));

    const trendSection = t("section.revenueTrend");
    for (const row of trend as any[]) {
      push(trendSection, `${row.name} ${t("label.actual")}`, Math.round(Number(row.actual || 0)));
      push(trendSection, `${row.name} ${t("kpi.target")}`, Math.round(Number(row.target || 0)));
      push(trendSection, `${row.name} ${t("kpi.lastYear")}`, Math.round(Number(row.lastYear || 0)));
    }

    const matrixSection = t("dash.revenueMatrix");
    pivot.forEach((channels: Map<string, number>, buCode: string) => {
      channels.forEach((amount: number, channelCode: string) =>
        push(matrixSection, `${buCode} × ${channelCode}`, Math.round(Number(amount || 0))),
      );
    });

    downloadCsv(
      `dashboard-${d.year}`,
      [t("dash.csvSection"), t("dash.csvLabel"), `${t("dash.csvValue")} (THB)`],
      rows,
    );
  };
  const monthGap = Number(data?.gapThisMonth || 0);
  const onTrack = monthGap <= 0;

  /* ══ Executive alert center — aggregated "needs attention" items ══ */
  const overdueAr = (arAging.buckets || []).reduce(
    (s: number, b: any) => s + (String(b.overdue_group || "").trim().toLowerCase() === "ondue" ? 0 : Number(b.balance || 0)),
    0,
  );
  const execAlerts: Array<{ level: "high" | "warn"; icon: any; title: string; detail: string; to?: string }> = [];
  if (monthGap > 0 && Number(data?.daysLeft || 0) > 0) {
    execAlerts.push({
      level: "high", icon: Target,
      title: `${t("dash.monthGap")} ${fmt(monthGap)}`,
      detail: `${t("dash.requiredPerDay")} ${fmt(data?.requiredPerDay)} ${t("dash.perDay")} • ${data?.daysLeft} ${t("momentum.daysLeft")}`,
      to: "sec-target",
    });
  }
  if (overdueAr > 0) {
    execAlerts.push({
      level: overdueAr >= Number(arAging.total || 0) * 0.4 ? "high" : "warn", icon: AlertTriangle,
      title: `${t("dash.arOverdue")} ${fmt(overdueAr)}`,
      detail: `${t("dash.arAging")}: ${fmt(arAging.total)}`,
      to: "sec-finance",
    });
  }
  if (Number(approvalSummary?.totalPending || 0) > 0) {
    execAlerts.push({
      level: Number(approvalSummary?.totalOverdue || 0) > 0 ? "high" : "warn", icon: ClipboardCheck,
      title: `${t("dash.pendingDocs")}: ${approvalSummary?.totalPending}`,
      detail: `${t("dash.overdueSla")} ${approvalSummary?.totalOverdue ?? 0}`,
      to: "/approvals/po",
    });
  }
  if ((stock.low_stock || []).length > 0) {
    execAlerts.push({
      level: "warn", icon: Database,
      title: `${t("dash.lowStock")}: ${(stock.low_stock || []).length}`,
      detail: (stock.low_stock || []).slice(0, 2).map((s: any) => s.item_name).join(", "),
      to: "sec-finance",
    });
  }

  /* ══ One-line executive summary built from the live KPI numbers ══ */
  /**
   * A BU's display name. A few sale lines carry no bu_code — a free-gift line,
   * a credit note nobody filed — and the raw fallback printed the string "null"
   * as a business unit on an executive dashboard.
   */
  const buLabel = (code: any) => {
    const key = String(code ?? "").trim();
    if (!key || key === "-" || key === "null" || key === "undefined") return t("dash.buUnassigned");
    return d.buNameMap?.[key] || key;
  };

  const orderCount = Number(data?.counts?.orders || 0);
  const avgDealValue = Number(data?.diagnose?.conversion?.avgDeal || 0)
    || (orderCount > 0 ? Number(kpi.ytd_actual || 0) / orderCount : 0);
  const secNav = [
    { id: "sec-kpi", label: t("dash.navKpi") },
    { id: "sec-target", label: t("dash.navTarget") },
    { id: "sec-trend", label: t("dash.navTrend") },
    { id: "sec-products", label: t("dash.navProducts") },
    { id: "sec-team", label: t("dash.navTeam") },
    { id: "sec-finance", label: t("dash.navFinance") },
    { id: "sec-insights", label: t("dash.navInsights") },
    { id: "sec-health", label: t("dash.navHealth") },
  ];
  const sync = dataSync;
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
  const buPie = buProfit.slice(0, 6).map((b: any) => ({ name: buLabel(b.bu), value: Math.max(Number(b.revenue || 0), 0) }));
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
        <Card title={t("section.achievement")} icon={<Target size={13} />} to="/month-summary" toLabel={t("dash.viewReport")}>
          <div className="flex flex-col items-center">
            <Gauge value={ach} label={t("dash.achievement")} />
          </div>
          <div className="mt-2">
            <Progress label={t("dash.cashShare")} v={totalPayment > 0 ? (cash / totalPayment) * 100 : 0} />
            <Progress label={t("label.repeatCustomer")} v={Number(qualityData.repeatPct || 0)} />
          </div>
        </Card>
        <Card title={t("section.payment")}>
          <div className="flex items-center gap-5">
            <div className="relative h-36 w-36 shrink-0">
              <ChartFrame className="h-36 w-36"><PieChart><Pie {...CHART_NO_ANIM} data={totalPayment > 0 ? [{ name: "Cash", value: cash }, { name: "Credit", value: credit }] : [{ name: "No data", value: 1 }]} dataKey="value" cx="50%" cy="50%" innerRadius={38} outerRadius={61} startAngle={90} endAngle={-270} strokeWidth={0}>{totalPayment > 0 ? [<Cell key="cash" fill={C.blue} />, <Cell key="credit" fill={C.amber} />] : <Cell fill="#c3d2e0" />}</Pie></PieChart></ChartFrame>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"><span className="text-[9px] font-semibold uppercase tracking-wider text-[var(--muted)]">Total</span><span className="mt-0.5 text-xs font-bold text-[var(--ink)]">{compact(totalPayment)}</span></div>
            </div>
            <div className="min-w-0 flex-1 space-y-4">
              <div><div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-[#4ac7f0]" /><p className={`text-xs ${tw.sub}`}>{t("dash.cash")}</p></div><p className="mt-1 text-lg font-bold text-[#2b70b5] dark:text-[#4ac7f0]">{fmt(cash)}</p></div>
              <div><div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-[#f5911f]" /><p className={`text-xs ${tw.sub}`}>{t("dash.credit")}</p></div><p className="mt-1 text-lg font-bold text-[#f5911f]">{fmt(credit)}</p></div>
            </div>
          </div>
        </Card>
        <Card title={t("dash.custQuality")}>
          <div className="grid grid-cols-2 gap-2">
            <Mini label={t("label.repeatCustomer")} value={pct(qualityData.repeatPct)} cls={tw.green} />
            <Mini label={t("label.singlePurchase")} value={pct(qualityData.singlePurchasePct)} cls={tw.blue} />
            <Mini label="Reactive (2M+)" value={String(qualityData.reactiveCustomers || 0)} cls="text-[var(--brand)]" />
          </div>
        </Card>
      </div>
    );
  };

  const renderRevenueMatrix = (matrix: any) => {
    if (!matrix.buList.length || !matrix.channelList.length) return null;
    return (
      <Card title={t("dash.revenueMatrix")} icon={<BarChart3 size={13} />} to="/sales-summary" toLabel={t("dash.viewReport")}>
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
              <tr key={b} className="hover:bg-[var(--surface-2)]">
                <td className={`whitespace-nowrap px-2 py-1.5 font-medium ${tw.head}`}>{buLabel(b)}</td>
                {matrix.channelList.map((ch: string) => {
                  const v = rm.get(ch) || 0;
                  const op = matrix.heatMax > 0 ? Math.max((v / matrix.heatMax) * 0.85, 0.04) : 0.04;
                  return (
                    <td key={ch} className="p-0.5 text-center">
                      <div className="rounded-lg px-2 py-1.5 tabular-nums font-medium" style={{ backgroundColor: `rgba(22,119,90,${op})`, color: op > 0.45 ? "#fff" : undefined }}>
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
    const localBuPie = buProfitRows.slice(0, 6).map((b: any) => ({ name: buLabel(b.bu), value: Math.max(Number(b.revenue || 0), 0) }));
    const localGpPie = groupRows.slice(0, 6).map((g: any) => ({ name: g.group, value: Math.max(Number(g.revenue || 0), 0) }));

    return (
      <>
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title={t("section.buRevenue")}>
            <ChartFrame className="h-44"><PieChart><Pie {...CHART_NO_ANIM} data={localBuPie} dataKey="value" cx="50%" cy="50%" outerRadius={65} strokeWidth={1} stroke={isDark ? "#1e293b" : "#fff"} label={({ name, percent }: any) => `${name} ${(percent*100).toFixed(0)}%`} labelLine={false} fontSize={10}>
              {localBuPie.map((_: any, i: number) => <Cell key={i} fill={PIE[i % PIE.length]} />)}
            </Pie></PieChart></ChartFrame>
          </Card>
          <Card title={t("section.groupProfit")}>
            <ChartFrame className="h-44"><PieChart><Pie {...CHART_NO_ANIM} data={localGpPie} dataKey="value" cx="50%" cy="50%" outerRadius={65} strokeWidth={1} stroke={isDark ? "#1e293b" : "#fff"} label={({ name, percent }: any) => `${(name||"").slice(0,8)} ${(percent*100).toFixed(0)}%`} labelLine={false} fontSize={10}>
              {localGpPie.map((_: any, i: number) => <Cell key={i} fill={PIE[i % PIE.length]} />)}
            </Pie></PieChart></ChartFrame>
          </Card>
          <Card title={t("dash.buProfit")}>
            <div className="space-y-1.5">{buProfitRows.slice(0, 6).map((b: any, i: number) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className={`font-medium ${tw.head}`}>{buLabel(b.bu)}</span>
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
                  <p className={`text-xs font-semibold ${tw.head}`}>{buLabel(b.bu)}</p>
                  <div className="mt-1.5 overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead><tr className={tw.sub}>
                        <th className="pb-1 pr-3 text-left font-medium">Brand</th>
                        <th className="pb-1 px-2 text-right font-medium">Revenue</th>
                        <th className="pb-1 px-2 text-right font-medium">Cost</th>
                        <th className="pb-1 pl-2 text-right font-medium">Profit</th>
                      </tr></thead>
                      <tbody className="divide-y divide-[var(--line-soft)] dark:divide-slate-800">
                        {b.brands.slice(0, 8).map((br: any, bri: number) => (
                          <tr key={bri} className="hover:bg-[var(--surface-2)]">
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
      <Card title={revenueTitle} to="/products" toLabel={t("dash.viewReport")}>
        {topRevenueRows.map((p: any, i: number) => (
          <div key={i} className="flex items-center justify-between border-b border-[var(--line-soft)] py-2 last:border-0">
            <div className="min-w-0 flex-1"><p className={`truncate text-xs font-medium ${tw.head}`}>{p.name || p.code}</p><p className="text-[10px] text-[var(--muted)]">{p.code}</p></div>
            <span className={`ml-3 text-xs font-bold tabular-nums ${tw.blue}`}>{fmt(p.revenue)}</span>
          </div>
        ))}
        {topRevenueRows.length === 0 && <Empty text={t("label.noData")} />}
      </Card>
      <Card title={marginTitle} to="/products" toLabel={t("dash.viewReport")}>
        {topMarginRows.map((p: any, i: number) => (
          <div key={i} className="flex items-center justify-between border-b border-[var(--line-soft)] py-2 last:border-0">
            <div className="min-w-0 flex-1"><p className={`truncate text-xs font-medium ${tw.head}`}>{p.name || p.code}</p><p className="text-[10px] text-[var(--muted)]">GP {(Number(p.gp || 0) * 100).toFixed(1)}%</p></div>
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
            <div key={i} className="flex items-center justify-between border-b border-[var(--line-soft)] py-1.5 text-xs last:border-0">
              <span className={`font-medium ${tw.head}`}>{p.label}</span>
              <div className="flex gap-3 tabular-nums"><span className={tw.sub}>Actual {fmt(p.actual)}</span><span className={`font-bold ${tw.red}`}>{pct(p.achPct)}</span></div>
            </div>
          ))}
          {risk.length === 0 && <Empty text={t("label.noData")} />}
        </Card>
        <Card title={`✦ ${t("dash.oppZones")}`}>
          {opp.map((p: any, i: number) => (
            <div key={i} className="flex items-center justify-between border-b border-[var(--line-soft)] py-1.5 text-xs last:border-0">
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

      <Card title={t("dash.arAging")} icon={<DollarSign size={13} />} to="/receivables" toLabel={t("dash.viewReport")}>
        <p className={`text-2xl font-bold ${tw.head}`}>{fmt(arData.total)}</p>
        <div className="mt-3 space-y-1.5">
          {(arData.buckets || []).map((b: any, i: number) => {
            const maxB = Math.max(...(arData.buckets || []).map((x: any) => Number(x.balance || 0)), 1);
            return (
              <div key={i}>
                <div className="flex justify-between text-xs"><span className={tw.sub}>{b.overdue_group}</span><span className={`font-semibold tabular-nums ${tw.head}`}>{fmt(b.balance)}</span></div>
                <div className="mt-0.5 h-1.5 w-full rounded-full bg-[var(--surface-2)]">
                  <div className={`h-full rounded-full transition-all duration-500 ${i < 2 ? "bg-[var(--pos)]" : i < 4 ? "bg-[var(--warn)]" : "bg-[var(--neg)]"}`} style={{ width: `${(Number(b.balance || 0) / maxB) * 100}%` }} />
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
          <div key={i} className={`rounded-lg border-l-[3px] py-2 pl-3 pr-2 ${a.level === "high" ? "border-l-rose-500 bg-[var(--neg-bg)]/50 dark:bg-rose-900/10" : a.level === "medium" ? "border-l-amber-500 bg-[var(--warn-bg)]/50 dark:bg-amber-900/10" : "border-l-slate-300 bg-[var(--surface-2)] "}`}>
            <p className={`text-xs font-semibold ${tw.head}`}>{a.title}</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--muted)]">{a.detail}</p>
          </div>
        ))}</div>
      </Card>
    </div>
  );

  /**
   * The highlights panel — the seven numbers a CEO opens this page for, on one
   * line under the title. Everything here is already computed above; this only
   * decides what earns a slot and which of them carry a colour. `tone` names a
   * token, so the value picks up --pos / --neg and follows dark mode.
   */
  type Highlight = { label: string; value: string; sub: string; tone?: "pos" | "warn" | "neg" };

  /**
   * The period the highlights describe. The panel is the page's summary line,
   * so it has to answer for whichever tab is open — left on YTD it contradicted
   * every widget under it the moment you opened a month tab.
   */
  const period =
    tab === "lastMonth"
      ? {
          label: prevTrend.name || t("kpi.lastMonth"),
          actual: Number(kpi.last_month_actual || 0),
          target: Number(kpi.last_month_target || 0),
          ach: lastMonthAch,
          lastYear: prevMonthLYActual,
          cash: lastMonthCash,
          credit: lastMonthCredit,
        }
      : tab === "thisMonth"
        ? {
            label: curTrend.name || t("kpi.thisMonth"),
            actual: Number(kpi.this_month_actual || 0),
            target: Number(kpi.this_month_target || 0),
            ach: thisMonthAch,
            lastYear: sameMonthLY,
            cash: thisMonthCash,
            credit: thisMonthCredit,
          }
        : {
            label: t("kpi.ytd"),
            actual: Number(kpi.ytd_actual || 0),
            target: Number(kpi.ytd_target || 0),
            ach: ytdAch,
            lastYear: Number(kpi.ytd_last_year || 0),
            cash: cashVal,
            credit: creditVal,
          };
  const periodYoy = period.lastYear > 0 ? (period.actual / period.lastYear - 1) * 100 : 0;
  const periodCashShare = period.cash + period.credit > 0
    ? (period.cash / (period.cash + period.credit)) * 100
    : 0;
  const hasPeriodTarget = period.target > 0;

  const highlights: Highlight[] = [
    {
      label: period.label,
      value: fmt(period.actual),
      sub: `${t("kpi.target")} ${compact(period.target)}`,
    },
    {
      label: t("dash.achievement"),
      value: hasPeriodTarget ? `${period.ach.toFixed(1)}%` : "—",
      sub: hasPeriodTarget
        ? `${t("kpi.gap")} ${compact(Math.max(period.target - period.actual, 0))}`
        : t("kpi.noTarget"),
      tone: !hasPeriodTarget ? undefined : period.ach >= 100 ? "pos" : period.ach >= 90 ? "warn" : "neg",
    },
    {
      label: "YoY",
      value: period.lastYear > 0 ? `${periodYoy >= 0 ? "+" : ""}${periodYoy.toFixed(1)}%` : "—",
      sub: `${t("kpi.lastYear")} ${compact(period.lastYear)}`,
      tone: period.lastYear > 0 ? (periodYoy >= 0 ? "pos" : "neg") : undefined,
    },
    {
      label: t("dash.cashShare"),
      value: `${periodCashShare.toFixed(0)}%`,
      sub: `${t("momentum.cash")} ${compact(period.cash)} · ${t("momentum.credit")} ${compact(period.credit)}`,
      tone: periodCashShare < 50 ? "warn" : undefined,
    },

    /* The pace only means something while the month is still running. */
    ...(tab === "thisMonth"
      ? ([{
          label: t("momentum.perDay"),
          value: fmt(data?.requiredPerDay),
          sub: `${data?.daysLeft || 0} ${t("momentum.daysLeft")}`,
          tone: onTrack ? undefined : "warn",
        }] as Highlight[])
      : []),

    /* Whole-year measures. They are computed over the year, not the period, so
       on a month tab they would sit next to July's numbers claiming to describe
       July — the contradiction this panel exists to avoid. */
    ...(tab === "overview"
      ? ([
          {
            label: t("kpi.thisMonth"),
            value: fmt(kpi.this_month_actual),
            sub: `${t("kpi.target")} ${compact(kpi.this_month_target)}`,
          },
          {
            label: t("kpi.forecast"),
            value: compact(data?.forecastEOY),
            sub: !hasYtdTarget
              ? t("kpi.noTarget")
              : eoyGap <= 0
                ? `${t("kpi.aheadOfPlan")} ${compact(Math.abs(eoyGap))}`
                : `${t("kpi.gap")} ${compact(eoyGap)}`,
          },
          {
            label: "GP %",
            value: exec || execFailed ? `${gpPct.toFixed(1)}%` : "—",
            sub: `${t("kpi.profit")} ${compact(exec?.grossProfit?.profit)}`,
            tone: exec && gpPct < 20 ? "warn" : undefined,
          },
          {
            label: t("kpi.collection"),
            value: exec || execFailed ? `${collectionRate.toFixed(0)}%` : "—",
            sub: `${t("momentum.cash")} ${compact(exec?.collection?.collected)}`,
            tone: exec && collectionRate < 50 ? "warn" : undefined,
          },
          {
            label: t("dash.customers"),
            value: Number(data?.counts?.customers || 0).toLocaleString(),
            sub: `${t("dash.orders")} ${Number(data?.counts?.orders || 0).toLocaleString()} · ${t("dash.revPerOrder")} ${compact(avgDealValue)}`,
          },
        ] as Highlight[])
      : []),

    /* A balance, not a period figure: what is owed right now is the same answer
       on every tab, and it is the one number here that never stops mattering. */
    {
      label: t("dash.arOverdue"),
      value: compact(overdueAr),
      sub: `${t("dash.arAging")} ${compact(arAging.total)}`,
      tone: overdueAr > Number(arAging.total || 0) * 0.4 ? "neg" : overdueAr > 0 ? "warn" : undefined,
    },
  ];

  return (
    <div style={font} className="sf-app min-h-screen bg-transparent">

      {/* ══════ LIGHTNING PAGE HEADER ══════
          Breadcrumb, then the page's identity and its actions, then the numbers
          nobody should have to scroll for, then the tabs. Salesforce puts the
          record's own summary above the fold and everything else behind a tab;
          this header is that same order. */}
      <header className="sf-hd" data-condensed={condensed ? "true" : undefined}>
        <div className="sf-crumb print:hidden">
          <LayoutDashboard size={11} />
          <span>{t("dash.tab.overview")}</span>
          <ChevronRight size={11} />
          <span className="font-semibold text-[var(--ink-soft)]">{t("app.title")}</span>
        </div>

        <div className="sf-ph">
          <div className="sf-ph-id">
            <span className="sf-icon"><BarChart3 size={18} /></span>
            <div className="min-w-0">
              <h1 className="sf-ph-title truncate">{t("app.title")}</h1>
              <p className="sf-ph-meta">
                {t("app.subtitle")} · FY {d.year} · {t("dash.currencyUnit")}
                {d.updatedAt && <> · {t("dash.updatedAt")} {d.updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</>}{" "}
                {/* ເວລາທີ່ຂໍ້ມູນຂາຍອັບເດດ — ຄົນລະຢ່າງກັບເວລາທີ່ໜ້ານີ້ດຶງ. */}
                <SaleSyncBadge />
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 print:hidden">
            <div className="sf-group">
              <button onClick={() => setShowFilter(true)} className={`btn ${activeFilters.length ? "is-on" : ""}`}>
                <Filter size={13} /> {t("app.filters")}
                {activeFilters.length > 0 && <span className="pill">{activeFilters.length}</span>}
              </button>
              <button onClick={() => d.load()} className="btn">
                <RefreshCw size={13} className={d.loading || d.refreshing ? "animate-spin" : ""} />
                {t("monthSummary.refresh")}
              </button>
            </div>
            {/* Everything that is a preference rather than an action lives behind
                the overflow, the way Lightning keeps a header to two buttons. */}
            <Kebab
              align="right"
              items={[
                { label: t("dash.autoRefresh"), icon: <Zap size={13} />, onClick: () => setAutoRefresh(!autoRefresh), state: autoRefresh ? "ON" : "OFF" },
                { label: t("dash.tvMode"), icon: <Monitor size={13} />, onClick: () => setTvMode(!tvMode), state: tvMode ? "ON" : "OFF" },
                { sep: true },
                { label: t("dash.exportCsv"), icon: <Download size={13} />, onClick: exportCsv },
                { label: t("dash.printReport"), icon: <Printer size={13} />, onClick: () => window.print() },
                { sep: true },
                { label: isDark ? t("theme.light") : t("theme.dark"), icon: isDark ? <Sun size={13} /> : <Moon size={13} />, onClick: toggleTheme },
              ]}
            />
          </div>
        </div>

        {/* ── Highlights panel ── */}
        <div className="sf-hl">
          {highlights.map((h) => (
            <div key={h.label} className="sf-hl-item">
              <p className="sf-hl-label">{h.label}</p>
              <p className="sf-hl-value" style={h.tone ? { color: `var(--${h.tone})` } : undefined}>{h.value}</p>
              <p className="sf-hl-sub">{h.sub}</p>
            </div>
          ))}
        </div>

        {activeFilters.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-2 print:hidden">
            <span className="text-[10px] font-semibold text-[var(--muted)]">{t("dash.activeFilters")}</span>
            {activeFilters.map((filter) => (
              <button key={filter.key} type="button" onClick={filter.clear} className="pill hover:opacity-75">
                {filter.label}<X size={10} />
              </button>
            ))}
          </div>
        )}

        <div className="sf-tabs print:hidden">
          {([
            { key: "overview" as const, label: t("dash.tab.overview") },
            { key: "lastMonth" as const, label: `${t("dash.tab.lastMonth")} · ${trend[prevMonthIdx]?.name || "Prev"}` },
            { key: "thisMonth" as const, label: `${t("dash.tab.thisMonth")} · ${trend[new Date().getMonth()]?.name || "Now"}` },
          ]).map(tb => (
            <button key={tb.key} onClick={() => setTab(tb.key)} className={`sf-tab ${tab === tb.key ? "is-active" : ""}`}>
              {tb.label}
            </button>
          ))}
        </div>
      </header>

      {/* ── Filters, docked to the right edge ──
          A panel rather than a strip: opening the filters used to shove the whole
          dashboard down the page, so you lost your place every time you changed
          one. */}
      {showFilter && (
        <>
          <div className="sf-dock-backdrop print:hidden" onClick={() => setShowFilter(false)} />
          <aside className="sf-dock print:hidden" role="dialog" aria-label={t("app.filters")}>
            <div className="sf-dock-hd">
              <p className="flex items-center gap-2 text-[13px] font-bold text-[var(--ink)]">
                <Filter size={14} className="text-[var(--brand)]" /> {t("app.filters")}
              </p>
              <button onClick={() => setShowFilter(false)} className="btn btn-ghost btn-icon"><X size={15} /></button>
            </div>
            <div className="sf-dock-bd space-y-3">
              {[
                { l: t("filter.year"), v: d.year, fn: (v: string) => d.setYear(v), opts: d.yearOptions.map((y: any) => ({ v: y, l: y })), noAll: true },
                { l: t("filter.bu"), v: d.bu, fn: (v: string) => d.setBu(v), opts: d.buOptions.map((o: any) => ({ v: o.value, l: o.label })) },
                { l: t("filter.channel"), v: d.channel[0] || "ALL", fn: (v: string) => d.setChannel([v]), opts: d.channelOptions.map((o: any) => ({ v: o.value, l: o.label })) },
                { l: t("filter.province"), v: d.province[0] || "ALL", fn: (v: string) => d.setProvince([v]), opts: d.provinceOptions.map((o: any) => ({ v: o.value, l: o.label })) },
              ].map((f, i) => (
                <div key={i}>
                  <label className="field-label">{f.l}</label>
                  <select value={f.v} onChange={e => f.fn(e.target.value)} className="select">
                    {!f.noAll && <option value="ALL">{t("app.all")}</option>}
                    {f.opts.map((o: any) => <option key={o.v} value={o.v}>{o.l}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <div className="sf-dock-ft">
              <button type="button" onClick={d.resetFilters} className="btn"><RotateCcw size={12} /> {t("dash.resetFilters")}</button>
              <button type="button" onClick={() => setShowFilter(false)} className="btn btn-primary">{t("app.close")}</button>
            </div>
          </aside>
        </>
      )}

      {tvMode && (
        <button onClick={() => setTvMode(false)} className="tv-keep fixed bottom-5 right-5 z-[60] inline-flex items-center gap-2 rounded-[var(--sf-r)] bg-[var(--brand-deep)] px-4 py-2.5 text-xs font-semibold text-white shadow-xl print:hidden">
          <X size={14} /> {t("dash.exitTv")}
        </button>
      )}

      {(d.loading || d.refreshing) && data && (
        <div className="fixed inset-x-0 top-0 z-50 h-1 overflow-hidden bg-sky-100 dark:bg-blue-900/30">
          <div className="h-full w-2/5 animate-[loading-bar_1.2s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-[#4ac7f0] via-[#2b70b5] to-[#f5911f]" style={{ animation: "loading-bar 1.2s ease-in-out infinite" }} />
          <style>{`@keyframes loading-bar { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }`}</style>
        </div>
      )}

      <main className="mx-auto max-w-[1600px] space-y-4 px-4 py-4 lg:px-6 lg:py-5">

        {/* ══════════════════════════════════════════════════════════════
            TAB: OVERVIEW (ພາບລວມ YTD)
        ══════════════════════════════════════════════════════════════ */}
        {tab === "overview" && (<>

        {/* ═══════════════════════════════════════════════════════════
            SECTION 0A: EXECUTIVE ALERT CENTER
        ═══════════════════════════════════════════════════════════ */}
        {execAlerts.length > 0 && (<>
          <div className="flex items-center gap-2">
            <Bell size={14} className="text-[var(--accent)]" />
            <h2 className="text-[15px] font-bold tracking-tight text-[var(--ink)]">{t("dash.alertCenter")}</h2>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
            {execAlerts.map((al, i) => {
              const cls = `flex w-full items-start gap-3 rounded-[var(--r-md)] border px-3.5 py-3 text-left transition-all hover:-translate-y-0.5 hover:shadow-sm ${al.level === "high" ? "border-[var(--neg)]/30 bg-[var(--neg-bg)]" : "border-[var(--warn)]/30 bg-[var(--warn-bg)]"}`;
              const inner = (<>
                <al.icon size={16} className={`mt-0.5 shrink-0 ${al.level === "high" ? "text-[var(--neg)]" : "text-[var(--warn)]"}`} />
                <div className="min-w-0">
                  <p className={`text-xs font-bold ${al.level === "high" ? "text-[var(--neg)]" : "text-[var(--warn)]"}`}>{al.title}</p>
                  <p className={`mt-0.5 truncate text-[11px] leading-snug ${tw.sub}`}>{al.detail}</p>
                </div>
              </>);
              if (al.to?.startsWith("/")) return <Link key={i} href={al.to} className={cls}>{inner}</Link>;
              return (
                <button key={i} type="button" onClick={() => al.to && document.getElementById(al.to)?.scrollIntoView({ behavior: "smooth", block: "start" })} className={`${cls} cursor-pointer`}>
                  {inner}
                </button>
              );
            })}
          </div>
        </>)}

        {/* ═══════════════════════════════════════════════════════════
            SECTION 0B: STICKY SECTION NAVIGATOR
        ═══════════════════════════════════════════════════════════ */}
        <div className="-mx-4 flex gap-1.5 overflow-x-auto border-y border-[var(--line-soft)] px-4 py-2 lg:-mx-6 lg:px-6 print:hidden">
          {secNav.map((n) => (
            <button key={n.id} onClick={() => document.getElementById(n.id)?.scrollIntoView({ behavior: "smooth", block: "start" })} className="pill whitespace-nowrap">{n.label}</button>
          ))}
        </div>

        {/* ═══════════════════════════════════════════════════════════
            SECTION 1: EXECUTIVE KPI STRIP
        ═══════════════════════════════════════════════════════════ */}
        <div id="sec-kpi" className="scroll-mt-32 md:scroll-mt-14" />
        {!hasYtdTarget && (
          <div className="flex items-start gap-2 rounded-[var(--r-md)] border border-[var(--warn)] bg-[var(--warn-bg)] px-3 py-2 text-[11.5px] text-[var(--warn)]">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>{t("dash.targetMissing")}</span>
          </div>
        )}
        {/* ═══════════════════════════════════════════════════════════
            SECTION 1: TARGET VS ACTUAL BY BU + APPROVAL QUEUE
        ═══════════════════════════════════════════════════════════ */}
        <div id="sec-target" className="scroll-mt-32 md:scroll-mt-14" />
        <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Card title={t("dash.targetVsActual")} icon={<Target size={13} />} to="/target" toLabel={t("dash.viewReport")}>
          <p className={`mb-3 text-xs ${tw.sub}`}>
            {t("dash.targetVsActualDesc")}
            {/* The target is 8 full months while the actual stops at the last
                synced sale, so the period has to be spelled out or the gap
                reads as underperformance. */}
            {sync?.sale_detail?.latest && (
              <>
                {" · "}
                {t("dash.targetPeriod")} 1–{new Date().getMonth() + 1} · {t("dash.actualThrough")}{" "}
                <span className="num font-semibold">{fmtDate(sync.sale_detail.latest)}</span>
              </>
            )}
          </p>
          {(() => {
            const curM = new Date().getMonth() + 1;
            const mKeys = ["","jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
            // odg_sales_target is stored per BU × channel × province × district,
            // so /targets-by-bu returns up to 30 rows for one BU. They have to be
            // summed — keying a Map by bu_code keeps only the last slice and
            // shows a target ~18× too small.
            const targetMap = new Map<string, number>();
            for (const row of (buTargets || []) as any[]) {
              let ytd = 0;
              for (let m = 1; m <= curM; m++) ytd += Number(row?.[mKeys[m]] || 0);
              const code = String(row?.bu_code);
              targetMap.set(code, (targetMap.get(code) || 0) + ytd);
            }
            const rows = buProfit
              .map((b: any) => {
                const bc = String(b.bu);
                const ytdTgt = targetMap.get(bc) || 0;
                const act = Number(b.revenue || 0);
                return { bu: bc, name: buLabel(bc), target: ytdTgt, actual: act, ach: ytdTgt > 0 ? (act / ytdTgt) * 100 : 0 };
              })
              .sort((a: any, b: any) => b.actual - a.actual);

            /* Nobody sets a plan for the online BU or for the lines that carry no
               BU at all, so those rows sat here at 0% next to six units that are
               genuinely being measured — three of them a stray credit note and a
               free-gift line worth −7,087 kip between them. They are still real
               kip, so they are folded into one residual line and stay in the
               total rather than being dropped: the total has to keep matching
               the YTD figure in the header. */
            const planned = rows.filter((r: any) => r.target > 0);
            const unplanned = rows.filter((r: any) => r.target <= 0);
            const unplannedActual = unplanned.reduce((s: number, r: any) => s + r.actual, 0);
            const showUnplanned = Math.abs(unplannedActual) >= 1;
            const grandTarget = rows.reduce((s: number, r: any) => s + r.target, 0);
            const grandActual = rows.reduce((s: number, r: any) => s + r.actual, 0);
            return (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className={tw.sub}>
                      <th className="pb-2 pr-2 text-left text-[10px] font-semibold uppercase tracking-wider">BU</th>
                      <th className="pb-2 px-2 text-right text-[10px] font-semibold uppercase tracking-wider">{t("kpi.target")}</th>
                      <th className="pb-2 px-2 text-right text-[10px] font-semibold uppercase tracking-wider">{t("label.actual")}</th>
                      <th className="pb-2 pl-2 text-right text-[10px] font-semibold uppercase tracking-wider">Ach</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--line-soft)] dark:divide-slate-800">
                    {planned.map((r: any, i: number) => (
                      <tr key={i} className="hover:bg-[var(--surface-2)]">
                        <td className={`py-1.5 pr-2 font-medium ${tw.head}`}>{r.name}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums text-[var(--muted)]">{compact(r.target)}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums font-semibold">{compact(r.actual)}</td>
                        <td className="py-1.5 pl-2 text-right">
                          <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-bold ${r.ach >= 100 ? "bg-[var(--pos-bg)] text-[var(--pos)]" : r.ach >= 90 ? "bg-[var(--warn-bg)] text-[var(--warn)]" : "bg-[var(--neg-bg)] text-[var(--neg)]"}`}>
                            {r.ach.toFixed(0)}%
                          </span>
                        </td>
                      </tr>
                    ))}
                    {showUnplanned && (
                      <tr
                        className="hover:bg-[var(--surface-2)]"
                        title={`${t("dash.noTargetHint")} — ${unplanned.map((r: any) => r.name).join(", ")}`}
                      >
                        <td className="py-1.5 pr-2 font-medium text-[var(--muted)]">{t("dash.noTargetRow")}</td>
                        <td className="py-1.5 px-2 text-right text-[var(--muted)]">–</td>
                        <td className="py-1.5 px-2 text-right tabular-nums text-[var(--muted)]">{compact(unplannedActual)}</td>
                        <td className="py-1.5 pl-2 text-right text-[var(--muted)]">–</td>
                      </tr>
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-[var(--line)]">
                      <td className={`pt-2 pr-2 text-xs font-bold ${tw.head}`}>{t("app.all")}</td>
                      <td className="pt-2 px-2 text-right text-xs font-bold tabular-nums">{compact(grandTarget)}</td>
                      <td className="pt-2 px-2 text-right text-xs font-bold tabular-nums">{compact(grandActual)}</td>
                      <td className="pt-2 pl-2 text-right text-xs font-bold">
                        <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-bold ${grandTarget > 0 && (grandActual / grandTarget) * 100 >= 100 ? "bg-[var(--pos-bg)] text-[var(--pos)]" : (grandTarget > 0 && (grandActual / grandTarget) * 100 >= 90) ? "bg-[var(--warn-bg)] text-[var(--warn)]" : "bg-[var(--neg-bg)] text-[var(--neg)]"}`}>
                          {grandTarget > 0 ? ((grandActual / grandTarget) * 100).toFixed(0) : "—"}%
                        </span>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            );
          })()}
        </Card>
          <Card title={t("dash.approvalCenter")} icon={<ClipboardCheck size={13} />} to="/approvals" toLabel={t("dash.viewReport")}>
            {!approvalSummary ? (
              <div className="space-y-2"><div className="skeleton h-10" /><div className="skeleton h-10" /><div className="skeleton h-10" /></div>
            ) : (
              <div className="space-y-1">
                {[
                  { key: "po", label: "PO", href: "/approvals/po" },
                  { key: "pr", label: "PR", href: "/approvals/pr" },
                  { key: "product", label: t("sidebar.approveProductName"), href: "/approvals/product-name" },
                ].map((item) => {
                  const queue = approvalSummary.queues?.[item.key] || {};
                  return (
                    <Link key={item.key} href={item.href} className="flex items-center gap-3 rounded-[var(--r-sm)] px-2 py-2 hover:bg-[var(--surface-2)]">
                      <span className="grid h-8 w-8 place-items-center rounded-[var(--r-sm)] bg-[var(--brand-soft)] text-[var(--brand)]"><ClipboardCheck size={15} /></span>
                      <span className="min-w-0 flex-1"><strong className="block text-[11.5px] text-[var(--ink)]">{item.label}</strong><small className="text-[10px] text-[var(--muted)]">{t("dash.overdueSla")} {queue.overdue || 0}</small></span>
                      <span className="num text-sm font-bold text-[var(--ink)]">{queue.pending || 0}</span>
                      <ArrowUpRight size={13} className="text-[var(--muted)]" />
                    </Link>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        {/* ═══════════════════════════════════════════════════════════
            SECTION 2: TODAY / WEEK / MOMENTUM
        ═══════════════════════════════════════════════════════════ */}
        <div className="ribbon flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-[var(--r-lg)] px-4 py-3.5 text-white">
          <div className="flex items-center gap-2.5">
            <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${onTrack ? "bg-[var(--pos-bg)] text-[var(--pos)] " : "bg-[var(--warn-bg)] text-[var(--warn)] "}`}>
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
          <Card title={t("section.achievement")} subtitle={`${t("kpi.target")} ${fmt(kpi.ytd_target)}`} icon={<Target size={13} />} to="/month-summary" toLabel={t("dash.viewReport")}>
            <div className="flex flex-col items-center">
              <Gauge value={ytdAch} label="YTD" />
            </div>
            <div className="mt-2">
              <Progress label={t("kpi.thisMonth")} v={thisMonthAch} />
              <Progress label={t("kpi.lastMonth")} v={lastMonthAch} />
            </div>
          </Card>
          <Card title={t("section.payment")}>
            <div className="flex items-center gap-5">
              <div className="relative h-36 w-36 shrink-0">
                <ChartFrame className="h-36 w-36"><PieChart><Pie {...CHART_NO_ANIM} data={cashVal + creditVal > 0 ? [{ name: "Cash", value: cashVal }, { name: "Credit", value: creditVal }] : [{ name: "No data", value: 1 }]} dataKey="value" cx="50%" cy="50%" innerRadius={38} outerRadius={61} startAngle={90} endAngle={-270} strokeWidth={0}>{cashVal + creditVal > 0 ? [<Cell key="cash" fill={C.blue} />, <Cell key="credit" fill={C.amber} />] : <Cell fill="#c3d2e0" />}</Pie></PieChart></ChartFrame>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"><span className="text-[9px] font-semibold uppercase tracking-wider text-[var(--muted)]">Total</span><span className="mt-0.5 text-xs font-bold text-[var(--ink)]">{compact(cashVal + creditVal)}</span></div>
              </div>
              <div className="min-w-0 flex-1 space-y-4">
                <div><div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-[#4ac7f0]" /><p className={`text-xs ${tw.sub}`}>{t("dash.cash")}</p></div><p className="mt-1 text-lg font-bold text-[#2b70b5] dark:text-[#4ac7f0]">{fmt(cashVal)}</p></div>
                <div><div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-[#f5911f]" /><p className={`text-xs ${tw.sub}`}>{t("dash.credit")}</p></div><p className="mt-1 text-lg font-bold text-[#f5911f]">{fmt(creditVal)}</p></div>
              </div>
            </div>
          </Card>
          <Card title={t("dash.custQuality")}>
            <div className="grid grid-cols-2 gap-2">
              <Mini label={t("label.repeatCustomer")} value={pct(quality.repeatPct)} cls={tw.green} />
              <Mini label={t("label.singlePurchase")} value={pct(quality.singlePurchasePct)} cls={tw.blue} />
              <Mini label="Reactive (2M+)" value={String(quality.reactiveCustomers || 0)} cls="text-[var(--brand)]" />
            </div>
          </Card>
        </div>

        {/* ═══════════════════════════════════════════════════════════
            SECTION 4: REVENUE TREND
        ═══════════════════════════════════════════════════════════ */}
        <div id="sec-trend" className="scroll-mt-32 md:scroll-mt-14" />
        <Card title={t("section.revenueTrend")}>
          <div className="mb-2 flex gap-4 text-[11px] text-[var(--muted)]">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[var(--brand)]" />{t("label.actual")}</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[var(--line)]" />{t("kpi.target")}</span>
            <span className="flex items-center gap-1"><span className="h-0.5 w-3 border-b-2 border-dashed border-emerald-400" />{t("kpi.lastYear")}</span>
          </div>
          <ChartFrame className="h-64">
            <AreaChart data={trend} margin={{ top: 5, right: 5, bottom: 0, left: -15 }}>
              <defs><linearGradient id="gA" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.blue} stopOpacity={0.2} /><stop offset="100%" stopColor={C.blue} stopOpacity={0} /></linearGradient></defs>
              <CartesianGrid strokeDasharray="3 3" stroke={isDark ? "#1e293b" : "#f1f5f9"} />
              <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "#94a3b8" }} />
              <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "#94a3b8" }} tickFormatter={(v: number) => compact(v)} />
              <Tooltip {...CHART_NO_ANIM} content={<Tip />} />
              <Area {...CHART_NO_ANIM} type="monotone" dataKey="target" name={t("kpi.target")} stroke="#cbd5e1" strokeWidth={1.5} fill="#f8fafc" fillOpacity={isDark ? 0.05 : 0.3} />
              <Area {...CHART_NO_ANIM} type="monotone" dataKey="actual" name={t("label.actual")} stroke={C.blue} strokeWidth={2.5} fill="url(#gA)" />
              <Area {...CHART_NO_ANIM} type="monotone" dataKey="lastYear" name={t("kpi.lastYear")} stroke={C.emerald} strokeWidth={1.5} fill="none" strokeDasharray="5 5" />
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
                <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v: string) => fmtDayMonth(v)} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v: number) => compact(v)} />
                <Tooltip {...CHART_NO_ANIM} content={<Tip />} /><Bar {...CHART_NO_ANIM} dataKey="amount" name={t("label.actual")} fill={C.blue} radius={[3, 3, 0, 0]} />
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
              <Tooltip {...CHART_NO_ANIM} content={<Tip />} /><Bar {...CHART_NO_ANIM} dataKey="cash" name={t("momentum.cash")} fill={C.emerald} radius={[4, 4, 0, 0]} /><Bar {...CHART_NO_ANIM} dataKey="credit" name={t("momentum.credit")} fill={C.amber} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ChartFrame>
        </Card>

        {/* ═══════════════════════════════════════════════════════════
            SECTION 6: REVENUE MATRIX (BU × Channel)
        ═══════════════════════════════════════════════════════════ */}
        {buList.length > 0 && channelList.length > 0 && (
          <Card title={t("dash.revenueMatrix")} icon={<BarChart3 size={13} />} to="/sales-summary" toLabel={t("dash.viewReport")}>
            <div className="overflow-x-auto"><table className="w-full text-xs">
              <thead><tr className={tw.sub}>
                <th className="px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wider">BU</th>
                {channelList.map((ch: string) => <th key={ch} className="px-1 py-2 text-center text-[10px] font-semibold uppercase tracking-wider">{ch}</th>)}
                <th className="px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wider">Total</th>
              </tr></thead>
              <tbody>{buList.map((b: string) => {
                const rm = pivot.get(b) || new Map();
                const tot = channelList.reduce((s: number, ch: string) => s + (rm.get(ch) || 0), 0);
                return (<tr key={b} className="hover:bg-[var(--surface-2)]">
                  <td className={`whitespace-nowrap px-2 py-1.5 font-medium ${tw.head}`}>{buLabel(b)}</td>
                  {channelList.map((ch: string) => { const v = rm.get(ch) || 0; const op = heatMax > 0 ? Math.max((v / heatMax) * 0.85, 0.04) : 0.04; return (
                    <td key={ch} className="p-0.5 text-center"><div className="rounded-lg px-2 py-1.5 tabular-nums font-medium" style={{ backgroundColor: `rgba(22,119,90,${op})`, color: op > 0.45 ? "#fff" : undefined }}>{v > 0 ? fmt(v) : "–"}</div></td>
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
        <div id="sec-products" className="scroll-mt-32 md:scroll-mt-14" />
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title={t("section.buRevenue")}>
            <ChartFrame className="h-44"><PieChart><Pie {...CHART_NO_ANIM} data={buPie} dataKey="value" cx="50%" cy="50%" outerRadius={65} strokeWidth={1} stroke={isDark ? "#1e293b" : "#fff"} label={({ name, percent }: any) => `${name} ${(percent*100).toFixed(0)}%`} labelLine={false} fontSize={10}>
              {buPie.map((_: any, i: number) => <Cell key={i} fill={PIE[i % PIE.length]} />)}
            </Pie></PieChart></ChartFrame>
          </Card>
          <Card title={t("section.groupProfit")}>
            <ChartFrame className="h-44"><PieChart><Pie {...CHART_NO_ANIM} data={gpPie} dataKey="value" cx="50%" cy="50%" outerRadius={65} strokeWidth={1} stroke={isDark ? "#1e293b" : "#fff"} label={({ name, percent }: any) => `${(name||"").slice(0,8)} ${(percent*100).toFixed(0)}%`} labelLine={false} fontSize={10}>
              {gpPie.map((_: any, i: number) => <Cell key={i} fill={PIE[i % PIE.length]} />)}
            </Pie></PieChart></ChartFrame>
          </Card>
          <Card title={t("dash.buProfit")}>
            <div className="space-y-1.5">{buProfit.slice(0, 6).map((b: any, i: number) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className={`font-medium ${tw.head}`}>{buLabel(b.bu)}</span>
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
                  <p className={`text-xs font-semibold ${tw.head}`}>{buLabel(b.bu)}</p>
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
                      <tbody className="divide-y divide-[var(--line-soft)] dark:divide-slate-800">
                        {b.brands.slice(0, 8).map((br: any, bri: number) => (
                          <tr key={bri} className="hover:bg-[var(--surface-2)]">
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
          <Card title={t("dash.topRevProducts")} to="/products" toLabel={t("dash.viewReport")}>
            {topRevenue.map((p: any, i: number) => (
              <div key={i} className="flex items-center justify-between border-b border-[var(--line-soft)] py-2 last:border-0">
                <div className="min-w-0 flex-1"><p className={`truncate text-xs font-medium ${tw.head}`}>{p.name || p.code}</p><p className="text-[10px] text-[var(--muted)]">{p.code}</p></div>
                <span className={`ml-3 text-xs font-bold tabular-nums ${tw.blue}`}>{fmt(p.revenue)}</span>
              </div>
            ))}
            {topRevenue.length === 0 && <Empty text={t("label.noData")} />}
          </Card>
          <Card title={t("dash.topMarginProducts")} to="/products" toLabel={t("dash.viewReport")}>
            {topMargin.map((p: any, i: number) => (
              <div key={i} className="flex items-center justify-between border-b border-[var(--line-soft)] py-2 last:border-0">
                <div className="min-w-0 flex-1"><p className={`truncate text-xs font-medium ${tw.head}`}>{p.name || p.code}</p><p className="text-[10px] text-[var(--muted)]">GP {(Number(p.gp || 0) * 100).toFixed(1)}%</p></div>
                <span className={`ml-3 text-xs font-bold tabular-nums ${tw.green}`}>{fmt(p.revenue)}</span>
              </div>
            ))}
            {topMargin.length === 0 && <Empty text={t("label.noData")} />}
          </Card>
        </div>

        {/* ═══════════════════════════════════════════════════════════
            SECTION 9: TEAM LEADERBOARD + PROVINCE RANKING
        ═══════════════════════════════════════════════════════════ */}
        <div id="sec-team" className="scroll-mt-32 md:scroll-mt-14" />
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title={`ທີມຂາຍ (${team.length})`}>{team.map((m: any, i: number) => <Rank key={i} i={i} label={m.name} value={fmt(m.actual)} ach={m.achPct} />)}{team.length === 0 && <Empty text={t("label.noData")} />}</Card>
          <Card title={`ແຂວງ Top (${provinces.length})`} to="/shop-map" toLabel={t("dash.viewReport")}>{provinces.map((p: any, i: number) => <Rank key={i} i={i} label={p.label} value={fmt(p.actual)} ach={p.achPct} />)}{provinces.length === 0 && <Empty text={t("label.noData")} />}</Card>
          <Card title="Bottom Sales Reps">
            {[...team].sort((a: any, b: any) => a.actual - b.actual).slice(0, 3).map((m: any, i: number) => (
              <div key={i} className="flex items-center justify-between border-b border-[var(--line-soft)] py-2 last:border-0">
                <div className="flex items-center gap-2">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--neg-bg)] text-[10px] font-bold text-[var(--neg)]">{i + 1}</span>
                  <span className={`text-xs font-medium ${tw.head}`}>{m.name}</span>
                </div>
                <div className="flex items-center gap-3 text-xs tabular-nums">
                  <span className={tw.sub}>{fmt(m.actual)}</span>
                  <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-bold ${(m.achPct || 0) >= 100 ? "bg-[var(--pos-bg)] text-[var(--pos)]" : (m.achPct || 0) >= 90 ? "bg-[var(--warn-bg)] text-[var(--warn)]" : "bg-[var(--neg-bg)] text-[var(--neg)]"}`}>{pct(m.achPct)}</span>
                </div>
              </div>
            ))}
            {team.length === 0 && <Empty text={t("label.noData")} />}
          </Card>
        </div>


        {/* ═══════════════════════════════════════════════════════════
            SECTION 10: TERRITORY RISK / OPPORTUNITY
        ═══════════════════════════════════════════════════════════ */}
        {(riskZones.length > 0 || oppZones.length > 0) && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={`⚠ ${t("dash.riskZones")}`}>
              {riskZones.map((p: any, i: number) => (
                <div key={i} className="flex items-center justify-between border-b border-[var(--line-soft)] py-1.5 last:border-0 text-xs">
                  <span className={`font-medium ${tw.head}`}>{p.label}</span>
                  <div className="flex gap-3 tabular-nums"><span className={tw.sub}>Actual {fmt(p.actual)}</span><span className={`font-bold ${tw.red}`}>{pct(p.achPct)}</span></div>
                </div>
              ))}
              {riskZones.length === 0 && <Empty text={t("label.noData")} />}
            </Card>
            <Card title={`✦ ${t("dash.oppZones")}`}>
              {oppZones.map((p: any, i: number) => (
                <div key={i} className="flex items-center justify-between border-b border-[var(--line-soft)] py-1.5 last:border-0 text-xs">
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
                <tr key={i} className="hover:bg-[var(--surface-2)]">
                  <td className="px-2 py-1.5 text-xs text-[var(--muted)]">{i + 1}</td>
                  <td className="px-2 py-1.5 text-xs"><p className={`font-medium ${tw.head}`}>{c.name}</p><p className="text-[10px] text-[var(--muted)]">{c.code}</p></td>
                  <td className={`px-2 py-1.5 text-right text-xs font-bold tabular-nums ${tw.blue}`}>{fmt(c.revenue)}</td>
                  <td className="px-2 py-1.5 text-right text-xs tabular-nums text-[var(--muted)]">{c.orders}</td>
                </tr>
              ))}</TBL>
            </Card>
            <Card title={`${t("dash.bottomCustomers")} (${t("kpi.thisMonth")})`}>
              <TBL heads={["#", t("label.customer"), t("label.actual"), "Orders"]}>{(exec.bottomCustomers || []).map((c: any, i: number) => (
                <tr key={i} className="hover:bg-[var(--surface-2)]">
                  <td className="px-2 py-1.5 text-xs text-[var(--muted)]">{i + 1}</td>
                  <td className="px-2 py-1.5 text-xs"><p className={`font-medium ${tw.head}`}>{c.name}</p><p className="text-[10px] text-[var(--muted)]">{c.code}</p></td>
                  <td className={`px-2 py-1.5 text-right text-xs font-bold tabular-nums ${tw.red}`}>{fmt(c.revenue)}</td>
                  <td className="px-2 py-1.5 text-right text-xs tabular-nums text-[var(--muted)]">{c.orders}</td>
                </tr>
              ))}</TBL>
            </Card>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════
            SECTION 12: STOCK + AR AGING + ACTIONS
        ═══════════════════════════════════════════════════════════ */}
        <div id="sec-finance" className="scroll-mt-32 md:scroll-mt-14" />
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
          <Card title={t("dash.arAging")} icon={<DollarSign size={13} />} to="/receivables" toLabel={t("dash.viewReport")}>
            <p className={`text-2xl font-bold ${tw.head}`}>{fmt(arAging.total)}</p>
            <div className="mt-3 space-y-1.5">
              {(arAging.buckets || []).map((b: any, i: number) => {
                const maxB = Math.max(...(arAging.buckets || []).map((x: any) => Number(x.balance || 0)), 1);
                return (<div key={i}>
                  <div className="flex justify-between text-xs"><span className={tw.sub}>{b.overdue_group}</span><span className={`font-semibold tabular-nums ${tw.head}`}>{fmt(b.balance)}</span></div>
                  <div className="mt-0.5 h-1.5 w-full rounded-full bg-[var(--surface-2)]">
                    <div className={`h-full rounded-full transition-all duration-500 ${i < 2 ? "bg-[var(--pos)]" : i < 4 ? "bg-[var(--warn)]" : "bg-[var(--neg)]"}`} style={{ width: `${(Number(b.balance || 0) / maxB) * 100}%` }} />
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
              <div key={i} className={`rounded-lg border-l-[3px] py-2 pl-3 pr-2 ${a.level === "high" ? "border-l-rose-500 bg-[var(--neg-bg)]/50 dark:bg-rose-900/10" : a.level === "medium" ? "border-l-amber-500 bg-[var(--warn-bg)]/50 dark:bg-amber-900/10" : "border-l-slate-300 bg-[var(--surface-2)] "}`}>
                <p className={`text-xs font-semibold ${tw.head}`}>{a.title}</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--muted)]">{a.detail}</p>
              </div>
            ))}</div>
            {actions.length === 0 && <Empty text={t("label.noData")} />}
          </Card>
        </div>

        {/* ═══════════════════════════════════════════════════════════
            SECTION 13: BUSINESS ANALYTICS (from /api/dashboard/analytics)
        ═══════════════════════════════════════════════════════════ */}
        {analytics && (<>
          <SectionHeading eyebrow="Business intelligence" title="Customer & commercial health" description="Trends, concentration, order quality and retention signals." />

          {/* MoM Growth + DSO + Concentration + AOV + Churn */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Kpi label="MoM Growth" value={`${momGrowthPct >= 0 ? "+" : ""}${momGrowthPct.toFixed(1)}%`} sub={`${t("kpi.lastMonth")} ${fmt(analytics.momGrowth?.lastMonth)}${Number(analytics.momGrowth?.comparedDays || 0) ? ` (1-${analytics.momGrowth.comparedDays} ມື້)` : ""}`} badge={trendBadge(momGrowthPct)} />
            <Kpi label="DSO (ມື້)" value={`${analytics.dso?.value || 0} ມື້`} sub={`AR ${fmt(analytics.dso?.arTotal)} ÷ ${fmt(analytics.dso?.dailyRevenue)}/ມື້`} badge={thresholdBadge(Number(analytics.dso?.value || 0) <= 45)} />
            <Kpi label="Top10 ລູກຄ້າ %" value={`${top10Pct.toFixed(1)}%`} sub={`${fmt(analytics.concentration?.top10Revenue)} / ${fmt(analytics.concentration?.ytdTotal)}`} ach={top10Pct} barTone={top10Pct <= 50 ? "pos" : "neg"} badge={null} />
            <Kpi label="AOV ເດືອນນີ້" value={fmt(analytics.aov?.thisMonth)} sub={`${t("kpi.lastMonth")} ${fmt(analytics.aov?.lastMonth)} (${Number(analytics.aov?.changePct || 0) >= 0 ? "+" : ""}${Number(analytics.aov?.changePct || 0).toFixed(1)}%)`} badge={trendBadge(Number(analytics.aov?.changePct || 0))} />
            <Kpi label="Retention Rate" value={`${retentionRate.toFixed(1)}%`} sub={`Churn ${analytics.churn?.churned || 0} / ໃໝ່ +${analytics.churn?.newAcquired || 0}${Number(analytics.momGrowth?.comparedDays || 0) ? ` · ທຽບ 1-${analytics.momGrowth.comparedDays} ມື້` : ""}`} ach={retentionRate} barTone={retentionRate >= 80 ? "pos" : "warn"} badge={null} />
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
                <tbody className="divide-y divide-[var(--line-soft)] dark:divide-slate-800">
                  {(analytics.channelProfit || []).map((ch: any, i: number) => (
                    <tr key={i} className="hover:bg-[var(--surface-2)]">
                      <td className={`px-2 py-1.5 font-medium ${tw.head}`}>{ch.channel}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmt(ch.revenue)}</td>
                      <td className={`px-2 py-1.5 text-right tabular-nums font-semibold ${Number(ch.profit) >= 0 ? tw.green : tw.red}`}>{fmt(ch.profit)}</td>
                      <td className="px-2 py-1.5 text-right"><span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${Number(ch.marginPct) >= 20 ? "bg-[var(--pos-bg)] text-[var(--pos)] " : Number(ch.marginPct) >= 10 ? "bg-[var(--warn-bg)] text-[var(--warn)] " : "bg-[var(--neg-bg)] text-[var(--neg)] "}`}>{Number(ch.marginPct).toFixed(1)}%</span></td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </Card>

            <Card title={t("dash.newVsReturn")}>
              <div className="flex items-center gap-4">
                <ChartFrame className="h-32 w-32 shrink-0"><PieChart>
                  <Pie {...CHART_NO_ANIM} data={[{ name: "ເກົ່າ", value: Number(analytics.newVsReturn?.returningRevenue || 0) }, { name: "ໃໝ່", value: Number(analytics.newVsReturn?.newRevenue || 0) }]} dataKey="value" cx="50%" cy="50%" innerRadius={30} outerRadius={52} strokeWidth={0}>
                    <Cell fill={C.blue} /><Cell fill={C.emerald} />
                  </Pie>
                </PieChart></ChartFrame>
                <div className="flex-1 space-y-3">
                  <div>
                    <div className={`flex items-center gap-1.5 text-xs ${tw.sub}`}><span className="h-2 w-2 rounded-full bg-[var(--brand)]" />{t("dash.oldCust")} ({analytics.newVsReturn?.returningCustomers || 0} ຄົນ)</div>
                    <p className={`text-lg font-bold ${tw.blue}`}>{fmt(analytics.newVsReturn?.returningRevenue)}</p>
                    <p className="text-[10px] text-[var(--muted)]">{pct(analytics.newVsReturn?.returnPct)}</p>
                  </div>
                  <div>
                    <div className={`flex items-center gap-1.5 text-xs ${tw.sub}`}><span className="h-2 w-2 rounded-full bg-[var(--pos)]" />{t("dash.newCust")} ({analytics.newVsReturn?.newCustomers || 0} ຄົນ)</div>
                    <p className={`text-lg font-bold ${tw.green}`}>{fmt(analytics.newVsReturn?.newRevenue)}</p>
                    <p className="text-[10px] text-[var(--muted)]">{pct(analytics.newVsReturn?.newPct)}</p>
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
                  <Tooltip {...CHART_NO_ANIM} content={<Tip />} />
                  <Bar {...CHART_NO_ANIM} dataKey="aov" name="AOV" fill={C.violet} radius={[3, 3, 0, 0]} />
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
                <div className="h-3 w-full rounded-full bg-[var(--surface-2)]">
                  <div className={`h-full rounded-full transition-all duration-700 ${Number(analytics.churn?.retentionRate || 0) >= 80 ? "bg-[var(--pos)]" : Number(analytics.churn?.retentionRate || 0) >= 60 ? "bg-[var(--warn)]" : "bg-[var(--neg)]"}`} style={{ width: `${Math.min(Number(analytics.churn?.retentionRate || 0), 100)}%` }} />
                </div>
              </div>
              <div className="mt-3">
                <div className="flex justify-between text-xs mb-1"><span className={tw.sub}>{t("dash.churnRate")}</span><span className={`font-bold ${tw.red}`}>{pct(analytics.churn?.churnRate)}</span></div>
                <div className="h-3 w-full rounded-full bg-[var(--surface-2)]">
                  <div className="h-full rounded-full bg-[var(--neg)] transition-all duration-700" style={{ width: `${Math.min(Number(analytics.churn?.churnRate || 0), 100)}%` }} />
                </div>
              </div>
            </Card>
          </div>

        </>)}
        {/* ═══════════════════════════════════════════════════════════
            SECTION 14: SALES MANAGER VIEW
        ═══════════════════════════════════════════════════════════ */}
        <div id="sec-insights" className="scroll-mt-32 md:scroll-mt-14" />
        {managerInsights && (<>
          <SectionHeading eyebrow="Manager workspace" title="Team execution" description="Rep performance, coaching priorities and account coverage." />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
                      <tr className="bg-[var(--surface-2)]">
                        {["Sales", "M Actual", "M Target", "M Ach", "YTD Ach", "Customers", "Orders", "AOV"].map((head) => (
                          <th key={head} className={`px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)] ${head === "Sales" ? "text-left" : "text-right"}`}>{head}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--line-soft)] dark:divide-slate-800">
                      {repPerformance.slice(0, 8).map((item: any, i: number) => (
                        <tr key={i} className="hover:bg-[var(--surface-2)]">
                          <td className="px-2 py-2">
                            <p className={`text-xs font-semibold ${tw.head}`}>{item.saleName}</p>
                            <p className="text-[10px] text-[var(--muted)]">Month Gap {fmt(item.gap)}</p>
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">{fmt(item.actual)}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-[var(--muted)]">{fmt(item.target)}</td>
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
                        <div key={i} className="rounded-lg border border-rose-100 bg-[var(--neg-bg)]/60 p-3 dark:border-rose-900/30 dark:bg-rose-900/10">
                          <div className="flex items-center justify-between gap-3">
                            <p className={`text-sm font-semibold ${tw.head}`}>{item.saleName}</p>
                            <TonePill label={pct(item.achPct)} tone="rose" />
                          </div>
                        <p className="mt-1 text-[11px] text-[var(--muted)]">Month Gap {fmt(item.gap)} • Orders {item.orders} • AOV {fmt(item.avgOrderValue)}</p>
                        </div>
                      ))}
                    {needSupport.length === 0 && <Empty text={t("label.noData")} />}
                  </div>
                </div>
                <div>
                  <p className={`mb-2 text-[10px] font-semibold uppercase tracking-wider ${tw.sub}`}>{t("dash.topPerformers")}</p>
                  <div className="space-y-2">
                    {topPerformers.map((item: any, i: number) => (
                        <div key={i} className="rounded-lg border border-[var(--line)] bg-[var(--pos-bg)]/60 p-3 dark:border-emerald-900/30 dark:bg-emerald-900/10">
                          <div className="flex items-center justify-between gap-3">
                            <p className={`text-sm font-semibold ${tw.head}`}>{item.saleName}</p>
                            <TonePill label={pct(item.achPct)} tone="emerald" />
                          </div>
                        <p className="mt-1 text-[11px] text-[var(--muted)]">Month Actual {fmt(item.actual)} • Customers {item.customers} • Orders {item.orders}</p>
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
                    <tr className="bg-[var(--surface-2)]">
                      {["Sales", "Revenue", "GP%", "Disc%", "Customers", "Orders", "AOV"].map((head) => (
                        <th key={head} className={`px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)] ${head === "Sales" ? "text-left" : "text-right"}`}>{head}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--line-soft)] dark:divide-slate-800">
                    {salesperson360.slice(0, 8).map((item: any, i: number) => (
                      <tr key={i} className="hover:bg-[var(--surface-2)]">
                        <td className="px-2 py-2">
                          <p className={`text-xs font-semibold ${tw.head}`}>{item.saleName}</p>
                          <p className="text-[10px] text-[var(--muted)]">Customer value {fmt(item.avgCustomerValue)}</p>
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
                    <tr className="bg-[var(--surface-2)]">
                      {["Branch", "Revenue", "GP%", "Customers", "Orders", "AOV"].map((head) => (
                        <th key={head} className={`px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)] ${head === "Branch" ? "text-left" : "text-right"}`}>{head}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--line-soft)] dark:divide-slate-800">
                    {branchPerformance.slice(0, 8).map((item: any, i: number) => (
                      <tr key={i} className="hover:bg-[var(--surface-2)]">
                        <td className="px-2 py-2">
                          <p className={`text-xs font-semibold ${tw.head}`}>{item.branchName}</p>
                          <p className="text-[10px] text-[var(--muted)]">Profit {fmt(item.profit)}</p>
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
                    <th className="px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">Day</th>
                    {heatmapHours.map((hour: string) => (
                      <th key={hour} className="px-1 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">{hour}</th>
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

          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            <Card title={t("dash.custBuyingPower")}>
              <div className="grid grid-cols-2 gap-2">
                {customerSegments.map((item: any, i: number) => (
                  <div key={i} className="rounded-lg bg-[var(--surface-2)] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className={`text-xs font-semibold ${tw.head}`}>{item.segment}</p>
                      <TonePill label={`${Number(item.sharePct || 0).toFixed(0)}%`} tone={item.segment === "VIP" ? "emerald" : item.segment === "Growth" ? "blue" : item.segment === "Core" ? "amber" : "rose"} />
                    </div>
                    <p className="mt-2 text-lg font-bold text-[var(--ink)]">{item.customers}</p>
                    <p className="text-[10px] text-[var(--muted)]">Revenue {fmt(item.revenue)}</p>
                  </div>
                ))}
              </div>
              {customerSegments.length === 0 && <Empty text={t("label.noData")} />}
            </Card>

            <Card title={t("dash.topBuyers")}>
              <div className="space-y-2">
                {topBuyers.map((item: any, i: number) => (
                  <div key={i} className="rounded-lg border border-[var(--line-soft)] p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className={`truncate text-sm font-semibold ${tw.head}`}>{item.customerName}</p>
                        <p className="text-[10px] text-[var(--muted)]">{item.customerCode} • {item.orders} orders • {item.activeMonths} months</p>
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
                  <div key={i} className="rounded-lg border border-amber-100 bg-[var(--warn-bg)]/60 p-3 dark:border-amber-900/30 dark:bg-amber-900/10">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className={`truncate text-sm font-semibold ${tw.head}`}>{item.customerName}</p>
                        <p className="text-[10px] text-[var(--muted)]">{item.segment} • Avg/Month {fmt(item.avgMonthlyRevenue)}</p>
                      </div>
                      <span className={`text-sm font-bold tabular-nums ${tw.amber}`}>{fmt(item.potentialGap)}</span>
                    </div>
                    <p className="mt-2 text-[11px] text-[var(--muted)]">Current month {fmt(item.currentMonthRevenue)} • follow-up ເພື່ອດຶງ spend ກັບຄືນ</p>
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
                  <div key={i} className="rounded-lg border border-[var(--line-soft)] p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className={`truncate text-sm font-semibold ${tw.head}`}>{item.customerName}</p>
                        <p className="text-[10px] text-[var(--muted)]">{item.segment} • Avg/Month {fmt(item.avgMonthlyRevenue)}</p>
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
                <div key={i} className={`rounded-[var(--r-md)] border p-4 ${item.priority === "high" ? "border-[var(--neg)] bg-[var(--neg-bg)]/70 dark:border-rose-900/40 dark:bg-rose-900/10" : "border-[var(--line)] bg-[var(--info-bg)]/70 dark:border-blue-900/40 dark:bg-blue-900/10"}`}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className={`text-sm font-semibold ${tw.head}`}>{item.title}</p>
                    <TonePill label={item.priority === "high" ? "High" : "Medium"} tone={item.priority === "high" ? "rose" : "blue"} />
                  </div>
                  <p className="text-xs leading-relaxed text-[var(--muted)]">{item.detail}</p>
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
          <SectionHeading eyebrow="Growth strategy" title="Owner priorities" description="Whitespace, revenue risk and the next best growth actions." />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Kpi label="Growth Gap" value={fmt(ownerFocus.whitespaceGap)} sub={`${ownerFocus.opportunityProvinces || 0} ແຂວງຍັງຕ່ຳກວ່າເປົ້າ`} badge={thresholdBadge(Number(ownerFocus.whitespaceGap || 0) <= 0)} />
            <Kpi label="Revenue At Risk" value={fmt(ownerFocus.lostRevenue)} sub={`${ownerFocus.lostCustomers || 0} ລູກຄ້າຢຸດຊື້ເດືອນນີ້`} badge={thresholdBadge(Number(ownerFocus.lostRevenue || 0) <= Number(ownerFocus.reactivatedRevenue || 0))} />
            <Kpi label="Reactivated Rev" value={fmt(ownerFocus.reactivatedRevenue)} sub={`${ownerFocus.reactivatedCustomers || 0} ລູກຄ້າກັບຄືນ`} badge={thresholdBadge(Number(ownerFocus.reactivatedRevenue || 0) > 0)} />
            <Kpi label="Best Channel" value={bestChannel ? `${Number(bestChannel.marginPct || 0).toFixed(1)}%` : "-"} sub={bestChannel ? `${bestChannel.channel} • share ${Number(bestChannel.sharePct || 0).toFixed(1)}%` : "-"} ach={bestChannel ? Number(bestChannel.marginPct || 0) : undefined} barTone={Number(bestChannel?.marginPct || 0) >= 18 ? "pos" : "warn"} badge={null} />
          </div>

          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            <Card title={t("dash.whitespace")}>
              <div className="space-y-3">
                {whitespaceProvinces.map((item: any, i: number) => (
                  <div key={i} className="rounded-lg border border-[var(--line-soft)] p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className={`truncate text-sm font-semibold ${tw.head}`}>{item.province}</p>
                        <p className="text-[10px] text-[var(--muted)]">Actual {fmt(item.actual)} / Target {fmt(item.target)}</p>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${Number(item.achPct || 0) >= 90 ? "bg-[var(--info-bg)] text-[var(--brand)] " : "bg-[var(--warn-bg)] text-[var(--warn)] "}`}>{pct(item.achPct)}</span>
                    </div>
                    <div className="mt-2 h-1.5 w-full rounded-full bg-[var(--surface-2)]">
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
                  <div key={i} className="flex items-center justify-between gap-3 rounded-lg bg-[var(--surface-2)] p-3">
                    <div className="min-w-0">
                      <p className={`truncate text-sm font-semibold ${tw.head}`}>{item.customerName}</p>
                      <p className="text-[10px] text-[var(--muted)]">{item.customerCode} • {item.orders} orders ເດືອນກ່ອນ</p>
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
                  <div key={i} className="rounded-lg bg-[var(--surface-2)] p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className={`truncate text-sm font-semibold ${tw.head}`}>{item.customerName}</p>
                        <p className="text-[10px] text-[var(--muted)]">{item.customerCode} • ຫາຍໄປ {item.idleMonths} ເດືອນ</p>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold bg-[var(--pos-bg)] text-[var(--pos)] `}>Return</span>
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
                  <div key={i} className="rounded-lg border border-[var(--line-soft)] p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className={`truncate text-sm font-semibold ${tw.head}`}>{item.channel}</p>
                        <p className="text-[10px] text-[var(--muted)]">Revenue {fmt(item.revenue)} • Share {Number(item.sharePct || 0).toFixed(1)}%</p>
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
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {recommendations.map((item: any, i: number) => (
                <div key={i} className={`rounded-[var(--r-md)] border p-4 ${item.priority === "high" ? "border-[var(--neg)] bg-[var(--neg-bg)]/70 dark:border-rose-900/40 dark:bg-rose-900/10" : "border-[var(--line)] bg-[var(--info-bg)]/70 dark:border-blue-900/40 dark:bg-blue-900/10"}`}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className={`text-sm font-semibold ${tw.head}`}>{item.title}</p>
                    <TonePill label={item.priority === "high" ? "High" : "Medium"} tone={item.priority === "high" ? "rose" : "blue"} />
                  </div>
                  <p className="text-xs leading-relaxed text-[var(--muted)]">{item.detail}</p>
                </div>
              ))}
              {recommendations.length === 0 && <Empty text={t("label.noData")} />}
            </div>
          </Card>
        </>)}

        {/* ═══════════════════════════════════════════════════════════
            SECTION 16: SYSTEM HEALTH / DATA FRESHNESS
        ═══════════════════════════════════════════════════════════ */}
        <div id="sec-health" className="scroll-mt-32 md:scroll-mt-14" />
        <Card title={t("dash.systemHealth")}>
          <p className={`mb-3 text-xs ${tw.sub}`}>{t("dash.systemHealthDesc")}</p>
          <div className="flex flex-wrap items-center gap-6">
            <div className="flex items-center gap-3">
              <Database size={20} className="text-[var(--brand)]" />
              <div>
                <p className={`text-xs ${tw.sub}`}>{t("dash.updatedAt")}</p>
                <p className={`text-xs font-semibold ${tw.head}`}>{d.updatedAt ? d.updatedAt.toLocaleString() : "—"}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className={`h-2.5 w-2.5 rounded-full ${d.refreshing ? "animate-pulse bg-[var(--warn)]" : "bg-[var(--pos)]"}`} />
              <div>
                <p className={`text-xs ${tw.sub}`}>{t("dash.refreshing")}</p>
                <p className={`text-xs font-semibold ${tw.head}`}>{d.refreshing ? t("app.loading") : "OK"}</p>
              </div>
            </div>
            <button
              onClick={() => d.load()}
              disabled={d.refreshing}
              className="ml-auto inline-flex items-center gap-2 rounded-lg bg-[var(--brand-deep)] px-4 py-2 text-xs font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50 print:hidden"
            >
              <RefreshCw size={14} className={d.refreshing ? "animate-spin" : ""} />
              {t("dash.refreshData")}
            </button>
          </div>

          {/* Source freshness — newest record in each upstream table. */}
          {sync && (
            <div className="mt-4 grid grid-cols-2 gap-3 border-t border-[var(--line-soft)] pt-4 sm:grid-cols-4">
              {[
                { label: t("dash.saleDetailLatest"), value: sync.sale_detail?.latest || "—", hint: `${compact(sync.sale_detail?.rows || 0)} rows` },
                { label: t("dash.monthlyCovers"), value: sync.sale_monthly?.latest_month ? `${sync.sale_monthly.latest_month}/${sync.sale_monthly.latest_year}` : "—" },
                { label: t("dash.arBills"), value: `${compact(sync.ar_aging?.rows || 0)}`, hint: compact(sync.ar_aging?.balance || 0) },
                { label: t("dash.targetYear"), value: sync.targets?.latest_year ? String(sync.targets.latest_year) : "—" },
              ].map((item, i) => (
                <div key={i} className="rounded-xl bg-[var(--surface-2)]/70 px-3 py-2.5">
                  <p className={`text-[10px] font-semibold uppercase tracking-wider ${tw.sub}`}>{item.label}</p>
                  <p className={`text-sm font-bold ${tw.head}`}>{item.value}</p>
                  {item.hint ? <p className={`text-[10px] ${tw.sub}`}>{item.hint}</p> : null}
                </div>
              ))}
            </div>
          )}
        </Card>

        </>)}

        {/* ══════════════════════════════════════════════════════════════
            TAB: LAST MONTH (ເດືອນກ່ອນ)
        ══════════════════════════════════════════════════════════════ */}
        {tab === "lastMonth" && (<>
          {renderFocusSummary(lastMonthAch, lastMonthCash, lastMonthCredit, lastMonthQuality)}

          {/* Trend chart highlighting last month */}
          <Card title={`ແນວໂນ້ມ — ${prevTrend.name || "ເດືອນກ່ອນ"} ທຽບປີກ່ອນ`}>
            <ChartFrame className="h-56">
              <BarChart data={trend.map((t: any, i: number) => ({ ...t, highlight: i === prevMonthIdx ? Number(t.actual || 0) : 0 }))} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke={isDark ? "#1e293b" : "#f1f5f9"} />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v: number) => compact(v)} />
                <Tooltip {...CHART_NO_ANIM} content={<Tip />} />
                <Bar {...CHART_NO_ANIM} dataKey="actual" name={`${d.year}`} fill="#cbd5e1" radius={[3, 3, 0, 0]} />
                <Bar {...CHART_NO_ANIM} dataKey="highlight" name={prevTrend.name || "Focus"} fill={C.blue} radius={[3, 3, 0, 0]} />
                <Bar {...CHART_NO_ANIM} dataKey="lastYear" name={`${Number(d.year) - 1}`} fill={C.amber} radius={[3, 3, 0, 0]} />
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
                <tr key={i} className="hover:bg-[var(--surface-2)]">
                  <td className="px-2 py-1.5 text-xs text-[var(--muted)]">{i + 1}</td>
                  <td className="px-2 py-1.5 text-xs"><p className={`font-medium ${tw.head}`}>{c.name}</p><p className="text-[10px] text-[var(--muted)]">{c.code}</p></td>
                  <td className={`px-2 py-1.5 text-right text-xs font-bold tabular-nums ${tw.blue}`}>{fmt(c.revenue)}</td>
                  <td className="px-2 py-1.5 text-right text-xs tabular-nums text-[var(--muted)]">{c.orders}</td>
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
          {/* Momentum strip */}
          <div className="ribbon flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-[var(--r-lg)] px-4 py-3.5 text-white">
            <div className="flex items-center gap-2.5">
              <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${onTrack ? "bg-[var(--pos-bg)] text-[var(--pos)] " : "bg-[var(--warn-bg)] text-[var(--warn)] "}`}>
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

          {/* Daily trend if available */}
          {exec && (exec.dailyTrend || []).length > 0 && (
            <Card title={`${t("section.dailySales")} — ${curTrend.name || "ເດືອນນີ້"}`}>
              <ChartFrame className="h-48">
                <BarChart data={exec.dailyTrend} barSize={14}>
                  <CartesianGrid strokeDasharray="3 3" stroke={isDark ? "#1e293b" : "#f1f5f9"} />
                  <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v: string) => fmtDayMonth(v)} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v: number) => compact(v)} />
                  <Tooltip {...CHART_NO_ANIM} content={<Tip />} /><Bar {...CHART_NO_ANIM} dataKey="amount" name={t("label.actual")} fill={C.blue} radius={[3, 3, 0, 0]} />
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
                <Tooltip {...CHART_NO_ANIM} content={<Tip />} />
                <Bar {...CHART_NO_ANIM} dataKey="actual" name={`${d.year}`} fill="#cbd5e1" radius={[3, 3, 0, 0]} />
                <Bar {...CHART_NO_ANIM} dataKey="highlight" name={curTrend.name || "Focus"} fill={C.blue} radius={[3, 3, 0, 0]} />
                <Bar {...CHART_NO_ANIM} dataKey="lastYear" name={`${Number(d.year) - 1}`} fill={C.amber} radius={[3, 3, 0, 0]} />
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
                <tr key={i} className="hover:bg-[var(--surface-2)]">
                  <td className="px-2 py-1.5 text-xs text-[var(--muted)]">{i + 1}</td>
                  <td className="px-2 py-1.5 text-xs"><p className={`font-medium ${tw.head}`}>{c.name}</p><p className="text-[10px] text-[var(--muted)]">{c.code}</p></td>
                  <td className={`px-2 py-1.5 text-right text-xs font-bold tabular-nums ${tw.blue}`}>{fmt(c.revenue)}</td>
                  <td className="px-2 py-1.5 text-right text-xs tabular-nums text-[var(--muted)]">{c.orders}</td>
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

/**
 * A Salesforce dashboard component: name and optional strapline in the header,
 * the visual in the body, and a footer that leads to the report the numbers
 * came from. `to` is what turns a tile into a component — without a report
 * behind it there is nothing to link to and no menu worth opening, so both the
 * footer and the kebab stay off rather than being drawn as dead chrome.
 */
function Card({
  title,
  subtitle,
  icon,
  to,
  toLabel,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  to?: string;
  toLabel?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="sf-widget min-h-0">
      <div className="sf-widget-hd">
        <div className="min-w-0 flex-1">
          <h3 className="sf-widget-title">{icon}{title}</h3>
          {subtitle && <p className="sf-widget-sub">{subtitle}</p>}
        </div>
        {action}
        {to && (
          <Kebab
            align="right"
            items={[
              { label: toLabel || "View report", icon: <ArrowUpRight size={13} />, href: to },
              { label: "Open in new tab", icon: <ArrowUpRight size={13} />, href: to, newTab: true },
            ]}
          />
        )}
      </div>
      <div className="sf-widget-bd">{children}</div>
      {to && (
        <div className="sf-widget-ft">
          <Link href={to} className="sf-viewreport">
            {toLabel || "View report"} <ChevronRight size={11} />
          </Link>
        </div>
      )}
    </section>
  );
}

type KebabItem = {
  label?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  href?: string;
  newTab?: boolean;
  /** Shown right-aligned for a toggle, so the menu says what state it is in. */
  state?: string;
  sep?: boolean;
};

/** The ⋮ menu Lightning puts on every header. Closes on outside click or Esc. */
function Kebab({ items, align = "right" }: { items: KebabItem[]; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`sf-kebab ${open ? "is-on" : ""}`}
      >
        <MoreVertical size={14} />
      </button>
      {open && (
        <div className="sf-menu" role="menu" style={align === "left" ? { left: 0, right: "auto" } : undefined}>
          {items.map((item, index) =>
            item.sep ? (
              <div key={`sep-${index}`} className="sf-menu-sep" />
            ) : item.href ? (
              <Link
                key={item.label}
                href={item.href}
                target={item.newTab ? "_blank" : undefined}
                onClick={() => setOpen(false)}
                className="sf-menu-item"
                role="menuitem"
              >
                {item.icon}{item.label}
              </Link>
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                onClick={() => { item.onClick?.(); setOpen(false); }}
                className="sf-menu-item"
              >
                {item.icon}{item.label}
                {item.state && <span className="sf-menu-state">{item.state}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Salesforce's gauge: one number against its plan on a 240° arc. The arc is
 * drawn as two stroked paths rather than a chart library — it is a fixed shape,
 * and Recharts would cost a mount and a resize observer to draw the same thing.
 */
function Gauge({
  value,
  label,
  min = "0%",
  max = "100%",
  size = 148,
}: {
  value: number;
  label: string;
  min?: string;
  max?: string;
  size?: number;
}) {
  const pctValue = Math.max(0, Math.min(Number(value || 0), 100));
  const tone = value >= 100 ? "pos" : value >= 90 ? "warn" : "neg";
  const stroke = 11;
  const radius = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  // 240° of arc, opening at the bottom: from 150° round to 30°.
  const point = (deg: number) => {
    const rad = (deg * Math.PI) / 180;
    return `${cx + radius * Math.cos(rad)} ${cy + radius * Math.sin(rad)}`;
  };
  const arc = (fromDeg: number, toDeg: number) =>
    `M ${point(fromDeg)} A ${radius} ${radius} 0 ${toDeg - fromDeg > 180 ? 1 : 0} 1 ${point(toDeg)}`;
  const sweep = 240;
  const height = Math.round(size * 0.74);

  return (
    <div className="sf-gauge" style={{ width: size, height }}>
      <svg width={size} height={height} viewBox={`0 0 ${size} ${height}`} aria-hidden>
        <path d={arc(150, 150 + sweep)} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} strokeLinecap="round" />
        <path
          d={arc(150, 150 + Math.max(sweep * (pctValue / 100), 0.01))}
          fill="none"
          stroke={`var(--${tone})`}
          strokeWidth={stroke}
          strokeLinecap="round"
        />
      </svg>
      <div className="sf-gauge-face">
        <span className="sf-gauge-value" style={{ color: `var(--${tone})` }}>{Number(value || 0).toFixed(1)}%</span>
        <span className="sf-gauge-label">{label}</span>
      </div>
      <div className="sf-gauge-ends absolute inset-x-1 bottom-0"><span>{min}</span><span>{max}</span></div>
    </div>
  );
}

function SectionHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <div className="mb-3 mt-6 flex items-end justify-between gap-4 border-b border-[var(--line-soft)] pb-2">
      <div className="min-w-0">
        <p className="eyebrow">{eyebrow}</p>
        <h2 className="text-[15px] font-bold tracking-tight text-[var(--ink)]">{title}</h2>
        <p className="page-sub">{description}</p>
      </div>
      <span className="hidden h-px w-24 bg-gradient-to-r from-[var(--accent)] to-transparent sm:block" />
    </div>
  );
}

/**
 * `ach` drives the pill and the bar the way an achievement does: 100% is good.
 * Metrics that are not an achievement (YoY, GP %) pass `badge` to replace the
 * pill — or `badge={null}` to drop it — and `barTone` to colour the bar on
 * their own threshold instead of the 90/100 one.
 */
function Kpi({
  label,
  value,
  sub,
  ach,
  badge,
  barTone,
  loading = false,
  featured = false,
}: {
  label: string;
  value: string;
  sub: string;
  ach?: number;
  badge?: { text: string; tone: "pos" | "warn" | "neg" } | null;
  barTone?: "pos" | "warn" | "neg";
  color?: string;
  loading?: boolean;
  featured?: boolean;
}) {
  const scored = ach == null ? null : ach >= 100 ? "pos" : ach >= 90 ? "warn" : "neg";
  const shade = barTone || scored;
  const tone = shade ? `pill-${shade}` : "";
  const fill = shade ? `is-${shade}` : "";
  const width = ach == null ? 0 : Math.min(Math.abs(ach), 100);

  const marker = loading
    ? null
    : badge === null
      ? null
      : badge
        ? <span className={`pill pill-${badge.tone}`}>{badge.text}</span>
        : ach != null
          ? <span className={`pill ${tone}`}>{pct(ach)}</span>
          : null;

  if (featured) return (
    <div className="card stat stat-featured flex min-h-44 flex-col justify-between p-4 sm:col-span-2 sm:row-span-2 lg:col-span-3 xl:col-span-2">
      <div className="flex items-start justify-between gap-2">
        <span className="stat-label">{label}</span>
        {marker}
      </div>
      <div className="py-3">
        <p className="stat-value">{value}</p>
        <p className="stat-sub">{sub}</p>
      </div>
      <div>
        <div className="mb-1 flex justify-between text-[10px] font-semibold uppercase tracking-wider text-white/45">
          <span>Progress</span><span className="num">{width.toFixed(0)}%</span>
        </div>
        <div className="bar"><div className="bar-fill" style={{ width: `${width}%` }} /></div>
      </div>
    </div>
  );

  return (
    <div className="card stat p-3.5">
      <div className="flex items-start justify-between gap-2">
        <span className="stat-label">{label}</span>
        {marker}
      </div>
      {loading ? (
        <>
          <div className="skeleton mt-2 h-6 w-28 rounded-[var(--r-xs)]" />
          <div className="skeleton mt-2 h-3 w-20 rounded-[var(--r-xs)]" />
          <div className="skeleton mt-3 h-[5px] w-full rounded-full" />
        </>
      ) : (
        <>
          <p className="stat-value truncate">{value}</p>
          <p className="stat-sub truncate">{sub}</p>
          {ach != null && (
            <div className="bar mt-2.5"><div className={`bar-fill ${fill}`} style={{ width: `${width}%` }} /></div>
          )}
        </>
      )}
    </div>
  );
}

function Progress({ label, v }: { label: string; v: number }) {
  const fill = v >= 100 ? "is-pos" : v >= 90 ? "is-warn" : "is-neg";
  return (
    <div className="mb-2.5 last:mb-0">
      <div className="flex items-baseline justify-between text-[11.5px]">
        <span className={tw.sub}>{label}</span>
        <span className={`num font-bold ${tw.head}`}>{v.toFixed(1)}%</span>
      </div>
      <div className="bar mt-1"><div className={`bar-fill ${fill}`} style={{ width: `${Math.min(v, 100)}%` }} /></div>
    </div>
  );
}

function Rank({ i, label, value, ach }: { i: number; label: string; value: string; ach: number }) {
  const tone = ach >= 100 ? "pill-pos" : ach >= 90 ? "pill-warn" : "pill-neg";
  const fill = ach >= 100 ? "is-pos" : ach >= 90 ? "is-warn" : "is-neg";
  return (
    <div className="flex items-center gap-2.5 py-1">
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--r-xs)] text-[11px] font-bold"
        style={{
          background: i === 0 ? "var(--warn-bg)" : "var(--surface-2)",
          color: i === 0 ? "var(--warn)" : "var(--muted)",
        }}
      >
        {i + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className={`truncate text-[12.5px] font-medium ${tw.head}`}>{label}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            <span className={`num text-[11.5px] ${tw.sub}`}>{value}</span>
            <span className={`pill ${tone}`}>{pct(ach)}</span>
          </span>
        </div>
        <div className="bar mt-1" style={{ height: 3 }}>
          <div className={`bar-fill ${fill}`} style={{ width: `${Math.min(ach, 100)}%` }} />
        </div>
      </div>
    </div>
  );
}

function Mini({ label, value, cls = "" }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-[var(--r-sm)] border border-[var(--line-soft)] bg-[var(--surface-2)] p-2">
      <p className="text-[10px] font-medium text-[var(--muted)]">{label}</p>
      <p className={`num mt-0.5 text-[13px] font-bold ${cls || tw.head}`}>{value}</p>
    </div>
  );
}

function Pill({ label, value, accent, icon }: { label: string; value: string; accent?: string; icon?: React.ReactNode }) {
  const cls = accent === "emerald" ? tw.green : accent === "amber" ? tw.amber : accent === "blue" ? tw.blue : accent === "red" ? tw.red : tw.head;
  return (<div className="flex items-center gap-1 text-xs">{icon && <span className="text-[var(--muted)]">{icon}</span>}<span className={tw.sub}>{label}</span><span className={`ml-0.5 font-semibold ${cls}`}>{value}</span></div>);
}

function Sep() { return <div className="hidden h-5 w-px bg-[var(--line)] sm:block" />; }

function Empty({ text = "ບໍ່ມີຂໍ້ມູນ" }: { text?: string }) {
  return <p className="py-5 text-center text-[11.5px] text-[var(--muted)]">{text}</p>;
}

function TBL({ heads, children }: { heads: string[]; children: React.ReactNode }) {
  return (
    <div className="tbl-scroll">
      <table className="tbl" style={{ minWidth: 420 }}>
        <thead><tr>{heads.map((h, i) => <th key={i} style={i < 2 ? { textAlign: "left" } : undefined}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function TonePill({ label, tone = "blue" }: { label: string; tone?: string }) {
  const cls = tone === "emerald" ? "pill-pos" : tone === "rose" ? "pill-neg" : tone === "amber" ? "pill-warn" : "";
  return <span className={`pill ${cls}`}>{label}</span>;
}
