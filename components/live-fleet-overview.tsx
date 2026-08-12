"use client";

// Links in this copied page point at TMS routes; TmsLink keeps the three
// screens this app hosts internal and sends the rest to TMS in a new tab.
import Link from "@/components/tms-link";
import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { FaArrowRight, FaBroadcastTower, FaMobileAlt, FaSpinner } from "react-icons/fa";
import api from "@/service/api";
import { parseGpsTimestampMs } from "@/lib/gps-time";

// A driver phone is "online" when its last fix is this fresh; older means the
// app stopped reporting. Mirrors OFFLINE_MS on the phones-map page.
const PHONE_OFFLINE_MS = 3 * 60_000;
const REFRESH_MS = 15_000;
const DEFAULT_CENTER: [number, number] = [17.9757, 102.6331]; // Vientiane

const COLOR_MOVING = "#10b981";
const COLOR_STOPPED = "#f6921e";
const COLOR_OFFLINE = "#94a3b8";

interface CarRow {
  lat?: string;
  lng?: string;
  speed?: string;
}

interface PhoneRow {
  lat?: string;
  lng?: string;
  speed?: string;
  recorded_at?: string;
}

interface FleetPoint {
  lat: number;
  lng: number;
  color: string;
}

interface Fleet {
  points: FleetPoint[];
  total: number;
  moving: number; // for phones this is "online & moving"
  stopped: number; // for phones this is "online & stopped"
  offline: number;
}

const EMPTY_FLEET: Fleet = { points: [], total: 0, moving: 0, stopped: 0, offline: 0 };

function parseCoord(value: string | undefined) {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

function buildCarFleet(rows: CarRow[]): Fleet {
  const points: FleetPoint[] = [];
  let moving = 0;
  let stopped = 0;
  let offline = 0;
  for (const row of rows) {
    const lat = parseCoord(row.lat);
    const lng = parseCoord(row.lng);
    if (lat == null || lng == null) {
      offline++;
      continue;
    }
    const isMoving = Number(row.speed) > 0;
    if (isMoving) moving++;
    else stopped++;
    points.push({ lat, lng, color: isMoving ? COLOR_MOVING : COLOR_STOPPED });
  }
  return { points, total: rows.length, moving, stopped, offline };
}

function buildPhoneFleet(rows: PhoneRow[]): Fleet {
  const points: FleetPoint[] = [];
  let moving = 0;
  let stopped = 0;
  let offline = 0;
  for (const row of rows) {
    const lat = parseCoord(row.lat);
    const lng = parseCoord(row.lng);
    const ts = parseGpsTimestampMs(row.recorded_at ?? "");
    const online = Number.isFinite(ts) && Date.now() - ts <= PHONE_OFFLINE_MS && lat != null && lng != null;
    let color = COLOR_OFFLINE;
    if (online) {
      const isMoving = Number(row.speed) > 0;
      if (isMoving) {
        moving++;
        color = COLOR_MOVING;
      } else {
        stopped++;
        color = COLOR_STOPPED;
      }
    } else {
      offline++;
    }
    if (lat != null && lng != null) points.push({ lat, lng, color });
  }
  return { points, total: rows.length, moving, stopped, offline };
}

// A small, self-contained Leaflet map. Scroll-zoom is off so it never hijacks
// page scrolling; markers are cleared + redrawn each refresh, and the view is
// fit to the points once (so live refreshes don't yank the user's pan/zoom).
function MiniMap({ points }: { points: FleetPoint[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const didFitRef = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;
    const map = L.map(el, {
      zoomControl: false,
      scrollWheelZoom: false,
      attributionControl: false,
    }).setView(DEFAULT_CENTER, 6);
    L.control.zoom({ position: "topright" }).addTo(map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    // Tiles often need a nudge once the card has its final size.
    const id = window.setTimeout(() => map.invalidateSize(), 150);
    return () => {
      window.clearTimeout(id);
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      didFitRef.current = false;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const latlngs: Array<[number, number]> = [];
    for (const p of points) {
      latlngs.push([p.lat, p.lng]);
      L.circleMarker([p.lat, p.lng], {
        radius: 5,
        color: "#ffffff",
        weight: 1.5,
        fillColor: p.color,
        fillOpacity: 0.95,
      }).addTo(layer);
    }
    if (!didFitRef.current && latlngs.length > 0) {
      if (latlngs.length === 1) map.setView(latlngs[0], 13);
      else map.fitBounds(L.latLngBounds(latlngs), { padding: [24, 24] });
      didFitRef.current = true;
    }
  }, [points]);

  return <div ref={containerRef} className="h-[200px] w-full" />;
}

function CountChip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {label} <span className="font-bold text-slate-700 dark:text-white tabular-nums">{value}</span>
    </span>
  );
}

function FleetCard({
  href,
  title,
  icon,
  accent,
  fleet,
  loading,
  error,
  online,
}: {
  href: string;
  title: string;
  icon: React.ReactNode;
  accent: string;
  fleet: Fleet;
  loading: boolean;
  error: boolean;
  /** Phones report online/offline; cars report moving/stopped/offline. */
  online: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200/70 bg-white/80 dark:border-slate-800 dark:bg-slate-900/65">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className={`flex h-7 w-7 items-center justify-center rounded-lg ${accent}`}>{icon}</div>
          <h2 className="text-sm font-bold text-slate-800 dark:text-white">{title}</h2>
          {loading && <FaSpinner className="animate-spin text-slate-300" size={11} />}
        </div>
        <Link
          href={href}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-400 transition-colors hover:text-teal-600 dark:hover:text-teal-400"
        >
          ເບິ່ງເຕັມ
          <FaArrowRight size={10} />
        </Link>
      </div>

      <div className="relative isolate">
        <MiniMap points={fleet.points} />
        {error && (
          <div className="absolute inset-0 z-[500] flex items-center justify-center bg-white/70 text-xs text-slate-500 dark:bg-slate-900/70">
            ດຶງຂໍ້ມູນບໍ່ສຳເລັດ
          </div>
        )}
        {!error && fleet.points.length === 0 && !loading && (
          <div className="absolute inset-0 z-[500] flex items-center justify-center bg-white/40 text-xs text-slate-400 dark:bg-slate-900/40">
            ບໍ່ມີຕຳແໜ່ງທີ່ຈະສະແດງ
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-200/60 px-4 py-2 dark:border-white/5">
        <CountChip label="ທັງໝົດ" value={fleet.total} color="#cbd5e1" />
        {online ? (
          <CountChip label="ອອນລາຍ" value={fleet.moving + fleet.stopped} color={COLOR_MOVING} />
        ) : (
          <CountChip label="ເຄື່ອນ" value={fleet.moving} color={COLOR_MOVING} />
        )}
        {!online && <CountChip label="ຈອດ" value={fleet.stopped} color={COLOR_STOPPED} />}
        <CountChip label="ອອບລາຍ" value={fleet.offline} color={COLOR_OFFLINE} />
      </div>
    </div>
  );
}

export function LiveFleetOverview() {
  const [cars, setCars] = useState<Fleet>(EMPTY_FLEET);
  const [phones, setPhones] = useState<Fleet>(EMPTY_FLEET);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      const [carRows, phoneRows] = await Promise.all([
        // Copied from tms/src/components/live-fleet-overview.tsx; the two
        // Server Actions become one proxied REST call to TMS.
        api.get("/transport/fleet-live").then((r) => (r.data?.data?.cars ?? []) as CarRow[]),
        api.get("/transport/fleet-live").then((r) => (r.data?.data?.phones ?? []) as PhoneRow[]),
      ]);
      setCars(buildCarFleet(carRows ?? []));
      setPhones(buildPhoneFleet(phoneRows ?? []));
      setError(false);
    } catch (e) {
      console.error("[live-fleet] load failed:", e);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <FleetCard
        href="/tracking/cars-map"
        title="ແຜນທີ່ລົດ (GPS)"
        icon={<FaBroadcastTower className="text-emerald-600 dark:text-emerald-400" size={12} />}
        accent="bg-emerald-500/10"
        fleet={cars}
        loading={loading}
        error={error}
        online={false}
      />
      <FleetCard
        href="/tracking/phones-map"
        title="ແຜນທີ່ມືຖືຄົນຂັບ"
        icon={<FaMobileAlt className="text-sky-600 dark:text-sky-400" size={12} />}
        accent="bg-sky-500/10"
        fleet={phones}
        loading={loading}
        error={error}
        online
      />
    </div>
  );
}
