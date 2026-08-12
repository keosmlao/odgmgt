import { type NextRequest } from "next/server";
import {
  getProductsForExport,
  getUserGroupCount,
  type ProductFilters,
} from "@/lib/pm/products";
import { getCurrentUser } from "@/lib/pm/session";

function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const sp = request.nextUrl.searchParams;
  const isOwner = (await getUserGroupCount(user.employeeCode)) > 0;
  const mineOn = isOwner && sp.get("mine") !== "0";

  const filters: ProductFilters = {
    q: sp.get("q") ?? "",
    groupMain: sp.get("group_main") ?? "",
    groupSub: sp.get("group_sub") ?? "",
    groupSub2: sp.get("group_sub2") ?? "",
    category: sp.get("category") ?? "",
    brand: sp.get("brand") ?? "",
    inStock: sp.get("in_stock") === "1",
    mineOf: mineOn ? user.employeeCode : "",
  };

  const rows = await getProductsForExport(filters);
  const header = ["ລະຫັດ", "ຊື່ສິນຄ້າ", "ໝວດ", "ຍີ່ຫໍ້", "ຄົງເຫຼືອ", "ໜ່ວຍ", "ຕົ້ນທຶນສະເລ່ຍ", "ຂາຍໜ້າຮ້ານ", "ຂາຍສົ່ງ", "ຕົ້ນທຶນປາກເຊ", "ຕົ້ນທຶນວຽງຈັນ", "ຜູ້ຮັບຜິດຊອບ"];
  const lines = [header.join(",")];
  for (const p of rows) {
    lines.push(
      [
        csvCell(p.code),
        csvCell(p.name_1 || p.name_eng_1),
        csvCell(p.category_name),
        csvCell(p.item_brand),
        csvCell(p.balance_qty),
        csvCell(p.unit_standard_name),
        csvCell(p.average_cost),
        csvCell(p.price_retail),
        csvCell(p.price_wholesale),
        csvCell(p.cost_pks),
        csvCell(p.cost_vte),
        csvCell(p.responsible_name),
      ].join(","),
    );
  }
  // BOM so Excel reads the Lao UTF-8 correctly.
  const csv = "﻿" + lines.join("\r\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="products-${rows.length}.csv"`,
    },
  });
}
