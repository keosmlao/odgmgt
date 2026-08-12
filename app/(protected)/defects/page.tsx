import Link from "next/link";
import Pagination from "@/components/pm/Pagination";
import { getDefectsByBrand, getRecentDefects } from "@/lib/pm/analytics";
import { getUserGroupCount } from "@/lib/pm/products";
import { getCurrentUser } from "@/lib/pm/session";

function fmtDate(v: string | null) {
  if (!v) return "-";
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : v;
}

export default async function DefectsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const user = await getCurrentUser();
  const isOwner = user ? (await getUserGroupCount(user.employeeCode)) > 0 : false;
  const mineOf = isOwner && user ? user.employeeCode : "";
  const PAGE_SIZE = 50;
  const page = Math.max(1, Number((await searchParams).page ?? "1") || 1);

  const [byBrand, recentFetched] = await Promise.all([
    getDefectsByBrand(mineOf, 15),
    getRecentDefects(mineOf, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE),
  ]);
  const hasNext = recentFetched.length > PAGE_SIZE;
  const recent = recentFetched.slice(0, PAGE_SIZE);
  const pageHref = (pg: number) => `/defects${pg > 1 ? `?page=${pg}` : ""}`;
  const totalOpen = byBrand.reduce((s, b) => s + b.open, 0);
  const total = byBrand.reduce((s, b) => s + b.total, 0);
  const maxB = Math.max(1, ...byBrand.map((b) => b.total));

  return (
    <div className="w-full">
      <div className="flex items-center gap-2 text-[11px] text-slate-400"><span>ໜ້າຫຼັກ</span><span>/</span><span className="text-slate-600">ຄຸນນະພາບ / ຕຳໜິ</span></div>
      <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 dark:text-white">ຄຸນນະພາບ / ຕຳໜິ</h1>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">ສິນຄ້າຕຳໜິ ແຍກຕາມຍີ່ຫໍ້ {isOwner ? "· ສະເພາະກຸ່ມທ່ານ" : ""}</p>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl glass p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"><p className="text-xs text-slate-500">ຕຳໜິທັງໝົດ</p><p className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">{total.toLocaleString("en-US")}</p></div>
        <div className="rounded-xl glass p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"><p className="text-xs text-slate-500">ຍັງບໍ່ແກ້ໄຂ</p><p className="mt-2 text-2xl font-bold text-red-600 dark:text-red-400">{totalOpen.toLocaleString("en-US")}</p></div>
        <div className="rounded-xl glass p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"><p className="text-xs text-slate-500">ຍີ່ຫໍ້ທີ່ມີຕຳໜິ</p><p className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">{byBrand.length}</p></div>
      </div>

      <div className="mt-4 rounded-xl glass p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-bold text-slate-900 dark:text-white">ຕຳໜິ ຕໍ່ຍີ່ຫໍ້</h2>
        <div className="mt-4 space-y-2">
          {byBrand.map((b) => (
            <div key={b.brand} className="flex items-center gap-3">
              <span className="w-32 shrink-0 truncate text-xs text-slate-600 dark:text-slate-300" title={b.brand}>{b.brand}</span>
              <div className="h-5 flex-1 overflow-hidden rounded bg-slate-100 dark:bg-slate-800"><div className="h-full bg-red-500" style={{ width: `${(b.total / maxB) * 100}%` }} /></div>
              <span className="w-24 shrink-0 text-right text-xs text-slate-500">{b.total} <span className="text-red-500">({b.open} ຄ້າງ)</span></span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl glass shadow-sm">
        <div className="border-b border-slate-200 px-5 py-3 dark:border-slate-800"><h2 className="text-sm font-bold text-slate-900 dark:text-white">ຕຳໜິລ້າສຸດ · {recent.length}</h2></div>
        {recent.length === 0 ? <p className="px-5 py-10 text-center text-sm text-slate-400">ບໍ່ມີຕຳໜິ</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-xs">
              <thead><tr className="border-b border-slate-200 bg-slate-50/70 text-left text-[10px] uppercase text-slate-500 dark:border-slate-800 dark:bg-slate-950/40"><th className="px-4 py-2.5 font-semibold">ວັນທີ</th><th className="px-4 py-2.5 font-semibold">ລະຫັດ</th><th className="px-4 py-2.5 font-semibold">ຊື່ / SN</th><th className="px-4 py-2.5 font-semibold">ອາການ</th><th className="px-4 py-2.5 font-semibold">ສະຖານະ</th></tr></thead>
              <tbody>
                {recent.map((d, i) => (
                  <tr key={i} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                    <td className="px-4 py-2 text-xs text-slate-500">{fmtDate(d.date)}</td>
                    <td className="px-4 py-2 font-mono text-xs"><Link href={`/products/${encodeURIComponent(d.code)}`} className="font-semibold text-blue-700 hover:underline dark:text-blue-400">{d.code}</Link></td>
                    <td className="px-4 py-2 text-slate-700 dark:text-slate-200"><span className="block max-w-xs truncate">{d.name}</span>{d.sn && <span className="font-mono text-[10px] text-slate-400">{d.sn}</span>}</td>
                    <td className="px-4 py-2 text-slate-600 dark:text-slate-400"><span className="block max-w-xs truncate">{d.remark || "-"}</span></td>
                    <td className="px-4 py-2">{d.open ? <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950 dark:text-red-300">ຄ້າງ</span> : <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">ແກ້ແລ້ວ</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Pagination current={page} hasNext={hasNext} hrefFor={pageHref} />
    </div>
  );
}
