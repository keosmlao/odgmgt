"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "@/components/tms-link";
import { useSearchParams } from "next/navigation";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  FaBatteryHalf,
  FaCompass,
  FaExclamationTriangle,
  FaExpand,
  FaExternalLinkAlt,
  FaMapMarkerAlt,
  FaMobileAlt,
  FaParking,
  FaRegClock,
  FaRoute,
  FaSearch,
  FaSignal,
  FaSpinner,
  FaSyncAlt,
  FaTachometerAlt,
  FaTimes,
  FaTruck,
  FaWifi,
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

// One phone's latest fix — keyed by the device, not the trip. Shape mirrors
// getPhoneFleet() in src/queries/tracking.js. unit_key is the stable identity
// (imei when known, else driver/car/doc_no) used for markers + selection; imei
// may be empty for legacy points. doc_no is the trip the latest point belongs
// to (used for the "full trail" link + context).
interface PhoneUnit {
  unit_key: string;
  imei: string;
  doc_no: string;
  doc_date: string;
  car: string;
  driver: string;
  job_status: number;
  lat: string;
  lng: string;
  speed: string;
  heading: string;
  accuracy: string;
  battery: string;
  signal: string;
  recorded_at: string;
  point_count: number;
  device_model: string;
  sim_phone: string;
  /** Seconds the phone has stayed within ~65m of its current position. */
  stationary_secs: number;
  /**
   * Latest tracking problem the driver app reported in the last 15 min, or ''
   * when healthy: 'gps_off' | 'no_permission' | 'auth_expired'. Distinguishes a
   * driver disabling tracking from a parked truck / dead zone.
   */
  tracking_status?: string;
}

// Driver-app-reported tracking problems → office-facing Lao label.
const TRACKING_ALERTS: Record<string, string> = {
  gps_off: "driver ປິດ GPS",
  no_permission: "driver ປິດສິດຕຳແໜ່ງ",
  auth_expired: "ເຊສຊັນໝົດອາຍຸ",
};
function trackingAlert(u: PhoneUnit): string | null {
  const key = String(u.tracking_status ?? "").trim();
  return key ? TRACKING_ALERTS[key] ?? null : null;
}

const AUTO_REFRESH_MS = 3_000;
const DEFAULT_CENTER: [number, number] = [17.9757, 102.6331]; // Vientiane
// A phone fix older than this means the driver app stopped reporting — we
// read that as "offline" even though the last coordinate is still valid.
const OFFLINE_MS = 3 * 60_000;

type FleetStatus = "moving" | "stopped" | "offline";
type Filter = "all" | "online" | FleetStatus;

const STATUS_COLORS: Record<FleetStatus, { solid: string; ring: string; text: string }> = {
  moving: { solid: "#10b981", ring: "#a7f3d0", text: "text-emerald-600 dark:text-emerald-400" },
  stopped: { solid: "#f6921e", ring: "#ffd071", text: "text-amber-600 dark:text-amber-400" },
  offline: { solid: "#94a3b8", ring: "#e2e8f0", text: "text-slate-500" },
};

function parseCoord(value: string) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

function isStale(recordedAt: string): boolean {
  const t = parseGpsTimestampMs(recordedAt);
  if (!Number.isFinite(t)) return true;
  return Date.now() - t > OFFLINE_MS;
}

function getStatus(u: PhoneUnit): FleetStatus {
  const hasFix = parseCoord(u.lat) != null && parseCoord(u.lng) != null;
  if (!hasFix || isStale(u.recorded_at)) return "offline";
  const speed = Number(u.speed);
  return Number.isFinite(speed) && speed > 0 ? "moving" : "stopped";
}

// Online = the phone reported a fresh fix (moving or stopped). Offline = its
// last fix is stale (app stopped reporting).
function isOnline(u: PhoneUnit): boolean {
  return getStatus(u) !== "offline";
}

function jobStatusLabel(s: number): { text: string; cls: string } {
  if (s >= 3) return { text: "ປິດແລ້ວ", cls: "bg-slate-500/10 text-slate-500" };
  if (s === 2) return { text: "ກຳລັງຈັດສົ່ງ", cls: "bg-sky-500/10 text-sky-600 dark:text-sky-400" };
  if (s === 1) return { text: "ຮັບແລ້ວ", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400" };
  return { text: "ລໍຖ້າ", cls: "bg-slate-500/10 text-slate-500" };
}

// "X ນທ / ຊມ / ມື້" — how long the phone has sat at its current spot.
function formatDuration(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  if (s < 60) return `${s} ວິ`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} ນທ`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h} ຊມ ${rm} ນທ` : `${h} ຊມ`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} ມື້ ${rh} ຊມ` : `${d} ມື້`;
}

// Trim the stored lat/lng strings to a readable coordinate pair.
function formatCoords(lat: string, lng: string): string {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return "-";
  return `${la.toFixed(5)}, ${ln.toFixed(5)}`;
}

function formatBattery(value: string): string {
  const n = Number(String(value ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return "-";
  return `${Math.round(n)}%`;
}

function buildOpenUrl(lat: string, lng: string) {
  return `https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lng}`)}`;
}

// Round pin with a phone glyph; when moving we tip an arrow toward `heading`
// so the marker reads like a moving driver, mirroring cars-map's truck icon.
function buildMarkerIcon(heading: number, status: FleetStatus, active: boolean) {
  const c = STATUS_COLORS[status];
  const outerRing = active
    ? `box-shadow: 0 0 0 6px rgba(79, 70, 229, 0.35), 0 4px 10px rgba(0,0,0,0.2);`
    : `box-shadow: 0 2px 6px rgba(0,0,0,0.25);`;
  const pulse =
    status === "moving"
      ? `<span style="position:absolute;inset:-8px;border-radius:50%;background:${c.solid};opacity:0.25;animation:phonesMapPulse 1.8s ease-out infinite;"></span>`
      : "";
  const glyph =
    status === "moving"
      ? `<svg width="18" height="18" viewBox="0 0 24 24" style="transform: rotate(${heading}deg);">
           <path d="M12 2 L19 20 L12 16 L5 20 Z" fill="white"/>
         </svg>`
      : `<svg width="15" height="15" viewBox="0 0 24 24" fill="white">
           <rect x="7" y="2" width="10" height="20" rx="2.5"/>
           <rect x="9.5" y="4" width="5" height="13" rx="0.6" fill="${c.solid}"/>
           <circle cx="12" cy="19.3" r="1" fill="${c.solid}"/>
         </svg>`;
  const html = `
    <div style="position:relative;width:34px;height:34px;display:flex;align-items:center;justify-content:center;">
      ${pulse}
      <div style="position:relative;width:32px;height:32px;border-radius:50%;background:${c.solid};border:2.5px solid white;display:flex;align-items:center;justify-content:center;${outerRing}">
        ${glyph}
      </div>
    </div>
  `;
  return L.divIcon({ html, className: "", iconSize: [34, 34], iconAnchor: [17, 17] });
}

// ==================== Sub-components ====================

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

// Explicit "is this phone online right now" chip — a live green pulse when the
// device is reporting, a muted grey dot (with last-seen) when it has gone quiet.
function OnlineBadge({ online, recordedAt }: { online: boolean; recordedAt: string }) {
  if (online) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-bold text-emerald-600 dark:text-emerald-400">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
        ອອນລາຍ
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-slate-500/10 px-1.5 py-0.5 text-[9px] font-bold text-slate-500"
      title={recordedAt ? `ເຫັນລ່າສຸດ: ${formatGpsWallTime(recordedAt)}` : undefined}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
      ອອບລາຍ
      {recordedAt && <span className="font-medium opacity-80">· {formatGpsRelative(recordedAt)}</span>}
    </span>
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
  color: "slate" | "sky" | "emerald" | "amber" | "slate2";
  active: boolean;
  onClick: () => void;
}) {
  const palette: Record<string, { dot: string; text: string; bgActive: string }> = {
    slate: { dot: "bg-slate-200", text: "text-slate-200", bgActive: "bg-white/15" },
    sky: { dot: "bg-sky-400", text: "text-sky-300", bgActive: "bg-sky-400/20" },
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
        active ? `${p.bgActive} border-white/30 ${p.text}` : "border-white/10 text-slate-300 hover:bg-white/5"
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
    { status: "stopped", label: "ຈອດ/ຢຸດ" },
    { status: "offline", label: "ບໍ່ສົ່ງສັນຍານ" },
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

function MiniStat({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-white/30 dark:bg-white/5 px-2.5 py-1.5">
      <p className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {icon} {label}
      </p>
      <p className="text-sm font-bold text-slate-800 dark:text-white">{value}</p>
    </div>
  );
}

function SelectedUnitCard({ unit, onClose }: { unit: PhoneUnit; onClose: () => void }) {
  const status = getStatus(unit);
  const c = STATUS_COLORS[status];
  const js = jobStatusLabel(unit.job_status);
  return (
    <div className="absolute top-4 left-4 z-[400] flex w-[280px] max-h-[calc(100vh-2rem)] flex-col rounded-lg glass-heavy shadow-xl overflow-hidden">
      <div
        className="px-4 py-2.5 flex items-center gap-2 text-white"
        style={{ background: `linear-gradient(135deg, ${c.solid}, ${c.solid}dd)` }}
      >
        <FaMobileAlt size={12} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold truncate">{unit.driver || unit.car || unit.doc_no}</p>
          <p className="text-[10px] opacity-90 truncate font-mono">
            {unit.imei ? `IMEI ${unit.imei}` : "ບໍ່ມີ IMEI (ຂໍ້ມູນ app)"}
          </p>
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
        <div className="flex flex-wrap items-center gap-1.5">
          <OnlineBadge online={status !== "offline"} recordedAt={unit.recorded_at} />
          <span className={`inline-flex items-center gap-1 text-[11px] font-semibold ${c.text}`}>
            <StatusDot status={status} />
            {status === "moving" ? `${unit.speed || 0} km/h` : status === "stopped" ? "ຈອດ/ຢຸດ" : "ບໍ່ສົ່ງສັນຍານ"}
          </span>
        </div>

        {trackingAlert(unit) && (
          <div className="flex items-center gap-1.5 rounded-lg bg-red-500/10 ring-1 ring-red-500/30 px-2.5 py-1.5 text-[11px] font-bold text-red-600 dark:text-red-400">
            <FaExclamationTriangle size={10} />
            {trackingAlert(unit)}
          </div>
        )}

        {/* The two things that matter for a phone: where it is now, and how
            long it has stayed there. */}
        <div className="rounded-lg bg-sky-500/5 ring-1 ring-sky-500/20 px-2.5 py-2 space-y-1">
          <p className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400">
            <FaMapMarkerAlt size={8} /> ຕຳແໜ່ງປະຈຸບັນ
          </p>
          <p className="font-mono text-[11px] text-slate-700 dark:text-slate-200">{formatCoords(unit.lat, unit.lng)}</p>
          <p className="flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-300">
            <FaRegClock size={9} className="text-teal-500" />
            ຢູ່ຈຸດນີ້{" "}
            <span className="font-bold text-slate-800 dark:text-white">
              {unit.stationary_secs > 30 ? formatDuration(unit.stationary_secs) : "ຫາກໍຮອດ"}
            </span>
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-teal-500/10 px-2.5 py-1.5">
            <p className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-teal-600 dark:text-teal-400">
              <FaTruck size={8} /> ລົດ
            </p>
            <p className="truncate text-xs font-bold text-slate-800 dark:text-white">{unit.car || "-"}</p>
          </div>
          <div className="rounded-lg bg-sky-500/10 px-2.5 py-1.5">
            <p className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400">
              <FaRoute size={8} /> ຖ້ຽວປະຈຸບັນ
            </p>
            <p className="truncate text-xs font-bold font-mono text-slate-800 dark:text-white">{unit.doc_no || "-"}</p>
            <span className={`mt-0.5 inline-block text-[9px] font-bold px-1.5 py-0.5 rounded-full ${js.cls}`}>{js.text}</span>
          </div>
        </div>

        {/* Telemetry is all-optional in the mobile schema (the legacy
            save_travel_history path sends none), so render only the fields that
            actually arrived — no card full of "-". Point count is always real. */}
        {(() => {
          const cells: Array<{ key: string; label: string; value: string; icon: React.ReactNode }> = [];
          if (unit.speed) cells.push({ key: "speed", label: "ຄວາມໄວ", value: `${unit.speed} km/h`, icon: <FaTachometerAlt size={8} /> });
          if (unit.heading) cells.push({ key: "heading", label: "ທິດທາງ", value: `${unit.heading}°`, icon: <FaCompass size={8} /> });
          if (formatBattery(unit.battery) !== "-") cells.push({ key: "battery", label: "ແບັດເຕີຣີ", value: formatBattery(unit.battery), icon: <FaBatteryHalf size={8} /> });
          if (unit.signal) cells.push({ key: "signal", label: "ສັນຍານ", value: unit.signal, icon: <FaSignal size={8} /> });
          if (unit.accuracy) cells.push({ key: "accuracy", label: "ຄວາມຄາດເຄື່ອນ", value: `${unit.accuracy} m`, icon: <FaMapMarkerAlt size={8} /> });
          cells.push({ key: "points", label: "ຈຳນວນຈຸດ", value: String(unit.point_count ?? 0), icon: <FaRoute size={8} /> });
          return (
            <div className="grid grid-cols-2 gap-2">
              {cells.map((cell) => (
                <MiniStat key={cell.key} label={cell.label} value={cell.value} icon={cell.icon} />
              ))}
            </div>
          );
        })()}

        {(unit.device_model || unit.sim_phone) && (
          <div className="rounded-lg bg-white/30 dark:bg-white/5 px-2.5 py-1.5">
            <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">ເຄື່ອງ</p>
            <p className="text-[11px] text-slate-700 dark:text-slate-300 leading-snug">
              {unit.device_model || "-"}
              {unit.sim_phone ? <span className="text-slate-400"> · 📱 {unit.sim_phone}</span> : null}
            </p>
          </div>
        )}

        <div className="rounded-lg bg-white/30 dark:bg-white/5 px-2.5 py-1.5">
          <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">ເວລາອັບເດດ</p>
          <p className="text-xs text-slate-700 dark:text-slate-300">
            {formatGpsWallTime(unit.recorded_at)}
            <span className="text-slate-400"> · {formatGpsRelative(unit.recorded_at)}</span>
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Link
            href={`/tracking/phone?doc=${encodeURIComponent(unit.doc_no)}`}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 px-3 py-2 text-[11px] font-semibold text-white transition-colors"
          >
            <FaRoute size={9} />
            ເສັ້ນທາງເຕັມ
          </Link>
          <a
            href={buildOpenUrl(unit.lat, unit.lng)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 px-3 py-2 text-[11px] font-semibold text-white transition-colors"
          >
            <FaExternalLinkAlt size={9} />
            Google Maps
          </a>
        </div>
      </div>
    </div>
  );
}

function UnitRow({
  unit,
  active,
  onFocus,
}: {
  unit: PhoneUnit;
  active: boolean;
  onFocus: (u: PhoneUnit) => void;
}) {
  const status = getStatus(unit);
  const c = STATUS_COLORS[status];
  const js = jobStatusLabel(unit.job_status);
  return (
    <button
      type="button"
      onClick={() => onFocus(unit)}
      className={`w-full text-left px-3 py-2.5 flex items-start gap-3 transition-colors border-l-2 ${
        active ? "bg-teal-500/10 border-l-teal-500" : "border-l-transparent hover:bg-white/30 dark:hover:bg-white/5"
      }`}
    >
      <div
        className="relative w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-white"
        style={{ backgroundColor: c.solid }}
      >
        <FaMobileAlt size={11} />
        {status === "moving" && (
          <span
            className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-white animate-pulse"
            style={{ backgroundColor: c.solid }}
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[13px] font-semibold text-slate-800 dark:text-white truncate">
            {unit.driver || unit.car || unit.doc_no}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <OnlineBadge online={status !== "offline"} recordedAt={unit.recorded_at} />
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${js.cls}`}>{js.text}</span>
          </div>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
          <FaTruck size={9} /> <span className="truncate">{unit.car}</span>
          <FaRoute size={9} /> <span className="truncate font-mono">{unit.doc_no}</span>
        </div>
        {trackingAlert(unit) && (
          <div className="mt-1 inline-flex items-center gap-1 rounded-md bg-red-500/15 px-1.5 py-0.5 text-[10.5px] font-bold text-red-600 dark:text-red-400">
            <FaExclamationTriangle size={9} />
            {trackingAlert(unit)}
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]">
          <span className={`inline-flex items-center gap-1 font-semibold ${c.text}`}>
            <StatusDot status={status} />
            {status === "moving" ? `${unit.speed || 0} km/h` : status === "stopped" ? "ຈອດ" : "ບໍ່ສົ່ງສັນຍານ"}
          </span>
          {formatBattery(unit.battery) !== "-" && (
            <span className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400">
              <FaBatteryHalf size={9} className="text-emerald-500" />
              {formatBattery(unit.battery)}
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400" title="ຈຳນວນຈຸດ">
            <FaRoute size={9} className="text-sky-500" />
            {unit.point_count ?? 0}
          </span>
          {status !== "moving" && unit.stationary_secs > 60 && (
            <span className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400" title="ຢູ່ຈຸດນີ້">
              <FaRegClock size={9} className="text-amber-500" />
              ຢູ່ຈຸດ {formatDuration(unit.stationary_secs)}
            </span>
          )}
        </div>
        {unit.recorded_at && (
          <div
            className="mt-1 flex items-center gap-1.5 text-[10.5px] text-slate-500 dark:text-slate-400"
            title={`ອັບເດດ: ${formatGpsWallTime(unit.recorded_at)}`}
          >
            <FaRegClock size={9} className="text-teal-500" />
            <span className="font-mono font-semibold text-slate-600 dark:text-slate-300">{formatGpsTime(unit.recorded_at)}</span>
            <span className="text-slate-400">· {formatGpsRelative(unit.recorded_at)}</span>
          </div>
        )}
      </div>
    </button>
  );
}

// ==================== Main Page ====================

function PhonesMapInner() {
  const searchParams = useSearchParams();
  const focusParam = searchParams.get("focus")?.trim() ?? "";

  const [units, setUnits] = useState<PhoneUnit[]>([]);
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
  const didFocusFromUrlRef = useRef(false);

  const load = useCallback(async (mode: "initial" | "refresh") => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    try {
      const result = ((await api.get("/transport/fleet-live")).data?.data?.phones ?? []) as PhoneUnit[];
      const onlineCount = result.filter(isOnline).length;
      setUnits(result);
      setFetchedAt(new Date());
      if (!result.length) {
        setError("ຍັງບໍ່ມີຖ້ຽວທີ່ມີຂໍ້ມູນຕຳແໜ່ງຈາກມືຖື");
      } else if (!onlineCount) {
        setError("ບໍ່ມີມືຖືທີ່ກຳລັງສົ່ງສັນຍານໃນຕອນນີ້");
      } else {
        setError(null);
      }
    } catch (err) {
      console.error(err);
      setError("ດຶງຂໍ້ມູນຕຳແໜ່ງມືຖືບໍ່ສຳເລັດ");
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

  useEffect(() => {
    setCountdown(Math.floor(AUTO_REFRESH_MS / 1000));
  }, [fetchedAt]);

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

  // Sync markers when units change
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const markers = markersRef.current;
    const nextKeys = new Set<string>();
    const points: Array<[number, number]> = [];
    const onlinePoints: Array<[number, number]> = [];

    for (const unit of units) {
      const lat = parseCoord(unit.lat);
      const lng = parseCoord(unit.lng);
      if (lat == null || lng == null) continue;
      const key = unit.unit_key;
      nextKeys.add(key);
      points.push([lat, lng]);

      const heading = Number(unit.heading) || 0;
      const status = getStatus(unit);
      if (status !== "offline") onlinePoints.push([lat, lng]);
      const isActive = selected === key;
      const icon = buildMarkerIcon(heading, status, isActive);

      const existing = markers.get(key);
      if (existing) {
        existing.setLatLng([lat, lng]);
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
      const focusPoints = onlinePoints.length > 0 ? onlinePoints : points;
      if (focusPoints.length === 1) {
        map.setView(focusPoints[0], 14);
      } else {
        map.fitBounds(L.latLngBounds(focusPoints), { padding: [40, 40] });
      }
      didFitRef.current = true;
    }
  }, [units, selected]);

  const handleFocus = useCallback((unit: PhoneUnit) => {
    const lat = parseCoord(unit.lat);
    const lng = parseCoord(unit.lng);
    if (lat == null || lng == null) return;
    setSelected(unit.unit_key);
    const map = mapRef.current;
    if (map) map.setView([lat, lng], 15);
  }, []);

  // When opened with ?focus=<imei|doc_no>, auto-select & zoom once data loads.
  useEffect(() => {
    if (!focusParam || didFocusFromUrlRef.current || units.length === 0) return;
    const needle = focusParam.toLowerCase();
    const match = units.find(
      (u) =>
        u.unit_key.toLowerCase() === needle ||
        u.imei.toLowerCase() === needle ||
        u.doc_no.toLowerCase() === needle
    );
    if (!match) return;
    didFocusFromUrlRef.current = true;
    handleFocus(match);
  }, [focusParam, units, handleFocus]);

  const handleFitAll = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const points: Array<[number, number]> = [];
    for (const unit of units) {
      const lat = parseCoord(unit.lat);
      const lng = parseCoord(unit.lng);
      if (lat != null && lng != null) points.push([lat, lng]);
    }
    if (points.length === 1) map.setView(points[0], 14);
    else if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
  }, [units]);

  const stats = useMemo(() => {
    let moving = 0;
    let stopped = 0;
    let offline = 0;
    for (const unit of units) {
      const status = getStatus(unit);
      if (status === "moving") moving++;
      else if (status === "stopped") stopped++;
      else offline++;
    }
    return { total: units.length, moving, stopped, offline, online: moving + stopped };
  }, [units]);

  const filteredUnits = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return units.filter((unit) => {
      const status = getStatus(unit);
      if (filter === "online" && status === "offline") return false;
      if (filter !== "all" && filter !== "online" && status !== filter) return false;
      if (!q) return true;
      return (
        (unit.driver || "").toLowerCase().includes(q) ||
        (unit.car || "").toLowerCase().includes(q) ||
        unit.doc_no.toLowerCase().includes(q) ||
        unit.imei.toLowerCase().includes(q)
      );
    });
  }, [units, filter, searchText]);

  const selectedUnit = useMemo(
    () => (selected ? units.find((u) => u.unit_key === selected) ?? null : null),
    [units, selected]
  );

  return (
    <>
      <style>{`
        @keyframes phonesMapPulse {
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
                <FaMobileAlt className="text-sky-300" size={14} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  </span>
                  <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-sky-300">Live Phones</p>
                </div>
                <h1 className="text-sm font-bold text-white leading-tight">ແຜນທີ່ມືຖືຄົນຂັບ</h1>
              </div>
            </div>

            {/* Status pills (also filter) */}
            <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
              <StatPill label="ທັງໝົດ" value={stats.total} color="slate" active={filter === "all"} onClick={() => setFilter("all")} />
              <StatPill label="ອອນລາຍ" value={stats.online} color="sky" active={filter === "online"} onClick={() => setFilter(filter === "online" ? "all" : "online")} />
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
            {selectedUnit && <SelectedUnitCard unit={selectedUnit} onClose={() => setSelected(null)} />}

            {/* Sidebar toggle button (floats on map edge) */}
            <button
              type="button"
              onClick={() => setSidebarOpen((v) => !v)}
              className="absolute top-4 right-4 z-[400] lg:hidden inline-flex items-center gap-1.5 rounded-lg bg-white/95 backdrop-blur px-3 py-2 text-[11px] font-semibold text-slate-700 shadow-lg border border-slate-200 hover:bg-white"
            >
              {sidebarOpen ? <FaTimes size={10} /> : <FaMobileAlt size={11} />}
              {sidebarOpen ? "ປິດລາຍການ" : `ລາຍການ (${filteredUnits.length})`}
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
                <FaMobileAlt className="text-teal-500" size={13} />
                <h2 className="text-sm font-bold text-slate-800 dark:text-white">ມືຖືຄົນຂັບ</h2>
                <span className="ml-auto rounded-full bg-teal-500/10 px-2 py-0.5 text-[10px] font-bold text-teal-600 dark:text-teal-400">
                  {filteredUnits.length} / {units.length}
                </span>
              </div>
              <div className="relative">
                <FaSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300" size={11} />
                <input
                  type="text"
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                  placeholder="ຄົ້ນຫາເລກຖ້ຽວ, ລົດ ຫຼື ຄົນຂັບ..."
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
              <div className="mt-2 grid grid-cols-5 gap-1 p-0.5 glass rounded-lg text-[10px]">
                {([
                  { key: "all", label: "ທັງໝົດ", icon: <FaMobileAlt size={9} /> },
                  { key: "online", label: "ອອນລາຍ", icon: <FaWifi size={9} /> },
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
              {units.length === 0 && !loading ? (
                <div className="px-4 py-10 text-center">
                  <FaMapMarkerAlt className="mx-auto text-slate-300 text-2xl mb-2" />
                  <p className="text-xs font-semibold text-slate-500">ຍັງບໍ່ມີຂໍ້ມູນຕຳແໜ່ງຈາກມືຖື</p>
                  <p className="text-[11px] text-slate-400 mt-1">ຄົນຂັບຕ້ອງເປີດ app ແລະ ເລີ່ມຖ້ຽວເພື່ອສົ່ງຕຳແໜ່ງ</p>
                </div>
              ) : filteredUnits.length === 0 ? (
                <div className="px-4 py-10 text-center text-xs text-slate-400">ບໍ່ພົບຜົນທີ່ກົງກັບການຄົ້ນຫາ</div>
              ) : (
                filteredUnits.map((unit) => (
                  <UnitRow key={unit.unit_key} unit={unit} active={selected === unit.unit_key} onFocus={handleFocus} />
                ))
              )}
            </div>

            {error && units.length > 0 && (
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

export default function PhonesMapPage() {
  return (
    <Suspense fallback={null}>
      <PhonesMapInner />
    </Suspense>
  );
}
