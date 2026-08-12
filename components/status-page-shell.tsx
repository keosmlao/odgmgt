"use client";

import { type ReactNode } from "react";

export type StatusTone =
  | "slate"
  | "amber"
  | "sky"
  | "emerald"
  | "rose"
  | "teal"
  | "orange";

export const STATUS_TONES: Record<StatusTone, { bg: string; text: string }> = {
  slate: { bg: "bg-slate-500/10", text: "text-slate-600 dark:text-slate-400" },
  amber: { bg: "bg-amber-500/10", text: "text-amber-600 dark:text-amber-400" },
  sky: { bg: "bg-sky-500/10", text: "text-sky-600 dark:text-sky-400" },
  emerald: {
    bg: "bg-emerald-500/10",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  rose: { bg: "bg-rose-500/10", text: "text-rose-600 dark:text-rose-400" },
  teal: { bg: "bg-teal-500/10", text: "text-teal-600 dark:text-teal-400" },
  orange: {
    bg: "bg-orange-500/10",
    text: "text-orange-600 dark:text-orange-400",
  },
};

export interface StatusStat {
  label: string;
  value: number | string;
  icon?: ReactNode;
  tone?: StatusTone;
}

export function StatusPageHeader({
  title,
  subtitle,
  icon,
  tone = "emerald",
  aside,
}: {
  title: string;
  subtitle: string;
  icon: ReactNode;
  tone?: StatusTone;
  aside?: ReactNode;
}) {
  const t = STATUS_TONES[tone];

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-lg ${t.bg} ${t.text} text-lg`}
        >
          {icon}
        </div>
        <div>
          <h1 className="text-lg font-bold text-slate-800 dark:text-white">
            {title}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {subtitle}
          </p>
        </div>
      </div>
      {aside}
    </div>
  );
}

export function StatusStatGrid({
  stats,
  columns = 4,
}: {
  stats: StatusStat[];
  columns?: 4 | 5;
}) {
  if (stats.length === 0) return null;

  return (
    <div
      className={`grid grid-cols-1 gap-3 sm:grid-cols-2 ${
        columns === 5 ? "xl:grid-cols-5" : "xl:grid-cols-4"
      }`}
    >
      {stats.map((stat, index) => {
        const t = STATUS_TONES[stat.tone ?? "slate"];

        return (
          <div key={`${stat.label}-${index}`} className="glass rounded-lg p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  {stat.label}
                </p>
                <p className={`mt-1 text-2xl font-bold ${t.text}`}>
                  {stat.value}
                </p>
              </div>
              {stat.icon && (
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${t.bg} ${t.text}`}
                >
                  {stat.icon}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function StatusControlPanel({ children }: { children: ReactNode }) {
  return <div className="glass rounded-lg p-4">{children}</div>;
}

export function StatusTableShell({
  count,
  children,
  note = "ສະເພາະຂໍ້ມູນປີ 2026",
}: {
  count: number;
  children: ReactNode;
  note?: string;
}) {
  return (
    <div className="glass rounded-lg overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-200/30 px-4 py-3 dark:border-white/5">
        <p className="text-xs text-slate-500">
          ພົບ{" "}
          <span className="font-semibold text-slate-700 dark:text-slate-200">
            {count}
          </span>{" "}
          ລາຍການ
        </p>
        <p className="text-[11px] text-slate-400">{note}</p>
      </div>
      {children}
    </div>
  );
}
