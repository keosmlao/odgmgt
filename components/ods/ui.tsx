// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

/* UI primitives ທີ່ທຸກໜ້າໃຊ້ຮ່ວມກັນ — ໃຫ້ໜ້າຕາຄືກັນທັງລະບົບ */

export const inputClass =
  "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50 read-only:bg-slate-50";

export const labelClass = "mb-1 block text-sm text-slate-600";

export function PageTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="text-center">
      <h1 className="text-2xl font-bold text-slate-700">{children}</h1>
      {sub && <p className="mt-1 text-sm text-slate-500">{sub}</p>}
    </div>
  );
}

export function Card({ title, children, actions }: { title?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-2">
          {title && <h2 className="font-bold text-slate-700">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

type ButtonTone = "primary" | "success" | "danger" | "neutral" | "info";
const tones: Record<ButtonTone, string> = {
  primary: "bg-brand-700 text-white hover:bg-brand-800",
  success: "bg-brand-700 text-white hover:bg-brand-700",
  danger: "bg-[#9f5f14] text-white hover:opacity-90",
  info: "bg-brand-500 text-white hover:bg-brand-500",
  neutral: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
};
type ButtonSize = "sm" | "md";
/** ຂະໜາດແຍກຈາກ base ⇒ className ຂອງຄົນເອີ້ນ override ໄດ້ຈິງ (ບໍ່ຕ້ານ h-10 ຂອງ base) */
const sizes: Record<ButtonSize, string> = {
  md: "h-10 gap-2 px-4 text-sm",
  sm: "h-8 gap-1.5 px-3 text-xs",
};
const buttonBase =
  "inline-flex items-center justify-center rounded-lg font-semibold transition disabled:cursor-not-allowed disabled:opacity-60";

export function Button({
  tone = "primary",
  size = "md",
  className = "",
  ...rest
}: { tone?: ButtonTone; size?: ButtonSize } & ComponentProps<"button">) {
  return <button {...rest} className={`${buttonBase} ${sizes[size]} ${tones[tone]} ${className}`} />;
}

export function LinkButton({
  tone = "primary",
  size = "md",
  className = "",
  ...rest
}: { tone?: ButtonTone; size?: ButtonSize } & ComponentProps<typeof Link>) {
  return <Link {...rest} className={`${buttonBase} ${sizes[size]} ${tones[tone]} ${className}`} />;
}

/** ລາຍການທີ່ຍັງບໍ່ທັນຍ້າຍມາ Next.js — ສະແດງແຕ່ກົດບໍ່ໄດ້ */
export function Todo({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span title="ຍັງບໍ່ທັນຍ້າຍມາ Next.js" className={`${buttonBase} ${sizes.md} cursor-not-allowed bg-slate-200 text-slate-500 ${className}`}>
      {children}
    </span>
  );
}

export function Table({ head, children, minWidth = 1000 }: { head: ReactNode[]; children: ReactNode; minWidth?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm" style={{ minWidth }}>
        <thead>
          <tr className="border-y border-slate-200 bg-slate-50 text-slate-600">
            {head.map((cell, index) => (
              <th key={index} className="whitespace-nowrap px-3 py-3 text-center font-semibold">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Empty({ children = "ບໍ່ພົບລາຍການ" }: { children?: ReactNode }) {
  return <p className="py-10 text-center text-sm text-slate-400">{children}</p>;
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-brand-orange-400 bg-brand-orange-50 p-4 text-sm text-brand-orange-700">{children}</p>;
}
