// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name; imports rewritten.
import { TrackingMap } from "@/components/ods/map/tracking-map";
import { ALL_ACCESS_SESSION } from "@/lib/ods/session-all";
import { swrCache } from "@/lib/cache";
import { mapLocations } from "@/lib/ods/map-locations";
import { CLAIM_SIDE, roleOf } from "@/lib/ods/roles";
import { MapPin } from "lucide-react";
import { redirect } from "next/navigation";

/**
 * ແຜนที่ຕິດຕາມงาน on-site — ສ້ອมบ้าน (IH) · ໄปรับ (PS) · ຕິດຕັ້ງ ທີ່ມีพิกัด.
 * ໝุดมาจาก location_lat/lng (ຕັ້ງຕອນເປີດงาน ด้วย location-picker).
 */
export const dynamic = "force-dynamic";

export default async function MapPage() {
  // No ODSS login here — this app is a management view and reads everything,
  // so the role gate that TMS/ODSS applies is replaced by full access.
  const session = ALL_ACCESS_SESSION;

  // Cached: every pin on the map comes from one query, and this is a read-only
  // management view — a few minutes behind is fine.
  const markers = (await swrCache("ods:map-locations", { ttl: 180_000, staleTtl: 24 * 3_600_000 }, () =>
    mapLocations(),
  )) as Awaited<ReturnType<typeof mapLocations>>;
  const ih = markers.filter((m) => m.service_type === "IH").length;
  const ps = markers.filter((m) => m.service_type === "PS").length;
  const inst = markers.filter((m) => m.kind === "install").length;

  const legend = (color: string, label: string, n: number) => (
    <span className="inline-flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-sm ring-1 ring-slate-200">
      <span className="size-3 rounded-full" style={{ background: color }} /> {label} <b className="tabular-nums">{n}</b>
    </span>
  );

  return (
    <div className="w-full space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-lg font-bold text-slate-700">
          <MapPin className="size-5 text-brand-700" /> ແຜนที่ຕິດຕາມงาน on-site
        </h1>
        <div className="flex flex-wrap gap-2">
          {legend("#1e5b9a", "ສ້ອມບ້ານ IH", ih)}
          {legend("#4bc7ef", "ໄປຮັບ PS", ps)}
          {legend("#f6921e", "ຕິດຕັ້ງ", inst)}
        </div>
      </div>
      {markers.length === 0 ? (
        <p className="rounded-2xl border border-brand-orange-400 bg-brand-orange-100 p-4 text-center text-sm text-brand-900">
          ຍັງບໍ່ມີงานที่ໝາຍພິກັດ (location) — ໝາຍພິກັດຕອນເປີດงาน (IH/PS/ຕິດຕັ້ງ) ຈຶ່ງຂຶ້ນແຜนที่.
        </p>
      ) : (
        <TrackingMap markers={markers} />
      )}
    </div>
  );
}
