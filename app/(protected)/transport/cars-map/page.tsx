"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  FaBroadcastTower,
  FaCompass,
  FaExternalLinkAlt,
  FaExpand,
  FaHourglassHalf,
  FaMapMarkerAlt,
  FaParking,
  FaRegClock,
  FaRoad,
  FaRoute,
  FaSearch,
  FaSignal,
  FaSpinner,
  FaSyncAlt,
  FaTachometerAlt,
  FaTimes,
  FaTruck,
} from "react-icons/fa";
// Copied from tms/src/app/(dashboard)/tracking/… — only the data call and
// the link component are swapped: this app talks REST + JWT and hosts just a
// few TMS screens, so other links open in TMS.
import api from "@/service/api";
import {
  formatGpsRelative,
  formatGpsTime,
  formatGpsWallTime,
  parseGpsTimestampMs,
} from "@/lib/gps-time";

interface GpsRealtime {
  imei: string;
  lat: string;
  lng: string;
  speed: string;
  heading: string;
  recorded_at: string;
  car_name: string;
  car_code: string;
  address: string;
  engine_state?: string;
  state_detail?: string;
  mileage?: string;
  sat?: string;
  gsm?: string;
  hdop?: string;
  oil?: string;
  ad_data?: string;
  input_state?: string;
  engine_state_since?: string;
  distance_today_m?: number;
  current_doc_no?: string;
  current_driver?: string;
  current_bills?: GpsCurrentBill[] | string;
}

interface GpsCurrentBill {
  bill_no: string;
  customer: string;
  status: string;
  phase: string;
}

function formatKilometers(meters: number | string | undefined | null): string {
  const n = Number(meters);
  if (!Number.isFinite(n) || n <= 0) return "0 km";
  if (n < 1000) return `${Math.round(n)} m`;
  return `${(n / 1000).toFixed(n < 10000 ? 2 : 1)} km`;
}

// Provider mileage often comes in metres (e.g. "59028482" = ~59,028 km).
// Treat values >= 100000 as metres; otherwise km.
function formatMileage(value: string | undefined): string {
  const n = Number(String(value ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return "-";
  const km = n >= 100000 ? n / 1000 : n;
  return `${km.toLocaleString("en-US", { maximumFractionDigits: 1 })} km`;
}

function formatDuration(fromIso: string | undefined): string {
  if (!fromIso) return "";
  const t = parseGpsTimestampMs(fromIso);
  if (!Number.isFinite(t)) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec} ວິ`;
  const m = Math.floor(diffSec / 60);
  if (m < 60) return `${m} ນທ`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h} ຊມ ${rm} ນທ` : `${h} ຊມ`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} ມື້ ${rh} ຊມ` : `${d} ມື້`;
}

// GPS quality grading: 0=poor, 1=ok, 2=good, 3=excellent
function gpsQuality(sat: string | undefined, hdop: string | undefined): {
  level: 0 | 1 | 2 | 3;
  label: string;
  bars: number;
} {
  const s = Number(sat);
  const h = Number(hdop);
  const hasSat = Number.isFinite(s);
  const hasHdop = Number.isFinite(h) && h > 0;
  if (!hasSat && !hasHdop) return { level: 0, label: "ບໍ່ມີ", bars: 0 };
  // Excellent: sat>=10 AND hdop<=1
  if (hasSat && s >= 10 && (!hasHdop || h <= 1)) return { level: 3, label: "ຍອດ", bars: 4 };
  if (hasSat && s >= 7 && (!hasHdop || h <= 2)) return { level: 2, label: "ດີ", bars: 3 };
  if (hasSat && s >= 4) return { level: 1, label: "ພໍໃຊ້", bars: 2 };
  return { level: 0, label: "ອ່ອນ", bars: 1 };
}

// GSM signal: provider value is often 0-31 (CSQ scale) or 0-100
function gsmBars(gsm: string | undefined): number {
  const n = Number(gsm);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // CSQ scale 0-31 (99 = unknown)
  if (n <= 31) {
    if (n >= 20) return 4;
    if (n >= 14) return 3;
    if (n >= 8) return 2;
    return 1;
  }
  // Percent scale 0-100
  if (n >= 75) return 4;
  if (n >= 50) return 3;
  if (n >= 25) return 2;
  return 1;
}

function safeParseJson<T = unknown>(value: string | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function getCurrentBills(car: GpsRealtime): GpsCurrentBill[] {
  const raw = car.current_bills;
  const parsed = typeof raw === "string" ? safeParseJson<unknown>(raw) : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const bill = item as Partial<GpsCurrentBill>;
    return [
      {
        bill_no: String(bill.bill_no ?? ""),
        customer: String(bill.customer ?? ""),
        status: String(bill.status ?? ""),
        phase: String(bill.phase ?? ""),
      },
    ];
  });
}

function billPhaseClass(phase: string) {
  switch (phase) {
    case "inprogress":
      return "bg-sky-500/10 text-sky-700 dark:text-sky-400";
    case "done":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "forwarded":
      return "bg-sky-500/10 text-sky-700 dark:text-sky-400";
    case "cancel":
      return "bg-rose-500/10 text-rose-700 dark:text-rose-400";
    default:
      return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
  }
}

type EngineState = "on" | "off" | "unknown";

function getEngineState(car: GpsRealtime): EngineState {
  const raw = String(car.engine_state ?? "").trim().toLowerCase();
  if (!raw) return "unknown";
  if (["1", "on", "true", "yes"].includes(raw)) return "on";
  if (["0", "off", "false", "no"].includes(raw)) return "off";
  return "unknown";
}

function engineLabel(state: EngineState): string {
  if (state === "on") return "ຕິດເຄື່ອງ";
  if (state === "off") return "ດັບເຄື່ອງ";
  return "ບໍ່ຮູ້";
}

const THAI_TO_LAO_STATE: Array<[RegExp, string]> = [
  [/ดับเครื่องยนต์/g, "ດັບເຄື່ອງຍົນ"],
  [/ติดเครื่องยนต์/g, "ຕິດເຄື່ອງຍົນ"],
  [/จอดรถ/g, "ຈອດລົດ"],
  [/ขับรถ/g, "ຂັບລົດ"],
  [/วิ่ง/g, "ແລ່ນ"],
  [/หยุด/g, "ຢຸດ"],
  [/ออฟไลน์/g, "ອອບລາຍ"],
];

function translateStateDetail(value: string): string {
  if (!value) return "";
  let out = value;
  for (const [re, repl] of THAI_TO_LAO_STATE) out = out.replace(re, repl);
  return out;
}

const AUTO_REFRESH_MS = 5_000;
const DEFAULT_CENTER: [number, number] = [17.9757, 102.6331]; // Vientiane

type FleetStatus = "moving" | "stopped" | "offline";
type Filter = "all" | FleetStatus;

const STATUS_COLORS: Record<FleetStatus, { solid: string; ring: string; text: string }> = {
  moving: { solid: "#10b981", ring: "#a7f3d0", text: "text-emerald-600" },
  stopped: { solid: "#f6921e", ring: "#ffd071", text: "text-amber-600" },
  offline: { solid: "#94a3b8", ring: "#e2e8f0", text: "text-slate-500" },
};

function parseCoord(value: string) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

function getStatus(car: GpsRealtime): FleetStatus {
  const hasFix = parseCoord(car.lat) != null && parseCoord(car.lng) != null;
  if (!hasFix) return "offline";
  const speed = Number(car.speed);
  return Number.isFinite(speed) && speed > 0 ? "moving" : "stopped";
}

function buildOpenUrl(lat: string, lng: string) {
  return `https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lng}`)}`;
}

function formatUpdatedAt(value: string) {
  return formatGpsWallTime(value);
}

function formatTime(value: string) {
  return formatGpsTime(value);
}

function formatRelative(value: string) {
  return formatGpsRelative(value);
}

function buildMarkerIcon(heading: number, status: FleetStatus, active: boolean) {
  const c = STATUS_COLORS[status];
  const outerRing = active
    ? `box-shadow: 0 0 0 6px rgba(79, 70, 229, 0.35), 0 4px 10px rgba(0,0,0,0.2);`
    : `box-shadow: 0 2px 6px rgba(0,0,0,0.25);`;
  const pulse = status === "moving"
    ? `<span style="position:absolute;inset:-8px;border-radius:50%;background:${c.solid};opacity:0.25;animation:carsMapPulse 1.8s ease-out infinite;"></span>`
    : "";
  const html = `
    <div style="position:relative;width:34px;height:34px;display:flex;align-items:center;justify-content:center;">
      ${pulse}
      <div style="position:relative;width:32px;height:32px;border-radius:50%;background:${c.solid};border:2.5px solid white;display:flex;align-items:center;justify-content:center;${outerRing}">
        <svg width="20" height="20" viewBox="0 0 24 24" style="transform: rotate(${heading}deg);">
          <!-- truck body (top-down view, front = up) -->
          <rect x="6.5" y="3" width="11" height="18" rx="2.5" fill="white"/>
          <!-- front windshield -->
          <rect x="8.5" y="5" width="7" height="3.2" rx="0.6" fill="rgba(15,23,42,0.6)"/>
          <!-- cab/cargo divider -->
          <line x1="6.5" y1="11" x2="17.5" y2="11" stroke="rgba(15,23,42,0.25)" stroke-width="0.6"/>
          <!-- rear window -->
          <rect x="8.5" y="16.2" width="7" height="2.6" rx="0.5" fill="rgba(15,23,42,0.4)"/>
          <!-- subtle direction tip -->
          <path d="M10.5 3 L13.5 3 L12 1.5 Z" fill="white"/>
        </svg>
      </div>
    </div>
  `;
  return L.divIcon({ html, className: "", iconSize: [34, 34], iconAnchor: [17, 17] });
}

// ==================== Sub-components ====================

function SignalBars({ bars, total = 4, color }: { bars: number; total?: number; color: string }) {
  return (
    <span className="inline-flex items-end gap-[1.5px] h-3" aria-label={`${bars}/${total}`}>
      {Array.from({ length: total }).map((_, i) => {
        const active = i < bars;
        const h = 4 + i * 2;
        return (
          <span
            key={i}
            className="rounded-[1px]"
            style={{
              width: 2.5,
              height: h,
              backgroundColor: active ? color : "rgba(148,163,184,0.35)",
            }}
          />
        );
      })}
    </span>
  );
}

function GpsBadge({ car }: { car: GpsRealtime }) {
  const q = gpsQuality(car.sat, car.hdop);
  if (q.bars === 0) return null;
  const colors = ["#94a3b8", "#f6921e", "#10b981", "#10b981"];
  const color = colors[q.level];
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400"
      title={`GPS: ${q.label} • ດາວທຽມ ${car.sat ?? "-"} • HDOP ${car.hdop ?? "-"}`}
    >
      <SignalBars bars={q.bars} color={color} />
      <span>GPS</span>
    </span>
  );
}

function GsmBadge({ car }: { car: GpsRealtime }) {
  const bars = gsmBars(car.gsm);
  if (bars === 0) return null;
  const color = bars >= 3 ? "#10b981" : bars === 2 ? "#f6921e" : "#ef4444";
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400"
      title={`GSM: ${car.gsm}`}
    >
      <SignalBars bars={bars} color={color} />
      <span>GSM</span>
    </span>
  );
}

function EngineBadge({ car }: { car: GpsRealtime }) {
  const state = getEngineState(car);
  if (state === "unknown") return null;
  const isOn = state === "on";
  const cls = isOn
    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 ring-emerald-500/30"
    : "bg-rose-500/15 text-rose-700 dark:text-rose-400 ring-rose-500/30";
  const dot = isOn ? "bg-emerald-500" : "bg-rose-500";
  const detail = translateStateDetail(String(car.state_detail ?? ""));
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${cls}`}
      title={detail || engineLabel(state)}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot} ${isOn ? "animate-pulse" : ""}`} />
      {engineLabel(state)}
    </span>
  );
}

function StatusDot({ status }: { status: FleetStatus }) {
  const c = STATUS_COLORS[status];
  return (
    <span
      className="inline-block h-2 w-2 rounded-full"
      style={{
        backgroundColor: c.solid,
        boxShadow: status === "moving" ? `0 0 0 3px ${c.ring}` : undefined,
      }}
    />
  );
}

function StatPill({
  label,
  value,
  color,
  active,
  onClick,
}: {
  label: string;
  value: number;
  color: "slate" | "emerald" | "amber" | "slate2";
  active: boolean;
  onClick: () => void;
}) {
  const palette: Record<string, { dot: string; text: string; bgActive: string }> = {
    slate: { dot: "bg-slate-200", text: "text-slate-200", bgActive: "bg-white/15" },
    emerald: { dot: "bg-emerald-400", text: "text-emerald-300", bgActive: "bg-emerald-400/20" },
    amber: { dot: "bg-amber-400", text: "text-amber-300", bgActive: "bg-amber-400/20" },
    slate2: { dot: "bg-slate-400", text: "text-slate-300", bgActive: "bg-slate-400/20" },
  };
  const p = palette[color];
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-medium transition-all ${
        active
          ? `${p.bgActive} border-white/30 ${p.text}`
          : "border-white/10 text-slate-300 hover:bg-white/5"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${p.dot}`} />
      <span>{label}</span>
      <span className="text-white font-bold">{value}</span>
    </button>
  );
}

function MapLegend() {
  const items: Array<{ status: FleetStatus; label: string }> = [
    { status: "moving", label: "ກຳລັງເຄື່ອນ" },
    { status: "stopped", label: "ຈອດຢູ່" },
    { status: "offline", label: "ບໍ່ເຊື່ອມຕໍ່" },
  ];
  return (
    <div className="absolute bottom-4 left-4 z-[400] rounded-lg glass px-3 py-2 shadow-lg">
      <p className="text-[9px] font-semibold uppercase tracking-widest text-slate-400 mb-1">ສັນຍາລັກ</p>
      <div className="flex flex-col gap-1">
        {items.map((item) => (
          <div key={item.status} className="flex items-center gap-2 text-[11px] text-slate-700 dark:text-slate-300">
            <StatusDot status={item.status} />
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SelectedCarCard({ car, onClose }: { car: GpsRealtime; onClose: () => void }) {
  const status = getStatus(car);
  const c = STATUS_COLORS[status];
  const hasFix = status !== "offline";
  const currentBills = getCurrentBills(car);
  return (
    <div className="absolute top-4 left-4 z-[400] flex w-[280px] max-h-[calc(100vh-2rem)] flex-col rounded-lg glass-heavy shadow-xl overflow-hidden">
      <div
        className="px-4 py-2.5 flex items-center gap-2 text-white"
        style={{ background: `linear-gradient(135deg, ${c.solid}, ${c.solid}dd)` }}
      >
        <FaTruck size={12} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold truncate">{car.car_name || car.car_code || car.imei}</p>
          <p className="text-[10px] opacity-90 font-mono truncate">{car.imei}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-md p-1 text-white/90 hover:bg-white/20 transition-colors"
          aria-label="Close"
        >
          <FaTimes size={10} />
        </button>
      </div>
      <div className="p-3 space-y-2 overflow-y-auto">
        {(car.current_doc_no || car.current_driver) && (
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-teal-500/10 px-2.5 py-1.5">
              <p className="text-[9px] font-semibold uppercase tracking-wide text-teal-600 dark:text-teal-400">
                ເລກຖ້ຽວ
              </p>
              <p className="truncate font-mono text-xs font-bold text-slate-800 dark:text-white">
                {car.current_doc_no || "-"}
              </p>
            </div>
            <div className="rounded-lg bg-sky-500/10 px-2.5 py-1.5">
              <p className="text-[9px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400">
                ຄົນຂັບປະຈຸບັນ
              </p>
              <p className="truncate text-xs font-bold text-slate-800 dark:text-white">
                {car.current_driver || "-"}
              </p>
            </div>
          </div>
        )}
        {currentBills.length > 0 && (
          <div className="rounded-lg bg-white/30 dark:bg-white/5 px-2.5 py-1.5">
            <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
              ບິນໃນຖ້ຽວ
            </p>
            <div className="mt-1.5 max-h-36 space-y-1.5 overflow-y-auto pr-1">
              {currentBills.map((bill, index) => (
                <div
                  key={`${bill.bill_no}-${index}`}
                  className="rounded-md border border-slate-200/60 bg-white/45 px-2 py-1.5 dark:border-white/5 dark:bg-white/5"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[11px] font-bold text-slate-800 dark:text-white">
                        {bill.bill_no || "-"}
                      </p>
                      <p className="mt-0.5 truncate text-[10px] text-slate-500 dark:text-slate-400">
                        {bill.customer || "-"}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${billPhaseClass(bill.phase)}`}
                    >
                      {bill.status || "-"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {hasFix ? (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <EngineBadge car={car} />
              {car.engine_state_since && (
                <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-400 ring-1 ring-sky-500/30">
                  <FaHourglassHalf size={8} /> {formatDuration(car.engine_state_since)}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-sky-500/10 px-2.5 py-1.5">
                <p className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-sky-500 dark:text-sky-400">
                  <FaTachometerAlt size={8} /> ຄວາມໄວ
                </p>
                <p className="text-sm font-bold text-slate-800 dark:text-white">
                  {car.speed ? `${car.speed} km/h` : "-"}
                </p>
              </div>
              <div className="rounded-lg bg-amber-500/10 px-2.5 py-1.5">
                <p className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-amber-500 dark:text-amber-400">
                  <FaCompass size={8} /> ທິດທາງ
                </p>
                <p className="text-sm font-bold text-slate-800 dark:text-white">
                  {car.heading ? `${car.heading}°` : "-"}
                </p>
              </div>
              <div className="rounded-lg bg-emerald-500/10 px-2.5 py-1.5">
                <p className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                  <FaRoute size={8} /> ໄລຍະທາງມື້ນີ້
                </p>
                <p className="text-sm font-bold text-slate-800 dark:text-white">
                  {formatKilometers(car.distance_today_m ?? 0)}
                </p>
              </div>
              <div className="rounded-lg bg-slate-500/10 px-2.5 py-1.5">
                <p className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
                  <FaRoad size={8} /> Odometer
                </p>
                <p className="text-sm font-bold text-slate-800 dark:text-white">
                  {formatMileage(car.mileage)}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 py-0.5">
              <GpsBadge car={car} />
              <GsmBadge car={car} />
              {car.oil && (
                <span className="inline-flex items-center gap-1 text-[10px] text-slate-500" title={`oil: ${car.oil}`}>
                  <span className="font-semibold">⛽</span>
                  {car.oil}
                </span>
              )}
            </div>
            {car.ad_data && (() => {
              const ad = safeParseJson<Record<string, number | null>>(car.ad_data);
              if (!ad) return null;
              const entries = Object.entries(ad).filter(([, v]) => v != null);
              if (entries.length === 0) return null;
              return (
                <div className="rounded-lg bg-white/30 dark:bg-white/5 px-2.5 py-1.5">
                  <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">Analog inputs</p>
                  <div className="mt-1 grid grid-cols-3 gap-x-2 gap-y-0.5 text-[10px] text-slate-700 dark:text-slate-300 font-mono">
                    {entries.map(([k, v]) => (
                      <span key={k}><span className="text-slate-400">{k}:</span> {String(v)}</span>
                    ))}
                  </div>
                </div>
              );
            })()}
            {car.input_state && (() => {
              const inp = safeParseJson<Record<string, number>>(car.input_state);
              if (!inp) return null;
              const entries = Object.entries(inp);
              if (entries.length === 0) return null;
              return (
                <div className="rounded-lg bg-white/30 dark:bg-white/5 px-2.5 py-1.5">
                  <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">Digital inputs</p>
                  <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
                    {entries.map(([k, v]) => (
                      <span
                        key={k}
                        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${
                          Number(v) ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-slate-500/10 text-slate-500"
                        }`}
                      >
                        <span className="font-mono">IN{k}</span>
                        <span className="font-bold">{Number(v) ? "ON" : "·"}</span>
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()}
            {car.state_detail && (
              <div className="rounded-lg bg-white/30 dark:bg-white/5 px-2.5 py-1.5">
                <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">ສະຖານະ</p>
                <p className="text-[11px] text-slate-700 dark:text-slate-300 leading-snug">{translateStateDetail(car.state_detail)}</p>
              </div>
            )}
            <div className="rounded-lg bg-white/30 dark:bg-white/5 px-2.5 py-1.5">
              <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">ເວລາອັບເດດ</p>
              <p className="text-xs text-slate-700 dark:text-slate-300">{formatUpdatedAt(car.recorded_at)}</p>
            </div>
            {car.address && (
              <div className="rounded-lg bg-white/30 dark:bg-white/5 px-2.5 py-1.5">
                <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">ທີ່ຕັ້ງ</p>
                <p className="text-[11px] text-slate-700 dark:text-slate-300 leading-snug">{car.address}</p>
              </div>
            )}
            <a
              href={buildOpenUrl(car.lat, car.lng)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-1.5 w-full rounded-lg bg-slate-900 hover:bg-slate-800 px-3 py-2 text-[11px] font-semibold text-white transition-colors"
            >
              <FaExternalLinkAlt size={9} />
              ເປີດ Google Maps
            </a>
          </>
        ) : (
          <div className="py-4 text-center">
            <p className="text-xs text-slate-500">ຍັງບໍ່ໄດ້ຮັບຕຳແໜ່ງ GPS</p>
          </div>
        )}
      </div>
    </div>
  );
}

function VehicleRow({
  car,
  active,
  onFocus,
}: {
  car: GpsRealtime;
  active: boolean;
  onFocus: (car: GpsRealtime) => void;
}) {
  const status = getStatus(car);
  const c = STATUS_COLORS[status];
  const hasFix = status !== "offline";
  return (
    <button
      type="button"
      onClick={() => hasFix && onFocus(car)}
      disabled={!hasFix}
      className={`w-full text-left px-3 py-2.5 flex items-start gap-3 transition-colors border-l-2 ${
        active
          ? "bg-teal-500/10 border-l-teal-500"
          : "border-l-transparent hover:bg-white/30 dark:hover:bg-white/5"
      } ${!hasFix ? "opacity-75 cursor-not-allowed hover:bg-transparent" : ""}`}
    >
      <div
        className="relative w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-white"
        style={{ backgroundColor: c.solid }}
      >
        <FaTruck size={11} />
        {status === "moving" && (
          <span
            className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-white animate-pulse"
            style={{ backgroundColor: c.solid }}
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-slate-800 dark:text-white truncate">
          {car.car_name || car.car_code || car.imei}
        </p>
        <p className="text-[10px] text-slate-400 font-mono truncate">{car.imei}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          <span className={`inline-flex items-center gap-1 font-semibold ${c.text}`}>
            <StatusDot status={status} />
            {status === "moving" ? `${car.speed || 0} km/h` : status === "stopped" ? "ຈອດ" : "ອອບລາຍ"}
          </span>
          <EngineBadge car={car} />
          {hasFix && car.heading && (
            <span className="inline-flex items-center gap-1 text-slate-500">
              <FaCompass size={9} className="text-amber-500" />
              {car.heading}°
            </span>
          )}
          {car.engine_state_since && (
            <span className="inline-flex items-center gap-1 text-[10px] text-slate-500" title={`ເລີ່ມສະຖານະ: ${car.engine_state_since}`}>
              <FaHourglassHalf size={8} className="text-sky-500" />
              {formatDuration(car.engine_state_since)}
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] text-slate-500 dark:text-slate-400">
          {car.mileage && (
            <span className="inline-flex items-center gap-1" title="ໄລຍະທາງລວມ (odometer)">
              <FaRoad size={9} className="text-slate-400" />
              {formatMileage(car.mileage)}
            </span>
          )}
          {Number(car.distance_today_m) > 0 && (
            <span className="inline-flex items-center gap-1" title="ໄລຍະທາງມື້ນີ້">
              <FaRoute size={9} className="text-emerald-500" />
              ມື້ນີ້ {formatKilometers(car.distance_today_m)}
            </span>
          )}
          <GpsBadge car={car} />
          <GsmBadge car={car} />
        </div>
        {car.recorded_at && (
          <div
            className="mt-1 flex items-center gap-1.5 text-[10.5px] text-slate-500 dark:text-slate-400"
            title={`ອັບເດດ: ${formatUpdatedAt(car.recorded_at)}`}
          >
            <FaRegClock size={9} className="text-teal-500" />
            <span className="font-mono font-semibold text-slate-600 dark:text-slate-300">
              {formatTime(car.recorded_at)}
            </span>
            <span className="text-slate-400">· {formatRelative(car.recorded_at)}</span>
          </div>
        )}
      </div>
      {hasFix && (
        <a
          href={buildOpenUrl(car.lat, car.lng)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="shrink-0 rounded-md glass p-1.5 text-slate-400 dark:text-slate-500 hover:text-teal-600 dark:hover:text-teal-400 transition-colors"
          title="ເປີດ Google Maps"
        >
          <FaExternalLinkAlt size={9} />
        </a>
      )}
    </button>
  );
}

// ==================== Main Page ====================

function CarsMapInner() {
  const searchParams = useSearchParams();
  const focusParam = searchParams.get("focus")?.trim() ?? "";

  const [cars, setCars] = useState<GpsRealtime[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [countdown, setCountdown] = useState(Math.floor(AUTO_REFRESH_MS / 1000));
  const [selected, setSelected] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const didFitRef = useRef(false);
  const loadInFlightRef = useRef(false);
  const didApplyInitialPreferenceRef = useRef(false);
  const didFocusFromUrlRef = useRef(false);

  const load = useCallback(async (mode: "initial" | "refresh") => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    try {
      const result = ((await api.get("/transport/fleet-live")).data?.data?.cars ?? []) as GpsRealtime[];
      const movingCount = result.filter((car) => getStatus(car) === "moving").length;
      const activeCount = result.filter((car) => parseCoord(car.lat) != null && parseCoord(car.lng) != null).length;
      setCars(result);
      if (!didApplyInitialPreferenceRef.current) {
        setFilter(movingCount > 0 ? "moving" : "all");
        didApplyInitialPreferenceRef.current = true;
      }
      setFetchedAt(new Date());
      if (!result.length) {
        setError("ບໍ່ພົບຂໍ້ມູນຕຳແໜ່ງລົດ");
      } else if (!activeCount) {
        setError("ຍັງບໍ່ໄດ້ຮັບຕຳແໜ່ງປະຈຸບັນຈາກ GPS provider");
      } else {
        setError(null);
      }
    } catch (err) {
      console.error(err);
      setError("ດຶງຂໍ້ມູນຈາກ GPS server ບໍ່ສຳເລັດ");
    } finally {
      setLoading(false);
      setRefreshing(false);
      loadInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    void load("initial");
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => void load("refresh"), AUTO_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [autoRefresh, load]);

  // Reset countdown after each successful fetch
  useEffect(() => {
    setCountdown(Math.floor(AUTO_REFRESH_MS / 1000));
  }, [fetchedAt]);

  // Tick countdown each second while auto-refresh is on
  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      setCountdown((c) => (c > 0 ? c - 1 : 0));
    }, 1000);
    return () => window.clearInterval(id);
  }, [autoRefresh]);

  // Initialize map (StrictMode-safe: cleanup fully tears down before re-mount)
  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container || mapRef.current) return;
    const map = L.map(container, { zoomControl: true }).setView(DEFAULT_CENTER, 7);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);
    mapRef.current = map;
    const markers = markersRef.current;
    return () => {
      map.remove();
      mapRef.current = null;
      markers.clear();
      didFitRef.current = false;
    };
  }, []);

  // Invalidate map size when sidebar visibility changes so tiles re-render
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const id = window.setTimeout(() => map.invalidateSize(), 250);
    return () => window.clearTimeout(id);
  }, [sidebarOpen]);

  // Sync markers when cars change
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const markers = markersRef.current;
    const nextKeys = new Set<string>();
    const points: Array<[number, number]> = [];
    const movingPoints: Array<[number, number]> = [];

    for (const car of cars) {
      const lat = parseCoord(car.lat);
      const lng = parseCoord(car.lng);
      if (lat == null || lng == null) continue;
      const key = car.imei;
      nextKeys.add(key);
      points.push([lat, lng]);

      const heading = Number(car.heading) || 0;
      const status = getStatus(car);
      if (status === "moving") movingPoints.push([lat, lng]);
      const isActive = selected === key;
      const icon = buildMarkerIcon(heading, status, isActive);

      const existing = markers.get(key);
      if (existing) {
        existing.setLatLng([lat, lng]);
        existing.unbindPopup();
        existing.setIcon(icon);
      } else {
        const marker = L.marker([lat, lng], { icon }).addTo(map);
        marker.on("click", () => setSelected(key));
        markers.set(key, marker);
      }
    }

    for (const [key, marker] of markers) {
      if (!nextKeys.has(key)) {
        marker.remove();
        markers.delete(key);
      }
    }

    if (!didFitRef.current && points.length > 0) {
      const focusPoints = movingPoints.length > 0 ? movingPoints : points;
      if (focusPoints.length === 1) {
        map.setView(focusPoints[0], 14);
      } else {
        map.fitBounds(L.latLngBounds(focusPoints), { padding: [40, 40] });
      }
      didFitRef.current = true;
    }
  }, [cars, selected]);

  const handleFocus = useCallback((car: GpsRealtime) => {
    const lat = parseCoord(car.lat);
    const lng = parseCoord(car.lng);
    if (lat == null || lng == null) return;
    setSelected(car.imei);
    const map = mapRef.current;
    if (map) {
      map.setView([lat, lng], 15);
    }
  }, []);

  // When opened from another page with ?focus=carCode (e.g. BillsInProgress
  // "ຕິດຕາມລົດ" link), auto-select & zoom to that car once data loads.
  useEffect(() => {
    if (!focusParam || didFocusFromUrlRef.current || cars.length === 0) return;
    const needle = focusParam.toLowerCase();
    const match = cars.find(
      (c) =>
        c.car_code?.toLowerCase() === needle ||
        c.car_name?.toLowerCase() === needle ||
        c.imei?.toLowerCase() === needle
    );
    if (!match) return;
    didFocusFromUrlRef.current = true;
    handleFocus(match);
  }, [focusParam, cars, handleFocus]);

  const handleFitAll = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const points: Array<[number, number]> = [];
    for (const car of cars) {
      const lat = parseCoord(car.lat);
      const lng = parseCoord(car.lng);
      if (lat != null && lng != null) points.push([lat, lng]);
    }
    if (points.length === 1) map.setView(points[0], 14);
    else if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
  }, [cars]);

  const stats = useMemo(() => {
    let moving = 0;
    let stopped = 0;
    let offline = 0;
    for (const car of cars) {
      const status = getStatus(car);
      if (status === "moving") moving++;
      else if (status === "stopped") stopped++;
      else offline++;
    }
    return { total: cars.length, moving, stopped, offline };
  }, [cars]);

  const filteredCars = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return cars.filter((car) => {
      const status = getStatus(car);
      if (filter !== "all" && status !== filter) return false;
      if (!q) return true;
      return (
        (car.car_name || "").toLowerCase().includes(q) ||
        (car.car_code || "").toLowerCase().includes(q) ||
        car.imei.toLowerCase().includes(q)
      );
    });
  }, [cars, filter, searchText]);

  const selectedCar = useMemo(
    () => (selected ? cars.find((c) => c.imei === selected) ?? null : null),
    [cars, selected]
  );

  return (
    <>
      <style>{`
        @keyframes carsMapPulse {
          0% { transform: scale(0.8); opacity: 0.5; }
          100% { transform: scale(1.8); opacity: 0; }
        }
        .leaflet-container { font-family: 'Noto Sans Lao', ui-sans-serif, system-ui, sans-serif; }
      `}</style>

      {/* Fullscreen container: cancel layout padding, fill viewport minus topbar & footer */}
      {/* Height/margins retuned for this app's shell: TMS renders inside a padded
          main with its own topbar (hence -m-4 and 100vh-6.5rem), while here the
          content area has no padding and no desktop topbar — only the 3.5rem
          mobile bar. Keeping TMS's values pushed the map outside the frame. */}
        <div className="h-[calc(100vh-3.5rem)] md:h-screen flex flex-col bg-slate-950 overflow-hidden">
        {/* Compact top bar */}
        <div className="shrink-0 bg-[#003260] border-b border-white/10">
          <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <div className="flex items-center gap-2.5 shrink-0">
              <div className="w-9 h-9 rounded-lg bg-white/10 backdrop-blur flex items-center justify-center ring-1 ring-white/20">
                <FaBroadcastTower className="text-sky-300" size={14} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  </span>
                  <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-sky-300">
                    Live Fleet
                  </p>
                </div>
                <h1 className="text-sm font-bold text-white leading-tight">ແຜນທີ່ລົດປະຈຸບັນ</h1>
              </div>
            </div>

            {/* Status pills (also filter) */}
            <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
              <StatPill label="ທັງໝົດ" value={stats.total} color="slate" active={filter === "all"} onClick={() => setFilter("all")} />
              <StatPill label="ເຄື່ອນ" value={stats.moving} color="emerald" active={filter === "moving"} onClick={() => setFilter(filter === "moving" ? "all" : "moving")} />
              <StatPill label="ຈອດ" value={stats.stopped} color="amber" active={filter === "stopped"} onClick={() => setFilter(filter === "stopped" ? "all" : "stopped")} />
              <StatPill label="ອອບລາຍ" value={stats.offline} color="slate2" active={filter === "offline"} onClick={() => setFilter(filter === "offline" ? "all" : "offline")} />
            </div>

            {/* Right actions */}
            <div className="flex items-center gap-2 shrink-0">
              {fetchedAt && (
                <span className="hidden md:inline text-[10px] text-slate-400">
                  {fetchedAt.toLocaleTimeString("lo-LA", { hour12: false })}
                </span>
              )}
              <button
                type="button"
                onClick={handleFitAll}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 hover:bg-white/10 transition-colors"
                title="ເບິ່ງທັງໝົດ"
              >
                <FaExpand size={10} />
                <span className="hidden sm:inline">Fit</span>
              </button>
              <label className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-[11px] text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(event) => setAutoRefresh(event.target.checked)}
                  className="h-3 w-3 accent-sky-400"
                />
                Auto {Math.floor(AUTO_REFRESH_MS / 1000)}s
                {autoRefresh && (
                  <span className="rounded-full bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-bold text-sky-200 tabular-nums">
                    {countdown}s
                  </span>
                )}
              </label>
              <button
                type="button"
                onClick={() => void load("refresh")}
                disabled={loading || refreshing}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-900 hover:bg-slate-100 transition-colors disabled:opacity-60"
              >
                <FaSyncAlt className={refreshing || loading ? "animate-spin" : ""} size={10} />
                <span className="hidden sm:inline">Refresh</span>
              </button>
            </div>
          </div>
        </div>

        {/* Main split: map + side panel */}
        <div className="flex-1 flex min-h-0 relative">
          {/* Map area */}
          <div className="flex-1 relative min-w-0">
            <div ref={mapContainerRef} className="absolute inset-0 bg-slate-200" />

            {loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/60 backdrop-blur-sm z-[500]">
                <div className="flex items-center gap-2 rounded-full bg-white/95 px-4 py-2 shadow-md">
                  <FaSpinner className="animate-spin text-sky-500" size={14} />
                  <span className="text-xs text-slate-600">ກຳລັງໂຫຼດແຜນທີ່...</span>
                </div>
              </div>
            )}

            <MapLegend />
            {selectedCar && <SelectedCarCard car={selectedCar} onClose={() => setSelected(null)} />}

            {/* Sidebar toggle button (floats on map edge) */}
            <button
              type="button"
              onClick={() => setSidebarOpen((v) => !v)}
              className="absolute top-4 right-4 z-[400] lg:hidden inline-flex items-center gap-1.5 rounded-lg bg-white/95 backdrop-blur px-3 py-2 text-[11px] font-semibold text-slate-700 shadow-lg border border-slate-200 hover:bg-white"
            >
              {sidebarOpen ? <FaTimes size={10} /> : <FaTruck size={11} />}
              {sidebarOpen ? "ປິດລາຍການ" : `ລາຍການ (${filteredCars.length})`}
            </button>

          </div>

          {/* Side panel */}
          <aside
            className={`${
              sidebarOpen ? "translate-x-0" : "translate-x-full lg:translate-x-0 lg:w-0 lg:border-l-0"
            } absolute lg:relative top-0 right-0 h-full w-[320px] lg:w-[340px] glass-heavy border-l border-slate-200/30 dark:border-white/5 flex flex-col shadow-xl lg:shadow-none transition-all duration-300 z-[450] overflow-hidden`}
          >
            {/* Search */}
            <div className="shrink-0 px-4 py-3 border-b border-slate-200/30 dark:border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <FaTruck className="text-teal-500" size={13} />
                <h2 className="text-sm font-bold text-slate-800 dark:text-white">ລາຍການລົດ</h2>
                <span className="ml-auto rounded-full bg-teal-500/10 px-2 py-0.5 text-[10px] font-bold text-teal-600 dark:text-teal-400">
                  {filteredCars.length} / {cars.length}
                </span>
              </div>
              <div className="relative">
                <FaSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300" size={11} />
                <input
                  type="text"
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                  placeholder="ຄົ້ນຫາຊື່ລົດ ຫຼື IMEI..."
                className="glass-input w-full pl-8 pr-8 py-2 rounded-lg text-xs"
                />
                {searchText && (
                  <button
                    type="button"
                    onClick={() => setSearchText("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-600"
                    aria-label="Clear"
                  >
                    <FaTimes size={9} />
                  </button>
                )}
              </div>

              {/* Filter tabs (segmented) */}
              <div className="mt-2 grid grid-cols-4 gap-1 p-0.5 glass rounded-lg text-[10px]">
                {([
                  { key: "all", label: "ທັງໝົດ", icon: <FaTruck size={9} /> },
                  { key: "moving", label: "ເຄື່ອນ", icon: <FaRoute size={9} /> },
                  { key: "stopped", label: "ຈອດ", icon: <FaParking size={9} /> },
                  { key: "offline", label: "ອອບລາຍ", icon: <FaSignal size={9} /> },
                ] as const).map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setFilter(tab.key)}
                    className={`flex items-center justify-center gap-1 py-1.5 rounded-md font-semibold transition-all ${
                      filter === tab.key
                        ? "glass-heavy text-teal-600 dark:text-teal-400"
                        : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                    }`}
                  >
                    {tab.icon}
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto divide-y divide-slate-200/30 dark:divide-white/5">
              {cars.length === 0 && !loading ? (
                <div className="px-4 py-10 text-center">
                  <FaMapMarkerAlt className="mx-auto text-slate-300 text-2xl mb-2" />
                  <p className="text-xs font-semibold text-slate-500">ຍັງບໍ່ມີລົດທີ່ຕັ້ງຄ່າ IMEI</p>
                  <p className="text-[11px] text-slate-400 mt-1">
                    ກະລຸນາເພີ່ມ IMEI ໃຫ້ລົດໃນໜ້າຈັດການລົດ
                  </p>
                </div>
              ) : filteredCars.length === 0 ? (
                <div className="px-4 py-10 text-center text-xs text-slate-400">
                  ບໍ່ພົບຜົນທີ່ກົງກັບການຄົ້ນຫາ
                </div>
              ) : (
                filteredCars.map((car) => (
                  <VehicleRow
                    key={car.imei}
                    car={car}
                    active={selected === car.imei}
                    onFocus={handleFocus}
                  />
                ))
              )}
            </div>

            {error && cars.length > 0 && (
              <div className="shrink-0 px-4 py-2 border-t border-amber-500/20 bg-amber-500/10 text-[11px] text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                <FaSignal size={10} />
                {error}
              </div>
            )}
          </aside>
        </div>
      </div>
    </>
  );
}

export default function CarsMapPage() {
  return (
    <Suspense fallback={null}>
      <CarsMapInner />
    </Suspense>
  );
}
