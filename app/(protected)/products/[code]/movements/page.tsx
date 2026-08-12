import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import Pagination from "@/components/pm/Pagination";
import { getItemMovements, getItemMovementWarehouses, getProductBrief } from "@/lib/pm/products";
import { getCurrentUser } from "@/lib/pm/session";

export const dynamic = "force-dynamic";

function fmtDate(v: string | null) {
  if (!v) return "-";
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : v;
}
function money(v: string) {
  const n = Number(v);
  return Number.isNaN(n) ? "-" : n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export default async function ItemMovementsPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ wh?: string; page?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { code } = await params;
  const decoded = decodeURIComponent(code);
  const sp = await searchParams;
  const wh = sp.wh ?? "";
  const PAGE_SIZE = 50;
  const page = Math.max(1, Number(sp.page ?? "1") || 1);

  const [brief, warehouses, fetched] = await Promise.all([
    getProductBrief(decoded),
    getItemMovementWarehouses(decoded),
    getItemMovements(decoded, wh, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE),
  ]);
  if (!brief) notFound();
  const hasNext = fetched.length > PAGE_SIZE;
  const rows = fetched.slice(0, PAGE_SIZE);
  const mk = (patch: Record<string, string>) => {
    const p = new URLSearchParams();
    const merged = { wh, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return `/products/${encodeURIComponent(decoded)}/movements${p.toString() ? `?${p}` : ""}`;
  };
  const pageHref = (pg: number) => mk({ page: pg > 1 ? String(pg) : "" });

  return (
    <div className="w-full">
      <div className="flex items-center gap-2 text-[11px] text-slate-400">
        <Link href="/products" className="hover:underline">ສິນຄ້າ</Link><span>/</span>
        <Link href={`/products/${encodeURIComponent(decoded)}`} className="font-mono hover:underline">{decoded}</Link><span>/</span>
        <span className="text-slate-600">ປະຫວັດເຄື່ອນໄຫວ</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">ປະຫວັດເຄື່ອນໄຫວທັງໝົດ</h1>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400"><span className="font-mono">{decoded}</span> · {brief.name}</p>
        </div>
        <a href={`/api/item-movements-export?code=${encodeURIComponent(decoded)}${wh ? `&wh=${encodeURIComponent(wh)}` : ""}`}
          className="inline-flex items-center gap-2 rounded-lg border border-emerald-300 bg-white px-4 py-2 text-xs font-bold text-emerald-700 shadow-sm transition hover:bg-emerald-50 dark:border-emerald-500/40 dark:bg-slate-900 dark:text-emerald-400 dark:hover:bg-emerald-500/10">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
          Export Excel
        </a>
      </div>

      {warehouses.length > 1 && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href={mk({ wh: "", page: "" })} className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${!wh ? "bg-teal-600 text-white" : "border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"}`}>ທຸກສາງ</Link>
          {warehouses.map((w) => (
            <Link key={w.warehouse} href={mk({ wh: w.warehouse, page: "" })} className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${wh === w.warehouse ? "bg-teal-600 text-white" : "border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"}`}>{w.wh_name || w.warehouse}</Link>
          ))}
        </div>
      )}

      <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full min-w-[680px] text-xs">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/70 text-left text-[10px] uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-950/40">
              <th className="px-4 py-2.5 font-semibold">ວັນທີ</th>
              <th className="px-4 py-2.5 font-semibold">ເລກເອກະສານ</th>
              <th className="px-4 py-2.5 font-semibold">ປະເພດ</th>
              <th className="px-4 py-2.5 font-semibold">ສາງ</th>
              <th className="px-4 py-2.5 text-right font-semibold">ຈຳນວນ</th>
              <th className="px-4 py-2.5 font-semibold">ຫົວໜ່ວຍ</th>
              <th className="px-4 py-2.5 text-right font-semibold">ມູນຄ່າ</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-400">ບໍ່ມີປະຫວັດເຄື່ອນໄຫວ</td></tr>}
            {rows.map((m, i) => {
              const inQty = Number(m.inqty), outQty = Number(m.outqty);
              const isOut = outQty !== 0;
              const qty = inQty > 0 ? inQty : -Math.abs(outQty);
              const amount = Number(m.amount);
              const signedAmount = isOut ? -Math.abs(amount) : amount;
              const cur = m.currency_code === "02" ? "₭" : m.currency_code === "01" ? "฿" : m.currency_code;
              return (
                <tr key={`${m.doc_no}-${i}`} className="border-b border-slate-50 last:border-0 hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/40">
                  <td className="px-4 py-2 text-slate-600 dark:text-slate-400">{fmtDate(m.doc_date)}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-700 dark:text-slate-300">{m.doc_no}</td>
                  <td className="px-4 py-2"><span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${isOut ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" : "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"}`}>{isOut ? "↓" : "↑"} {m.doc_type || (isOut ? "ຈ່າຍອອກ" : "ຮັບເຂົ້າ")}</span></td>
                  <td className="px-4 py-2 text-slate-600 dark:text-slate-400">{m.wh_name || "-"}</td>
                  <td className={`px-4 py-2 text-right font-medium tabular-nums ${isOut ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}>{qty > 0 ? "+" : ""}{qty.toLocaleString("en-US")}</td>
                  <td className="px-4 py-2 text-slate-500">{m.unit_code || "-"}</td>
                  <td className={`px-4 py-2 text-right tabular-nums ${isOut ? "text-red-600 dark:text-red-400" : "text-slate-700 dark:text-slate-200"}`}>{signedAmount < 0 ? "-" : ""}{cur}{money(String(Math.abs(signedAmount)))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pagination current={page} hasNext={hasNext} hrefFor={pageHref} />
    </div>
  );
}
