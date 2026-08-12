// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
"use client";
import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback } from "react";

/**
 * **ປຸ່ມກັບຄືນ — ກັບໄປໜ້າທີ່ມາຈິງ**.
 *
 * ── ບັນຫາທີ່ແກ້ ──
 * ໜ້າລາຍລະອຽດແຕ່ລະໜ້າມີລິ້ງກັບຄືນ **ຝັງໄວ້ຕາຍຕົວ** (ເຊັ່ນ "ກັບຄິວກຳລັງສ້ອມ") ⇒ ຄົນທີ່ເຂົ້າມາ
 * ຈາກໜ້າອື່ນ (ຄິວອື່ນ · ຄົ້ນຫາ · ແຈ້ງເຕືອນ · ໜ້າອາໄຫຼ່) ກົດກັບຄືນແລ້ວ **ໄປໂຜ່ບ່ອນອື່ນ**
 * ແລ້ວຕ້ອງໄລ່ຫາບ່ອນເກົ່າຄືນເອງ.
 *
 * ອັນນີ້ໃຊ້ປະຫວັດຂອງ browser (`router.back()`) ⇒ ກັບໄປໜ້າທີ່ມາຈິງສະເໝີ.
 * ເປີດລິ້ງກົງ/ແທັບໃໝ່ (ບໍ່ມີປະຫວັດ) ⇒ ຕົກໄປໜ້າ `fallback` ຄືເກົ່າ.
 */
export function BackLink({ fallback, label }: { fallback: string; label: string }) {
  const router = useRouter();
  /** ອ່ານປະຫວັດ **ຕອນກົດ** (ບໍ່ແມ່ນຕອນ render) ⇒ ບໍ່ຕ້ອງ setState ໃນ effect */
  const goBack = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push(fallback);
  }, [router, fallback]);

  return (
    <button
      type="button"
      onClick={goBack}
      className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium text-brand-700 hover:underline"
    >
      <ArrowLeft className="size-3.5" />
      {label}
    </button>
  );
}
