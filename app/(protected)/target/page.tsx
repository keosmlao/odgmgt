"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Search,
  X,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useLanguage } from "@/context/LanguageContext";
import api from "@/service/api";

/* ── Constants ── */
const MONTHS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DEFAULT_CHANNEL_LABELS: Record<string, string> = { "101": "Retail", "102": "Wholesale", "103": "Technician", "106": "Project", "107": "Online" };
const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = [2025, 2026, 2027];
const CH_BADGE: Record<string, string> = { Retail: "R", Wholesale: "W", Technician: "T", Project: "P", Online: "O" };

/* ── Helpers ── */
function fmtCurrency(n: number) { return Number(n || 0).toLocaleString(); }
function fmtInput(n: number) { const s = Number(n || 0); return Number.isNaN(s) ? "" : s.toLocaleString(); }
function parseInput(raw: string) { const c = String(raw || "").replace(/,/g, "").replace(/[^\d.-]/g, ""); const p = Number(c); return Number.isNaN(p) ? 0 : p; }
function normalizeMonths(months: any) { return MONTHS.map((_, index) => Number(months?.[index] || 0)); }
function sumMonths(months: any) { return normalizeMonths(months).reduce((sum, value) => sum + value, 0); }
function makeCellId(rowId: string, monthIdx: number) { return JSON.stringify([rowId, monthIdx]); }
function getRowMonths(row: any, overrides: any, year: number) {
  if (!row) return normalizeMonths([]);
  const baseMonths = normalizeMonths(row.months);
  const ym = overrides?.[String(year)] || {};
  if (Array.isArray(ym?.[row.id])) {
    return MONTHS.map((_, index) => {
      const overrideValue = ym[row.id]?.[index];
      return typeof overrideValue === "number"
        ? overrideValue
        : Number(overrideValue ?? baseMonths[index] ?? 0);
    });
  }
  return baseMonths;
}

export default function TargetSetup() {
  const STORAGE_KEY = "target-setup-bu-v1";
  const { user } = useAuth() || {};
  const router = useRouter();
  const { t } = useLanguage();
  const isBuManager = user?.role === "sale_bu_manager";

  /* ── State ── */
  const [selectedBU, setSelectedBU] = useState(() => { try { const raw = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null; const saved = raw ? JSON.parse(raw) : null; return saved?.selectedBU || "All"; } catch { return "All"; } });
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [buOptions, setBuOptions] = useState<any[]>([]);
  const [channelOptions, setChannelOptions] = useState<any[]>([]);
  const [targetData, setTargetData] = useState<any[]>([]);
  const [targetDataAll, setTargetDataAll] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [displayYear, setDisplayYear] = useState(CURRENT_YEAR);
  const [monthOverrides, setMonthOverrides] = useState<any>({});
  const [navLoading, setNavLoading] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [search, setSearch] = useState("");

  const availableYears = useMemo(() => { const ys = YEAR_OPTIONS.includes(CURRENT_YEAR) ? YEAR_OPTIONS : [...YEAR_OPTIONS, CURRENT_YEAR]; return ys.sort((a, b) => a - b); }, []);
  const showBuHeader = selectedBU !== "All";
  const canEditRows = selectedBU !== "All";

  const buMap = useMemo(() => { const m: Record<string, string> = {}; buOptions.forEach((b: any) => { m[b.code] = b.name; }); return m; }, [buOptions]);
  const channelLabelMap = useMemo(() => { if (channelOptions.length) { const m: Record<string, string> = {}; channelOptions.forEach((item: any) => { const code = item?.code ?? item?.id; if (code) m[String(code)] = item?.name || item?.name_1 || String(code); }); return m; } return DEFAULT_CHANNEL_LABELS; }, [channelOptions]);
  const allowedChannels = (user?.channel_codes || []).map((c: string) => channelLabelMap[String(c)] || String(c)).filter(Boolean);

  /* ── Effects ── */
  useEffect(() => { try { if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify({ selectedBU })); } catch {} }, [selectedBU]);
  useEffect(() => { api.get("/bu").then(({ data }) => { if (data.success && Array.isArray(data.data)) setBuOptions(data.data.map((item: any, idx: number) => ({ code: item.code || `BU-${idx}`, name: item.name_1 || item.name || item.code }))); }).catch(() => {}); }, []);
  useEffect(() => { api.get("/sale-channel").then(({ data }) => { if (data.success && Array.isArray(data.data)) setChannelOptions(data.data.map((item: any) => ({ code: item.code, name: item.name_1 || item.name || item.code }))); }).catch(() => setChannelOptions([])); }, []);

  const loadTargets = useCallback(async (year: number, cancelled?: () => boolean) => {
    const normalize = (rows: any[], defaultBuName?: string) => rows.map((item: any, idx: number) => {
      const yearVal = Number(item.year ?? item.target_year ?? year);
      const buCode = item.bu_code || item.bu || "ALL";
      const buName = defaultBuName || buMap[buCode] || buCode || `BU-${idx}`;
      const provinceName = item.province_name || (item.province_code === "ALL" ? "Nationwide" : item.province) || "Nationwide";
      const districtName = item.district_name || (item.district_code === "ALL" ? "All Districts" : item.district) || "All Districts";
      const channelCode = item.sale_channel || item.channel;
      const channelName = channelLabelMap[channelCode] || item.channel_name || channelCode || "Channel";
      const months = normalizeMonths([item.jan || 0, item.feb || 0, item.mar || 0, item.apr || 0, item.may || 0, item.jun || 0, item.jul || 0, item.aug || 0, item.sep || 0, item.oct || 0, item.nov || 0, item.dec || 0]);
      return {
        id: item.id || `${buCode}-${yearVal}-${channelCode}-${provinceName}-${districtName}`,
        bu: buName,
        buCode,
        channel: channelName,
        channelCode,
        location: provinceName,
        district: districtName,
        provinceCode: item.province_code || item.province || "ALL",
        districtCode: item.district_code || item.district || "ALL",
        target: sumMonths(months),
        months,
        year: yearVal,
      };
    });

    setLoading(true);
    try {
      const [byBuRes, allRes] = await Promise.all([
        api.get("/targets-by-bu", { params: { year } }),
        api.get("/targets", { params: { year, aggregate: 1 } }),
      ]);
      if (cancelled?.()) return;
      const byBu = byBuRes.data?.success && Array.isArray(byBuRes.data.data) ? normalize(byBuRes.data.data) : [];
      const all = allRes.data?.success && Array.isArray(allRes.data.data) ? normalize(allRes.data.data, "All BU") : [];
      setTargetData(byBu);
      setTargetDataAll(all);
    } catch {
      if (cancelled?.()) return;
      setTargetData([]);
      setTargetDataAll([]);
    } finally {
      if (!cancelled?.()) setLoading(false);
    }
  }, [buMap, channelLabelMap]);

  useEffect(() => {
    let cancelled = false;
    void loadTargets(displayYear, () => cancelled);
    return () => { cancelled = true; };
  }, [displayYear, loadTargets]);

  /* ── Derived data ── */
  const filteredRows = useMemo(() => {
    let rows = selectedBU === "All" ? targetDataAll : targetData.filter((d) => d.bu === selectedBU);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter((r) => r.location?.toLowerCase().includes(q) || r.district?.toLowerCase().includes(q) || r.channel?.toLowerCase().includes(q));
    }
    return rows;
  }, [selectedBU, targetData, targetDataAll, search]);

  const groupedData = useMemo(() => {
    const groups: any = {};
    filteredRows.forEach((row) => {
      if (isBuManager && allowedChannels.length && !allowedChannels.includes(row.channel)) return;
      const buKey = selectedBU === "All" ? "ALL" : row.bu;
      if (!groups[buKey]) groups[buKey] = {};
      if (!groups[buKey][row.channel]) groups[buKey][row.channel] = [];
      groups[buKey][row.channel].push(row);
    });
    return groups;
  }, [selectedBU, filteredRows, isBuManager, allowedChannels]);

  const buHasData = useMemo(() => { const m: Record<string, boolean> = {}; targetData.forEach((r) => { if (r?.bu) m[r.bu] = true; }); return m; }, [targetData]);
  const editableRowMap = useMemo(() => {
    const map = new Map<string, any>();
    targetData.forEach((row) => map.set(String(row.id), row));
    return map;
  }, [targetData]);
  const grandTotal = filteredRows.reduce((sum, row) => sum + sumMonths(getRowMonths(row, monthOverrides, displayYear)), 0);
  const pendingChanges = useMemo(() => {
    const yearOverrides = monthOverrides?.[String(displayYear)] || {};
    const changes: Array<{
      rowId: string;
      buCode: string;
      provinceCode: string;
      districtCode: string;
      channelCode: string;
      year: number;
      month: number;
      value: number;
    }> = [];

    Object.keys(yearOverrides).forEach((rowId) => {
      const row = editableRowMap.get(String(rowId));
      if (!row || Number(row.year) !== Number(displayYear)) return;
      const currentMonths = getRowMonths(row, monthOverrides, displayYear);
      const originalMonths = normalizeMonths(row.months);

      currentMonths.forEach((value, monthIdx) => {
        if (Number(value || 0) !== Number(originalMonths[monthIdx] || 0)) {
          changes.push({
            rowId: String(row.id),
            buCode: row.buCode,
            provinceCode: row.provinceCode || "ALL",
            districtCode: row.districtCode || "ALL",
            channelCode: row.channelCode,
            year: Number(row.year),
            month: monthIdx + 1,
            value: Number(value || 0),
          });
        }
      });
    });

    return changes;
  }, [displayYear, editableRowMap, monthOverrides]);
  const dirtyCellIds = useMemo(() => new Set(pendingChanges.map((item) => makeCellId(item.rowId, item.month - 1))), [pendingChanges]);
  const dirtyRowIds = useMemo(() => new Set(pendingChanges.map((item) => item.rowId)), [pendingChanges]);
  const pendingRowCount = dirtyRowIds.size;
  const isVientianeRow = (row: any) => row.provinceCode === "01" || (row.location || "").toLowerCase().includes("vientiane");
  const toggleExpand = (key: string) => setExpandedGroups((p) => ({ ...p, [key]: !p[key] }));
  const handleCreateNew = () => { setNavLoading(true); setTimeout(() => router.push("/target/new"), 50); };
  const resetCurrentYearChanges = () => {
    setMonthOverrides((prev: any) => {
      const next = { ...prev };
      delete next[String(displayYear)];
      return next;
    });
    setSaveFeedback(null);
  };
  const saveChanges = async () => {
    if (!pendingChanges.length) return;
    setSaveLoading(true);
    setSaveFeedback(null);
    try {
      for (const change of pendingChanges) {
        await api.post("/targets", {
          bu_code: change.buCode,
          province_code: change.provinceCode,
          district_code: change.districtCode,
          channel_code: change.channelCode,
          target: change.value,
          year: change.year,
          month: change.month,
        });
      }
      await loadTargets(displayYear);
      setMonthOverrides((prev: any) => {
        const next = { ...prev };
        delete next[String(displayYear)];
        return next;
      });
      setSaveFeedback({
        type: "success",
        text: `Saved ${pendingChanges.length} monthly changes.`,
      });
    } catch (error: any) {
      setSaveFeedback({
        type: "error",
        text: error?.response?.data?.message || "Unable to save changes.",
      });
    } finally {
      setSaveLoading(false);
    }
  };

  /* ── Month input cells ── */
  const MonthCells = ({ months, isParent = false, rowId }: { months: number[]; isParent?: boolean; rowId?: string }) => (
    <>
      {months.map((val, idx) => {
        const cellId = rowId ? makeCellId(rowId, idx) : "";
        const isDirty = rowId ? dirtyCellIds.has(cellId) : false;
        const editable = Boolean(rowId) && canEditRows && !saveLoading;
        return (
          <td key={idx} className={`border-b border-slate-100 px-1 py-0.5 text-right dark:border-slate-800 ${isParent ? "bg-slate-50/80 dark:bg-slate-800/40" : ""}`}>
            {isParent ? (
              <span className="block px-2 py-1 text-xs font-semibold tabular-nums text-slate-600 dark:text-slate-300">{fmtCurrency(val)}</span>
            ) : !editable ? (
              <span className={`block rounded-lg px-2 py-1.5 text-xs tabular-nums ${isDirty ? "bg-amber-50 font-semibold text-amber-700 dark:bg-amber-500/10 dark:text-amber-300" : "text-slate-700 dark:text-slate-200"}`}>
                {fmtCurrency(val)}
              </span>
            ) : (
              <div className="relative">
                <input
                  type="text"
                  value={fmtInput(val)}
                  onChange={(e) => {
                    if (!rowId) return;
                    const nv = parseInput(e.target.value);
                    setSaveFeedback(null);
                    setMonthOverrides((prev: any) => {
                      const next = { ...prev };
                      const yearKey = String(displayYear);
                      const ym = { ...(next[yearKey] || {}) };
                      const rm = normalizeMonths(months);
                      rm[idx] = nv;
                      ym[rowId] = rm;
                      next[yearKey] = ym;
                      return next;
                    });
                  }}
                  className={`w-full rounded-lg bg-transparent px-2 py-1.5 text-right text-xs tabular-nums text-slate-700 outline-none transition-all focus:bg-blue-50 focus:ring-2 focus:ring-blue-500/20 dark:text-slate-200 dark:focus:bg-blue-900/20 ${isDirty ? "bg-amber-50/80 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20" : ""}`}
                />
              </div>
            )}
          </td>
        );
      })}
    </>
  );

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-slate-50 text-slate-800 dark:bg-slate-950 dark:text-slate-200"
      style={{ fontFamily: '"Noto Sans Lao","Noto Sans",system-ui,sans-serif' }}
    >
      {/* ══ Header ══ */}
      <header className="shrink-0 border-b border-slate-200/80 bg-white px-5 py-3 dark:border-slate-800/80 dark:bg-slate-900">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-lg font-bold text-slate-900 dark:text-white">
              {t("sidebar.target")}
            </h1>
            <div className="flex items-center gap-2 rounded-xl bg-blue-50 px-3 py-1.5 dark:bg-blue-500/10">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-500">Total</span>
              <span className="text-sm font-bold tabular-nums text-blue-700 dark:text-blue-400">{fmtCurrency(grandTotal)}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <select
              value={displayYear}
              onChange={(e) => setDisplayYear(Number(e.target.value))}
              className="appearance-none rounded-xl border border-slate-200 bg-white py-2 pl-3 pr-8 text-sm font-medium outline-none transition-all focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            >
              {availableYears.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
            {pendingChanges.length > 0 && (
              <span className="rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                {pendingChanges.length} unsaved changes
              </span>
            )}
            <button
              onClick={resetCurrentYearChanges}
              disabled={saveLoading || pendingChanges.length === 0}
              className="flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <RotateCcw size={14} />
              Reset
            </button>
            <button
              onClick={saveChanges}
              disabled={saveLoading || pendingChanges.length === 0}
              className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm shadow-emerald-600/20 transition-all hover:bg-emerald-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saveLoading ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saveLoading ? "Saving..." : "Save Changes"}
            </button>

            <button
              onClick={handleCreateNew}
              disabled={navLoading}
              className="flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-sm shadow-blue-600/20 transition-all hover:bg-blue-700 active:scale-[0.98] disabled:opacity-60"
            >
              {navLoading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              {navLoading ? t("app.loading") : t("sidebar.target")}
            </button>
          </div>
        </div>
      </header>

      {/* ══ Filter bar ══ */}
      <div className="shrink-0 border-b border-slate-200/80 bg-white px-5 py-3 dark:border-slate-800/80 dark:bg-slate-900">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          {/* BU filter pills */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            <button
              onClick={() => setSelectedBU("All")}
              className={`shrink-0 rounded-xl px-4 py-2 text-xs font-semibold transition-all ${
                selectedBU === "All"
                  ? "bg-blue-600 text-white shadow-sm shadow-blue-600/20"
                  : "border border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              }`}
            >
              {t("app.all")}
            </button>
            {buOptions.map((bu: any) => {
              const disabled = !buHasData[bu.name];
              return (
                <button
                  key={bu.name}
                  onClick={() => setSelectedBU(bu.name)}
                  disabled={disabled}
                  className={`flex shrink-0 items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold transition-all ${
                    selectedBU === bu.name
                      ? "bg-blue-600 text-white shadow-sm shadow-blue-600/20"
                      : disabled
                        ? "border border-slate-100 text-slate-300 dark:border-slate-800 dark:text-slate-600"
                        : "border border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  }`}
                >
                  <span className={`flex h-5 w-5 items-center justify-center rounded-lg text-[10px] font-bold ${
                    selectedBU === bu.name ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                  }`}>
                    {bu.name?.charAt(0)?.toUpperCase() || "?"}
                  </span>
                  {bu.name}
                </button>
              );
            })}
          </div>

          {/* Right side: search + bulk edit */}
          <div className="flex items-center gap-2">
            {!canEditRows && (
              <span className="hidden rounded-xl bg-slate-100 px-3 py-2 text-[11px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300 md:inline-flex">
                Select one BU to edit monthly targets
              </span>
            )}
            <div className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 transition-all focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 dark:border-slate-700 dark:bg-slate-800">
              <Search size={14} className="text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`${t("filter.province")}...`}
                className="w-28 bg-transparent text-xs text-slate-700 outline-none placeholder:text-slate-400 dark:text-slate-200 sm:w-36"
              />
              {search && (
                <button onClick={() => setSearch("")} className="text-slate-400 hover:text-slate-600">
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
        </div>
        {saveFeedback && (
          <div className={`mt-3 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium ${
            saveFeedback.type === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300"
              : "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300"
          }`}>
            {saveFeedback.type === "success" ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
            <span>{saveFeedback.text}</span>
            <span className="ml-auto rounded-lg bg-white/70 px-2 py-0.5 text-[10px] font-semibold dark:bg-slate-900/40">
              {pendingRowCount > 0 ? `${pendingRowCount} rows pending` : "All changes synced"}
            </span>
          </div>
        )}
      </div>

      {/* ══ Table ══ */}
      <div className="relative flex-1 overflow-hidden">
        <div className="absolute inset-0 overflow-auto">
          <table className="w-full min-w-max border-collapse">
            <thead className="sticky top-0 z-20">
              <tr className="bg-slate-900 text-[10px] font-semibold uppercase tracking-wider text-slate-300">
                <th className="sticky left-0 z-30 w-[240px] border-b border-slate-700 bg-slate-900 px-4 py-3 text-left lg:w-[300px]">
                  Structure
                </th>
                {MONTH_LABELS.map((m, i) => (
                  <th key={i} className="min-w-[85px] border-b border-slate-700 px-2 py-3 text-center">{m}</th>
                ))}
                <th className="sticky right-0 z-30 min-w-[120px] border-b border-l border-slate-700 bg-slate-900 px-4 py-3 text-right">
                  Year Total
                </th>
              </tr>
            </thead>

            <tbody className="text-xs">
              {Object.keys(groupedData).map((buName) => (
                <React.Fragment key={buName}>
                  {showBuHeader && (
                    <tr>
                      <td className="sticky left-0 z-10 border-b border-slate-200 bg-white p-0 dark:border-slate-800 dark:bg-slate-900">
                        <div className="flex items-center gap-2.5 border-l-4 border-blue-600 bg-slate-50 px-4 py-2.5 dark:bg-slate-800/60">
                          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-xs font-bold text-white shadow-sm">
                            {buName?.charAt(0)?.toUpperCase() || "?"}
                          </span>
                          <span className="text-sm font-bold text-slate-800 dark:text-white">{buName.toUpperCase()}</span>
                        </div>
                      </td>
                      <td colSpan={13} className="border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-800/60" />
                    </tr>
                  )}

                  {Object.keys(groupedData[buName]).map((chName) => {
                    const rows = groupedData[buName][chName];
                    const vientianeRows = rows.filter(isVientianeRow);
                    const otherRows = rows.filter((r: any) => !isVientianeRow(r));
                    const chMonths = MONTHS.map((_: any, idx: number) => rows.reduce((sum: number, r: any) => sum + (getRowMonths(r, monthOverrides, displayYear)?.[idx] || 0), 0));
                    const chTotal = chMonths.reduce((s, v) => s + v, 0);
                    const groupKey = `${buName}-${chName}-VT`;
                    const isExpanded = expandedGroups[groupKey];
                    const vtMonths = MONTHS.map((_: any, idx: number) => vientianeRows.reduce((sum: number, r: any) => sum + (getRowMonths(r, monthOverrides, displayYear)?.[idx] || 0), 0));
                    const vtTotal = vientianeRows.reduce((sum: number, row: any) => sum + sumMonths(getRowMonths(row, monthOverrides, displayYear)), 0);
                    const chLetter = CH_BADGE[chName] || chName?.charAt(0)?.toUpperCase() || "?";

                    return (
                      <React.Fragment key={`${buName}-${chName}`}>
                        {/* Channel header */}
                        <tr>
                          <td className="sticky left-0 z-10 border-b border-slate-100 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900" style={{ paddingLeft: showBuHeader ? 28 : 16 }}>
                            <div className="flex items-center gap-2">
                              <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br from-slate-100 to-slate-50 text-[10px] font-bold text-slate-600 shadow-sm dark:from-slate-700 dark:to-slate-800 dark:text-slate-300">
                                {chLetter}
                              </span>
                              <span className="text-xs font-bold uppercase tracking-wide text-slate-700 dark:text-slate-200">{chName}</span>
                            </div>
                          </td>
                          <td colSpan={13} className="border-b border-slate-100 dark:border-slate-800" />
                        </tr>

                        {/* Channel total */}
                        <tr className="bg-slate-50/80 dark:bg-slate-800/30">
                          <td className="sticky left-0 z-10 border-b border-slate-100 bg-slate-50/80 px-4 py-1.5 dark:border-slate-800 dark:bg-slate-800/30" style={{ paddingLeft: showBuHeader ? 28 : 16 }}>
                            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                              Total {chName}
                            </span>
                          </td>
                          <MonthCells months={chMonths} isParent />
                          <td className="sticky right-0 z-10 border-b border-l border-slate-100 bg-slate-50/80 px-4 py-1.5 text-right text-sm font-bold tabular-nums text-slate-800 dark:border-slate-800 dark:bg-slate-800/30 dark:text-white">
                            {fmtCurrency(chTotal)}
                          </td>
                        </tr>

                        {/* Vientiane group */}
                        {vientianeRows.length > 0 && (
                          <>
                            <tr
                              onClick={() => toggleExpand(groupKey)}
                              className="cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40"
                            >
                              <td className="sticky left-0 z-10 border-b border-slate-100 bg-white px-4 py-1.5 dark:border-slate-800 dark:bg-slate-900">
                                <div className="flex items-center gap-2" style={{ marginLeft: showBuHeader ? 24 : 12 }}>
                                  <ChevronRight size={12} className={`text-slate-400 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">Vientiane Capital</span>
                                  <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                                    {vientianeRows.length}
                                  </span>
                                </div>
                              </td>
                              <MonthCells months={vtMonths} isParent />
                              <td className="sticky right-0 z-10 border-b border-l border-slate-100 bg-slate-50/80 px-4 py-1.5 text-right font-semibold tabular-nums text-slate-800 dark:border-slate-800 dark:bg-slate-800/30 dark:text-white">
                                {fmtCurrency(vtTotal)}
                              </td>
                            </tr>
                            {isExpanded && vientianeRows.map((row: any) => (
                              <tr key={row.id} className="transition-colors hover:bg-blue-50/40 dark:hover:bg-blue-900/10">
                                <td className="sticky left-0 z-10 border-b border-slate-100 bg-white px-4 py-1.5 dark:border-slate-800 dark:bg-slate-900">
                                  <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400" style={{ marginLeft: showBuHeader ? 48 : 36 }}>
                                    <span className="text-slate-300 dark:text-slate-600">&#8627;</span>
                                    <span className="text-xs">{row.district}</span>
                                  </div>
                                </td>
                                <MonthCells months={getRowMonths(row, monthOverrides, displayYear)} rowId={row.id} />
                                <td className={`sticky right-0 z-10 border-b border-l border-slate-100 bg-white px-4 py-1.5 text-right tabular-nums dark:border-slate-800 dark:bg-slate-900 ${
                                  dirtyRowIds.has(String(row.id))
                                    ? "font-semibold text-amber-700 dark:text-amber-300"
                                    : "text-slate-600 dark:text-slate-300"
                                }`}>
                                  {fmtCurrency(sumMonths(getRowMonths(row, monthOverrides, displayYear)))}
                                </td>
                              </tr>
                            ))}
                          </>
                        )}

                        {/* Other provinces */}
                        {otherRows.map((row: any) => (
                          <tr key={row.id} className="transition-colors hover:bg-blue-50/40 dark:hover:bg-blue-900/10">
                            <td className="sticky left-0 z-10 border-b border-slate-100 bg-white px-4 py-1.5 dark:border-slate-800 dark:bg-slate-900">
                              <div className="flex items-center gap-2" style={{ marginLeft: showBuHeader ? 36 : 24 }}>
                                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{row.location}</span>
                              </div>
                            </td>
                            <MonthCells months={getRowMonths(row, monthOverrides, displayYear)} rowId={row.id} />
                            <td className={`sticky right-0 z-10 border-b border-l border-slate-100 bg-white px-4 py-1.5 text-right font-semibold tabular-nums dark:border-slate-800 dark:bg-slate-900 ${
                              dirtyRowIds.has(String(row.id))
                                ? "text-amber-700 dark:text-amber-300"
                                : "text-slate-700 dark:text-slate-200"
                            }`}>
                              {fmtCurrency(sumMonths(getRowMonths(row, monthOverrides, displayYear)))}
                            </td>
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {/* Loading overlays */}
        {(loading || navLoading) && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-white/80 backdrop-blur-sm dark:bg-slate-950/80">
            <Loader2 className={`h-8 w-8 animate-spin ${navLoading ? "text-emerald-500" : "text-blue-500"}`} />
            <p className="mt-3 text-sm font-medium text-slate-600 dark:text-slate-300">
              {navLoading ? "Opening..." : t("app.loading")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
