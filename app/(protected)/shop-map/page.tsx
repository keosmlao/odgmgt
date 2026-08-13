"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { RefreshCw, Search, Store, X } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import api from "@/service/api";

type Shop = {
  code: string;
  name: string | null;
  lat: number;
  lng: number;
  province_code: string;
  province: string;
  phone: string | null;
  address: string | null;
  last_buy: string | null;
  days_since: number | null;
  amount_12m: number;
  docs_12m: number;
};
type Data = {
  shops: Shop[];
  provinces: { province: string; shops: number }[];
  totals: { shops: number; active90: number; quiet: number; cold: number; provinces: number; amount_12m: number };
};

const VIENTIANE: L.LatLngExpression = [18.0, 102.6];

/** How recently the shop bought decides its colour — green fresh, red gone quiet. */
const BANDS = [
  { key: "active", max: 90, color: "#17876d" },
  { key: "quiet", max: 365, color: "#f5911f" },
  { key: "cold", max: Infinity, color: "#d64545" },
] as const;
type BandKey = (typeof BANDS)[number]["key"] | "all";

function bandOf(shop: Shop) {
  if (shop.days_since == null) return BANDS[2];
  return BANDS.find((band) => shop.days_since! <= band.max) ?? BANDS[2];
}

const money = (value: number) =>
  value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value.toLocaleString("en-US", { maximumFractionDigits: 0 });

export default function ShopMapPage() {
  const { t } = useLanguage();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [province, setProvince] = useState("");
  const [band, setBand] = useState<BandKey>("all");
  const [term, setTerm] = useState("");
  const [selected, setSelected] = useState<Shop | null>(null);

  const boxRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  // 2,058 markers: the canvas renderer keeps panning smooth where SVG would not.
  const rendererRef = useRef<L.Canvas | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const response = await api.get("/shop-map");
      if (response.data?.success) setData(response.data.data);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const shops = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return (data?.shops || []).filter((shop) => {
      if (province && shop.province !== province) return false;
      if (band !== "all" && bandOf(shop).key !== band) return false;
      if (needle && !`${shop.code} ${shop.name ?? ""} ${shop.phone ?? ""}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [data, province, band, term]);

  // Create the map once.
  useEffect(() => {
    if (mapRef.current || !boxRef.current) return;
    const map = L.map(boxRef.current, { zoomControl: true, preferCanvas: true }).setView(VIENTIANE, 8);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap",
      maxZoom: 19,
    }).addTo(map);
    rendererRef.current = L.canvas({ padding: 0.5 });
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Redraw markers whenever the filtered set changes.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    for (const shop of shops) {
      const { color } = bandOf(shop);
      L.circleMarker([shop.lat, shop.lng], {
        renderer: rendererRef.current ?? undefined,
        radius: shop.amount_12m > 1_000_000 ? 8 : shop.amount_12m > 100_000 ? 6 : 4,
        color: "#ffffff",
        weight: 1,
        fillColor: color,
        fillOpacity: 0.85,
      })
        .on("click", () => setSelected(shop))
        .addTo(layer);
    }
    // Fit whatever is on screen, including the unfiltered first load. Without
    // this the map stayed at its default zoom over Vientiane, where the 1,600
    // shops in the capital overlap into what looks like a single dot and the
    // provinces are off-screen entirely.
    if (shops.length > 0) {
      map.fitBounds(L.latLngBounds(shops.map((shop) => [shop.lat, shop.lng] as L.LatLngTuple)), {
        padding: [40, 40],
        maxZoom: 14,
      });
    }
  }, [shops]);

  const totals = data?.totals;

  // The topbar (min-height 3.25rem) sits above this, so the map takes what is
  // left of the viewport. Not h-screen: that is taller than the space the shell
  // leaves, which squeezed the map and pushed the rest of the page down.
  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
        <span className="flex items-center gap-1.5 text-[13px] font-bold">
          <Store size={15} style={{ color: "var(--brand)" }} />
          {t("sidebar.shopMap")}
        </span>

        <span className="text-[11px]" style={{ color: "var(--muted)" }}>
          {shops.length.toLocaleString("en-US")} / {(totals?.shops ?? 0).toLocaleString("en-US")} {t("shopMap.shops")}
        </span>

        <label className="relative ml-auto">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: "var(--muted)" }} />
          <input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder={t("shopMap.search")}
            className="input !h-8 !w-56 !pl-8 text-[12px]"
          />
        </label>

        <select value={province} onChange={(event) => setProvince(event.target.value)} className="select !h-8 !w-44 text-[12px]">
          <option value="">{t("shopMap.allProvinces")}</option>
          {(data?.provinces || []).map((row) => (
            <option key={row.province} value={row.province}>{row.province} ({row.shops})</option>
          ))}
        </select>

        <div className="flex overflow-hidden rounded-[var(--r-sm)] border text-[11px] font-semibold" style={{ borderColor: "var(--line)" }}>
          {(["all", "active", "quiet", "cold"] as BandKey[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setBand(key)}
              className="px-2.5 py-1.5 transition"
              style={
                band === key
                  ? { background: "var(--brand)", color: "#fff" }
                  : { background: "var(--surface)", color: "var(--ink-soft)" }
              }
            >
              {t(`shopMap.band.${key}`)}
              {key !== "all" && totals && (
                <span className="ml-1 opacity-70">
                  {key === "active" ? totals.active90 : key === "quiet" ? totals.quiet : totals.cold}
                </span>
              )}
            </button>
          ))}
        </div>

        <button type="button" onClick={load} className="btn btn-ghost btn-icon" title={t("approve.refresh")} disabled={loading}>
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={boxRef} className="absolute inset-0" />

        {(loading || failed) && (
          <div className="absolute left-1/2 top-4 z-[500] -translate-x-1/2 rounded-full px-4 py-1.5 text-[12px] font-semibold shadow-lg"
               style={{ background: "var(--surface)", border: "1px solid var(--line)", color: failed ? "var(--neg)" : "var(--ink)" }}>
            {failed ? t("app.error") : t("app.loading")}
          </div>
        )}

        <div className="absolute bottom-4 left-4 z-[400] rounded-[var(--r-sm)] px-3 py-2 text-[11px] shadow-lg"
             style={{ background: "var(--surface)", border: "1px solid var(--line)" }}>
          {BANDS.map((b) => (
            <p key={b.key} className="flex items-center gap-1.5 leading-relaxed">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: b.color }} />
              {t(`shopMap.legend.${b.key}`)}
            </p>
          ))}
        </div>

        {selected && (
          <div className="absolute right-4 top-4 z-[500] w-72 rounded-[var(--r-md)] p-3.5 shadow-xl"
               style={{ background: "var(--surface)", border: "1px solid var(--line)" }}>
            <button type="button" onClick={() => setSelected(null)} className="float-right" style={{ color: "var(--muted)" }}>
              <X size={14} />
            </button>
            <p className="pr-5 text-[13px] font-bold leading-snug">{selected.name || selected.code}</p>
            <p className="num text-[11px]" style={{ color: "var(--muted)" }}>{selected.code}</p>

            <dl className="mt-2.5 space-y-1 text-[11.5px]">
              {[
                [t("shopMap.province"), selected.province || "-"],
                [t("shopMap.phone"), selected.phone || "-"],
                [t("shopMap.address"), selected.address || "-"],
                [t("shopMap.lastBuy"), selected.last_buy ? `${selected.last_buy} (${selected.days_since} ${t("ar.days")})` : t("shopMap.never")],
                [t("shopMap.sales12m"), `${money(selected.amount_12m)} · ${selected.docs_12m} ${t("ar.bills")}`],
              ].map(([label, value]) => (
                <div key={label} className="flex gap-2">
                  <dt className="w-20 shrink-0" style={{ color: "var(--muted)" }}>{label}</dt>
                  <dd className="min-w-0 flex-1 font-medium">{value}</dd>
                </div>
              ))}
            </dl>

            <a
              href={`https://www.google.com/maps/search/?api=1&query=${selected.lat},${selected.lng}`}
              target="_blank"
              rel="noreferrer"
              className="mt-3 block rounded-[var(--r-sm)] py-1.5 text-center text-[11px] font-bold text-white"
              style={{ background: "var(--brand)" }}
            >
              {t("shopMap.openMaps")}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
