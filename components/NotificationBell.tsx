"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, FileCheck2, PackageCheck, ShoppingCart } from "lucide-react";
import api from "@/service/api";
import { useLanguage } from "@/context/LanguageContext";
import { currency } from "@/hooks/useDashboard";

type Queue = { pending: number; overdue: number; value: number };
type Summary = { queues: { pr: Queue; po: Queue; product: Queue }; totalPending: number; totalOverdue: number };

/** Floating bell that surfaces pending approvals wherever the user is. */
export default function NotificationBell() {
  const { t } = useLanguage();
  const [data, setData] = useState<Summary | null>(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.get("/dashboard/approval-summary")
        .then((res) => { if (!cancelled && res.data?.success) setData(res.data); })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  // Close on outside click.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const queues = data?.queues;
  const items = queues
    ? [
        { key: "pr", label: t("notif.pr"), to: "/approvals/pr", icon: <FileCheck2 size={15} />, ...queues.pr },
        { key: "po", label: t("notif.po"), to: "/approvals/po", icon: <ShoppingCart size={15} />, ...queues.po },
        { key: "product", label: t("notif.product"), to: "/approvals/product-name", icon: <PackageCheck size={15} />, ...queues.product },
      ].filter((item) => item.pending > 0)
    : [];
  const count = data?.totalPending || 0;

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("notif.title")}
        className="relative flex h-8 w-8 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--surface)] text-[var(--ink-soft)] transition hover:border-[#4ac7f0] hover:text-[var(--brand)]"
      >
        <Bell size={17} />
        {count > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--neg)] px-1 text-[10px] font-bold text-white">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-50 w-72 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface)] shadow-xl">
          <p className="border-b border-[var(--line)] px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">
            {t("notif.title")}
          </p>
          {items.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-[var(--muted)]">{t("notif.empty")}</p>
          ) : (
            <div className="p-1.5">
              {items.map((item) => (
                <Link
                  key={item.key}
                  href={item.to}
                  onClick={() => setOpen(false)}
                  className="flex items-start gap-2.5 rounded-xl px-2.5 py-2.5 transition hover:bg-[var(--surface-2)]"
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--info-bg)] text-[var(--brand)]">
                    {item.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-[var(--ink)]">
                      {item.label} · {item.pending}
                    </span>
                    <span className="block truncate text-[11px] text-[var(--muted)]">
                      {item.value > 0 ? currency(item.value) : ""}
                      {item.value > 0 && item.overdue > 0 ? " · " : ""}
                      {item.overdue > 0 ? `${item.overdue} ${t("notif.overdue")}` : ""}
                    </span>
                  </span>
                  {item.overdue > 0 && <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[var(--neg)]" />}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
