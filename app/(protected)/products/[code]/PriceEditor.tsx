"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { setSalePrice, type PriceState } from "./price-actions";
import type { EditablePrice } from "@/lib/pm/pricing";

const initial: PriceState = { error: null, success: null, roworder: null };

function SaveBtn() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="rounded-md bg-teal-600 px-3 py-1.5 text-[11px] font-bold text-white shadow-sm transition hover:bg-teal-500 disabled:opacity-60">
      {pending ? "..." : "ບັນທຶກ"}
    </button>
  );
}

function Row({ itemCode, p }: { itemCode: string; p: EditablePrice }) {
  const [state, action] = useActionState(setSalePrice, initial);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-2 last:border-0 dark:border-slate-800">
      <input type="hidden" name="roworder" value={p.roworder} />
      <input type="hidden" name="item_code" value={itemCode} />
      <div className="w-40 text-xs font-medium text-slate-700 dark:text-slate-200">
        {p.group_label}
        <span className="ml-1 text-[10px] text-slate-400">{p.currency_sign}{p.unit ? ` · ${p.unit}` : ""}</span>
      </div>
      <input
        name="price"
        type="number"
        min={0}
        step="0.01"
        defaultValue={p.price}
        className="min-h-8 w-32 rounded-md border border-slate-200 bg-white px-2 text-right text-xs tabular-nums text-slate-900 outline-none focus:border-teal-400 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
      />
      <SaveBtn />
      {state.error && <span className="text-[11px] font-medium text-red-600 dark:text-red-400">{state.error}</span>}
      {state.success && <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400">{state.success}</span>}
    </form>
  );
}

export default function PriceEditor({ itemCode, prices }: { itemCode: string; prices: EditablePrice[] }) {
  if (!prices.length) {
    return <p className="text-xs text-slate-400">ບໍ່ມີແຖວລາຄາຂາຍທີ່ active ໃນເດືອນນີ້ (ລາຄາຖືກສ້າງເປັນລາຍເດືອນໃນ ERP)</p>;
  }
  return (
    <div>
      <div className="flex flex-col">
        {prices.map((p) => (
          <Row key={p.roworder} itemCode={itemCode} p={p} />
        ))}
      </div>
      <p className="mt-2 text-[10px] text-slate-400">ແກ້ໄຂໃຊ້ກັບແຖວລາຄາຂອງເດືອນປັດຈຸບັນ (ERP ສ້າງລາຄາໃໝ່ຕໍ່ເດືອນ).</p>
    </div>
  );
}
