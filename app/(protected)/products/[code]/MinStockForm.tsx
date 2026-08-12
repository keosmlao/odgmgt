"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { setMinStock, type MinStockState } from "./min-stock-actions";

const initial: MinStockState = { error: null, success: null };

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-teal-600 px-4 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-teal-500 disabled:opacity-60"
    >
      {pending ? "..." : "ບັນທຶກ"}
    </button>
  );
}

export default function MinStockForm({
  itemCode,
  current,
  balance,
}: {
  itemCode: string;
  current: { min: number | null; max: number | null };
  balance: number;
}) {
  const [state, action] = useActionState(setMinStock, initial);
  const { min, max } = current;
  const low = min != null && balance < min;
  const over = max != null && balance > max;
  const status = low
    ? { cls: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300", label: "ຕໍ່າກວ່າ min — ຄວນສັ່ງຊື້" }
    : over
      ? { cls: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300", label: "ເກີນ max — ຢຸດສັ່ງຊື້" }
      : { cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300", label: "ຢູ່ໃນຊ່ວງທີ່ເໝາະສົມ" };

  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="item_code" value={itemCode} />
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Min (ຂັ້ນຕໍ່າ)</span>
        <input
          type="number"
          name="min_qty"
          defaultValue={min ?? ""}
          min={0}
          step="1"
          placeholder="min"
          className="min-h-9 w-28 rounded-lg glass px-3 text-sm text-slate-900 outline-none transition focus:border-teal-400 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Max (ຂັ້ນສູງ)</span>
        <input
          type="number"
          name="max_qty"
          defaultValue={max ?? ""}
          min={0}
          step="1"
          placeholder="max"
          className="min-h-9 w-28 rounded-lg glass px-3 text-sm text-slate-900 outline-none transition focus:border-teal-400 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
        />
      </label>
      <SaveButton />
      {(min != null || max != null) && (
        <span className={`mb-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${status.cls}`}>{status.label}</span>
      )}
      {state.error && <span className="mb-1.5 text-xs font-medium text-red-600 dark:text-red-400">{state.error}</span>}
      {state.success && <span className="mb-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">{state.success}</span>}
    </form>
  );
}
