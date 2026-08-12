"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  deleteProductSpareRelation,
  updateProductSpareRelation,
  type RelationActionState,
} from "./actions";

const initialState: RelationActionState = { error: null, success: null };

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-teal-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-teal-500 disabled:opacity-60"
    >
      {pending ? "ກຳລັງບັນທຶກ..." : "ບັນທຶກ"}
    </button>
  );
}

function DeleteButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-60 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
    >
      {pending ? "ກຳລັງລຶບ..." : "ລຶບ"}
    </button>
  );
}

export default function RelatedItemActions({
  currentCode,
  relatedCode,
}: {
  currentCode: string;
  relatedCode: string;
}) {
  const [editing, setEditing] = useState(false);
  const [updateState, updateAction] = useActionState(updateProductSpareRelation, initialState);
  const [deleteState, deleteAction] = useActionState(deleteProductSpareRelation, initialState);

  return (
    <div className="min-w-44">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setEditing((value) => !value)}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-teal-300 hover:text-teal-600 dark:border-slate-700 dark:text-slate-300"
        >
          {editing ? "ຍົກເລີກ" : "ແກ້ໄຂ"}
        </button>
        <form
          action={deleteAction}
          onSubmit={(event) => {
            if (!window.confirm(`ຢືນຢັນລຶບການຈັບຄູ່ ${relatedCode}?`)) event.preventDefault();
          }}
        >
          <input type="hidden" name="current_code" value={currentCode} />
          <input type="hidden" name="related_code" value={relatedCode} />
          <DeleteButton />
        </form>
      </div>

      {editing && (
        <form action={updateAction} className="mt-2 flex items-center gap-2">
          <input type="hidden" name="current_code" value={currentCode} />
          <input type="hidden" name="old_related_code" value={relatedCode} />
          <input
            name="new_related_code"
            required
            autoComplete="off"
            defaultValue={relatedCode}
            aria-label="ລະຫັດໃໝ່"
            className="min-h-9 w-36 rounded-lg glass px-2 font-mono text-xs text-slate-900 outline-none focus:border-teal-400 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
          />
          <SaveButton />
        </form>
      )}

      {updateState.error && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{updateState.error}</p>}
      {updateState.success && <p className="mt-1 text-[11px] text-emerald-600 dark:text-emerald-400">{updateState.success}</p>}
      {deleteState.error && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{deleteState.error}</p>}
    </div>
  );
}
