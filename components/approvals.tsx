"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, CircleCheck, Clock3, RefreshCw, User, X } from "lucide-react";
import { Pill, type Tone } from "@/components/ui";
import { useLanguage } from "@/context/LanguageContext";
import api from "@/service/api";

/* Shared bits for the three approval queues — same filter, pill and buttons
   whether the underlying status column is a smallint or a text value. */

export const FILTERS = ["pending", "approved", "rejected", "all"] as const;
export type Filter = (typeof FILTERS)[number];

/** "mine" = documents the signed-in employee raised, submitted or ruled on. */
export type Scope = "mine" | "all";
const SCOPE_KEY = "odg_approval_scope";

/** 1 / "approved" → approved, -1 / "rejected" → rejected, anything else waits. */
export function normalizeStatus(status: unknown): "pending" | "approved" | "rejected" {
  if (typeof status === "number") return status === 1 ? "approved" : status === -1 ? "rejected" : "pending";
  const text = String(status || "").toLowerCase();
  if (text === "approved") return "approved";
  if (["rejected", "cancelled", "canceled"].includes(text)) return "rejected";
  return "pending";
}

const STATUS_TONE: Record<string, Tone> = { approved: "pos", rejected: "neg", pending: "warn" };

/**
 * Some rows still carry the name as the picker's raw payload —
 * {"{\"label\":\"TEST\",\"value\":\"00\"}","{\"value\":\"KANTO\"}",…} — instead of
 * the joined text. Rebuild "TEST - KANTO - …" from it; anything else is returned
 * untouched.
 */
export function readItemName(raw: unknown) {
  const text = String(raw ?? "").trim();
  if (!text.startsWith("{") || !text.includes("value")) return text;

  const objects = text.replace(/\\"/g, '"').match(/\{[^{}]*\}/g);
  if (!objects) return text;

  const labels = objects
    .map((part) => {
      try {
        const parsed = JSON.parse(part);
        return String(parsed?.label ?? parsed?.value ?? "").trim();
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  return labels.length ? labels.join(" - ") : text;
}

/** Long product names wrap instead of stretching the table — .tbl cells are nowrap. */
export function ItemName({ value, className }: { value: unknown; className?: string }) {
  const text = readItemName(value);
  return (
    <span className={`block max-w-[26rem] whitespace-normal break-words ${className || ""}`}>{text || "-"}</span>
  );
}

export function StatusPill({ status }: { status: unknown }) {
  const { t } = useLanguage();
  const state = normalizeStatus(status);
  return (
    <Pill tone={STATUS_TONE[state]}>
      {state === "pending" ? <Clock3 size={11} /> : state === "approved" ? <CircleCheck size={11} /> : <X size={11} />}
      {t(`approve.status.${state}`)}
    </Pill>
  );
}

export function FilterTabs({ value, onChange }: { value: Filter; onChange: (next: Filter) => void }) {
  const { t } = useLanguage();
  return (
    <div className="approval-tabs" role="tablist" aria-label={t("approve.status")}>
      {FILTERS.map((filter) => (
        <button
          key={filter}
          type="button"
          onClick={() => onChange(filter)}
          role="tab"
          aria-selected={value === filter}
          className={`approval-tab ${value === filter ? "is-active" : ""}`}
        >
          {t(`approve.filter.${filter}`)}
        </button>
      ))}
    </div>
  );
}

export function ApprovalHeader({
  icon,
  title,
  subtitle,
  filter,
  onFilterChange,
  scope,
  onScopeChange,
  onRefresh,
  loading,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  filter: Filter;
  onFilterChange: (next: Filter) => void;
  scope?: Scope;
  onScopeChange?: (next: Scope) => void;
  onRefresh: () => void;
  loading: boolean;
}) {
  const { t } = useLanguage();
  return (
    <header className="approval-hero">
      <div className="approval-hero-copy">
        <span className="approval-hero-icon" aria-hidden="true">{icon}</span>
        <div className="min-w-0">
          <p className="eyebrow">{t("approve.eyebrow")}</p>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
      </div>
      <div className="approval-hero-tools">
        {scope && onScopeChange && (
          <div className="approval-tabs approval-scope">
            {(["mine", "all"] as Scope[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onScopeChange(option)}
                className={`approval-tab ${scope === option ? "is-active" : ""}`}
              >
                {option === "mine" ? <User size={13} className="mr-1 inline-block align-[-2px]" /> : null}
                {t(`approve.scope.${option}`)}
              </button>
            ))}
          </div>
        )}
        <FilterTabs value={filter} onChange={onFilterChange} />
        <button type="button" className="approval-refresh" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          <span>{t("approve.refresh")}</span>
        </button>
      </div>
    </header>
  );
}

/** Approve / reject pair — hidden once the row has been settled. */
export function RowActions({
  status,
  busy,
  onApprove,
  onReject,
}: {
  status: unknown;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { t } = useLanguage();
  if (normalizeStatus(status) !== "pending") return <span className="muted text-[11px]">—</span>;

  return (
    <span className="approval-actions">
      <button
        type="button"
        disabled={busy}
        onClick={onApprove}
        className="approval-action is-approve"
      >
        <Check size={13} />
        {t("approve.action.approve")}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onReject}
        className="approval-action is-reject"
      >
        <X size={13} />
        {t("approve.action.reject")}
      </button>
    </span>
  );
}

/** Confirms the verdict and, for a rejection, collects the reason. */
function askVerdict(action: "approve" | "reject", t: (key: string) => string) {
  if (action === "approve") {
    return window.confirm(t("approve.confirmApprove")) ? { ok: true as const, reason: null } : { ok: false as const };
  }
  const reason = window.prompt(t("approve.rejectReason"), "");
  if (reason === null) return { ok: false as const };
  return { ok: true as const, reason: reason.trim() };
}

/**
 * Loads one queue and posts verdicts back to it. `errorKey` is an i18n key so
 * the page can render it in whatever language is active.
 */
export function useApprovalQueue<T>(endpoint: string) {
  const { t } = useLanguage();
  const [filter, setFilter] = useState<Filter>("pending");
  const [scope, setScopeState] = useState<Scope>("mine");
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState("");

  // An approver who works across the whole company should not have to switch
  // back to "all" on every page, so the choice is remembered.
  useEffect(() => {
    const saved = localStorage.getItem(SCOPE_KEY);
    if (saved === "all" || saved === "mine") setScopeState(saved);
  }, []);

  const setScope = useCallback((next: Scope) => {
    setScopeState(next);
    localStorage.setItem(SCOPE_KEY, next);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorKey("");
    try {
      const response = await api.get(endpoint, { params: { filter, scope } });
      if (response.data?.success) setData(response.data.data);
      else setErrorKey("app.error");
    } catch {
      setErrorKey("app.error");
    } finally {
      setLoading(false);
    }
  }, [endpoint, filter, scope]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = useCallback(
    async (action: "approve" | "reject", payload: Record<string, unknown>) => {
      const verdict = askVerdict(action, t);
      if (!verdict.ok) return;
      setBusy(true);
      setErrorKey("");
      try {
        await api.post(endpoint, { ...payload, action, reason: verdict.reason });
        await load();
      } catch (error) {
        const status = (error as { response?: { status?: number } })?.response?.status;
        setErrorKey(status === 409 ? "approve.alreadyHandled" : "approve.failed");
      } finally {
        setBusy(false);
      }
    },
    [endpoint, load, t],
  );

  return { filter, setFilter, scope, setScope, data, loading, busy, errorKey, reload: load, decide };
}
