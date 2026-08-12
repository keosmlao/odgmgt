export default function Loading() {
  return (
    <div className="w-full animate-pulse">
      <div className="h-4 w-40 rounded bg-slate-200 dark:bg-slate-800" />

      {/* Hero */}
      <div className="mt-3 flex flex-col gap-5 rounded-xl border border-slate-200/80 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 lg:flex-row lg:items-center">
        <div className="h-28 w-28 shrink-0 rounded-xl bg-slate-200 dark:bg-slate-800" />
        <div className="flex-1 space-y-3">
          <div className="h-5 w-24 rounded-full bg-slate-200 dark:bg-slate-800" />
          <div className="h-7 w-2/3 rounded bg-slate-200 dark:bg-slate-800" />
          <div className="h-4 w-1/3 rounded bg-slate-200 dark:bg-slate-800" />
        </div>
      </div>

      {/* Stat tiles */}
      <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 rounded-xl border border-slate-200/80 bg-white dark:border-slate-800 dark:bg-slate-900" />
        ))}
      </div>

      {/* Tab bar */}
      <div className="mt-5 h-12 rounded-xl glass" />

      {/* Content cards */}
      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-64 rounded-xl border border-slate-200/80 bg-white dark:border-slate-800 dark:bg-slate-900" />
        ))}
      </div>

      <span className="sr-only">ກຳລັງໂຫຼດ...</span>
    </div>
  );
}
