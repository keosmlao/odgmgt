export default function Loading() {
  return (
    <div className="w-full animate-pulse">
      <div className="h-8 w-56 rounded bg-slate-200 dark:bg-slate-800" />

      {/* Filter bar */}
      <div className="mt-5 h-40 rounded-xl glass" />

      {/* Table */}
      <div className="mt-4 rounded-xl glass">
        <div className="h-11 border-b border-slate-200 bg-slate-50/80 dark:border-slate-800 dark:bg-slate-950/50" />
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-slate-100 px-4 py-3 last:border-0 dark:border-slate-800">
            <div className="h-4 w-24 rounded bg-slate-200 dark:bg-slate-800" />
            <div className="h-4 flex-1 rounded bg-slate-200 dark:bg-slate-800" />
            <div className="h-4 w-20 rounded bg-slate-200 dark:bg-slate-800" />
            <div className="h-4 w-16 rounded bg-slate-200 dark:bg-slate-800" />
          </div>
        ))}
      </div>

      <span className="sr-only">ກຳລັງໂຫຼດ...</span>
    </div>
  );
}
