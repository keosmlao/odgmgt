// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name; imports rewritten.
"use client";
import type { MapMarker } from "@/lib/ods/map-locations";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";

/** ນະຄອນຫຼວງວຽງຈັນ — ຈຸດເລີ່ມຕົ້ນເມື່ອບໍ່ມີໝຸດ */
const VIENTIANE: [number, number] = [17.9757, 102.6331];

const colorOf = (m: MapMarker) => (m.kind === "install" ? "#f6921e" : m.service_type === "PS" ? "#4bc7ef" : "#1e5b9a");

/** ແຜนที่ຕິດຕາມงาน on-site — leaflet + OpenStreetMap (ບໍ່ຕ້ອງ API key). ໂຫ฼ด client-side. */
export function TrackingMap({ markers }: { markers: MapMarker[] }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let map: import("leaflet").Map | undefined;
    import("leaflet").then((L) => {
      if (!container.current) return;
      const center: [number, number] = markers.length ? [markers[0].lat, markers[0].lng] : VIENTIANE;
      map = L.map(container.current).setView(center, markers.length ? 12 : 11);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);

      const dot = (color: string) =>
        L.divIcon({
          className: "",
          html: `<div style="width:16px;height:16px;border-radius:9999px;background:${color};border:3px solid white;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>`,
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        });

      const bounds: [number, number][] = [];
      markers.forEach((m) => {
        L.marker([m.lat, m.lng], { icon: dot(colorOf(m)) })
          .addTo(map!)
          .bindPopup(`<b>${m.title}</b>${m.sub ? `<br/>${m.sub}` : ""}<br/><a href="${m.href}" target="_blank" rel="noreferrer">ເປີດງານ →</a>`);
        bounds.push([m.lat, m.lng]);
      });
      if (bounds.length > 1) map.fitBounds(bounds, { padding: [40, 40] });
    });
    return () => { map?.remove(); };
  }, [markers]);

  return <div ref={container} className="h-[70vh] w-full rounded-2xl border border-slate-200 shadow-sm" />;
}
