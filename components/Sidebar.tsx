"use client";

import React from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Target,
  BarChart2,
  CalendarRange,
  Award,
  BadgePercent,
  ChevronDown,
  FileCheck2,
  PackageCheck,
  Settings,
  Settings2,
  ShieldCheck,
  ShoppingCart,
  LogOut,
  Users,
  Table,
  Menu,
  X,
  Moon,
  Sun,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useLanguage } from "@/context/LanguageContext";
import { useTheme } from "@/context/ThemeContext";

type MenuItem = { path: string; i18nKey: string; icon: React.ReactNode };
type MenuGroup = { key: string; items: MenuItem[] };

const LOCALE_FLAGS: Record<string, string> = { lo: "🇱🇦", th: "🇹🇭", en: "🇬🇧" };

/** Grouped so the nav reads as sections rather than one long list. */
const MENU_GROUPS: MenuGroup[] = [
  {
    key: "sidebar.groupOverview",
    items: [
      { path: "/dashboard", i18nKey: "sidebar.dashboard", icon: <LayoutDashboard size={17} /> },
      { path: "/analytics", i18nKey: "sidebar.analytics", icon: <BarChart2 size={17} /> },
    ],
  },
  {
    key: "sidebar.groupReports",
    items: [
      { path: "/sales-summary", i18nKey: "sidebar.summary", icon: <Table size={17} /> },
      { path: "/month-summary", i18nKey: "sidebar.monthSummary", icon: <CalendarRange size={17} /> },
      { path: "/retail-incentive", i18nKey: "sidebar.incentive", icon: <Award size={17} /> },
    ],
  },
  {
    key: "sidebar.groupPlanning",
    items: [
      { path: "/target", i18nKey: "sidebar.target", icon: <Target size={17} /> },
      { path: "/sales-assignment", i18nKey: "sidebar.assignment", icon: <Users size={17} /> },
    ],
  },
  {
    key: "sidebar.groupApproval",
    items: [
      { path: "/approvals/product-name", i18nKey: "sidebar.approveProductName", icon: <PackageCheck size={17} /> },
      { path: "/approvals/pr", i18nKey: "sidebar.approvePr", icon: <FileCheck2 size={17} /> },
      { path: "/approvals/po", i18nKey: "sidebar.approvePo", icon: <ShoppingCart size={17} /> },
    ],
  },
  {
    key: "sidebar.groupSystem",
    items: [
      { path: "/incentive-config", i18nKey: "sidebar.incentiveCfg", icon: <Settings2 size={17} /> },
      { path: "/commission", i18nKey: "sidebar.commission", icon: <BadgePercent size={17} /> },
      { path: "/access", i18nKey: "sidebar.access", icon: <ShieldCheck size={17} /> },
      { path: "/settings", i18nKey: "sidebar.settings", icon: <Settings size={17} /> },
    ],
  },
];

const isPathActive = (pathname: string, path: string) =>
  pathname === path || pathname.startsWith(`${path}/`);

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

export default function Sidebar() {
  const { user, logout } = useAuth();
  const { t, locale, setLocale, locales: locs } = useLanguage();
  const { isDark, toggleTheme } = useTheme() as { isDark: boolean; toggleTheme: () => void };
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  /** Sections the user folded away — every group starts open. */
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});

  React.useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  /** Never leave the section holding the current page folded. */
  React.useEffect(() => {
    const active = MENU_GROUPS.find((group) => group.items.some((item) => isPathActive(pathname, item.path)));
    if (!active) return;
    setCollapsed((prev) => (prev[active.key] ? { ...prev, [active.key]: false } : prev));
  }, [pathname]);

  const displayName = user?.full_name || user?.username || "User";

  return (
    <>
      {/* ── Mobile top bar ── */}
      <div className="fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between border-b border-white/10 bg-[var(--brand-deep)] px-3 text-white md:hidden">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-[var(--r-sm)] bg-white/10 ring-1 ring-white/15">
            <Image src="/ODG.png" alt="ODG" width={18} height={18} />
          </span>
          <span className="text-[13px] font-bold tracking-wide">ODIEN GROUP</span>
        </div>
        <button
          type="button"
          onClick={() => setMobileOpen((open) => !open)}
          className="flex h-9 w-9 items-center justify-center rounded-[var(--r-sm)] border border-white/15 text-white/85 transition-colors hover:bg-white/10"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
        >
          {mobileOpen ? <X size={17} /> : <Menu size={17} />}
        </button>
      </div>

      {/* ── Overlay ── */}
      <button
        type="button"
        aria-label="Close sidebar overlay"
        onClick={() => setMobileOpen(false)}
        className={`fixed inset-0 z-40 backdrop-blur-sm transition-opacity md:hidden ${
          mobileOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        style={{ background: "rgba(0, 20, 38, 0.5)" }}
      />

      {/* ── Sidebar ── */}
      <aside
        className={`fixed left-0 top-0 z-50 flex h-screen w-64 max-w-[84vw] flex-col bg-[var(--brand-deep)] text-white transition-transform duration-200 md:w-60 md:max-w-none md:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ boxShadow: "var(--sh-3)" }}
      >
        {/* Brand */}
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-white/10 px-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-[var(--r-sm)] bg-white/10 ring-1 ring-white/15">
            <Image src="/ODG.png" alt="ODG" width={20} height={20} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-bold leading-tight tracking-[0.06em]">ODIEN GROUP</p>
            <p className="truncate text-[10px] leading-tight text-white/45">Sales Management</p>
          </div>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-[var(--r-sm)] text-white/60 hover:bg-white/10 md:hidden"
            aria-label="Close menu"
          >
            <X size={15} />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-2.5 py-3">
          {MENU_GROUPS.map((group) => {
            const isOpen = !collapsed[group.key];
            return (
            <div key={group.key} className="mb-3 last:mb-0">
              <button
                type="button"
                onClick={() => setCollapsed((prev) => ({ ...prev, [group.key]: !prev[group.key] }))}
                aria-expanded={isOpen}
                className="mb-1 flex w-full items-center justify-between gap-2 rounded-[var(--r-xs)] px-2.5 py-1 text-[9.5px] font-bold uppercase tracking-[0.18em] text-white/35 transition-colors hover:text-white/60"
              >
                <span className="truncate">{t(group.key)}</span>
                <ChevronDown
                  size={13}
                  className={`shrink-0 transition-transform ${isOpen ? "" : "-rotate-90"}`}
                />
              </button>
              <div className={`space-y-0.5 ${isOpen ? "" : "hidden"}`}>
                {group.items.map((item) => {
                  const isActive = isPathActive(pathname, item.path);
                  return (
                    <Link
                      key={item.path}
                      href={item.path}
                      onClick={() => setMobileOpen(false)}
                      className={`relative flex items-center gap-2.5 rounded-[var(--r-sm)] px-2.5 py-2 text-[12.5px] font-medium transition-colors ${
                        isActive ? "bg-white/12 text-white" : "text-white/62 hover:bg-white/8 hover:text-white"
                      }`}
                    >
                      {isActive && (
                        <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-[var(--accent)]" />
                      )}
                      <span className={`shrink-0 ${isActive ? "text-[var(--sky)]" : ""}`}>{item.icon}</span>
                      <span className="truncate">{t(item.i18nKey)}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
            );
          })}
        </nav>

        {/* Preferences */}
        <div className="border-t border-white/10 px-2.5 py-2.5">
          <div className="flex items-center gap-1">
            {locs.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLocale(l)}
                className={`flex-1 rounded-[var(--r-xs)] py-1 text-center text-[11px] font-semibold transition-colors ${
                  locale === l ? "bg-[var(--accent)] text-white" : "text-white/55 hover:bg-white/10 hover:text-white"
                }`}
              >
                {LOCALE_FLAGS[l]} {l.toUpperCase()}
              </button>
            ))}
            <button
              type="button"
              onClick={toggleTheme}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--r-xs)] text-white/55 transition-colors hover:bg-white/10 hover:text-white"
              aria-label="Toggle theme"
            >
              {isDark ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          </div>
        </div>

        {/* User */}
        <div className="flex items-center gap-2.5 border-t border-white/10 px-3 py-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/12 text-[11px] font-bold text-[var(--warm)]">
            {initials(displayName)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-semibold leading-tight">{displayName}</p>
            <p className="truncate text-[10px] uppercase tracking-wider text-white/45">{user?.role || "—"}</p>
          </div>
          <button
            type="button"
            onClick={logout}
            className="flex h-8 w-8 items-center justify-center rounded-[var(--r-sm)] text-white/55 transition-colors hover:bg-white/10 hover:text-white"
            title={t("sidebar.logout")}
          >
            <LogOut size={15} />
          </button>
        </div>
      </aside>
    </>
  );
}
