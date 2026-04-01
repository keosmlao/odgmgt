"use client";

import { BarChart2 } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";

export default function AnalyticsPage() {
  const { t } = useLanguage();

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950"
      style={{ fontFamily: '"Noto Sans Lao","Noto Sans",system-ui,sans-serif' }}
    >
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50 dark:bg-blue-500/10">
          <BarChart2 size={28} className="text-blue-500" />
        </div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-white">{t("sidebar.analytics")}</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Coming soon</p>
      </div>
    </div>
  );
}
