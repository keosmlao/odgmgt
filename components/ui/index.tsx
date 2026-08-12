"use client";

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

/* ══════════════════════════════════════════════════════════════
   Shared UI primitives. Everything is driven by the tokens in
   globals.css — pass tones, not colours.
   ══════════════════════════════════════════════════════════════ */

export type Tone = "brand" | "pos" | "warn" | "neg" | "muted";

const cx = (...values: (string | false | null | undefined)[]) =>
  values.filter(Boolean).join(" ");

export const toneClass = (tone: Tone) =>
  tone === "pos" ? "pill-pos" : tone === "warn" ? "pill-warn" : tone === "neg" ? "pill-neg" : tone === "muted" ? "pill-muted" : "";

/** Achievement colouring used across every report: ≥100 good, ≥90 warn, else bad. */
export const achTone = (value: number): Tone =>
  Number(value || 0) >= 100 ? "pos" : Number(value || 0) >= 90 ? "warn" : "neg";

export const fmtNum = (value: unknown) =>
  Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

export const fmtPct = (value: unknown, digits = 1) => `${Number(value || 0).toFixed(digits)}%`;

/* ── Page frame ───────────────────────────────────────────── */

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  children,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="page-hd">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="page-title truncate">{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-end gap-2">{children}</div>}
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("page", className)}>{children}</div>;
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-3 mt-6 flex items-end justify-between gap-4 border-b pb-2" style={{ borderColor: "var(--line-soft)" }}>
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h2 className="text-[15px] font-bold tracking-tight" style={{ color: "var(--ink)" }}>
          {title}
        </h2>
        {description && <p className="page-sub">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

/* ── Card ─────────────────────────────────────────────────── */

export function Card({
  title,
  action,
  children,
  className,
  flush = false,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={cx("card", className)}>
      {(title || action) && (
        <div className="card-hd">
          {typeof title === "string" ? <h3 className="card-title">{title}</h3> : title}
          {action}
        </div>
      )}
      <div className={flush ? "card-bd-flush" : "card-bd"}>{children}</div>
    </section>
  );
}

/* ── Stat tile ────────────────────────────────────────────── */

export function StatTile({
  label,
  value,
  sub,
  pct,
  tone,
  featured = false,
  icon,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Progress / achievement percentage — renders the pill and the bar. */
  pct?: number;
  tone?: Tone;
  featured?: boolean;
  icon?: ReactNode;
  className?: string;
}) {
  const resolved = tone || (pct == null ? "brand" : achTone(pct));
  const width = pct == null ? 0 : Math.min(Math.abs(Number(pct)), 100);
  return (
    <div className={cx("card stat", featured && "stat-featured", "p-3.5", className)}>
      <div className="flex items-start justify-between gap-2">
        <span className="stat-label flex items-center gap-1.5">
          {icon}
          {label}
        </span>
        {pct != null && <span className={cx("pill", toneClass(resolved))}>{fmtPct(pct, 0)}</span>}
      </div>
      <p className="stat-value truncate">{value}</p>
      {sub && <p className="stat-sub truncate">{sub}</p>}
      {pct != null && (
        <div className="bar mt-2.5">
          <div
            className={cx(
              "bar-fill",
              resolved === "pos" && "is-pos",
              resolved === "warn" && "is-warn",
              resolved === "neg" && "is-neg",
            )}
            style={{ width: `${width}%` }}
          />
        </div>
      )}
    </div>
  );
}

/* ── Small building blocks ────────────────────────────────── */

export function Pill({ children, tone = "brand" }: { children: ReactNode; tone?: Tone }) {
  return <span className={cx("pill", toneClass(tone))}>{children}</span>;
}

export function Progress({ label, value, tone }: { label: string; value: number; tone?: Tone }) {
  const resolved = tone || achTone(value);
  return (
    <div className="mb-2.5 last:mb-0">
      <div className="flex items-baseline justify-between text-[11.5px]">
        <span className="muted">{label}</span>
        <span className="num font-bold" style={{ color: "var(--ink)" }}>
          {fmtPct(value)}
        </span>
      </div>
      <div className="bar mt-1">
        <div
          className={cx(
            "bar-fill",
            resolved === "pos" && "is-pos",
            resolved === "warn" && "is-warn",
            resolved === "neg" && "is-neg",
          )}
          style={{ width: `${Math.min(Math.abs(value), 100)}%` }}
        />
      </div>
    </div>
  );
}

export function Mini({ label, value, tone = "brand" }: { label: string; value: ReactNode; tone?: Tone }) {
  const color =
    tone === "pos" ? "var(--pos)" : tone === "warn" ? "var(--warn)" : tone === "neg" ? "var(--neg)" : "var(--ink)";
  return (
    <div className="rounded-[var(--r-sm)] border p-2" style={{ borderColor: "var(--line-soft)", background: "var(--surface-2)" }}>
      <p className="text-[10px] font-medium" style={{ color: "var(--muted)" }}>
        {label}
      </p>
      <p className="num mt-0.5 text-[13px] font-bold" style={{ color }}>
        {value}
      </p>
    </div>
  );
}

export function Rank({
  index,
  label,
  value,
  pct,
}: {
  index: number;
  label: string;
  value: ReactNode;
  pct?: number;
}) {
  const tone = pct == null ? "brand" : achTone(pct);
  return (
    <div className="flex items-center gap-2.5 py-1">
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--r-xs)] text-[11px] font-bold"
        style={{
          background: index === 0 ? "var(--warn-bg)" : "var(--surface-2)",
          color: index === 0 ? "var(--warn)" : "var(--muted)",
        }}
      >
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[12.5px] font-medium" style={{ color: "var(--ink)" }}>
            {label}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="num text-[11.5px]" style={{ color: "var(--muted)" }}>
              {value}
            </span>
            {pct != null && <Pill tone={tone}>{fmtPct(pct, 0)}</Pill>}
          </span>
        </div>
        {pct != null && (
          <div className="bar mt-1" style={{ height: 3 }}>
            <div
              className={cx(
                "bar-fill",
                tone === "pos" && "is-pos",
                tone === "warn" && "is-warn",
                tone === "neg" && "is-neg",
              )}
              style={{ width: `${Math.min(Math.abs(pct), 100)}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Form controls ────────────────────────────────────────── */

export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("min-w-0", className)}>
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}

export function Button({
  variant = "default",
  loading = false,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "accent" | "ghost" | "icon";
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx(
        "btn",
        variant === "primary" && "btn-primary",
        variant === "accent" && "btn-accent",
        variant === "ghost" && "btn-ghost",
        variant === "icon" && "btn-icon",
        className,
      )}
      disabled={props.disabled || loading}
      {...props}
    >
      {loading && <Loader2 size={13} className="animate-spin" />}
      {children}
    </button>
  );
}

/* ── Table ────────────────────────────────────────────────── */

export function Table({
  heads,
  children,
  minWidth,
}: {
  heads: ReactNode[];
  children: ReactNode;
  minWidth?: number;
}) {
  return (
    <div className="tbl-scroll">
      <table className="tbl" style={minWidth ? { minWidth } : undefined}>
        <thead>
          <tr>
            {heads.map((head, index) => (
              <th key={index}>{head}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/* ── States ───────────────────────────────────────────────── */

export function Empty({ text = "ບໍ່ມີຂໍ້ມູນ" }: { text?: string }) {
  return (
    <p className="py-6 text-center text-[11.5px]" style={{ color: "var(--muted)" }}>
      {text}
    </p>
  );
}

export function Loading({ text = "ກຳລັງໂຫຼດ..." }: { text?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-[12px]" style={{ color: "var(--muted)" }}>
      <Loader2 size={15} className="animate-spin" />
      {text}
    </div>
  );
}

export function ErrorNote({ text }: { text: string }) {
  return (
    <div
      className="mb-3 rounded-[var(--r-md)] border px-3 py-2 text-[12px] font-medium"
      style={{ borderColor: "var(--neg)", background: "var(--neg-bg)", color: "var(--neg)" }}
    >
      {text}
    </div>
  );
}

/** Shared Recharts palette so every chart in the app matches. */
export const CHART_COLORS = ["#2b70b5", "#f5911f", "#4ac7f0", "#ffd170", "#003361", "#71b6dc", "#e5a353", "#8dd8f3"];
