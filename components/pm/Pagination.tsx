import Link from "next/link";

// Shared list pagination (server component). Two modes:
//  - known total: pass `totalPages` (and optional `total`) → shows "ໜ້າ X / Y".
//  - unknown total: pass `hasNext` (fetch pageSize+1 rows to detect it) → prev/next only.
export default function Pagination({
  current,
  hasNext,
  totalPages,
  total,
  hrefFor,
}: {
  current: number;
  hasNext?: boolean;
  totalPages?: number;
  total?: number;
  hrefFor: (page: number) => string;
}) {
  const isFirst = current <= 1;
  const isLast = totalPages != null ? current >= totalPages : !hasNext;
  if (isFirst && isLast) return null;
  return (
    <div className="mt-4 flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <span className="text-slate-500 dark:text-slate-400">
        ໜ້າ {current}
        {totalPages != null ? ` / ${totalPages}` : ""}
        {total != null ? ` · ${total.toLocaleString("en-US")} ລາຍການ` : ""}
      </span>
      <div className="flex gap-2">
        <PageLink disabled={isFirst} href={hrefFor(current - 1)}>
          ກ່ອນໜ້າ
        </PageLink>
        <PageLink disabled={isLast} href={hrefFor(current + 1)}>
          ຖັດໄປ
        </PageLink>
      </div>
    </div>
  );
}

function PageLink({ href, disabled, children }: { href: string; disabled: boolean; children: React.ReactNode }) {
  const base = "rounded-xl border px-4 py-2 font-medium transition";
  if (disabled) {
    return (
      <span className={`${base} cursor-not-allowed border-slate-200 text-slate-300 dark:border-slate-800 dark:text-slate-600`}>
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className={`${base} border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800`}
    >
      {children}
    </Link>
  );
}
