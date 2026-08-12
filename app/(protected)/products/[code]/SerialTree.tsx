"use client";

import { useState } from "react";
import type { Serial, SerialWarehouse } from "@/lib/pm/products";

export default function SerialTree({
  warehouses,
  serials,
}: {
  warehouses: SerialWarehouse[];
  serials: Serial[];
}) {
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    warehouses.length > 0 ? { [warehouses[0].wh_code]: true } : {},
  );

  const byWh: Record<string, Serial[]> = {};
  for (const s of serials) {
    (byWh[s.wh_code] ??= []).push(s);
  }

  return (
    <div className="space-y-2">
      {warehouses.map((wh) => {
        const isOpen = open[wh.wh_code];
        const rows = byWh[wh.wh_code] ?? [];
        return (
          <div key={wh.wh_code} className="rounded-xl border border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={() => setOpen((o) => ({ ...o, [wh.wh_code]: !o[wh.wh_code] }))}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
            >
              <span className="flex items-center gap-2">
                <span className={`text-slate-400 transition ${isOpen ? "rotate-90" : ""}`}>▶</span>
                <span className="font-medium text-slate-900 dark:text-white">
                  {wh.wh_name || wh.wh_code || "ບໍ່ລະບຸສາງ"}
                </span>
                <span className="font-mono text-xs text-slate-400">{wh.wh_code}</span>
              </span>
              <span className="flex items-center gap-2 text-xs">
                <span className="rounded-full bg-green-100 px-2 py-0.5 text-green-700 dark:bg-green-950 dark:text-green-300">
                  ໃນສາງ {wh.in_stock.toLocaleString("en-US")}
                </span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  ທັງໝົດ {wh.total.toLocaleString("en-US")}
                </span>
              </span>
            </button>

            {isOpen && (
              <div className="overflow-x-auto border-t border-slate-100 dark:border-slate-800">
                <table className="w-full min-w-[1240px] text-xs">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                      <th className="px-4 py-2 font-medium">ISN</th>
                      <th className="px-4 py-2 font-medium">SN</th>
                      <th className="px-4 py-2 font-medium">Rack</th>
                      <th className="px-4 py-2 font-medium">Location</th>
                      <th className="px-4 py-2 text-right font-medium">ອາຍຸ (ວັນ)</th>
                      <th className="px-4 py-2 font-medium">ໃບຮັບເຂົ້າ</th>
                      <th className="px-4 py-2 font-medium">PO</th>
                      <th className="px-4 py-2 font-medium">ໃບຊື້</th>
                      <th className="px-4 py-2 text-right font-medium">ລາຄາຊື້</th>
                      <th className="px-4 py-2 font-medium">ຕຳນິ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s, i) => (
                      <tr key={`${s.serial_no}-${i}`} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="px-4 py-2 font-mono text-xs text-slate-800 dark:text-slate-200">{s.isn || "-"}</td>
                        <td className="px-4 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">{s.serial_no}</td>
                        <td className="px-4 py-2">
                          <span className="block font-medium text-slate-700 dark:text-slate-200">{s.rack_name || "-"}</span>
                          <span className="block font-mono text-xs text-slate-400">{s.rack || "-"}</span>
                        </td>
                        <td className="px-4 py-2">
                          <span className="block font-medium text-slate-700 dark:text-slate-200">{s.location_name || "-"}</span>
                          <span className="block font-mono text-xs text-slate-400">{s.location || "-"}</span>
                        </td>
                        <td className="px-4 py-2 text-right text-slate-600 dark:text-slate-400">
                          {s.age_days != null ? s.age_days.toLocaleString("en-US") : "-"}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                          {s.receipt_doc || <span className="font-sans text-slate-400">ບໍ່ພົບເອກະສານ</span>}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                          {s.po_no || <span className="font-sans text-slate-400">ບໍ່ໄດ້ຜູກ PO</span>}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                          {s.purchase_doc || <span className="font-sans text-slate-400">ບໍ່ພົບ PUIH</span>}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-right font-semibold text-slate-800 dark:text-slate-200">
                          {s.purchase_price
                            ? `${s.purchase_currency === "02" ? "₭" : "฿"} ${Number(s.purchase_price).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
                            : <span className="font-normal text-slate-400">ບໍ່ພົບລາຄາ PUIH</span>}
                        </td>
                        <td className="px-4 py-2">
                          {s.defect ? (
                            <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                              {s.defect}
                            </span>
                          ) : (
                            <span className="text-xs text-slate-400">ບໍ່ມີຕຳນິ</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {rows.length < wh.total && (
                      <tr>
                        <td colSpan={10} className="px-4 py-2 text-xs text-slate-400">
                          ສະແດງ {rows.length} / {wh.total.toLocaleString("en-US")} (ໂຫຼດຈຳກັດ)
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
