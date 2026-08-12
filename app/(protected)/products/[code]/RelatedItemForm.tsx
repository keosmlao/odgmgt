"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { addProductSpareRelation, type AddRelationState } from "./actions";
import ProductSearchSelect from "./ProductSearchSelect";

const initialState: AddRelationState = { error: null, success: null };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-teal-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-teal-500 disabled:opacity-60"
    >
      {pending ? "ກຳລັງເພີ່ມ..." : "ເພີ່ມ"}
    </button>
  );
}

function AddRelationModal({
  currentCode,
  isSpare,
  onClose,
}: {
  currentCode: string;
  isSpare: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, action] = useActionState(addProductSpareRelation, initialState);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  useEffect(() => {
    if (state.success) onClose();
  }, [state.success, onClose]);

  const title = isSpare ? "ເພີ່ມສິນຄ້າທີ່ໃຊ້ຮ່ວມ" : "ເພີ່ມອາໄຫຼ່ທີ່ໃຊ້ຮ່ວມ";

  return (
    <dialog
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-auto w-[min(92vw,680px)] rounded-xl bg-transparent p-0 text-left text-slate-900 shadow-2xl backdrop:bg-slate-950/55 backdrop:backdrop-blur-[2px] dark:text-white"
    >
      <div className="overflow-visible rounded-xl glass shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div>
            <h3 className="text-base font-bold text-slate-900 dark:text-white">{title}</h3>
            <p className="mt-1 text-xs text-slate-400">ຄົ້ນຫາດ້ວຍລະຫັດ ຫຼື ຊື່ລາຍການ</p>
          </div>
          <button type="button" onClick={onClose} aria-label="ປິດ" className="grid h-8 w-8 place-items-center rounded-lg text-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-white">×</button>
        </div>

        <form action={action} className="p-5">
          <input type="hidden" name="current_code" value={currentCode} />
          <label className="text-xs font-semibold text-slate-700 dark:text-slate-200">
            {isSpare ? "ຄົ້ນຫາສິນຄ້າ" : "ຄົ້ນຫາອາໄຫຼ່"}
          </label>
          <div className="mt-2">
            <ProductSearchSelect
              spareOnly={!isSpare}
              placeholder={isSpare ? "ຄົ້ນຫາ ລະຫັດ / ຊື່ ສິນຄ້າ" : "ຄົ້ນຫາ ລະຫັດ / ຊື່ ອາໄຫຼ່"}
            />
          </div>
          {state.error && <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">{state.error}</p>}
          <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
            <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-5 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">ຍົກເລີກ</button>
            <SubmitButton />
          </div>
        </form>
      </div>
    </dialog>
  );
}

export default function RelatedItemForm({
  currentCode,
  isSpare,
}: {
  currentCode: string;
  isSpare: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mb-4 flex justify-end">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-teal-600 px-4 text-sm font-bold text-white shadow-sm transition hover:bg-teal-500"
      >
        <span aria-hidden="true" className="text-lg leading-none">＋</span>
        {isSpare ? "ເພີ່ມສິນຄ້າ" : "ເພີ່ມອາໄຫຼ່"}
      </button>
      {open && (
        <AddRelationModal
          currentCode={currentCode}
          isSpare={isSpare}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
