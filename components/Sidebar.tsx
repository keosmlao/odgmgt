"use client";

import React from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Target,
  BarChart2,
  Settings,
  LogOut,
  ChevronRight,
  Users,
  Table,
  Smartphone,
  Menu,
  X,
  Globe,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useLanguage } from "@/context/LanguageContext";

type MenuChild = { path: string; i18nKey: string };
type MenuItem = {
  path: string;
  i18nKey: string;
  icon: React.ReactNode;
  children?: MenuChild[];
};

const LOCALE_FLAGS: Record<string, string> = {
  lo: "🇱🇦",
  th: "🇹🇭",
  en: "🇬🇧",
};

const MENU_ITEMS: MenuItem[] = [
  { path: "/dashboard", i18nKey: "sidebar.dashboard", icon: <LayoutDashboard size={20} /> },
  { path: "/target", i18nKey: "sidebar.target", icon: <Target size={20} /> },
  { path: "/sales-assignment", i18nKey: "sidebar.assignment", icon: <Users size={20} /> },
  { path: "/sales-summary", i18nKey: "sidebar.summary", icon: <Table size={20} /> },
  // { path: "/mobile", i18nKey: "sidebar.mobile", icon: <Smartphone size={20} /> },
  { path: "/analytics", i18nKey: "sidebar.analytics", icon: <BarChart2 size={20} /> },
  { path: "/settings", i18nKey: "sidebar.settings", icon: <Settings size={20} /> },
];

export default function Sidebar() {
  const { user, logout } = useAuth();
  const { t, locale, setLocale, locales: locs, localeLabels } = useLanguage();
  const pathname = usePathname();
  const [openMenus, setOpenMenus] = React.useState<Record<string, boolean>>({});
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const nextLocale = () => {
    const idx = locs.indexOf(locale);
    setLocale(locs[(idx + 1) % locs.length]);
  };

  return (
    <>
      {/* ── Mobile top bar ── */}
      <div className="fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between border-b border-slate-200/80 bg-white/90 px-4 backdrop-blur-lg md:hidden dark:border-slate-800/80 dark:bg-slate-950/90">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900">
            <Image src="/ODG.png" alt="ODG" width={20} height={20} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-slate-900 dark:text-white">
              ODIEN GROUP
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={nextLocale}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-sm transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"
            title={localeLabels[locale]}
          >
            {LOCALE_FLAGS[locale]}
          </button>
          <button
            type="button"
            onClick={() => setMobileOpen((o) => !o)}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
          >
            {mobileOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </div>

      {/* ── Overlay ── */}
      <button
        type="button"
        aria-label="Close sidebar overlay"
        onClick={() => setMobileOpen(false)}
        className={`fixed inset-0 z-40 bg-slate-950/40 backdrop-blur-sm transition-opacity md:hidden ${
          mobileOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      {/* ── Sidebar ── */}
      <aside
        className={`fixed left-0 top-0 z-50 flex h-screen w-72 max-w-[86vw] flex-col border-r border-slate-200/80 bg-white transition-transform duration-200 md:w-64 md:max-w-none md:translate-x-0 dark:border-slate-800/80 dark:bg-slate-900 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ fontFamily: '"Noto Sans Lao","Noto Sans",system-ui,sans-serif' }}
      >
        {/* ── Header ── */}
        <div className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-slate-200/80 px-5 dark:border-slate-800/80">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-900 shadow-sm">
              <Image src="/ODG.png" alt="ODG" width={22} height={22} />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-bold text-slate-900 dark:text-white">
                ODIEN GROUP
              </h1>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 md:hidden dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="Close menu"
          >
            <X size={16} />
          </button>
        </div>

        {/* ── Navigation ── */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <p className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400 dark:text-slate-500">
            {t("sidebar.menu")}
          </p>

          <div className="space-y-0.5">
            {MENU_ITEMS.map((item) => {
              const children = item.children;
              const isActive = children
                ? pathname.startsWith(item.path)
                : pathname === item.path;
              const hasChildren = Array.isArray(children) && children.length > 0;
              const isOpen = hasChildren ? !!openMenus[item.path] : true;

              return (
                <div key={item.path}>
                  {hasChildren ? (
                    <button
                      type="button"
                      onClick={() =>
                        setOpenMenus((p) => ({ ...p, [item.path]: !p[item.path] }))
                      }
                      className={`group flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-[13px] font-medium transition-all ${
                        isActive
                          ? "bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400"
                          : "text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-200"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className="shrink-0">{item.icon}</span>
                        <span>{t(item.i18nKey)}</span>
                      </div>
                      <ChevronRight
                        size={14}
                        className={`text-slate-400 transition-transform ${isOpen ? "rotate-90" : ""}`}
                      />
                    </button>
                  ) : (
                    <Link
                      href={item.path}
                      onClick={() => setMobileOpen(false)}
                      className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-all ${
                        isActive
                          ? "bg-blue-50 text-blue-600 shadow-sm dark:bg-blue-500/10 dark:text-blue-400"
                          : "text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-200"
                      }`}
                    >
                      <span className="shrink-0">{item.icon}</span>
                      <span>{t(item.i18nKey)}</span>
                    </Link>
                  )}

                  {hasChildren && isOpen && children && (
                    <div className="ml-7 mt-0.5 space-y-0.5 border-l border-slate-200 pl-3 dark:border-slate-800">
                      {children.map((child) => {
                        const childActive = pathname === child.path;
                        return (
                          <Link
                            key={child.path}
                            href={child.path}
                            onClick={() => setMobileOpen(false)}
                            className={`flex items-center rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                              childActive
                                ? "text-blue-600 dark:text-blue-400"
                                : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                            }`}
                          >
                            {t(child.i18nKey)}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </nav>

        {/* ── Language switcher ── */}
        <div className="border-t border-slate-200/80 px-4 py-3 dark:border-slate-800/80">
          <div className="flex items-center gap-1">
            <Globe size={14} className="shrink-0 text-slate-400" />
            {locs.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLocale(l)}
                className={`flex-1 rounded-lg py-1.5 text-center text-[11px] font-semibold transition-all ${
                  locale === l
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                }`}
              >
                {LOCALE_FLAGS[l]} {localeLabels[l]}
              </button>
            ))}
          </div>
        </div>

        {/* ── User profile ── */}
        <div className="border-t border-slate-200/80 p-4 dark:border-slate-800/80">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600 text-xs font-bold text-white shadow-sm">
              {(user?.full_name || user?.username || "U").charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-slate-700 dark:text-slate-200">
                {user?.full_name || user?.username || "User"}
              </p>
              <p className="truncate text-[11px] font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500">
                {user?.role || "Admin"}
              </p>
            </div>
            <button
              type="button"
              onClick={logout}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500 dark:text-slate-500 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
              title={t("sidebar.logout")}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
