"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import AsyncSelect from "@/components/pm/ClientAsyncSelect";
import {
  addItemSupplier,
  removeItemSupplier,
  setLifecycle,
  type PmState,
} from "./pm-actions";
import type { ItemSupplier } from "@/lib/pm/products";

const initial: PmState = { error: null, success: null };
type Opt = { value: string; label: string };

const LIFECYCLE_OPTIONS = [
  { value: "new", label: "ໃໝ່" },
  { value: "active", label: "ຂາຍປົກກະຕິ" },
  { value: "phaseout", label: "ກຳລັງເຊົາ" },
  { value: "discontinued", label: "ຢຸດຂາຍ" },
];

function Pending({ idle }: { idle: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="rounded-lg bg-teal-600 px-4 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-teal-500 disabled:opacity-60">
      {pending ? "..." : idle}
    </button>
  );
}

export default function PmSettings({
  itemCode,
  lifecycle,
  suppliers,
}: {
  itemCode: string;
  lifecycle: { status: string; note: string } | null;
  suppliers: ItemSupplier[];
}) {
  const [lcState, lcAction] = useActionState(setLifecycle, initial);
  const [supState, supAction] = useActionState(addItemSupplier, initial);
  const [, delAction] = useActionState(removeItemSupplier, initial);

  const loadSuppliers = async (input: string): Promise<Opt[]> => {
    if (!input.trim()) return [];
    const res = await fetch(`/api/supplier-search?q=${encodeURIComponent(input)}`);
    if (!res.ok) return [];
    const rows: { code: string; name: string }[] = await res.json();
    return rows.map((r) => ({ value: r.code, label: `${r.name} · ${r.code}` }));
  };

  return (
    <div className="space-y-5">
      {/* Lifecycle */}
      <form action={lcAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="item_code" value={itemCode} />
        <span className="text-sm text-slate-500 dark:text-slate-400">ສະຖານະພະລິດຕະພັນ</span>
        <select
          name="status"
          defaultValue={lifecycle?.status ?? ""}
          className="min-h-9 rounded-lg glass px-3 text-sm text-slate-900 outline-none focus:border-teal-400 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
        >
          <option value="">— ບໍ່ກຳນົດ —</option>
          {LIFECYCLE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <Pending idle="ບັນທຶກ" />
        {lcState.success && <span className="text-xs text-emerald-700 dark:text-emerald-400">{lcState.success}</span>}
        {lcState.error && <span className="text-xs text-red-600 dark:text-red-400">{lcState.error}</span>}
      </form>

      {/* Suppliers */}
      <div className="border-t border-slate-100 pt-4 dark:border-slate-800">
        <p className="mb-2 text-sm text-slate-500 dark:text-slate-400">ຜູ້ສະໜອງ</p>
        {suppliers.length > 0 ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {suppliers.map((s) => (
              <span key={s.id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                {s.supplier_name}
                <form action={delAction} className="inline">
                  <input type="hidden" name="id" value={s.id} />
                  <input type="hidden" name="item_code" value={itemCode} />
                  <button type="submit" aria-label="ລຶບ" className="text-slate-400 hover:text-red-600">✕</button>
                </form>
              </span>
            ))}
          </div>
        ) : (
          <p className="mb-3 text-xs text-slate-400">ຍັງບໍ່ໄດ້ກຳນົດຜູ້ສະໜອງ</p>
        )}
        <form action={supAction} className="flex flex-col gap-2 sm:flex-row">
          <input type="hidden" name="item_code" value={itemCode} />
          <div className="min-w-0 flex-1">
            <AsyncSelect<Opt>
              name="supplier_code"
              instanceId="supplier-search"
              loadOptions={loadSuppliers}
              placeholder="ຄົ້ນຫາຜູ້ສະໜອງ"
              noOptionsMessage={({ inputValue }) => (inputValue ? "ບໍ່ພົບ" : "ພິມເພື່ອຄົ້ນຫາ")}
              loadingMessage={() => "ກຳລັງຄົ້ນຫາ..."}
              menuPortalTarget={typeof document !== "undefined" ? document.body : undefined}
              unstyled
              classNames={{
                control: ({ isFocused }: { isFocused: boolean }) =>
                  ["min-h-9 rounded-lg border bg-white px-1 text-sm dark:bg-slate-950", isFocused ? "border-teal-400" : "border-slate-200 dark:border-slate-700"].join(" "),
                valueContainer: () => "px-2 py-0.5",
                placeholder: () => "text-slate-400",
                input: () => "text-slate-900 dark:text-white",
                singleValue: () => "text-slate-900 dark:text-white",
                menu: () => "mt-1 overflow-hidden rounded-lg glass shadow-lg dark:border-slate-700 dark:bg-slate-900",
                menuList: () => "max-h-60 py-1",
                option: ({ isFocused }: { isFocused: boolean }) => ["cursor-pointer px-3 py-2 text-sm", isFocused ? "bg-slate-100 dark:bg-slate-800" : "text-slate-700 dark:text-slate-300"].join(" "),
              }}
              styles={{ menuPortal: (base) => ({ ...base, zIndex: 50 }) }}
            />
          </div>
          <Pending idle="ເພີ່ມ" />
        </form>
        {supState.success && <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">{supState.success}</p>}
        {supState.error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{supState.error}</p>}
      </div>
    </div>
  );
}
