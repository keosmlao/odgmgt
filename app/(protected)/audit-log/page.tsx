"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { History, RefreshCw, Search } from "lucide-react";
import api from "@/service/api";
import { useLanguage } from "@/context/LanguageContext";

type AuditRow = {
  id: number;
  at: string;
  username: string | null;
  action: string;
  detail: string | null;
  ip: string | null;
};

/** Colours per action family so the trail scans at a glance. */
const ACTION_TONES: { match: RegExp; cls: string }[] = [
  { match: /^login$/, cls: "bg-[#2b70b5]/10 text-[#2b70b5]" },
  { match: /_failed|_denied|_rejected/, cls: "bg-[var(--neg)]/10 text-[var(--neg)]" },
  { match: /_approved/, cls: "bg-[var(--pos)]/12 text-[var(--pos)]" },
  { match: /user_/, cls: "bg-[var(--warn)]/14 text-[var(--warn)]" },
];

const actionTone = (action: string) =>
  ACTION_TONES.find((tone) => tone.match.test(action))?.cls ||
  "bg-[var(--surface-2)] text-[var(--muted)]";

const ACTIONS = [
  "login",
  "login_failed",
  "login_denied",
  "po_approved",
  "po_rejected",
  "pr_approved",
  "pr_rejected",
  "product_approved",
  "product_rejected",
  "user_created",
  "user_updated",
  "user_deleted",
];

export default function AuditLogPage() {
  const { t, locale } = useLanguage();

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState("");
  const [username, setUsername] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { limit: 300 };
      if (action) params.action = action;
      if (username.trim()) params.username = username.trim();
      const res = await api.get("/audit-log", { params });
      setRows(res?.data?.data || []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [action, username]);

  useEffect(() => {
    const timer = setTimeout(() => {
      load();
    }, username ? 350 : 0);
    return () => clearTimeout(timer);
  }, [load, username]);

  const fmtTime = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "lo-LA", {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale],
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#2b70b5]/10 text-[#2b70b5]">
            <History size={20} />
          </span>
          <div>
            <h1 className="text-lg font-bold text-[var(--ink)]">{t("sidebar.auditLog")}</h1>
            <p className="text-xs text-[var(--muted)]">{t("audit.subtitle")}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={load}
          className="flex items-center gap-2 rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-xs font-semibold text-[var(--ink-soft)] shadow-sm transition hover:border-[#4ac7f0] dark:bg-[var(--surface-2)]"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t("audit.searchUser")}
            className="h-10 w-56 rounded-xl border border-[var(--line)] bg-white pl-9 pr-3 text-xs text-[var(--ink)] shadow-sm outline-none transition focus:border-[#4ac7f0] dark:bg-[var(--surface-2)]"
          />
        </div>
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="h-10 rounded-xl border border-[var(--line)] bg-white px-3 text-xs font-medium text-[var(--ink-soft)] shadow-sm outline-none transition focus:border-[#4ac7f0] dark:bg-[var(--surface-2)]"
        >
          <option value="">{t("audit.allActions")}</option>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <span className="ml-auto text-[11px] text-[var(--muted)]">{rows.length} rows</span>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-2xl border border-[var(--line)] bg-white shadow-sm dark:bg-[var(--surface)]">
        <div className="max-h-[70vh] overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 z-10 bg-[var(--surface-2)] text-[10px] uppercase tracking-wider text-[var(--muted)]">
              <tr>
                <th className="px-4 py-2.5 font-bold">{t("audit.time")}</th>
                <th className="px-4 py-2.5 font-bold">{t("audit.user")}</th>
                <th className="px-4 py-2.5 font-bold">{t("audit.action")}</th>
                <th className="px-4 py-2.5 font-bold">{t("audit.detail")}</th>
                <th className="px-4 py-2.5 font-bold">{t("audit.ip")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)]">
              {loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-[var(--muted)]">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-[var(--muted)]">
                    —
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className="transition hover:bg-[var(--surface-2)]/60">
                    <td className="whitespace-nowrap px-4 py-2.5 text-[var(--muted)]">
                      {fmtTime.format(new Date(row.at))}
                    </td>
                    <td className="px-4 py-2.5 font-semibold text-[var(--ink)]">{row.username || "—"}</td>
                    <td className="px-4 py-2.5">
                      <span className={`rounded-md px-2 py-0.5 font-semibold ${actionTone(row.action)}`}>
                        {row.action}
                      </span>
                    </td>
                    <td className="max-w-72 truncate px-4 py-2.5 text-[var(--ink-soft)]" title={row.detail || ""}>
                      {row.detail || "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[11px] text-[var(--muted)]">
                      {row.ip || "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
