"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { addActivity, addComment, deleteComment, toggleActivity, type ChatterState } from "./chatter-actions";
import type { Comment, Activity } from "@/lib/pm/chatter";
import type { DeptStaff } from "@/lib/pm/products";

const initial: ChatterState = { error: null, success: null };

function fmtDateTime(v: string | null) {
  if (!v) return "";
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[3]}/${m[2]} ${m[4]}:${m[5]}` : v;
}
function fmtDate(v: string | null) {
  if (!v) return "-";
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : v;
}

function PostBtn({ idle }: { idle: string }) {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} className="rounded-lg bg-teal-600 px-4 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-teal-500 disabled:opacity-60">{pending ? "..." : idle}</button>;
}

export default function ChatterActivities({
  itemCode,
  comments,
  activities,
  staff,
  currentUserCode,
}: {
  itemCode: string;
  comments: Comment[];
  activities: Activity[];
  staff: DeptStaff[];
  currentUserCode: string;
}) {
  const [, commentAction] = useActionState(addComment, initial);
  const [, delAction] = useActionState(deleteComment, initial);
  const [actState, activityAction] = useActionState(addActivity, initial);
  const [, toggleAction] = useActionState(toggleActivity, initial);
  const openCount = activities.filter((a) => a.status !== "done").length;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {/* Chatter */}
      <section className="rounded-xl glass p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-5">
        <h2 className="mb-3 text-sm font-bold text-slate-900 dark:text-white">ສົນທະນາ / ບັນທຶກ ({comments.length})</h2>
        <form action={commentAction} className="flex flex-col gap-2">
          <input type="hidden" name="item_code" value={itemCode} />
          <textarea name="body" rows={2} required placeholder="ຂຽນຂໍ້ຄວາມ..." className="w-full rounded-lg glass p-2.5 text-sm text-slate-900 outline-none transition focus:border-teal-400 dark:border-slate-700 dark:bg-slate-950 dark:text-white" />
          <div className="flex justify-end"><PostBtn idle="ໂພສ" /></div>
        </form>
        <div className="mt-3 space-y-3">
          {comments.length === 0 ? <p className="text-xs text-slate-400">ຍັງບໍ່ມີຂໍ້ຄວາມ</p> : comments.map((c) => (
            <div key={c.id} className="rounded-lg bg-slate-50 p-3 dark:bg-slate-950/40">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">{c.author}</p>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-400">{fmtDateTime(c.created_at)}</span>
                  {c.author_code === currentUserCode && (
                    <form action={delAction} className="inline">
                      <input type="hidden" name="id" value={c.id} />
                      <input type="hidden" name="item_code" value={itemCode} />
                      <button type="submit" aria-label="ລຶບ" className="text-slate-300 hover:text-red-600">✕</button>
                    </form>
                  )}
                </div>
              </div>
              <p className="mt-1 whitespace-pre-line text-sm text-slate-700 dark:text-slate-200">{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Activities */}
      <section className="rounded-xl glass p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-5">
        <h2 className="mb-3 text-sm font-bold text-slate-900 dark:text-white">ວຽກ / ຕິດຕາມ ({openCount} ຄ້າງ)</h2>
        <form action={activityAction} className="space-y-2">
          <input type="hidden" name="item_code" value={itemCode} />
          <input name="title" required placeholder="ຫົວຂໍ້ວຽກ (ເຊັ່ນ: ຕິດຕໍ່ຜູ້ສະໜອງ)" className="w-full rounded-lg glass px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-teal-400 dark:border-slate-700 dark:bg-slate-950 dark:text-white" />
          <div className="flex flex-wrap gap-2">
            <select name="assignee" className="min-h-9 flex-1 rounded-lg glass px-2 text-sm text-slate-900 outline-none focus:border-teal-400 dark:border-slate-700 dark:bg-slate-950 dark:text-white">
              <option value="">— ມອບໝາຍໃຫ້ (ບໍ່ບັງຄັບ) —</option>
              {staff.map((s) => <option key={s.employee_code} value={s.employee_code}>{s.fullname}</option>)}
            </select>
            <input type="date" name="due_date" className="min-h-9 rounded-lg glass px-2 text-sm text-slate-900 outline-none focus:border-teal-400 dark:border-slate-700 dark:bg-slate-950 dark:text-white" />
            <PostBtn idle="ເພີ່ມ" />
          </div>
          {actState.success && <p className="text-xs text-emerald-700 dark:text-emerald-400">{actState.success}</p>}
          {actState.error && <p className="text-xs text-red-600 dark:text-red-400">{actState.error}</p>}
        </form>
        <div className="mt-3 space-y-2">
          {activities.length === 0 ? <p className="text-xs text-slate-400">ຍັງບໍ່ມີວຽກ</p> : activities.map((a) => {
            const done = a.status === "done";
            const overdue = !done && a.due_date && a.due_date < new Date().toISOString().slice(0, 10);
            return (
              <div key={a.id} className={`flex items-start gap-2 rounded-lg border p-2.5 ${done ? "border-slate-100 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-950/30" : "border-slate-200 dark:border-slate-800"}`}>
                <form action={toggleAction} className="pt-0.5">
                  <input type="hidden" name="id" value={a.id} />
                  <input type="hidden" name="item_code" value={itemCode} />
                  <button type="submit" aria-label="toggle" className={`grid h-4 w-4 place-items-center rounded border text-[10px] ${done ? "border-teal-500 bg-teal-500 text-white" : "border-slate-300 text-transparent hover:border-teal-400 dark:border-slate-600"}`}>✓</button>
                </form>
                <div className="min-w-0 flex-1">
                  <p className={`text-sm ${done ? "text-slate-400 line-through" : "font-medium text-slate-800 dark:text-slate-200"}`}>{a.title}</p>
                  <div className="mt-0.5 flex flex-wrap gap-2 text-[10px] text-slate-400">
                    {a.assignee_name && <span>👤 {a.assignee_name}</span>}
                    {a.due_date && <span className={overdue ? "font-semibold text-red-500" : ""}>📅 {fmtDate(a.due_date)}{overdue ? " (ເກີນກຳນົດ)" : ""}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
