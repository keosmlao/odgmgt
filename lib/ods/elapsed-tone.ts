// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
/**
 * ສີເຕືອນຕາມເວລາທີ່ຄ້າງ — ໃຊ້ໄດ້ທັງ server ແລະ client component.
 * (ແຍກອອກຈາກ components/elapsed.tsx ເພາະໄຟລ໌ນັ້ນເປັນ "use client"
 *  ຈຶ່ງເອີ້ນຟັງຊັນຂອງມັນຈາກ server component ບໍ່ໄດ້)
 */
export function elapsedTone(seconds: number | null) {
  if (seconds == null) return { chip: "bg-slate-100 text-slate-500", bar: "bg-slate-200" };
  const days = seconds / 86400;
  if (days >= 30) return { chip: "bg-brand-orange-700 text-white", bar: "bg-brand-orange-700" };
  if (days >= 7) return { chip: "bg-brand-orange-100 text-brand-orange-700", bar: "bg-brand-orange-400" };
  if (days >= 3) return { chip: "bg-brand-orange-300 text-brand-900", bar: "bg-brand-orange-300" };
  return { chip: "bg-slate-100 text-slate-600", bar: "bg-slate-200" };
}
