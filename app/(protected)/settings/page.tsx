"use client";

import { Bell, ChevronRight, Globe2, LockKeyhole, Settings, ShieldCheck, UserRound } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";

const SECTIONS = [
  { icon: UserRound, title: "Profile", copy: "Personal details and account information" },
  { icon: Globe2, title: "Language & region", copy: "Display language, date and number formats" },
  { icon: Bell, title: "Notifications", copy: "Choose the updates you want to receive" },
  { icon: LockKeyhole, title: "Security", copy: "Password and active session controls" },
];

export default function SettingsPage() {
  const { t } = useLanguage();

  return (
    <div className="min-h-screen">
      <header className="page-hd">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-[var(--r-md)] bg-[var(--brand-deep)] text-white">
            <Settings size={19} />
          </span>
          <div>
            <p className="eyebrow">Workspace</p>
            <h1 className="page-title">{t("sidebar.settings")}</h1>
            <p className="page-sub">Manage your account preferences and workspace experience.</p>
          </div>
        </div>
      </header>

      <div className="page mx-auto max-w-4xl">
        <div className="grid gap-3 md:grid-cols-2">
          {SECTIONS.map(({ icon: Icon, title, copy }) => (
            <button
              key={title}
              type="button"
              className="card group flex items-center gap-3 p-3.5 text-left transition hover:border-[var(--brand)]"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--r-sm)] bg-[var(--info-bg)] text-[var(--brand)]">
                <Icon size={17} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-bold text-[var(--ink)]">{title}</span>
                <span className="mt-0.5 block text-[11.5px] leading-5 text-[var(--muted)]">{copy}</span>
              </span>
              <ChevronRight size={16} className="text-[var(--muted)] transition group-hover:translate-x-0.5 group-hover:text-[var(--brand)]" />
            </button>
          ))}
        </div>

        <div
          className="mt-3 flex items-start gap-2.5 rounded-[var(--r-md)] border p-3.5"
          style={{ borderColor: "var(--line)", background: "var(--info-bg)", color: "var(--brand)" }}
        >
          <ShieldCheck size={18} className="mt-0.5 shrink-0" />
          <div>
            <p className="text-[13px] font-semibold">Protected workspace</p>
            <p className="mt-0.5 text-[11.5px] leading-5 opacity-75">
              Some organization settings are managed by your administrator.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
