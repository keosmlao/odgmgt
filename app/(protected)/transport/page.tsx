"use client";

// Links in this copied page point at TMS routes; TmsLink keeps the three
// screens this app hosts internal and sends the rest to TMS in a new tab.
import Link from "@/components/tms-link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FaArrowRight,
  FaBoxOpen,
  FaCalendarTimes,
  FaChartLine,
  FaCheckCircle,
  FaClipboardCheck,
  FaExclamationTriangle,
  FaPhone,
  FaPhoneSlash,
  FaRoute,
  FaSyncAlt,
  FaThumbsUp,
  FaTruck,
  FaSpinner,
  FaClock,
  FaUsers,
} from "react-icons/fa";
import { FIXED_YEAR } from "@/lib/fixed-year";
import api from "@/service/api";
import { LiveFleetOverview } from "@/components/live-fleet-overview";
import {
  deliveryPerfRates,
  formatLeadHours,
  type DeliveryPerfReport,
} from "@/lib/delivery-performance";
// Ported from server actions: getDashboardData

// ==================== Types ====================

type CountValue = number | string | null | undefined;

interface SummaryData {
  bill_count: CountValue; pickup: CountValue; logistic: CountValue;
  logistic_od: CountValue; logistic_dt: CountValue; logistic_ps: CountValue;
}

interface TeamData {
  bill_count: CountValue; still: CountValue; complete: CountValue;
}

interface PendingShipment {
  doc_no: string; doc_date: string; transport_name: string | null;
  sale: string | null; transport: string | null;
  time_open: string | null; time_use: string | null; time_use_seconds?: CountValue;
}

interface InProgressShipment {
  bill_no: string;
  doc_no: string;
  doc_date: string;
  bill_date: string;
  customer: string;
  telephone: string;
  active_sent_start: string;
  active_seconds?: CountValue;
  car: string;
  driver: string;
  transport_name: string;
}

interface WaitingDispatchShipment {
  bill_no: string;
  doc_no: string;
  doc_date: string;
  bill_date: string;
  customer: string;
  telephone: string;
  waiting_since: string;
  waiting_seconds?: CountValue;
  car: string;
  driver: string;
  transport_name: string;
  picked_up?: boolean;
}

interface DeliveredPendingCloseShipment {
  bill_no: string;
  doc_no: string;
  doc_date: string;
  bill_date: string;
  customer: string;
  telephone: string;
  delivered_at: string;
  pending_close_seconds?: CountValue;
  car: string;
  driver: string;
  transport_name: string;
  job_status: CountValue;
  job_status_text: string;
  url_img?: string;
  sight_img?: string;
  delivery_images?: string[];
  image_count?: CountValue;
  remark?: string;
}

interface PendingSummary {
  month_count: CountValue; today_count: CountValue;
  today_pending: CountValue; today_complete: CountValue;
  month_pending: CountValue; month_complete: CountValue;
  year_pending: CountValue; year_in_progress?: CountValue; year_complete: CountValue;
  current_date: string; current_month: string;
}

interface PendingBreakdown {
  total: CountValue;
  overdue: CountValue;
  past_send_date: CountValue;
  contacted: CountValue;
  uncontacted: CountValue;
  ready: CountValue;
}

interface DeliveryKpiPeriod {
  total: CountValue;
  on_time: CountValue;
  breach: CountValue;
  avg_delivery_seconds: number | null;
  avg_close_seconds: number | null;
}

interface DeliveryKpiTargets {
  on_time_rate: number | null;
  avg_delivery_minutes: number | null;
  avg_close_minutes: number | null;
}

interface DeliveryKpiBranch extends DeliveryKpiPeriod {
  branch_code: string;
  branch_name: string;
}

interface DeliveryKpiTrendDay {
  day: string;
  total: number;
  on_time: number;
  breach: number;
  avg_delivery_seconds: number | null;
  avg_close_seconds: number | null;
}

interface DeliveryKpi {
  today: DeliveryKpiPeriod;
  month: DeliveryKpiPeriod;
  year: DeliveryKpiPeriod;
  by_branch?: {
    today: DeliveryKpiBranch[];
    month: DeliveryKpiBranch[];
    year: DeliveryKpiBranch[];
  };
  trend_30d?: DeliveryKpiTrendDay[];
  targets?: DeliveryKpiTargets;
}

interface CustomerRatingSummary {
  total: number;
  avg_stars: number | null;
  positive: number;
  negative: number;
}

interface DashboardData {
  data: SummaryData;
  thunjai?: { bill_count: CountValue; item_count: CountValue; item_qty: CountValue };
  kl: TeamData; dt: TeamData; ps: TeamData;
  user_branch: string | null;
  branch_names?: Record<string, string>;
  trans: PendingShipment[]; trans_month: PendingShipment[]; trans_today: PendingShipment[];
  in_progress?: InProgressShipment[];
  in_progress_count?: CountValue;
  waiting_dispatch?: WaitingDispatchShipment[];
  waiting_dispatch_count?: CountValue;
  delivered_pending_close?: DeliveredPendingCloseShipment[];
  delivered_pending_close_count?: CountValue;
  pending_summary: PendingSummary;
  pending_breakdown?: PendingBreakdown;
  delivery_kpi?: DeliveryKpi;
  customer_rating?: CustomerRatingSummary;
}

// Progressive slices returned by the three split server actions. The page
// fetches them in parallel and renders each section as its slice arrives.
type SummarySlice = Pick<
  DashboardData,
  "data" | "thunjai" | "kl" | "dt" | "ps" | "user_branch" | "branch_names" | "customer_rating"
> & { pending_summary: Partial<PendingSummary> };
type KpiSlice = { delivery_kpi: DeliveryKpi };
type PendingSlice = {
  trans: PendingShipment[];
  trans_month: PendingShipment[];
  trans_today: PendingShipment[];
  pending_summary: Partial<PendingSummary>;
  pending_breakdown: PendingBreakdown;
  still: Record<string, number>;
};

// ==================== Helpers ====================

const numberFormatter = new Intl.NumberFormat("en-US");

function toNumber(value: CountValue) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
function formatNumber(value: CountValue) {
  return numberFormatter.format(toNumber(value));
}
function getPercent(part: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}
function formatAgingSeconds(value: CountValue) {
  const totalSeconds = Math.max(0, Math.trunc(toNumber(value)));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [
    days > 0 ? `${days}ມ` : null,
    days > 0 || hours > 0 ? `${hours}ຊ` : null,
    days > 0 || hours > 0 || minutes > 0 ? `${minutes}ນ` : null,
    `${seconds}ວ`,
  ].filter(Boolean);
  return parts.join(" ");
}
function getAgingClassName(value: CountValue) {
  const totalSeconds = toNumber(value);
  if (totalSeconds >= 4 * 3600) return "bg-rose-500/10 text-rose-600 dark:text-rose-400 ring-rose-500/20";
  if (totalSeconds >= 2 * 3600) return "bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-amber-500/20";
  return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ring-emerald-500/20";
}

const EMPTY_TEAM: TeamData = { bill_count: 0, still: 0, complete: 0 };

// Shared card shell — soft brand-tinted border, gentle shadow, xl radius.
const CARD =
  "rounded-xl border border-slate-200/70 bg-white/80 shadow-sm dark:border-slate-800 dark:bg-slate-900/65";

// ==================== UI Pieces ====================


function HeroKpiTile({
  label,
  value,
  caption,
  icon,
  accent,
  loading = false,
}: {
  label: string;
  value: CountValue;
  caption?: string;
  icon: React.ReactNode;
  accent: string;
  loading?: boolean;
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-white/15 bg-white/10 p-4 backdrop-blur-md transition-all hover:border-white/25 hover:bg-white/15">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-sky-100/80">{label}</p>
          {loading ? (
            <span className="mt-1.5 block h-8 w-16 animate-pulse rounded bg-white/20" />
          ) : (
            <p className="mt-1 text-3xl font-extrabold leading-none text-white tabular-nums">{formatNumber(value)}</p>
          )}
          {loading ? (
            <span className="mt-2 block h-2.5 w-24 animate-pulse rounded bg-white/10" />
          ) : (
            caption && <p className="mt-1.5 text-[11px] text-sky-100/70">{caption}</p>
          )}
        </div>
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-lg ring-1 ring-white/25 ${accent}`}>
          {icon}
        </div>
      </div>
    </div>
  );
}

// Zone divider — brand accent bar + title + fading rule, separates the live-ops
// zone from the insights zone without adding visual weight.
function ZoneHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex items-center gap-3 pt-2">
      <span className="h-7 w-1.5 shrink-0 rounded-full brand-gradient-cool" />
      <div className="min-w-0">
        <h2 className="text-base font-extrabold leading-tight text-slate-800 dark:text-white">{title}</h2>
        {subtitle && <p className="truncate text-[11px] text-slate-400 dark:text-slate-500">{subtitle}</p>}
      </div>
      <div className="h-px flex-1 bg-gradient-to-r from-slate-200 to-transparent dark:from-slate-700/70" />
    </div>
  );
}

type PendingStatTone = "amber" | "rose" | "orange" | "sky" | "slate" | "emerald";

const pendingStatPalette: Record<PendingStatTone, { icon: string; text: string; badge: string }> = {
  amber: { icon: "bg-amber-500/10 text-amber-600 dark:text-amber-400", text: "text-amber-700 dark:text-amber-300", badge: "bg-amber-50 dark:bg-amber-950/30" },
  rose: { icon: "bg-rose-500/10 text-rose-600 dark:text-rose-400", text: "text-rose-700 dark:text-rose-300", badge: "bg-rose-50 dark:bg-rose-950/30" },
  orange: { icon: "bg-orange-500/10 text-orange-600 dark:text-orange-400", text: "text-orange-700 dark:text-orange-300", badge: "bg-orange-50 dark:bg-orange-950/30" },
  sky: { icon: "bg-sky-500/10 text-sky-600 dark:text-sky-400", text: "text-sky-700 dark:text-sky-300", badge: "bg-sky-50 dark:bg-sky-950/30" },
  slate: { icon: "bg-slate-500/10 text-slate-600 dark:text-slate-400", text: "text-slate-700 dark:text-slate-300", badge: "bg-slate-50 dark:bg-slate-800/40" },
  emerald: { icon: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", text: "text-emerald-700 dark:text-emerald-300", badge: "bg-emerald-50 dark:bg-emerald-950/30" },
};

function PendingStat({ label, value, icon, tone }: {
  label: string;
  value: CountValue;
  icon: React.ReactNode;
  tone: PendingStatTone;
}) {
  const c = pendingStatPalette[tone];
  return (
    <div className={`rounded-xl ${c.badge} p-3.5 flex items-center gap-3`}>
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${c.icon}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 truncate">{label}</p>
        <p className={`text-2xl font-extrabold tabular-nums leading-tight ${c.text}`}>{formatNumber(value)}</p>
      </div>
    </div>
  );
}

function MiniDonut({
  label,
  sublabel,
  complete,
  pending,
  gradientFrom,
  gradientTo,
  gradientId,
}: {
  label: string;
  sublabel?: string;
  complete: number;
  pending: number;
  gradientFrom: string;
  gradientTo: string;
  gradientId: string;
}) {
  const total = complete + pending;
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const completePct = total > 0 ? complete / total : 0;
  const pendingDash = circumference * (1 - completePct);
  const percent = getPercent(complete, total);

  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-slate-200/70 bg-white/65 p-3 dark:border-slate-800 dark:bg-slate-900/50">
      <div className="flex items-center gap-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 dark:text-gray-400">
          {label}
        </p>
        {sublabel && (
          <span className="text-[9px] text-slate-400 font-normal">· {sublabel}</span>
        )}
      </div>

      <div className="relative w-[110px] h-[110px]">
        <svg viewBox="0 0 110 110" className="w-full h-full -rotate-90">
          <circle
            cx="55"
            cy="55"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="11"
            className="text-slate-100 dark:text-gray-800"
          />
          {total > 0 && (
            <circle
              cx="55"
              cy="55"
              r={radius}
              fill="none"
              stroke={`url(#${gradientId})`}
              strokeWidth="11"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={pendingDash}
              style={{ transition: "stroke-dashoffset 0.6s ease" }}
            />
          )}
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={gradientFrom} />
              <stop offset="100%" stopColor={gradientTo} />
            </linearGradient>
          </defs>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {total === 0 ? (
            <>
              <p className="text-sm font-semibold text-slate-400">—</p>
              <p className="text-[9px] uppercase tracking-wider text-slate-400 mt-0.5">ບໍ່ມີບິນ</p>
            </>
          ) : (
            <>
              <p
                className="text-xl font-bold tabular-nums"
                style={{
                  background: `linear-gradient(135deg, ${gradientFrom}, ${gradientTo})`,
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                }}
              >
                {percent}%
              </p>
              <p className="text-[9px] uppercase tracking-wider text-slate-500 dark:text-gray-400 mt-0.5">ສຳເລັດ</p>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5 w-full">
        <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/30 px-2 py-1 text-center">
          <p className="text-[9px] text-emerald-600 font-semibold">ສົ່ງ</p>
          <p className="text-xs font-bold text-emerald-700 dark:text-emerald-300 tabular-nums">
            {formatNumber(complete)}
          </p>
        </div>
        <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 px-2 py-1 text-center">
          <p className="text-[9px] text-amber-600 font-semibold">ລໍ</p>
          <p className="text-xs font-bold text-amber-700 dark:text-amber-300 tabular-nums">
            {formatNumber(pending)}
          </p>
        </div>
      </div>
    </div>
  );
}

function TeamCard({ name, code, stats, color }: {
  name: string; code: string; stats: TeamData; color: "sky" | "emerald" | "amber";
}) {
  const total = toNumber(stats.bill_count);
  const pending = toNumber(stats.still);
  const complete = toNumber(stats.complete);
  const rate = getPercent(complete, total);

  const palette = {
    sky: { text: "text-sky-600 dark:text-sky-400", bg: "bg-sky-500", soft: "bg-sky-50 dark:bg-sky-950/40" },
    emerald: { text: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500", soft: "bg-emerald-50 dark:bg-emerald-950/40" },
    amber: { text: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500", soft: "bg-amber-50 dark:bg-amber-950/40" },
  } as const;
  const c = palette[color];

  return (
    <div className="rounded-xl border border-slate-200/70 bg-white/75 p-4 transition-all hover:-translate-y-0.5 hover:shadow-lg dark:border-slate-800 dark:bg-slate-900/60">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={`w-9 h-9 rounded-lg ${c.soft} ${c.text} flex items-center justify-center`}>
            <FaTruck size={13} />
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">{code}</p>
            <p className="text-sm font-bold text-slate-800 dark:text-white">{name}</p>
          </div>
        </div>
        <div className={`text-right ${c.text}`}>
          <p className="text-2xl font-extrabold tabular-nums leading-none">{rate}%</p>
          <p className="text-[10px] text-slate-400 mt-0.5">ສຳເລັດ</p>
        </div>
      </div>

      <div className="mt-3 h-1.5 rounded-full bg-slate-200/50 dark:bg-white/5 overflow-hidden">
        <div className={`h-full ${c.bg} transition-all duration-500`} style={{ width: `${rate}%` }} />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-white/50 dark:bg-white/5 py-1.5">
          <p className="text-[9px] uppercase tracking-wide text-slate-400">ທັງໝົດ</p>
          <p className="text-sm font-bold text-slate-800 dark:text-white tabular-nums">{formatNumber(total)}</p>
        </div>
        <div className="rounded-lg bg-amber-500/10 py-1.5">
          <p className="text-[9px] uppercase tracking-wide text-amber-600">ລໍຖ້າ</p>
          <p className="text-sm font-bold text-amber-700 dark:text-amber-300 tabular-nums">{formatNumber(pending)}</p>
        </div>
        <div className="rounded-lg bg-emerald-500/10 py-1.5">
          <p className="text-[9px] uppercase tracking-wide text-emerald-600">ສົ່ງແລ້ວ</p>
          <p className="text-sm font-bold text-emerald-700 dark:text-emerald-300 tabular-nums">{formatNumber(complete)}</p>
        </div>
      </div>
    </div>
  );
}

function CarrierMixBar({ label, value, total, color }: {
  label: string; value: number; total: number; color: string;
}) {
  const pct = getPercent(value, total);
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="font-medium text-slate-600 dark:text-gray-300">{label}</span>
        <span className="text-slate-500 dark:text-gray-400 tabular-nums">
          {formatNumber(value)} <span className="text-slate-400">· {pct}%</span>
        </span>
      </div>
      <div className="h-2 rounded-full bg-slate-200/50 dark:bg-white/5 overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function PendingList({ items, emptyMessage, agingTick }: {
  items: PendingShipment[]; emptyMessage: string; agingTick: number;
}) {
  if (items.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-slate-400">
        <FaCheckCircle className="mx-auto text-emerald-300 text-3xl mb-2" />
        {emptyMessage}
      </div>
    );
  }
  return (
    <div className="divide-y divide-slate-200/30 dark:divide-white/5">
      {items.map((item) => {
        const liveAging = item.time_use_seconds == null ? null : toNumber(item.time_use_seconds) + agingTick;
        return (
          <div key={item.doc_no} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-slate-50/80 dark:hover:bg-white/5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300">
              <FaBoxOpen size={13} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-sm text-slate-800 dark:text-white truncate">{item.doc_no}</p>
              <p className="text-[11px] text-slate-500 dark:text-gray-400 truncate">
                {item.doc_date} · {item.transport_name || "-"}
              </p>
              <p className="text-[10px] text-slate-400 truncate">
                {item.sale || "-"} / {item.transport || "-"}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ${getAgingClassName(liveAging)}`}>
                <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                {liveAging == null ? item.time_use || "ລໍຖ້າ" : formatAgingSeconds(liveAging)}
              </span>
              {item.time_open && (
                <p className="mt-0.5 text-[10px] text-slate-400">ເປີດ {item.time_open}</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function InProgressList({ items, total, agingTick }: {
  items: InProgressShipment[];
  total: CountValue;
  agingTick: number;
}) {
  if (items.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-slate-400">
        <FaCheckCircle className="mx-auto text-emerald-300 text-3xl mb-2" />
        ບໍ່ມີລາຍການກຳລັງຈັດສົ່ງ
      </div>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-2 px-5 py-3 bg-sky-500/5 border-b border-slate-200/30 dark:border-white/5">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-400">ບິນທັງໝົດ</p>
          <p className="text-lg font-bold text-sky-700 dark:text-sky-300 tabular-nums">{formatNumber(total)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-400">ສະແດງ</p>
          <p className="text-lg font-bold text-teal-700 dark:text-teal-300 tabular-nums">
            {formatNumber(items.length)}
          </p>
        </div>
      </div>

      <div className="divide-y divide-slate-200/30 dark:divide-white/5">
        {items.map((item) => {
          const liveSeconds = item.active_seconds == null ? null : toNumber(item.active_seconds) + agingTick;
          return (
            <div key={`${item.doc_no}-${item.bill_no}`} className="px-5 py-3 hover:bg-slate-50/80 dark:hover:bg-white/5 transition-colors">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300">
                  <FaTruck size={13} />
                </div>
                <div className="min-w-[200px] flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-bold text-sm text-slate-800 dark:text-white">{item.bill_no}</p>
                    <span className="rounded-full bg-sky-100 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 px-2 py-0.5 text-[10px] font-semibold">
                      ກຳລັງຈັດສົ່ງ
                    </span>
                    <span className="text-[10px] text-slate-400">ຖ້ຽວ {item.doc_no}</span>
                  </div>
                  <p className="text-[11px] text-slate-600 dark:text-gray-300 truncate font-medium">
                    {item.customer || "-"}
                  </p>
                  <p className="text-[10px] text-slate-400 truncate">
                    {item.transport_name || "-"} · {item.car || "-"} / {item.driver || "-"}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ${getAgingClassName(liveSeconds)}`}>
                    <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                    {liveSeconds == null ? "ກຳລັງຈັດສົ່ງ" : formatAgingSeconds(liveSeconds)}
                  </span>
                  <p className="mt-0.5 text-[10px] text-slate-400">ເລີ່ມ {item.active_sent_start || "-"}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WaitingDispatchList({ items, total, agingTick }: {
  items: WaitingDispatchShipment[];
  total: CountValue;
  agingTick: number;
}) {
  if (items.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-slate-400">
        <FaCheckCircle className="mx-auto text-emerald-300 text-3xl mb-2" />
        ບໍ່ມີບິນຈັດຖ້ຽວແລ້ວທີ່ລໍຖ້າຈັດສົ່ງ
      </div>
    );
  }

  const pickedCount = items.filter((i) => i.picked_up).length;

  return (
    <div>
      <div className="grid grid-cols-3 gap-2 px-5 py-3 bg-amber-500/5 border-b border-slate-200/30 dark:border-white/5">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-400">ບິນທັງໝົດ</p>
          <p className="text-lg font-bold text-amber-700 dark:text-amber-300 tabular-nums">{formatNumber(total)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-400">ສະແດງ</p>
          <p className="text-lg font-bold text-teal-700 dark:text-teal-300 tabular-nums">
            {formatNumber(items.length)}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-400">ເບີກເຄື່ອງແລ້ວ</p>
          <p className="text-lg font-bold text-emerald-700 dark:text-emerald-300 tabular-nums">
            {formatNumber(pickedCount)}
          </p>
        </div>
      </div>

      <div className="divide-y divide-slate-200/30 dark:divide-white/5">
        {items.map((item) => {
          const liveSeconds = item.waiting_seconds == null ? null : toNumber(item.waiting_seconds) + agingTick;
          return (
            <div key={`${item.doc_no}-${item.bill_no}`} className="px-5 py-3 hover:bg-slate-50/80 dark:hover:bg-white/5 transition-colors">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
                  <FaClock size={13} />
                </div>
                <div className="min-w-[200px] flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-bold text-sm text-slate-800 dark:text-white">{item.bill_no}</p>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      item.picked_up
                        ? "bg-emerald-100 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300"
                        : "bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300"
                    }`}>
                      {item.picked_up ? "ເບີກເຄື່ອງແລ້ວ" : "ລໍຖ້າຈັດສົ່ງ"}
                    </span>
                    <span className="text-[10px] text-slate-400">ຖ້ຽວ {item.doc_no}</span>
                  </div>
                  <p className="text-[11px] text-slate-600 dark:text-gray-300 truncate font-medium">
                    {item.customer || "-"}
                  </p>
                  <p className="text-[10px] text-slate-400 truncate">
                    {item.transport_name || "-"} · {item.car || "-"} / {item.driver || "-"}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ${getAgingClassName(liveSeconds)}`}>
                    <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                    {liveSeconds == null ? "ລໍຖ້າ" : formatAgingSeconds(liveSeconds)}
                  </span>
                  <p className="mt-0.5 text-[10px] text-slate-400">ຈັດຖ້ຽວ {item.waiting_since || "-"}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ImageThumb({ src, label }: { src: string; label: string }) {
  const [open, setOpen] = useState(false);
  if (!src) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group relative h-11 w-11 overflow-hidden rounded-lg border border-slate-200 bg-slate-100 transition-all hover:ring-2 hover:ring-teal-500 dark:border-gray-700 dark:bg-gray-800"
        title={label}
      >
        <img src={src} alt={label} className="h-full w-full object-cover" />
        <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent text-[8px] font-semibold text-white px-1 py-0.5 text-center">
          {label}
        </span>
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 cursor-zoom-out"
          onClick={() => setOpen(false)}
        >
          <img src={src} alt={label} className="max-w-full max-h-[90vh] object-contain rounded-lg" />
        </div>
      )}
    </>
  );
}

function DeliveredPendingCloseList({ items, total, agingTick }: {
  items: DeliveredPendingCloseShipment[];
  total: CountValue;
  agingTick: number;
}) {
  if (items.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-slate-400">
        <FaCheckCircle className="mx-auto text-emerald-300 text-3xl mb-2" />
        ບໍ່ມີບິນທີ່ຈັດສົ່ງສຳເລັດທີ່ຍັງບໍ່ປິດຖ້ຽວ
      </div>
    );
  }

  const driverClosedCount = items.filter((i) => toNumber(i.job_status) === 3).length;

  return (
    <div>
      <div className="grid grid-cols-3 gap-2 px-5 py-3 bg-emerald-500/5 border-b border-slate-200/30 dark:border-white/5">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-400">ບິນທັງໝົດ</p>
          <p className="text-lg font-bold text-emerald-700 dark:text-emerald-300 tabular-nums">{formatNumber(total)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-400">ສະແດງ</p>
          <p className="text-lg font-bold text-teal-700 dark:text-teal-300 tabular-nums">
            {formatNumber(items.length)}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-400">ຄົນຂັບປິດງານແລ້ວ</p>
          <p className="text-lg font-bold text-sky-700 dark:text-sky-300 tabular-nums">
            {formatNumber(driverClosedCount)}
          </p>
        </div>
      </div>

      <div className="divide-y divide-slate-200/30 dark:divide-white/5">
        {items.map((item) => {
          const liveSeconds = item.pending_close_seconds == null ? null : toNumber(item.pending_close_seconds) + agingTick;
          const isDriverClosed = toNumber(item.job_status) === 3;
          const deliveryImages = Array.isArray(item.delivery_images)
            ? item.delivery_images.filter(Boolean)
            : [];
          const allImagesRaw = [
            ...deliveryImages.map((src, index) => ({ src, label: `ຮູບ ${index + 1}` })),
            ...(item.url_img ? [{ src: item.url_img, label: "ຮູບຫຼັກ" }] : []),
            ...(item.sight_img ? [{ src: item.sight_img, label: "ລາຍເຊັນ" }] : []),
          ];
          const seenImages = new Set<string>();
          const allImages = allImagesRaw.filter((image) => {
            if (seenImages.has(image.src)) return false;
            seenImages.add(image.src);
            return true;
          });
          return (
            <div key={`${item.doc_no}-${item.bill_no}`} className="px-5 py-3 hover:bg-slate-50/80 dark:hover:bg-white/5 transition-colors">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                  <FaCheckCircle size={13} />
                </div>
                <div className="min-w-[200px] flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-bold text-sm text-slate-800 dark:text-white">{item.bill_no}</p>
                    <span className="rounded-full bg-emerald-100 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 px-2 py-0.5 text-[10px] font-semibold">
                      ຈັດສົ່ງສຳເລັດ
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      isDriverClosed
                        ? "bg-sky-100 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300"
                        : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
                    }`}>
                      {item.job_status_text || "ຍັງບໍ່ປິດຖ້ຽວ"}
                    </span>
                    <span className="text-[10px] text-slate-400">ຖ້ຽວ {item.doc_no}</span>
                  </div>
                  <p className="text-[11px] text-slate-600 dark:text-gray-300 truncate font-medium">
                    {item.customer || "-"}
                  </p>
                  <p className="text-[10px] text-slate-400 truncate">
                    {item.transport_name || "-"} · {item.car || "-"} / {item.driver || "-"}
                  </p>
                </div>
                {allImages.length > 0 && (
                  <div className="flex max-w-[240px] flex-wrap items-center justify-end gap-1.5 shrink-0">
                    {allImages.map((image, index) => (
                      <ImageThumb key={`${item.doc_no}-${item.bill_no}-${index}`} src={image.src} label={image.label} />
                    ))}
                  </div>
                )}
                <div className="shrink-0 text-right">
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ${getAgingClassName(liveSeconds)}`}>
                    <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                    {liveSeconds == null ? "ລໍ" : formatAgingSeconds(liveSeconds)}
                  </span>
                  <p className="mt-0.5 text-[10px] text-slate-400">ສົ່ງສຳເລັດ {item.delivered_at || "-"}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ==================== Main ====================

type PendingTab = "year" | "month" | "today";
type KpiTab = "today" | "month" | "year";

function formatKpiDuration(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}ຊ ${m}ນ`;
  if (m > 0) return `${m}ນ ${s}ວ`;
  return `${s}ວ`;
}

function Sparkline({ values, color, label, targetLine }: {
  values: Array<number | null>;
  color: string;
  label: string;
  targetLine?: number | null;
}) {
  const cleaned = values.map((v) => (v == null || !Number.isFinite(v) ? null : Number(v)));
  const nonNull = cleaned.filter((v): v is number => v != null);
  if (nonNull.length === 0) {
    return (
      <div className="h-10 flex items-center justify-center text-[10px] text-slate-400">
        {label} — ບໍ່ມີຂໍ້ມູນ
      </div>
    );
  }
  const max = Math.max(...nonNull, targetLine ?? 0);
  const min = Math.min(...nonNull, targetLine ?? max);
  const range = max - min || 1;
  const w = 200;
  const h = 32;
  const step = cleaned.length > 1 ? w / (cleaned.length - 1) : 0;
  const points: Array<[number, number]> = [];
  cleaned.forEach((v, i) => {
    if (v == null) return;
    const x = i * step;
    const y = h - ((v - min) / range) * h;
    points.push([x, y]);
  });
  const path = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const targetY = targetLine != null ? h - ((targetLine - min) / range) * h : null;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-10">
      {targetY != null && (
        <line
          x1={0}
          y1={targetY}
          x2={w}
          y2={targetY}
          stroke="currentColor"
          strokeWidth="0.8"
          strokeDasharray="2 2"
          className="text-slate-400/60"
        />
      )}
      <path d={path} fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      {points.length > 0 && (
        <circle cx={points[points.length - 1][0]} cy={points[points.length - 1][1]} r="2" fill={color} />
      )}
    </svg>
  );
}

type TargetStatus = "pass" | "fail" | "none";

function targetBadge(status: TargetStatus, target: string | null): React.ReactNode {
  if (status === "none" || !target) return null;
  const cls = status === "pass"
    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30"
    : "bg-rose-500/15 text-rose-700 dark:text-rose-300 ring-rose-500/30";
  const icon = status === "pass" ? "▲" : "▼";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold ring-1 ${cls}`}>
      {icon} {target}
    </span>
  );
}

function DeliveryKpiCard({ kpi }: { kpi: DeliveryKpi }) {
  const [tab, setTab] = useState<KpiTab>("today");
  const period = kpi[tab];
  const branches = kpi.by_branch?.[tab] ?? [];
  const trend = kpi.trend_30d ?? [];
  const targets = kpi.targets ?? { on_time_rate: null, avg_delivery_minutes: null, avg_close_minutes: null };
  const onTimeSeries = trend.map((d) =>
    d.total > 0 ? Math.round((d.on_time / d.total) * 100) : null
  );
  const breachSeries = trend.map((d) => d.breach);
  const avgDeliverySeries = trend.map((d) =>
    d.avg_delivery_seconds == null ? null : d.avg_delivery_seconds / 60
  );
  const avgCloseSeries = trend.map((d) =>
    d.avg_close_seconds == null ? null : d.avg_close_seconds / 60
  );
  const onTimeRate = getPercent(toNumber(period.on_time), toNumber(period.total));
  const breachRate = getPercent(toNumber(period.breach), toNumber(period.total));
  const avgDeliveryMin = period.avg_delivery_seconds == null ? null : period.avg_delivery_seconds / 60;
  const avgCloseMin = period.avg_close_seconds == null ? null : period.avg_close_seconds / 60;

  const onTimeStatus: TargetStatus = targets.on_time_rate == null
    ? "none"
    : period.total
    ? (onTimeRate >= targets.on_time_rate ? "pass" : "fail")
    : "none";
  const avgDeliveryStatus: TargetStatus = targets.avg_delivery_minutes == null
    ? "none"
    : avgDeliveryMin == null
    ? "none"
    : (avgDeliveryMin <= targets.avg_delivery_minutes ? "pass" : "fail");
  const avgCloseStatus: TargetStatus = targets.avg_close_minutes == null
    ? "none"
    : avgCloseMin == null
    ? "none"
    : (avgCloseMin <= targets.avg_close_minutes ? "pass" : "fail");

  const tabs: Array<{ key: KpiTab; label: string }> = [
    { key: "today", label: "ວັນນີ້" },
    { key: "month", label: "ເດືອນນີ້" },
    { key: "year", label: "ປີນີ້" },
  ];

  return (
    <div className={`${CARD} p-5`}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-teal-500/10 flex items-center justify-center">
            <FaChartLine className="text-teal-600 dark:text-teal-400" size={13} />
          </div>
          <h2 className="text-sm font-bold text-slate-800 dark:text-white">KPI ການຈັດສົ່ງ</h2>
          <Link
            href="/manage/settings/kpi"
            className="text-[10px] text-slate-400 hover:text-teal-600 dark:hover:text-teal-300 underline decoration-dotted"
            title="ຕັ້ງຄ່າເປົ້າໝາຍ"
          >
            ຕັ້ງຄ່າເປົ້າໝາຍ
          </Link>
        </div>
        <div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800/70">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`px-3 py-1 rounded-md text-[11px] font-semibold transition-all ${
                tab === t.key
                  ? "bg-white text-teal-700 shadow-sm dark:bg-slate-900 dark:text-teal-300"
                  : "text-slate-500 dark:text-gray-400 hover:text-slate-700"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/30 p-3.5">
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="flex items-center gap-2 min-w-0">
              <FaCheckCircle className="text-emerald-600 dark:text-emerald-400 shrink-0" size={11} />
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 truncate">
                ສຳເລັດທັນເວລາ
              </p>
            </div>
            {targetBadge(onTimeStatus, targets.on_time_rate != null ? `${targets.on_time_rate}%` : null)}
          </div>
          <p className="text-2xl font-extrabold text-emerald-700 dark:text-emerald-300 tabular-nums leading-tight">
            {onTimeRate}%
          </p>
          <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
            {formatNumber(period.on_time)} / {formatNumber(period.total)} ບິນ
          </p>
          <Sparkline values={onTimeSeries} color="#059669" label="ທັນເວລາ" targetLine={targets.on_time_rate} />
        </div>

        <div className="rounded-xl bg-rose-50 dark:bg-rose-950/30 p-3.5">
          <div className="flex items-center gap-2 mb-1">
            <FaExclamationTriangle className="text-rose-600 dark:text-rose-400" size={11} />
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              ຊ້າກວ່າກຳນົດ
            </p>
          </div>
          <p className="text-2xl font-extrabold text-rose-700 dark:text-rose-300 tabular-nums leading-tight">
            {formatNumber(period.breach)}
          </p>
          <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">{breachRate}% ຂອງທີ່ສົ່ງ</p>
          <Sparkline values={breachSeries} color="#e11d48" label="ຊ້າ" />
        </div>

        <div className="rounded-xl bg-sky-50 dark:bg-sky-950/30 p-3.5">
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="flex items-center gap-2 min-w-0">
              <FaTruck className="text-sky-600 dark:text-sky-400 shrink-0" size={11} />
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 truncate">
                ສະເລ່ຍເວລາສົ່ງ
              </p>
            </div>
            {targetBadge(avgDeliveryStatus, targets.avg_delivery_minutes != null ? formatKpiDuration(targets.avg_delivery_minutes * 60) : null)}
          </div>
          <p className="text-2xl font-extrabold text-sky-700 dark:text-sky-300 tabular-nums leading-tight">
            {formatKpiDuration(period.avg_delivery_seconds)}
          </p>
          <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">ຮັບຖ້ຽວ → ສົ່ງສຳເລັດ</p>
          <Sparkline values={avgDeliverySeries} color="#1489ba" label="ສະເລ່ຍສົ່ງ" targetLine={targets.avg_delivery_minutes} />
        </div>

        <div className="rounded-xl bg-amber-50 dark:bg-amber-950/30 p-3.5">
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="flex items-center gap-2 min-w-0">
              <FaClock className="text-amber-600 dark:text-amber-400 shrink-0" size={11} />
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 truncate">
                ສະເລ່ຍເວລາປິດຖ້ຽວ
              </p>
            </div>
            {targetBadge(avgCloseStatus, targets.avg_close_minutes != null ? formatKpiDuration(targets.avg_close_minutes * 60) : null)}
          </div>
          <p className="text-2xl font-extrabold text-amber-700 dark:text-amber-300 tabular-nums leading-tight">
            {formatKpiDuration(period.avg_close_seconds)}
          </p>
          <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">ສົ່ງສຳເລັດ → ປິດຖ້ຽວ</p>
          <Sparkline values={avgCloseSeries} color="#e07310" label="ສະເລ່ຍປິດ" targetLine={targets.avg_close_minutes} />
        </div>
      </div>

      <p className="mt-2 text-[9px] text-slate-400">ແນວໂນ້ມ 30 ມື້ຫຼ້າສຸດ · ເສັ້ນປະ = ເປົ້າໝາຍ</p>

      {branches.length > 0 && (
        <div className="mt-4 border-t border-slate-200/60 dark:border-white/10 pt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
            ປຽບທຽບລະຫວ່າງສາຂາ
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="px-2 py-1.5 text-left font-semibold">ສາຂາ</th>
                  <th className="px-2 py-1.5 text-right font-semibold">ສົ່ງສຳເລັດ</th>
                  <th className="px-2 py-1.5 text-right font-semibold">ທັນເວລາ</th>
                  <th className="px-2 py-1.5 text-right font-semibold">ຊ້າ</th>
                  <th className="px-2 py-1.5 text-right font-semibold">ສະເລ່ຍສົ່ງ</th>
                  <th className="px-2 py-1.5 text-right font-semibold">ສະເລ່ຍປິດ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/60 dark:divide-white/5">
                {branches.map((b) => {
                  const rate = getPercent(toNumber(b.on_time), toNumber(b.total));
                  const meets = targets.on_time_rate == null || b.total === 0
                    ? null
                    : rate >= targets.on_time_rate;
                  return (
                    <tr key={b.branch_code} className="hover:bg-white/40 dark:hover:bg-white/5">
                      <td className="px-2 py-1.5 font-semibold text-slate-700 dark:text-slate-200">{b.branch_name}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-300">{formatNumber(b.total)}</td>
                      <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${
                        meets === true ? "text-emerald-600 dark:text-emerald-400"
                        : meets === false ? "text-rose-600 dark:text-rose-400"
                        : "text-slate-600 dark:text-slate-300"
                      }`}>
                        {formatNumber(b.on_time)} <span className="text-[9px] font-normal text-slate-400">· {rate}%</span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-rose-600 dark:text-rose-400">{formatNumber(b.breach)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-sky-600 dark:text-sky-400">{formatKpiDuration(b.avg_delivery_seconds)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-amber-600 dark:text-amber-400">{formatKpiDuration(b.avg_close_seconds)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ປະສິດທິພາບການຈັດສົ່ງ ຂອງເດືອນນີ້ — ຍ່ອມາຈາກລາຍງານເຕັມທີ່
// /reports/delivery-performance (ໃຊ້ຊຸດຂໍ້ມູນ ແລະ ສູດຄິດເປີເຊັນອັນດຽວກັນ).
function DeliveryPerformanceCard({ perf }: { perf: DeliveryPerfReport }) {
  const overall = perf.overall;
  const rates = deliveryPerfRates(overall);

  const balance: Array<{ label: string; value: number; cls: string }> = [
    { label: "ຍອດຍົກມາ", value: overall.carry_in, cls: "text-amber-700 dark:text-amber-300" },
    { label: "ເປີດບິນໃນເດືອນ", value: overall.opened, cls: "text-sky-700 dark:text-sky-300" },
    { label: "ສົ່ງສຳເລັດ", value: overall.delivered, cls: "text-emerald-700 dark:text-emerald-300" },
    { label: "ຍອດຄົງເຫຼືອຍົກໄປ", value: overall.carry_out, cls: "text-rose-700 dark:text-rose-300" },
  ];

  const lanes: Array<{ title: string; hint: string; slices: Array<{ label: string; rate: number; count: number; bar: string; text: string }> }> = [
    {
      title: "ນັບແຕ່ເວລາເປີດບິນ",
      hint: "ເປີດບິນ → ສົ່ງສຳເລັດ",
      slices: [
        { label: "≤24h", rate: rates.openOnTimeRate, count: overall.from_open.le_24h, bar: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300" },
        { label: "24–48h", rate: rates.open24to48Rate, count: overall.from_open.h24_48, bar: "bg-amber-500", text: "text-amber-700 dark:text-amber-300" },
        { label: ">48h", rate: rates.openOver48Rate, count: overall.from_open.gt_48h, bar: "bg-rose-500", text: "text-rose-700 dark:text-rose-300" },
      ],
    },
    {
      title: "ນັບແຕ່ວັນນັດຈັດສົ່ງ",
      hint: "ວັນນັດ → ສົ່ງສຳເລັດ",
      slices: [
        { label: "≤24h", rate: rates.schedOnTimeRate, count: overall.from_schedule.le_24h, bar: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300" },
        { label: "24–48h", rate: rates.sched24to48Rate, count: overall.from_schedule.h24_48, bar: "bg-amber-500", text: "text-amber-700 dark:text-amber-300" },
        { label: ">48h", rate: rates.schedOver48Rate, count: overall.from_schedule.gt_48h, bar: "bg-rose-500", text: "text-rose-700 dark:text-rose-300" },
        { label: "ບໍ່ໄດ້ນັດ", rate: rates.schedUnknownRate, count: overall.from_schedule.no_schedule, bar: "bg-slate-400", text: "text-slate-600 dark:text-slate-300" },
      ],
    },
  ];

  const quality = [
    { label: "ເລື່ອນນັດ >2 ຄັ້ງ", rate: rates.rescheduledRate, count: overall.rescheduled_over_2 },
    { label: "ທະຍອຍສົ່ງ", rate: rates.multiLegRate, count: overall.multi_leg_bills },
    { label: "ສົ່ງບໍ່ຄົບຈຳນວນ", rate: rates.shortRate, count: overall.short_bills },
    { label: "ຍົກເລີກ", rate: rates.cancelledRate, count: overall.cancelled_bills },
  ];

  return (
    <div className={`${CARD} p-5`}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center">
            <FaClipboardCheck className="text-indigo-600 dark:text-indigo-400" size={13} />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-800 dark:text-white">ປະສິດທິພາບການຈັດສົ່ງ · ເດືອນນີ້</h2>
            <p className="text-[11px] text-slate-400 dark:text-gray-500">
              {formatNumber(overall.handled)} ບິນຢູ່ໃນມື · ເວລານຳສົ່ງສະເລ່ຍ {formatLeadHours(overall.avg_lead_open_h)}
            </p>
          </div>
        </div>
        <Link
          href="/reports/delivery-performance"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold text-white shadow-sm transition-colors bg-indigo-600 hover:bg-indigo-500"
        >
          ລາຍງານເຕັມ <FaArrowRight size={9} />
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {balance.map((item) => (
          <div key={item.label} className="rounded-xl bg-slate-50 dark:bg-white/5 p-3.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              {item.label}
            </p>
            <p className={`text-2xl font-extrabold tabular-nums leading-tight ${item.cls}`}>
              {formatNumber(item.value)}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
        {lanes.map((lane) => (
          <div key={lane.title}>
            <div className="flex items-baseline justify-between gap-2 mb-1.5">
              <p className="text-[11px] font-bold text-slate-600 dark:text-slate-300">{lane.title}</p>
              <p className="text-[10px] text-slate-400">{lane.hint}</p>
            </div>
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-white/5">
              {lane.slices.map((slice) => (
                <div key={slice.label} className={slice.bar} style={{ width: `${slice.rate}%` }} />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {lane.slices.map((slice) => (
                <div key={slice.label} className="flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full ${slice.bar}`} />
                  <span className="text-[10px] text-slate-500 dark:text-slate-400">{slice.label}</span>
                  <span className={`text-[11px] font-bold tabular-nums ${slice.text}`}>
                    {slice.rate.toFixed(1)}%
                  </span>
                  <span className="text-[9px] text-slate-400">({formatNumber(slice.count)})</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 border-t border-slate-200/60 dark:border-white/10 pt-3 grid grid-cols-2 lg:grid-cols-4 gap-3">
        {quality.map((item) => (
          <div key={item.label}>
            <p className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">{item.label}</p>
            <p className="text-lg font-extrabold tabular-nums text-slate-800 dark:text-slate-100">
              {item.rate.toFixed(1)}%
              <span className="ml-1 text-[10px] font-normal text-slate-400">{formatNumber(item.count)} ບິນ</span>
            </p>
          </div>
        ))}
      </div>

      <p className="mt-2 text-[9px] text-slate-400">
        ຍອດຍົກໄປ = ບິນລໍຈັດຖ້ຽວ + ບິນທີ່ຂຶ້ນລົດແລ້ວແຕ່ຍັງບໍ່ຮອດມືລູກຄ້າ (ຄືກັບ tile &quot;ຄ້າງສົ່ງ&quot; ດ້ານເທິງ)
      </p>
    </div>
  );
}

// Placeholder shown while a slow slice (KPI / pending) is still loading, so the
// section's space is reserved and the user sees it is on the way.
function SectionSkeleton({ height = "h-28", title }: { height?: string; title?: string }) {
  return (
    <div className={`${CARD} p-5`}>
      {title && (
        <div className="mb-3 flex items-center gap-2">
          <div className="h-8 w-8 animate-pulse rounded-lg bg-slate-200/70 dark:bg-white/5" />
          <div className="h-3.5 w-44 animate-pulse rounded bg-slate-200/70 dark:bg-white/5" />
        </div>
      )}
      <div className={`w-full animate-pulse rounded-lg bg-slate-100 dark:bg-white/5 ${height}`} />
    </div>
  );
}

// Shared header for the live-ops list cards: tinted icon chip, title, count
// subtitle and a colored "view all" action.
function ActivityCardHeader({ icon, tint, title, subtitle, href, ctaClass }: {
  icon: React.ReactNode;
  tint: string;
  title: string;
  subtitle: string;
  href: string;
  ctaClass: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 justify-between px-5 py-3.5 border-b border-slate-200/40 dark:border-white/5">
      <div className="flex items-center gap-2.5">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${tint}`}>
          {icon}
        </div>
        <div>
          <h2 className="text-sm font-bold text-slate-800 dark:text-white">{title}</h2>
          <p className="text-[11px] text-slate-400 dark:text-gray-500">{subtitle}</p>
        </div>
      </div>
      <Link
        href={href}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold text-white shadow-sm transition-colors ${ctaClass}`}
      >
        ເບິ່ງທັງໝົດ <FaArrowRight size={9} />
      </Link>
    </div>
  );
}

export default function DashboardPage() {
  const [summary, setSummary] = useState<SummarySlice | null>(null);
  const [kpi, setKpi] = useState<KpiSlice | null>(null);
  const [perf, setPerf] = useState<DeliveryPerfReport | null>(null);
  const [pending, setPending] = useState<PendingSlice | null>(null);
  const [activity, setActivity] = useState<Partial<DashboardData> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agingTick, setAgingTick] = useState(0);
  const [pendingTab, setPendingTab] = useState<PendingTab>("today");
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  // Fetch the three core slices + activity in parallel. Each updates its own
  // state, so its section renders the instant that slice lands — the slow
  // pending slice no longer blocks the hero / KPIs / fast cards. Summary gates
  // first paint; the rest stream in behind skeletons.
  const loadAll = useCallback((force = false) => {
    setLoading(true);
    // Copied from tms/src/app/(dashboard)/page.tsx — only the data calls are
    // swapped for the REST proxy, which forwards to TMS so the figures are the
    // ones TMS itself computes.
    const slice = (name: string) =>
      api
        .get("/transport/overview", { params: { slice: name, force: force ? 1 : undefined } })
        .then((response) => response.data?.data);

    slice("summary")
      .then((s) => { setSummary(s as SummarySlice); setError(null); setLastFetched(new Date()); })
      .catch((e) => { console.error(e); setError("ບໍ່ສາມາດໂຫຼດຂໍ້ມູນໄດ້"); })
      .finally(() => setLoading(false));
    slice("kpi")
      .then((k) => setKpi(k as KpiSlice))
      .catch(() => undefined);
    slice("delivery")
      .then((p) => setPerf((p as { delivery_performance: DeliveryPerfReport }).delivery_performance))
      .catch(() => undefined);
    slice("pending")
      .then((p) => setPending(p as PendingSlice))
      .catch(() => undefined);
    slice("activity")
      .then((a) => setActivity(a as Partial<DashboardData>))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    // Kept exactly as TMS has it — this page is a copy, so it should stay
    // diffable against the original rather than be restructured here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll(false);
  }, [loadAll]);

  useEffect(() => {
    const timer = window.setInterval(() => setAgingTick(c => c + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const handleRefresh = () => loadAll(true);

  const pendingReady = !!pending;

  // Merge the slices into one DashboardData-shaped object so the render below can
  // keep reading `data.xxx` (guarded for the slices that haven't arrived yet).
  const data: Partial<DashboardData> = useMemo(() => {
    const merged: Partial<DashboardData> = {};
    if (summary) Object.assign(merged, summary);
    if (kpi) merged.delivery_kpi = kpi.delivery_kpi;
    if (pending) {
      merged.trans = pending.trans;
      merged.trans_month = pending.trans_month;
      merged.trans_today = pending.trans_today;
      merged.pending_breakdown = pending.pending_breakdown;
      merged.pending_summary = {
        ...(summary?.pending_summary ?? {}),
        ...pending.pending_summary,
      } as PendingSummary;
      if (summary) {
        merged.kl = { ...summary.kl, still: pending.still["02-0001"] };
        merged.dt = { ...summary.dt, still: pending.still["02-0002"] };
        merged.ps = { ...summary.ps, still: pending.still["02-0003"] };
      }
    }
    return merged;
  }, [summary, kpi, pending]);

  const computed = useMemo(() => {
    if (!data.data) return null;
    const sd = data.data;
    const totalBills = toNumber(sd.bill_count);
    const logistic = toNumber(sd.logistic);
    const odLogistic = toNumber(sd.logistic_od);
    const dtLogistic = toNumber(sd.logistic_dt);
    const psLogistic = toNumber(sd.logistic_ps);

    const branchNames = data.branch_names ?? {};
    const nameFor = (code: string, fallback: string) =>
      branchNames[code]?.trim() || fallback;

    const allTeams = [
      { code: "KL", branch: "02-0001", name: nameFor("02-0001", "KL"), stats: data.kl ?? EMPTY_TEAM, color: "sky" as const },
      { code: "DT", branch: "02-0002", name: nameFor("02-0002", "DT"), stats: data.dt ?? EMPTY_TEAM, color: "emerald" as const },
      { code: "PS", branch: "02-0003", name: nameFor("02-0003", "PS"), stats: data.ps ?? EMPTY_TEAM, color: "amber" as const },
    ];
    const teams = data.user_branch ? allTeams.filter((t) => t.branch === data.user_branch) : allTeams;

    // Pending-derived metrics are null until the pending slice lands; the hero
    // tiles + completion donuts render a skeleton in the meantime.
    //
    // "ຄ້າງສົ່ງ" = ບິນລໍຈັດຖ້ຽວ + ບິນທີ່ຈັດຖ້ຽວແລ້ວແຕ່ຍັງບໍ່ຮອດມືລູກຄ້າ.
    // ບິນທີ່ຂຶ້ນລົດແລ້ວຫາຍອອກຈາກໜ້າ /bills-pending ຈຶ່ງເຄີຍຕົກຫາຍໄປຈາກ KPI ນີ້
    // ທັງທີ່ຍັງເປັນວຽກຄ້າງຢູ່.
    const hasPending = !!data.pending_breakdown;
    const waitingDispatch = hasPending ? toNumber(data.pending_summary?.year_pending) : null;
    const inProgressBills = hasPending ? toNumber(data.pending_summary?.year_in_progress) : null;
    const totalPending =
      waitingDispatch == null ? null : waitingDispatch + (inProgressBills ?? 0);
    const totalComplete = teams.reduce((s, t) => s + toNumber(t.stats.complete), 0);
    const totalLogisticWork = totalPending == null ? null : totalComplete + totalPending;
    const completionRate = totalPending == null ? null : getPercent(totalComplete, totalPending + totalComplete);
    const logisticWorkRate = totalLogisticWork == null ? null : getPercent(totalLogisticWork, totalBills);
    const logisticRate = getPercent(logistic, totalBills);

    const allCarrierMix = [
      { branch: "02-0001", label: nameFor("02-0001", "OD Logistic"), value: odLogistic, bar: "bg-gradient-to-r from-sky-400 to-sky-600" },
      { branch: "02-0002", label: nameFor("02-0002", "DT Logistic"), value: dtLogistic, bar: "bg-gradient-to-r from-emerald-400 to-emerald-600" },
      { branch: "02-0003", label: nameFor("02-0003", "PS Logistic"), value: psLogistic, bar: "bg-gradient-to-r from-amber-400 to-amber-600" },
    ];
    const carrierMix = data.user_branch ? allCarrierMix.filter((c) => c.branch === data.user_branch) : allCarrierMix;

    return {
      totalBills,
      logistic,
      totalLogisticWork,
      teams,
      totalPending,
      waitingDispatch,
      inProgressBills,
      totalComplete,
      completionRate,
      logisticWorkRate,
      logisticRate,
      carrierMix,
    };
  }, [data]);

  if (loading && !summary) {
    return (
      <div className="flex flex-col items-center justify-center py-32">
        <FaSpinner className="mb-4 animate-spin text-4xl text-teal-700 dark:text-teal-300" />
        <p className="text-slate-500 text-sm">ກຳລັງໂຫຼດ Dashboard...</p>
      </div>
    );
  }

  if (!summary || !computed) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-rose-700 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300">
        <div className="flex items-start gap-3">
          <FaExclamationTriangle className="mt-0.5" />
          <div>
            <h1 className="font-semibold">Dashboard ບໍ່ພ້ອມໃຊ້ງານ</h1>
            <p className="text-sm mt-1">{error ?? "ບໍ່ສາມາດໂຫຼດຂໍ້ມູນໄດ້"}</p>
            <button
              onClick={() => handleRefresh()}
              className="mt-3 px-4 py-2 bg-rose-600 text-white rounded-lg text-xs font-medium hover:bg-rose-700 flex items-center gap-2"
            >
              <FaSyncAlt /> ລອງໃໝ່
            </button>
          </div>
        </div>
      </div>
    );
  }

  const {
    totalBills,
    logistic,
    totalLogisticWork,
    teams,
    totalPending,
    waitingDispatch,
    inProgressBills,
    totalComplete,
    completionRate,
    logisticWorkRate,
    logisticRate,
    carrierMix,
  } = computed;
  const currentYear = FIXED_YEAR;

  const ps = data.pending_summary;
  const pendingLists: Record<PendingTab, { count: CountValue; items: PendingShipment[]; subtitle: string }> = {
    // ລາຍການນີ້ສະແດງສະເພາະບິນລໍຈັດຖ້ຽວ ຈຳນວນຈຶ່ງຕ້ອງເປັນ waitingDispatch
    // ບໍ່ແມ່ນຍອດຄ້າງລວມ (ທີ່ບວກບິນກຳລັງສົ່ງນຳ) ບໍ່ດັ່ງນັ້ນຫົວຂໍ້ກັບລາຍການຈະບໍ່ຕົງ
    year: { count: waitingDispatch ?? 0, items: data.trans ?? [], subtitle: `ປີ ${currentYear}` },
    month: { count: ps?.month_count, items: data.trans_month ?? [], subtitle: `ເດືອນ ${ps?.current_month ?? ""}` },
    today: { count: ps?.today_count, items: data.trans_today ?? [], subtitle: `ວັນ ${ps?.current_date ?? ""}` },
  };
  const currentPending = pendingLists[pendingTab];

  return (
    <div className="space-y-6 pb-2">
      {/* ========== HERO ========== */}
      <div className="relative overflow-hidden rounded-2xl brand-gradient-cool p-5 shadow-xl ring-1 ring-white/10 sm:p-6">
        {/* Decorative layers: fine grid + soft light blooms */}
        <div
          className="absolute inset-0 opacity-20"
          style={{
            backgroundImage:
              "linear-gradient(90deg, rgba(255,255,255,.14) 1px, transparent 1px), linear-gradient(rgba(255,255,255,.10) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />
        <div className="pointer-events-none absolute -top-24 -right-16 h-64 w-64 rounded-full bg-sky-300/25 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-28 -left-10 h-72 w-72 rounded-full bg-amber-300/15 blur-3xl" />

        <div className="relative">
          {/* Title row */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                </span>
                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-sky-100/90">
                  Transport Control Center
                </p>
              </div>
              <h1 className="mt-1 text-2xl sm:text-3xl font-extrabold text-white leading-tight">
                ສູນຄວບຄຸມການຂົນສົ່ງ
              </h1>
              <p className="text-[11px] text-sky-100/70 mt-1">ODG Transport · ປີ {currentYear}</p>
            </div>
            <div className="flex items-center gap-2">
              {lastFetched && (
                <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-2.5 py-1 text-[10px] text-sky-100/80 backdrop-blur">
                  <FaClock size={9} />
                  {lastFetched.toLocaleTimeString("lo-LA", { hour12: false })}
                </span>
              )}
              <button
                onClick={() => void handleRefresh()}
                disabled={loading}
                className="flex items-center gap-2 rounded-lg border border-white/15 bg-white/10 px-3.5 py-2 text-xs font-medium text-white backdrop-blur transition-all hover:bg-white/20 disabled:opacity-60"
              >
                <FaSyncAlt className={loading ? "animate-spin" : ""} size={11} />
                ຣີເຟຣຊ
              </button>
            </div>
          </div>

          {/* KPI grid */}
          <div className="mt-5 grid gap-3 grid-cols-2 lg:grid-cols-4">
            <HeroKpiTile
              label="ບິນທັງໝົດ"
              value={totalBills}
              caption={`ປີ ${currentYear}`}
              icon={<FaBoxOpen size={14} />}
              accent="bg-white text-teal-900"
            />
            <HeroKpiTile
              label="ຕ້ອງຂົນສົ່ງ"
              value={totalLogisticWork ?? 0}
              loading={totalLogisticWork == null}
              caption={logisticWorkRate == null ? undefined : `${logisticWorkRate}% ຂອງບິນທັງໝົດ`}
              icon={<FaTruck size={14} />}
              accent="bg-sky-500 text-white"
            />
            <HeroKpiTile
              label="ສົ່ງສຳເລັດ"
              value={totalComplete}
              caption={completionRate == null ? undefined : `${completionRate}% ສຳເລັດ`}
              icon={<FaCheckCircle size={14} />}
              accent="bg-emerald-500 text-white"
            />
            <HeroKpiTile
              label="ຄ້າງສົ່ງ"
              value={totalPending ?? 0}
              loading={totalPending == null}
              caption={
                totalPending == null
                  ? undefined
                  : `ລໍຈັດຖ້ຽວ ${formatNumber(waitingDispatch ?? 0)} · ກຳລັງສົ່ງ ${formatNumber(inProgressBills ?? 0)}`
              }
              icon={<FaClock size={14} />}
              accent="bg-amber-500 text-white"
            />
          </div>

        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl px-4 py-3 text-sm text-amber-800 dark:text-amber-300 flex items-center gap-2">
          <FaExclamationTriangle size={12} />
          {error}
        </div>
      )}

      {/* ========== LIVE OPERATIONS ZONE ========== */}
      <ZoneHeading
        title="ການເຄື່ອນໄຫວສົດ"
        subtitle="ລົດ ແລະ ບິນທີ່ກຳລັງເຄື່ອນໄຫວ · ອັບເດດອັດຕະໂນມັດ"
      />

      {/* Live fleet map (cars + driver phones) */}
      <LiveFleetOverview />

      {/* Waiting dispatch */}
      <div className={`${CARD} overflow-hidden`}>
        <ActivityCardHeader
          icon={<FaClock className="text-amber-500" size={13} />}
          tint="bg-amber-500/10"
          title="ຈັດຖ້ຽວແລ້ວ ລໍຖ້າຈັດສົ່ງ"
          subtitle={`ສະແດງ ${formatNumber((activity?.waiting_dispatch ?? []).length)} / ${formatNumber(activity?.waiting_dispatch_count ?? 0)} ບິນ`}
          href="/bills-waitingsent"
          ctaClass="bg-amber-600 hover:bg-amber-700"
        />
        <WaitingDispatchList
          items={activity?.waiting_dispatch ?? []}
          total={activity?.waiting_dispatch_count ?? 0}
          agingTick={agingTick}
        />
      </div>

      {/* In progress */}
      <div className={`${CARD} overflow-hidden`}>
        <ActivityCardHeader
          icon={<FaTruck className="text-sky-500" size={13} />}
          tint="bg-sky-500/10"
          title="ລາຍການກຳລັງຈັດສົ່ງ"
          subtitle={`ສະແດງ ${formatNumber((activity?.in_progress ?? []).length)} / ${formatNumber(activity?.in_progress_count ?? 0)} ບິນ`}
          href="/bills-inprogress"
          ctaClass="bg-sky-600 hover:bg-sky-700"
        />
        <InProgressList
          items={activity?.in_progress ?? []}
          total={activity?.in_progress_count ?? 0}
          agingTick={agingTick}
        />
      </div>

      {/* Delivered, awaiting job close */}
      <div className={`${CARD} overflow-hidden`}>
        <ActivityCardHeader
          icon={<FaCheckCircle className="text-emerald-500" size={13} />}
          tint="bg-emerald-500/10"
          title="ຈັດສົ່ງສຳເລັດ ແຕ່ຍັງບໍ່ປິດຖ້ຽວ"
          subtitle={`ສະແດງ ${formatNumber((activity?.delivered_pending_close ?? []).length)} / ${formatNumber(activity?.delivered_pending_close_count ?? 0)} ບິນ`}
          href="/bill-complete"
          ctaClass="bg-emerald-600 hover:bg-emerald-700"
        />
        <DeliveredPendingCloseList
          items={activity?.delivered_pending_close ?? []}
          total={activity?.delivered_pending_close_count ?? 0}
          agingTick={agingTick}
        />
      </div>

      {/* Pending bills */}
      <div className={`${CARD} overflow-hidden`}>
        <ActivityCardHeader
          icon={<FaClock className="text-amber-500" size={13} />}
          tint="bg-amber-500/10"
          title="ລາຍການລໍຖ້າຈັດສົ່ງ"
          subtitle={currentPending.subtitle}
          href="/bills-pending"
          ctaClass="bg-slate-900 hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
        />

        {pendingReady ? (
        <>
        {/* Tabs */}
        <div className="px-5 pt-3">
          <div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800/70">
            {([
              { key: "today" as const, label: "ວັນນີ້", count: ps?.today_count },
              { key: "month" as const, label: "ເດືອນນີ້", count: ps?.month_count },
              { key: "year" as const, label: `ປີ ${currentYear}`, count: waitingDispatch },
            ]).map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setPendingTab(tab.key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-semibold transition-all ${
                  pendingTab === tab.key
                    ? "bg-white text-teal-700 shadow-sm dark:bg-slate-900 dark:text-teal-300"
                    : "text-slate-500 dark:text-gray-400 hover:text-slate-700"
                }`}
              >
                {tab.label}
                <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
                  pendingTab === tab.key
                    ? "bg-teal-500/10 text-teal-700 dark:text-teal-300"
                    : "bg-white/50 dark:bg-white/5 text-slate-500"
                }`}>
                  {formatNumber(tab.count)}
                </span>
              </button>
            ))}
          </div>
        </div>

        <PendingList
          items={currentPending.items}
          emptyMessage={`ບໍ່ມີລາຍການໃນ${currentPending.subtitle}`}
          agingTick={agingTick}
        />
        </>
        ) : (
          <div className="flex items-center justify-center py-16">
            <FaSpinner className="animate-spin text-2xl text-slate-300" />
          </div>
        )}
      </div>

      {/* ========== INSIGHTS ZONE ========== */}
      <ZoneHeading
        title="ພາບລວມ ແລະ ຕົວຊີ້ວັດ"
        subtitle="ສະຫຼຸບຜົນງານການຂົນສົ່ງ · ປີຽບທຽບສາຂາ ແລະ ແນວໂນ້ມ"
      />

      {/* Pending breakdown */}
      {!data.pending_breakdown ? (
        <SectionSkeleton title="ສະຖານະບິນຄ້າງສົ່ງ" height="h-20" />
      ) : (
        <Link
          href="/bills-pending"
          className={`block ${CARD} p-5 transition-all hover:-translate-y-0.5 hover:shadow-lg`}
        >
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
                <FaClock className="text-amber-500" size={13} />
              </div>
              <h2 className="text-sm font-bold text-slate-800 dark:text-white">ສະຖານະບິນຄ້າງສົ່ງ</h2>
            </div>
            <FaArrowRight className="text-slate-300" size={11} />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <PendingStat
              label="ຈຳນວນທີ່ຄ້າງສົ່ງ"
              value={data.pending_breakdown.total}
              icon={<FaBoxOpen size={13} />}
              tone="amber"
            />
            <PendingStat
              label="ເກີນກຳນົດແລ້ວ"
              value={data.pending_breakdown.overdue}
              icon={<FaExclamationTriangle size={13} />}
              tone="rose"
            />
            <PendingStat
              label="ຕິດຕໍ່ແລ້ວ"
              value={data.pending_breakdown.contacted}
              icon={<FaPhone size={13} />}
              tone="sky"
            />
            <PendingStat
              label="ຍັງບໍ່ຕິດຕໍ່"
              value={data.pending_breakdown.uncontacted}
              icon={<FaPhoneSlash size={13} />}
              tone="slate"
            />
            <PendingStat
              label="ພ້ອມສົ່ງແລ້ວ"
              value={data.pending_breakdown.ready}
              icon={<FaThumbsUp size={13} />}
              tone="emerald"
            />
            <PendingStat
              label="ກາຍມື້ສົ່ງ"
              value={data.pending_breakdown.past_send_date}
              icon={<FaCalendarTimes size={13} />}
              tone="orange"
            />
          </div>
        </Link>
      )}

      {/* Delivery KPI */}
      {data.delivery_kpi ? (
        <DeliveryKpiCard kpi={data.delivery_kpi} />
      ) : (
        <SectionSkeleton title="KPI ການຈັດສົ່ງ" height="h-32" />
      )}

      {/* ປະສິດທິພາບການຈັດສົ່ງ (ຍອດຍົກມາ/ຍົກໄປ + ຊັ້ນເວລານຳສົ່ງ) */}
      {perf ? (
        <DeliveryPerformanceCard perf={perf} />
      ) : (
        <SectionSkeleton title="ປະສິດທິພາບການຈັດສົ່ງ" height="h-40" />
      )}

      {/* Customer rating */}
      {data.customer_rating && data.customer_rating.total > 0 && (
        <div className={`${CARD} p-5`}>
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-500">
              ★
            </div>
            <h2 className="text-sm font-bold text-slate-800 dark:text-white">ການປະເມີນຈາກລູກຄ້າ</h2>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-xl bg-amber-50 dark:bg-amber-950/30 p-3.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">ສະເລ່ຍ</p>
              <p className="text-2xl font-extrabold text-amber-700 dark:text-amber-300 tabular-nums">
                {data.customer_rating.avg_stars?.toFixed(2) ?? "—"} <span className="text-base">★</span>
              </p>
            </div>
            <div className="rounded-xl bg-slate-50 dark:bg-slate-800/40 p-3.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">ປະເມີນທັງໝົດ</p>
              <p className="text-2xl font-extrabold text-slate-700 dark:text-slate-200 tabular-nums">{formatNumber(data.customer_rating.total)}</p>
            </div>
            <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/30 p-3.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">ດີ (4–5★)</p>
              <p className="text-2xl font-extrabold text-emerald-700 dark:text-emerald-300 tabular-nums">{formatNumber(data.customer_rating.positive)}</p>
            </div>
            <div className="rounded-xl bg-rose-50 dark:bg-rose-950/30 p-3.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">ບໍ່ດີ (1–2★)</p>
              <p className="text-2xl font-extrabold text-rose-700 dark:text-rose-300 tabular-nums">{formatNumber(data.customer_rating.negative)}</p>
            </div>
          </div>
        </div>
      )}

      {/* Overview grid: completion donuts / carrier mix / teams */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Completion donut card — split by day / month / year */}
        <div className={`${CARD} p-5 lg:col-span-2`}>
          <div className="flex items-center gap-2.5 mb-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-50 dark:bg-teal-950/40">
              <FaChartLine className="text-teal-700 dark:text-teal-300" size={13} />
            </div>
            <h2 className="text-sm font-bold text-slate-800 dark:text-white">ຄວາມຄືບໜ້າການຂົນສົ່ງ</h2>
          </div>
          <p className="text-[11px] text-slate-400 dark:text-gray-500">ແຍກຕາມ ວັນ · ເດືອນ · ປີ</p>

          {pendingReady ? (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <MiniDonut
              label="ວັນນີ້"
              sublabel={ps?.current_date}
              complete={toNumber(ps?.today_complete)}
              pending={toNumber(ps?.today_pending)}
              gradientFrom="#4bc7ef"
              gradientTo="#2c6fb6"
              gradientId="grad-today"
            />
            <MiniDonut
              label="ເດືອນນີ້"
              sublabel={ps?.current_month}
              complete={toNumber(ps?.month_complete)}
              pending={toNumber(ps?.month_pending)}
              gradientFrom="#2c6fb6"
              gradientTo="#003260"
              gradientId="grad-month"
            />
            <MiniDonut
              label="ປີ"
              sublabel={String(currentYear)}
              complete={toNumber(ps?.year_complete)}
              pending={toNumber(ps?.year_pending)}
              gradientFrom="#ffd071"
              gradientTo="#f6921e"
              gradientId="grad-year"
            />
          </div>
          ) : (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[170px] animate-pulse rounded-xl bg-slate-100 dark:bg-white/5" />
            ))}
          </div>
          )}
        </div>

        {/* Carrier mix */}
        <div className={`${CARD} p-5`}>
          <div className="flex items-center gap-2.5 mb-1">
            <div className="w-8 h-8 rounded-lg bg-sky-500/10 flex items-center justify-center">
              <FaRoute className="text-sky-500" size={13} />
            </div>
            <h2 className="text-sm font-bold text-slate-800 dark:text-white">ສັດສ່ວນຂົນສົ່ງ</h2>
          </div>
          <p className="text-[11px] text-slate-400 dark:text-gray-500">
            {formatNumber(logistic)} ບິນ · {logisticRate}% ຂອງທັງໝົດ
          </p>
          <div className="mt-5 space-y-3.5">
            {carrierMix.map((c) => (
              <CarrierMixBar key={c.label} label={c.label} value={c.value} total={logistic} color={c.bar} />
            ))}
          </div>
        </div>

        {/* Teams */}
        <div className={`${CARD} p-5`}>
          <div className="flex items-center gap-2.5 mb-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-500/10">
              <FaUsers className="text-teal-700 dark:text-teal-300" size={13} />
            </div>
            <h2 className="text-sm font-bold text-slate-800 dark:text-white">ໜ່ວຍຂົນສົ່ງ</h2>
          </div>
          <div className="space-y-2.5">
            {teams.map((t) => (
              <TeamCard key={t.code} {...t} />
            ))}
          </div>
        </div>
      </div>

      {/* ThunJai express — bills + products moved via ThunJai (transport 02-0005) */}
      {data.thunjai && (
        <div className="rounded-xl border border-violet-200/70 bg-violet-50/50 p-5 shadow-sm dark:border-violet-900/40 dark:bg-violet-950/20">
          <div className="mb-3 flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/15">
              <FaTruck className="text-violet-600 dark:text-violet-400" size={13} />
            </div>
            <h2 className="text-sm font-bold text-slate-800 dark:text-white">ຂົນສົ່ງທັນໃຈ (ThunJai)</h2>
            <span className="ml-auto text-[11px] text-slate-400">ປີ {currentYear}</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-white/70 px-3.5 py-2.5 dark:bg-white/5">
              <p className="text-[11px] text-slate-400">ຈຳນວນບິນ</p>
              <p className="text-2xl font-extrabold tabular-nums text-violet-700 dark:text-violet-400">
                {toNumber(data.thunjai.bill_count).toLocaleString("en-US")}
              </p>
            </div>
            <div className="rounded-xl bg-white/70 px-3.5 py-2.5 dark:bg-white/5">
              <p className="text-[11px] text-slate-400">ຈຳນວນສິນຄ້າ</p>
              <p className="text-2xl font-extrabold tabular-nums text-violet-700 dark:text-violet-400">
                {toNumber(data.thunjai.item_qty).toLocaleString("en-US", { maximumFractionDigits: 0 })}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
