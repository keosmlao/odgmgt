/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "@/service/api";

const FILTERS_CACHE_KEY = "dashboard:filters";
const FILTERS_TTL = 600_000;
const DASHBOARD_TTL = 300_000;

export function readSessionCache<T>(key: string, ttl: number): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (Date.now() - Number(parsed.ts || 0) > ttl) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    return (parsed.data as T) ?? null;
  } catch {
    return null;
  }
}

export function writeSessionCache<T>(key: string, data: T) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    // ignore client cache write failures
  }
}

function dashboardCacheKey(year: string, bu: string, channel: string, province: string) {
  return `dashboard:owner-sales:${year}|${bu}|${channel}|${province}`;
}

export function currency(value: any) {
  return Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function currencyM(value: any) {
  return `${(Number(value || 0) / 1000000).toFixed(1)}M`;
}

export function pct(actual: any, target: any) {
  const a = Number(actual || 0);
  const t = Number(target || 0);
  return t ? (a / t) * 100 : 0;
}

export function monthName(month: any) {
  const labels = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return labels[Number(month || 1) - 1] || "-";
}

export function statusFromPct(value: any) {
  const amount = Number(value || 0);
  if (amount >= 100) return { label: "Good", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" };
  if (amount >= 90) return { label: "Watch", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" };
  return { label: "Risk", cls: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300" };
}

function mapOptionRows(rows: any[]) {
  return (rows || []).map((row: any) => ({
    value: String(row.code ?? row.id ?? row.value ?? row.name ?? "ALL"),
    label: row.name_1 || row.name || String(row.code ?? row.id ?? row.value ?? "ALL"),
  }));
}

function normalizeDashboard(payload: any) {
  const kpi = payload?.kpi || {};
  const ytdAch = pct(kpi.ytd_actual, kpi.ytd_target);
  const thisMonthAch = pct(kpi.this_month_actual, kpi.this_month_target);
  const lastMonthAch = pct(kpi.last_month_actual, kpi.last_month_target);
  const yoy = pct(Number(kpi.ytd_actual || 0) - Number(kpi.ytd_last_year || 0), kpi.ytd_last_year);
  const monthIndex = new Date().getMonth() + 1;
  const forecastEOY = monthIndex > 0 ? (Number(kpi.ytd_actual || 0) / monthIndex) * 12 : 0;
  const eoyGap = Number(kpi.ytd_target || 0) - forecastEOY;
  const gapThisMonth = Math.max(0, Number(kpi.this_month_target || 0) - Number(kpi.this_month_actual || 0));
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = Math.max(daysInMonth - now.getDate(), 1);
  const territory = payload?.territory || {};
  const coverageData = territory.coverage || [];
  const coverageTotal = Math.round(Number(coverageData[0]?.value || 0));

  const buChannelRows = payload?.structure?.buChannel || [];
  const buSet = new Set<string>();
  const chSet = new Set<string>();
  const pivot = new Map<string, Map<string, number>>();
  for (const row of buChannelRows) {
    const bu = row.bu ?? "UNKNOWN";
    const ch = row.channel ?? "UNKNOWN";
    const amt = Number(row.amount || 0);
    buSet.add(bu);
    chSet.add(ch);
    if (!pivot.has(bu)) pivot.set(bu, new Map());
    pivot.get(bu)!.set(ch, (pivot.get(bu)!.get(ch) || 0) + amt);
  }

  return {
    ...payload,
    buList: [...buSet],
    channelList: [...chSet],
    pivot,
    ytdAch, thisMonthAch, lastMonthAch, yoy,
    forecastEOY, eoyGap, gapThisMonth, daysLeft,
    requiredPerDay: gapThisMonth / daysLeft,
    coverageData, coverageTotal,
  };
}

export function useDashboard() {
  const initialYear = String(new Date().getFullYear());
  const cachedFilters = readSessionCache<any>(FILTERS_CACHE_KEY, FILTERS_TTL);
  const initialDashboardCache = readSessionCache<any>(
    dashboardCacheKey(initialYear, "ALL", "ALL", "ALL"),
    DASHBOARD_TTL,
  );

  const [yearOptions, setYearOptions] = useState<string[]>(
    () => ((cachedFilters?.years || []).map(String).sort()),
  );
  const [buOptions, setBuOptions] = useState<any[]>(() => mapOptionRows(cachedFilters?.bu || []));
  const [channelOptions, setChannelOptions] = useState<any[]>(() => mapOptionRows(cachedFilters?.channels || []));
  const [provinceOptions, setProvinceOptions] = useState<any[]>(() => mapOptionRows(cachedFilters?.provinces || []));
  const [year, setYear] = useState(() => {
    const years = (cachedFilters?.years || []).map(String).sort();
    return years.includes(initialYear) ? initialYear : years[years.length - 1] || initialYear;
  });
  const [bu, setBu] = useState("ALL");
  const [channel, setChannel] = useState<string[]>(["ALL"]);
  const [province, setProvince] = useState<string[]>(["ALL"]);
  const [searchQuery, setSearchQuery] = useState("");
  const [data, setData] = useState<any>(
    () => (initialDashboardCache ? normalizeDashboard(initialDashboardCache) : null),
  );
  const dataRef = useRef(data);
  dataRef.current = data;
  const [loading, setLoading] = useState(!initialDashboardCache);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const filtersLoaded = useRef(false);

  // Load filters + dashboard data in parallel on first mount
  useEffect(() => {
    if (filtersLoaded.current) return;
    filtersLoaded.current = true;

    const currentYear = String(new Date().getFullYear());

    Promise.all([
      api.get("/dashboard/filters"),
      api.get("/dashboard/owner-sales", { params: { year: currentYear, bu: "ALL", channel: "ALL", province: "ALL" } }),
    ])
      .then(([filtersRes, dashRes]) => {
        // Process filters
        const f = filtersRes.data || {};
        writeSessionCache(FILTERS_CACHE_KEY, f);
        const years = (f.years || []).map(String).sort();
        setYearOptions(years);
        if (years.length) {
          setYear((cur: string) => years.includes(cur) ? cur : years[years.length - 1]);
        }
        setBuOptions(mapOptionRows(f.bu));
        setChannelOptions(mapOptionRows(f.channels));
        setProvinceOptions(mapOptionRows(f.provinces));

        // Process dashboard data
        writeSessionCache(
          dashboardCacheKey(currentYear, "ALL", "ALL", "ALL"),
          dashRes.data || {},
        );
        setData(normalizeDashboard(dashRes.data || {}));
      })
      .catch(() => {
        if (!initialDashboardCache) {
          setError("Unable to load dashboard");
        }
      })
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
    // Mount-only bootstrap. Do not depend on sessionStorage parse results — a fresh object
    // reference each render would re-run this effect every time and waste work.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-shot init
  }, []);

  // Reload only dashboard data when filters change (skip first mount)
  const isFirstRender = useRef(true);
  const load = useCallback(async () => {
    const channelParam = !channel.length || channel.includes("ALL") ? "ALL" : channel.join(",");
    const provinceParam = !province.length || province.includes("ALL") ? "ALL" : province.join(",");
    const cacheKey = dashboardCacheKey(year, bu, channelParam, provinceParam);
    const cached = readSessionCache<any>(cacheKey, DASHBOARD_TTL);

    if (cached) {
      setData(normalizeDashboard(cached));
    }

    if (!dataRef.current && !cached) setLoading(true);
    else setRefreshing(true);
    setError("");
    try {
      const params = {
        year,
        bu,
        channel: channelParam,
        province: provinceParam,
      };
      const response = await api.get("/dashboard/owner-sales", { params });
      writeSessionCache(cacheKey, response.data || {});
      setData(normalizeDashboard(response.data || {}));
    } catch (err: any) {
      if (!dataRef.current && !cached) {
        setError(err?.response?.data?.error || "Unable to load dashboard data");
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [year, bu, channel, province]);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    load();
  }, [load]);

  const buNameMap = useMemo(() => {
    return Object.fromEntries(buOptions.map((item: any) => [item.value, item.label]));
  }, [buOptions]);

  return {
    data, loading, refreshing, error, load,
    year, setYear: (v: any) => setYear(String(v)),
    bu, setBu,
    channel, setChannel,
    province, setProvince,
    searchQuery, setSearchQuery,
    yearOptions, buOptions, channelOptions, provinceOptions,
    buNameMap,
  };
}
