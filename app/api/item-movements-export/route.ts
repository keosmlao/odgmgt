import { type NextRequest } from "next/server";
import { getItemMovementsForExport } from "@/lib/pm/products";
import { getCurrentUser } from "@/lib/pm/session";

function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV (UTF-8 BOM → opens directly in Excel) of all movements for one item.
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const sp = request.nextUrl.searchParams;
  const code = (sp.get("code") ?? "").trim();
  const wh = (sp.get("wh") ?? "").trim();
  if (!code) return new Response("Missing code", { status: 400 });

  const rows = await getItemMovementsForExport(code, wh);
  const header = ["ວັນທີ", "ເລກເອກະສານ", "ປະເພດ", "ສາງ", "ຮັບເຂົ້າ", "ຈ່າຍອອກ", "ຫົວໜ່ວຍ", "ມູນຄ່າ", "ສະກຸນເງິນ"];
  const lines = [header.join(",")];
  for (const m of rows) {
    lines.push(
      [
        csvCell(m.doc_date),
        csvCell(m.doc_no),
        csvCell(m.doc_type),
        csvCell(m.wh_name),
        csvCell(m.inqty),
        csvCell(m.outqty),
        csvCell(m.unit_code),
        csvCell(m.amount),
        csvCell(m.currency_code === "02" ? "LAK" : m.currency_code === "01" ? "THB" : m.currency_code),
      ].join(","),
    );
  }
  const csv = "﻿" + lines.join("\r\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="movements-${code}-${rows.length}.csv"`,
    },
  });
}
