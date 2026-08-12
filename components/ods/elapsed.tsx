// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
"use client";
import { useEffect, useState } from "react";

/**
 * ເວລາທີ່ຄ້າງຢູ່ຂັ້ນນີ້ — ເດີນທຸກວິນາທີ.
 *
 * ຮັບເປັນ "ຈຳນວນວິນາທີ" ຈາກ server ແລ້ວນັບຕໍ່ຢູ່ browser
 * (ບໍ່ສົ່ງເປັນວັນທີ ຈຶ່ງບໍ່ມີບັນຫາເຂດເວລາ ຫຼື hydration ບໍ່ຕົງກັນ).
 */

function format(totalSeconds: number) {
  const seconds = Math.max(0, totalSeconds);
  const days = Math.floor(seconds / 86400);
  const rest = seconds % 86400;
  const clock = [Math.floor(rest / 3600), Math.floor((rest % 3600) / 60), rest % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  return days > 0 ? `${days} ມື້ ${clock}` : clock;
}

/** ນັບຂຶ້ນເລື້ອຍໆ — ເລີ່ມຈາກຄ່າທີ່ server ສົ່ງມາ */
function Ticker({ from, className }: { from: number; className: string }) {
  const [value, setValue] = useState(from);

  useEffect(() => {
    const timer = setInterval(() => setValue((current) => current + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <span className={`tabular-nums ${className}`} suppressHydrationWarning>
      {format(value)}
    </span>
  );
}

/**
 * `live=false` = **ຄ່າຄົງທີ່** (ຂັ້ນທີ່ຜ່ານໄປແລ້ວ) ⇒ ບໍ່ເດີນ.
 * ຂັ້ນທີ່ຈົບໄປແລ້ວແຕ່ຕົວເລກຍັງແລ່ນ ເຮັດໃຫ້ອ່ານຜິດວ່າມັນຍັງຄ້າງຢູ່.
 */
export function Elapsed({
  seconds,
  className = "",
  live = true,
}: {
  seconds: number | null;
  className?: string;
  live?: boolean;
}) {
  if (seconds == null) return <span className={className}>-</span>;
  if (!live) return <span className={`tabular-nums ${className}`}>{format(seconds)}</span>;
  // key = ຄ່າຈາກ server → ໂຫຼດຂໍ້ມູນໃໝ່ແລ້ວຕົວນັບເລີ່ມຈາກຄ່າໃໝ່
  return <Ticker key={seconds} from={seconds} className={className} />;
}
