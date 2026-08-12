// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
"use client";
import { useRouter } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";

/**
 * ແຖວຕາຕະລາງທີ່ **ກົດບ່ອນໃດກໍໄດ້ → ໄປໜ້າ detail** — ໃຫ້ທຸກຕາຕະລາງມີພຶດຕິກຳຄືກັນ.
 *
 * ກົດໃສ່ ລິ້ງ/ປຸ່ມ/ຊ່ອງກรອກ ພາຍໃນແຖວ (ເຊັ່ນ ປຸ່ມ modal ຈັດຊ່າງ, ລິ້ງ code) ຈະ **ບໍ່**
 * navigate — ໃຫ້ອົງປະກອບນັ້ນເຮັດໜ້າທີ່ຂອງມັນເອງ. ໝາຍ `data-no-nav` ໃສ່ cell ໃດກໍໄດ້
 * ທີ່ຢາກໃຫ້ກົດແລ້ວບໍ່ໄປໜ້າ detail.
 *
 * ຮອງຮັບກົດກາງ/Ctrl+ກົດ (ເປີດແທັບໃໝ່) ຄືລິ້ງທຳມະດາ.
 */
export function RowLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const router = useRouter();

  const navigate = (event: MouseEvent<HTMLTableRowElement>) => {
    if ((event.target as HTMLElement).closest("a,button,input,select,textarea,label,[data-no-nav]")) return;
    // ກົດກາງ ຫຼື Ctrl/⌘+ກົດ = ເປີດແທັບໃໝ່
    if (event.metaKey || event.ctrlKey || event.button === 1) {
      window.open(href, "_blank");
      return;
    }
    router.push(href);
  };

  return (
    <tr
      onClick={navigate}
      onAuxClick={(event) => event.button === 1 && navigate(event)}
      className={`cursor-pointer ${className}`}
    >
      {children}
    </tr>
  );
}
