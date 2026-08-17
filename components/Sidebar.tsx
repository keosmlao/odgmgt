"use client";

import React from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  Ban,
  Waypoints,
  LayoutDashboard,
  Target,
  BarChart2,
  CalendarCheck,
  CalendarDays,
  CalendarClock,
  CalendarRange,
  Award,
  BadgePercent,
  ChevronDown,
  FileCheck2,
  Package,
  PackageCheck,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  ShieldAlert,
  ShoppingCart,
  Users,
  Store,
  Table,
  Timer,
  MapPin,
  Radio,
  Smartphone,
  Wrench,
  Camera,
  ClipboardList,
  PackageX,
  Clock,
  Boxes,
  Wallet,
  Landmark,
  Truck,
  History,
  Menu,
  X,
} from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";

const EXPANDED_MENUS_KEY = "odg_sidebar_expanded_menus";

type SubMenuItem = { path: string; i18nKey: string };
type MenuItem = {
  path: string;
  i18nKey: string;
  icon: React.ReactNode;
  children?: SubMenuItem[];
};
type MenuGroup = { key: string; items: MenuItem[] };

/** Grouped so the nav reads as sections rather than one long list. */
export const MENU_GROUPS: MenuGroup[] = [
  {
    key: "sidebar.groupOverview",
    items: [
      { path: "/dashboard", i18nKey: "sidebar.dashboard", icon: <LayoutDashboard size={17} /> },
      { path: "/analytics", i18nKey: "sidebar.analytics", icon: <BarChart2 size={17} /> },
      { path: "/meeting-schedule", i18nKey: "sidebar.meetingSchedule", icon: <CalendarDays size={17} /> },
    ],
  },
  {
    key: "sidebar.groupReports",
    items: [
      { path: "/sales-summary", i18nKey: "sidebar.summary", icon: <Table size={17} /> },
      { path: "/month-summary", i18nKey: "sidebar.monthSummary", icon: <CalendarRange size={17} /> },
      { path: "/retail-incentive", i18nKey: "sidebar.incentive", icon: <Award size={17} /> },
      { path: "/incentive-daily", i18nKey: "sidebar.incentiveDaily", icon: <CalendarCheck size={17} /> },
      { path: "/receivables", i18nKey: "sidebar.receivables", icon: <Wallet size={17} /> },
      { path: "/cash-bank", i18nKey: "sidebar.cashBank", icon: <Landmark size={17} /> },
    ],
  },
  {
    key: "sidebar.groupTransport",
    items: [
      { path: "/transport", i18nKey: "sidebar.transport", icon: <Truck size={17} /> },
      { path: "/transport/delivery-performance", i18nKey: "sidebar.deliveryPerformance", icon: <Timer size={17} /> },
      { path: "/transport/gps-monthly", i18nKey: "sidebar.gpsMonthly", icon: <MapPin size={17} /> },
      { path: "/transport/cars-map", i18nKey: "sidebar.carsMap", icon: <Radio size={17} /> },
      { path: "/transport/phones-map", i18nKey: "sidebar.phonesMap", icon: <Smartphone size={17} /> },
      { path: "/transport/pod", i18nKey: "sidebar.pod", icon: <Camera size={17} /> },
      { path: "/transport/daily-department", i18nKey: "sidebar.dailyDept", icon: <ClipboardList size={17} /> },
      { path: "/transport/pending-daily", i18nKey: "sidebar.pendingDaily", icon: <PackageX size={17} /> },
      { path: "/transport/bills-waitingsent", i18nKey: "sidebar.billsWaiting", icon: <Clock size={17} /> },
      { path: "/transport/bills-inprogress", i18nKey: "sidebar.billsInProgress", icon: <Truck size={17} /> },
      { path: "/transport/bill-complete", i18nKey: "sidebar.billsComplete", icon: <PackageCheck size={17} /> },
      { path: "/transport/truck-utilization", i18nKey: "sidebar.truckUtilization", icon: <Boxes size={17} /> },
    ],
  },
  {
    key: "sidebar.groupProduct",
    items: [
      { path: "/products", i18nKey: "sidebar.products", icon: <Package size={17} /> },
      { path: "/defects", i18nKey: "sidebar.defects", icon: <ShieldAlert size={17} /> },
    ],
  },
  {
    key: "sidebar.groupPlanning",
    items: [
      { path: "/target", i18nKey: "sidebar.target", icon: <Target size={17} /> },
      { path: "/sales-assignment", i18nKey: "sidebar.assignment", icon: <Users size={17} /> },
      { path: "/shop-map", i18nKey: "sidebar.shopMap", icon: <Store size={17} /> },
    ],
  },
  {
    key: "sidebar.groupService",
    items: [
      { path: "/service-center", i18nKey: "sidebar.serviceCenter", icon: <Wrench size={17} /> },
      { path: "/service-center/schedule", i18nKey: "sidebar.serviceSchedule", icon: <CalendarRange size={17} /> },
      { path: "/service-center/tracking", i18nKey: "sidebar.serviceTracking", icon: <MapPin size={17} /> },
      { path: "/service-center/revenue", i18nKey: "sidebar.serviceRevenue", icon: <BadgePercent size={17} /> },
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
      { path: "/incentive-config", i18nKey: "sidebar.incentiveCfg", icon: <SlidersHorizontal size={17} /> },
      { path: "/incentive-exclude", i18nKey: "sidebar.incentiveExclude", icon: <Ban size={17} /> },
      { path: "/incentive-mapping", i18nKey: "sidebar.incentiveMapping", icon: <Waypoints size={17} /> },
      { path: "/sale-month-override", i18nKey: "sidebar.saleMonthOverride", icon: <CalendarClock size={17} /> },
      { path: "/commission", i18nKey: "sidebar.commission", icon: <BadgePercent size={17} /> },
      { path: "/access", i18nKey: "sidebar.access", icon: <ShieldCheck size={17} /> },
      { path: "/settings", i18nKey: "sidebar.settings", icon: <Settings size={17} /> },
      { path: "/audit-log", i18nKey: "sidebar.auditLog", icon: <History size={17} /> },
    ],
  },
];

const matchesPath = (pathname: string, path: string) =>
  pathname === path || pathname.startsWith(`${path}/`);

/** Leaf links are shared with the top bar so both surfaces resolve the same page. */
export const NAVIGATION_ITEMS = MENU_GROUPS.flatMap((group) =>
  group.items.flatMap((item) => item.children ?? [item]),
);

/**
 * Only the most specific menu entry lights up. Matching with startsWith alone
 * highlighted both /transport and /transport/cars-map at the same time, so the
 * longest matching path wins and everything else stays inactive.
 */
const activePathFor = (pathname: string) =>
  NAVIGATION_ITEMS
    .map((item) => item.path)
    .filter((path) => matchesPath(pathname, path))
    .sort((a, b) => b.length - a.length)[0] ?? null;

export default function Sidebar() {
  const { t } = useLanguage();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  /** Sections the user folded away — every group starts open. */
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const [expandedMenus, setExpandedMenus] = React.useState<Record<string, boolean>>({});

  /** Restore submenus the user left open before a browser refresh. */
  React.useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(EXPANDED_MENUS_KEY) || "[]");
      if (!Array.isArray(saved)) return;
      setExpandedMenus((prev) => ({
        ...Object.fromEntries(saved.map((path) => [String(path), true])),
        ...prev,
      }));
    } catch {
      localStorage.removeItem(EXPANDED_MENUS_KEY);
    }
  }, []);

  React.useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  /** Never leave the section holding the current page folded. */
  React.useEffect(() => {
    const current = activePathFor(pathname);
    const active = MENU_GROUPS.find((group) =>
      group.items.some((item) => item.path === current || item.children?.some((child) => child.path === current)),
    );
    if (!active) return;
    setCollapsed((prev) => (prev[active.key] ? { ...prev, [active.key]: false } : prev));

    const parent = active.items.find((item) => item.children?.some((child) => child.path === current));
    if (parent) {
      setExpandedMenus((prev) => (prev[parent.path] ? prev : { ...prev, [parent.path]: true }));
    }
  }, [pathname]);

  const activePath = activePathFor(pathname);

  const toggleSubmenu = (path: string, defaultOpen: boolean) => {
    setExpandedMenus((prev) => {
      const next = { ...prev, [path]: !(prev[path] ?? defaultOpen) };
      const openPaths = Object.entries(next)
        .filter(([, open]) => open)
        .map(([menuPath]) => menuPath);
      localStorage.setItem(EXPANDED_MENUS_KEY, JSON.stringify(openPaths));
      return next;
    });
  };

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
                  const isActive = item.path === activePath;
                  if (item.children) {
                    const hasActiveChild = item.children.some((child) => child.path === activePath);
                    const isSubmenuOpen = expandedMenus[item.path] ?? hasActiveChild;

                    return (
                      <div key={item.path}>
                        <button
                          type="button"
                          aria-expanded={isSubmenuOpen}
                          onClick={() => toggleSubmenu(item.path, hasActiveChild)}
                          className={`relative flex w-full items-center gap-2.5 rounded-[var(--r-sm)] px-2.5 py-2 text-[12.5px] font-medium transition-colors ${
                            hasActiveChild ? "bg-white/12 text-white" : "text-white/62 hover:bg-white/8 hover:text-white"
                          }`}
                        >
                          {hasActiveChild && (
                            <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-[var(--accent)]" />
                          )}
                          <span className={`shrink-0 ${hasActiveChild ? "text-[var(--sky)]" : ""}`}>{item.icon}</span>
                          <span className="min-w-0 flex-1 truncate text-left">{t(item.i18nKey)}</span>
                          <ChevronDown
                            size={13}
                            className={`shrink-0 transition-transform ${isSubmenuOpen ? "" : "-rotate-90"}`}
                          />
                        </button>

                        <div className={`ml-4 border-l border-white/10 pl-2 pt-0.5 ${isSubmenuOpen ? "" : "hidden"}`}>
                          {item.children.map((child) => {
                            const isChildActive = child.path === activePath;
                            return (
                              <Link
                                key={child.path}
                                href={child.path}
                                onClick={() => setMobileOpen(false)}
                                className={`relative flex items-center rounded-[var(--r-sm)] px-2.5 py-1.5 text-[11.5px] font-medium transition-colors ${
                                  isChildActive
                                    ? "bg-white/10 text-white"
                                    : "text-white/52 hover:bg-white/8 hover:text-white"
                                }`}
                              >
                                {isChildActive && (
                                  <span className="absolute -left-[11px] h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                                )}
                                <span className="truncate">{t(child.i18nKey)}</span>
                              </Link>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }

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

      </aside>
    </>
  );
}
