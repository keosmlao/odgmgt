"use client";

import { Settings } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";

export default function SettingsPage() {
  const { t } = useLanguage();

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950"
      style={{ fontFamily: '"Noto Sans Lao","Noto Sans",system-ui,sans-serif' }}
    >
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 dark:bg-slate-800">
          <Settings size={28} className="text-slate-500" />
        </div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-white">{t("sidebar.settings")}</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Coming soon</p>
      </div>
    </div>
  );
}
