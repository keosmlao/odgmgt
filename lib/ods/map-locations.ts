// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name; imports rewritten.
import { query } from "@/lib/ods/db";

/** ໝຸດເທິງແຜນທີ່ຕິດຕາມ — ງານສ້ອมบ้าน (IH) / ໄปรับ (PS) + ຕິດຕັ້ງ ທີ່ມີพิกัด. */
export type MapMarker = {
  kind: "repair" | "install";
  code: string;
  lat: number;
  lng: number;
  title: string;
  sub: string | null;
  service_type: string | null;
  href: string;
};

export async function mapLocations(): Promise<MapMarker[]> {
  const [repair, install] = await Promise.all([
    query<{ code: string; lat: number; lng: number; service_type: string | null; product: string | null; customer: string | null; loc: string | null }>(
      `select a.code, a.location_lat lat, a.location_lng lng, a.service_type,
          a.name_1 product, c.name_1 customer, nullif(trim(a.location_repair),'') loc
        from tb_product a left join ar_customer c on c.code = a.cust_code
       where a.location_lat is not null and a.location_lng is not null
         and a.return_complete is null and a.service_type in ('IH','PS')`,
    ),
    query<{ code: string; lat: number; lng: number; customer: string | null; loc: string | null }>(
      `select i.code, i.location_lat lat, i.location_lng lng, c.name_1 customer, nullif(trim(i.location_inst),'') loc
        from ods_tb_install i left join ar_customer c on c.code = i.cust_code
       where i.location_lat is not null and i.location_lng is not null and i.cancel_date is null`,
    ),
  ]);

  const repairMarks: MapMarker[] = repair.rows.map((r) => ({
    kind: "repair",
    code: r.code,
    lat: Number(r.lat),
    lng: Number(r.lng),
    title: `${r.code} · ${r.service_type ?? ""}`,
    sub: [r.customer, r.product, r.loc].filter(Boolean).join(" · ") || null,
    service_type: r.service_type,
    href: `/service/${r.code}`,
  }));
  const installMarks: MapMarker[] = install.rows.map((r) => ({
    kind: "install",
    code: r.code,
    lat: Number(r.lat),
    lng: Number(r.lng),
    title: `${r.code} · ຕິດຕັ້ງ`,
    sub: [r.customer, r.loc].filter(Boolean).join(" · ") || null,
    service_type: "install",
    href: `/installations/${r.code}`,
  }));
  return [...repairMarks, ...installMarks];
}
