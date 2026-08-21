"use client";

import React from "react";
import { usePathname } from "next/navigation";
import { LogOut, Moon, Sun } from "lucide-react";
import { NAVIGATION_ITEMS } from "@/components/Sidebar";
import NotificationBell from "@/components/NotificationBell";
import { useAuth } from "@/context/AuthContext";
import { useLanguage } from "@/context/LanguageContext";
import { useTheme } from "@/context/ThemeContext";

const LOCALE_FLAGS: Record<string, string> = { lo: "🇱🇦", th: "🇹🇭", en: "🇬🇧" };

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

/**
 * Header for the signed-in app: where you are on the left, who you are and the
 * app-wide preferences on the right. The page name is resolved from the same
 * leaf links the sidebar renders, so a new menu entry needs no change here.
 */
export default function Topbar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const { t, locale, setLocale, locales } = useLanguage();
  const { isDark, toggleTheme } = useTheme() as { isDark: boolean; toggleTheme: () => void };

  // Longest matching path wins, so /transport/pod beats /transport — the same
  // rule the sidebar uses to decide which entry is highlighted.
  const current = NAVIGATION_ITEMS
    .filter((item) => pathname === item.path || pathname.startsWith(`${item.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];

  const displayName = user?.full_name || user?.username || "User";

  return (
    <header className="topbar print:hidden">
      <div className="min-w-0">
        <p className="topbar-title truncate">{current ? t(current.i18nKey) : t("sidebar.menu")}</p>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <div className="topbar-locales">
          {locales.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setLocale(option)}
              className={`topbar-locale ${locale === option ? "is-active" : ""}`}
            >
              {LOCALE_FLAGS[option]} {option.toUpperCase()}
            </button>
          ))}
        </div>

        <NotificationBell />

        <button type="button" onClick={toggleTheme} className="btn btn-ghost btn-icon" aria-label="Toggle theme">
          {isDark ? <Sun size={14} /> : <Moon size={14} />}
        </button>

        <span className="topbar-user">
          <span className="topbar-avatar">{initials(displayName)}</span>
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-[12px] font-semibold">{displayName}</span>
            {/* The job title from odg_employee, not the app's permission role —
                a manager whose access level is "ceo" is still a ຜູ້ຈັດການ. Older
                tokens carry no title, so the role stays as the fallback. */}
            <span
              className="block truncate text-[10px] tracking-wider"
              style={{ color: "var(--muted)" }}
              title={user?.role ? `${user.role}` : undefined}
            >
              {user?.position_name || (user?.role ? String(user.role).toUpperCase() : "—")}
            </span>
          </span>
        </span>

        <button type="button" onClick={logout} className="btn btn-ghost btn-icon" title={t("sidebar.logout")}>
          <LogOut size={14} />
        </button>
      </div>
    </header>
  );
}
