// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
"use client";
import { LoaderCircle } from "lucide-react";
import { useLinkStatus } from "next/link";

/**
 * ວົງກົມໝູນ ທີ່ຂຶ້ນຢູ່ໃນປຸ່ມທີ່ຫາກໍກົດ ຈົນກວ່າໜ້າໃໝ່ຈະໂຫຼດເສັດ.
 * ຕ້ອງວາງໄວ້ຂ້າງໃນ <Link> ຈຶ່ງໃຊ້ໄດ້ (useLinkStatus ອ່ານສະຖານະຈາກ Link ແມ່).
 */
export function LinkPending({ className = "size-4" }: { className?: string }) {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return <LoaderCircle aria-label="ກຳລັງໂຫຼດ" className={`animate-spin ${className}`} />;
}
