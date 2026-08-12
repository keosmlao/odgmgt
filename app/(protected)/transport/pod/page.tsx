"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FaBroadcastTower,
  FaCamera,
  FaCheckCircle,
  FaExclamationTriangle,
  FaExternalLinkAlt,
  FaFileSignature,
  FaHistory,
  FaMapMarkerAlt,
  FaSearch,
  FaSpinner,
} from "react-icons/fa";
// Copied from tms — only the data calls are swapped for the REST proxy, which
// forwards to TMS so the figures stay the ones TMS computes.
import api from "@/service/api";
import {
  StatusPageHeader,
  StatusStatGrid,
  StatusTableShell,
} from "@/components/status-page-shell";
import { PodLiveFeed } from "@/components/pod-live-feed";
import {
  PodProofDialog,
  ProofChipRow,
  podMapsUrl,
} from "@/components/pod-proof";
import { addDays, getLaoToday } from "@/lib/lao-date";
import {
  POD_PART_LABELS,
  POD_STATE_LABELS,
  podConditionLabel,
  podMissingParts,
  podPercent,
  podState,
  type PodDriverRow,
  type PodRow,
  type PodTotals,
} from "@/lib/pod";

const STATE_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "ທັງໝົດ" },
  { value: "incomplete", label: "POD ບໍ່ຄົບ" },
  { value: "none", label: "ບໍ່ມີຫຼັກຖານເລີຍ" },
  { value: "no_photo", label: "ຂາດຮູບ" },
  { value: "no_signature", label: "ຂາດລາຍເຊັນ" },
  { value: "no_gps", label: "ຂາດ GPS" },
  { value: "complete", label: "ຄົບແລ້ວ" },
];

const ROW_LIMIT = 300;

// GPS ຈຸດປິດບິນ ແລະ ຮູບຫຼາຍໃບ ຫາກໍເລີ່ມເກັບແຕ່ 05/2026 (ກ່ອນໜ້ານັ້ນ 0 ໃບ) —
// ເລືອກຊ່ວງກ່ອນວັນນີ້ແລ້ວຈະເຫັນ "ຂາດ GPS" ເຕັມໜ້າໂດຍບໍ່ແມ່ນຄວາມຜິດຄົນຂັບ.
const GPS_START = "2026-05-01";

export default function PodTrackingPage() {
  const [tab, setTab] = useState<"live" | "history">("live");
  const [from, setFrom] = useState(addDays(getLaoToday(), -7));
  const [to, setTo] = useState(getLaoToday());
  const [driver, setDriver] = useState("all");
  const [state, setState] = useState("all");
  const [search, setSearch] = useState("");
  const [requireSignature, setRequireSignature] = useState(false);
  const [rows, setRows] = useState<PodRow[]>([]);
  const [totals, setTotals] = useState<PodTotals | null>(null);
  const [byDriver, setByDriver] = useState<PodDriverRow[]>([]);
  const [drivers, setDrivers] = useState<{ code: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ bill: string; doc: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = (
        await api.get("/transport/logistics", {
          params: { report: "pod", fromDate: from, toDate: to, driver, state, search: search.trim(), limit: ROW_LIMIT, requireSignature },
        })
      ).data?.data as {
        rows: PodRow[];
        totals: PodTotals;
        by_driver: PodDriverRow[];
        drivers: { code: string; name: string }[];
      };
      setRows(data.rows ?? []);
      setTotals(data.totals ?? null);
      setByDriver(data.by_driver ?? []);
      setDrivers(data.drivers ?? []);
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : "ໂຫຼດບໍ່ສຳເລັດ");
    } finally {
      setLoading(false);
    }
  }, [from, to, driver, state, search, requireSignature]);

  // ໂຫຼດເທື່ອດຽວຕອນເປີດແທັບຍ້ອນຫຼັງ — ຫຼັງຈາກນັ້ນຜູ້ໃຊ້ກົດ "ເບິ່ງ" ເອງ
  useEffect(() => {
    if (tab === "history" && totals === null) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const stats = useMemo(() => {
    if (!totals) return [];
    return [
      {
        label: "ບິນສົ່ງສຳເລັດ",
        value: totals.bills,
        icon: <FaCheckCircle />,
        tone: "slate" as const,
      },
      {
        label: `POD ຄົບ (${podPercent(totals.complete, totals.bills)}%)`,
        value: totals.complete,
        icon: <FaCheckCircle />,
        tone: "emerald" as const,
      },
      {
        label: "ຂາດຮູບ",
        value: totals.missing_photo,
        icon: <FaCamera />,
        tone: "amber" as const,
      },
      {
        label: `ມີລາຍເຊັນ (${podPercent(totals.with_signature, totals.bills)}%)`,
        value: totals.with_signature,
        icon: <FaFileSignature />,
        tone: requireSignature ? ("orange" as const) : ("sky" as const),
      },
      {
        label: "ຂາດ GPS",
        value: totals.missing_gps,
        icon: <FaMapMarkerAlt />,
        tone: "rose" as const,
      },
    ];
  }, [totals, requireSignature]);

  const truncated = rows.length >= ROW_LIMIT;
  const beforeGps = from < GPS_START;

  return (
    <div className="space-y-5">
      <StatusPageHeader
        title="ຕິດຕາມ POD (ຫຼັກຖານການສົ່ງ)"
        subtitle="ຄົນຂັບປິດການຈັດສົ່ງແນວໃດ — ຮູບ · ລາຍເຊັນ · GPS ແບບສົດ ແລະ ຍ້ອນຫຼັງ"
        icon={<FaCamera />}
        tone="teal"
        aside={
          <div className="flex rounded-lg bg-slate-500/10 p-0.5">
            {(
              [
                ["live", "ສົດ", <FaBroadcastTower key="l" size={10} />],
                ["history", "ຍ້ອນຫຼັງ", <FaHistory key="h" size={10} />],
              ] as const
            ).map(([value, label, icon]) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  tab === value
                    ? "bg-white text-teal-700 shadow-sm dark:bg-slate-800 dark:text-teal-400"
                    : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                }`}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>
        }
      />

      <label className="flex w-fit cursor-pointer items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300">
        <input
          type="checkbox"
          checked={requireSignature}
          onChange={(e) => setRequireSignature(e.target.checked)}
          className="h-3.5 w-3.5 accent-teal-600"
        />
        ນັບ &quot;ລາຍເຊັນລູກຄ້າ&quot; ເປັນຫຼັກຖານບັງຄັບ
        <span className="text-slate-400">
          (ຄ່າເລີ່ມຕົ້ນ: ບໍ່ບັງຄັບ — ຍັງເກັບໄດ້ພຽງສ່ວນນ້ອຍ)
        </span>
      </label>

      {tab === "live" ? (
        <PodLiveFeed
          requireSignature={requireSignature}
          driver={driver}
          driverName={drivers.find((d) => d.code === driver)?.name ?? ""}
          onClearDriver={() => setDriver("all")}
        />
      ) : (
        <>
          <div className="glass flex flex-wrap items-end gap-3 rounded-lg p-4">
            <div>
              <label className="block text-[10px] font-semibold text-slate-500">ແຕ່ວັນ</label>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="glass-input mt-1 h-9 rounded-lg px-3 text-xs"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-500">ຫາວັນ</label>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="glass-input mt-1 h-9 rounded-lg px-3 text-xs"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-500">ຄົນຂັບ</label>
              <select
                value={driver}
                onChange={(e) => setDriver(e.target.value)}
                className="glass-input mt-1 h-9 rounded-lg px-3 text-xs"
              >
                <option value="all">ທັງໝົດ</option>
                {drivers.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-500">
                ສະຖານະ POD
              </label>
              <select
                value={state}
                onChange={(e) => setState(e.target.value)}
                className="glass-input mt-1 h-9 rounded-lg px-3 text-xs"
              >
                {STATE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-[160px] flex-1">
              <label className="block text-[10px] font-semibold text-slate-500">
                ຄົ້ນຫາ ເລກບິນ / ລູກຄ້າ
              </label>
              <div className="relative mt-1">
                <FaSearch
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  size={11}
                />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void load();
                  }}
                  placeholder="ເລກບິນ ຫຼື ຊື່ລູກຄ້າ"
                  className="glass-input h-9 w-full rounded-lg pl-8 pr-3 text-xs"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="h-9 rounded-lg bg-teal-700 px-4 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
            >
              {loading ? <FaSpinner className="animate-spin" /> : "ເບິ່ງ"}
            </button>
          </div>

          {error && <p className="text-[11px] text-rose-500">{error}</p>}

          <StatusStatGrid stats={stats} columns={5} />

          {totals && (
            <p className="text-[10px] leading-relaxed text-slate-500">
              ນັບສະເພາະບິນທີ່ <b>ປິດສຳເລັດ</b> ໃນຊ່ວງວັນທີ່ເລືອກ. ຮູບ ແລະ GPS ບັງຄັບທຸກບິນ
              {requireSignature ? (
                <>
                  , ແລະ ຕອນນີ້ນັບ <b>ລາຍເຊັນ</b> ບັງຄັບສະເພາະບິນສົ່ງເຖິງລູກຄ້າ (
                  {totals.to_customer_bills} ໃບ) — ບິນຝາກສາຂາ / ຂົນສົ່ງ / ລົດເມ ບໍ່ມີລູກຄ້າ
                  ຢູ່ບ່ອນນັ້ນໃຫ້ເຊັນ
                </>
              ) : (
                <>
                  {" "}
                  ສ່ວນລາຍເຊັນສະແດງໄວ້ເປັນຄວາມຄືບໜ້າເທົ່ານັ້ນ ຍັງບໍ່ນັບເປັນ POD ບໍ່ຄົບ
                </>
              )}
              .
              {totals.no_proof > 0 && (
                <>
                  {" "}
                  ມີ <b className="text-rose-500">{totals.no_proof}</b> ໃບທີ່ປິດໂດຍບໍ່ມີ
                  ຫຼັກຖານເລີຍ.
                </>
              )}
              {beforeGps && (
                <>
                  {" "}
                  <b className="text-amber-600">ໝາຍເຫດ:</b> ຮູບຫຼາຍໃບ ແລະ GPS ຈຸດປິດບິນ
                  ຫາກໍເລີ່ມເກັບແຕ່ 05/2026 — ບິນກ່ອນນັ້ນຈະຂຶ້ນວ່າຂາດ ໂດຍບໍ່ແມ່ນຄວາມຜິດຄົນຂັບ.
                </>
              )}
            </p>
          )}

          {byDriver.length > 0 && (
            <div className="glass rounded-lg p-4">
              <p className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                <FaExclamationTriangle className="text-amber-500" />
                ຄົນຂັບທີ່ຕ້ອງຕາມ POD
              </p>
              <div className="flex flex-wrap gap-2">
                {byDriver.map((d) => (
                  <button
                    key={d.driver_code || d.driver_name}
                    type="button"
                    onClick={() => {
                      setDriver(d.driver_code);
                      setState("incomplete");
                    }}
                    className="rounded-lg bg-slate-500/5 px-3 py-2 text-left transition-colors hover:bg-teal-500/10"
                    title="ກົດເພື່ອກັ່ນຕອງ ແລ້ວກົດ ເບິ່ງ"
                  >
                    <p className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                      {d.driver_name}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      ຂາດ{" "}
                      <span className="font-bold tabular-nums text-rose-500">
                        {d.incomplete}
                      </span>
                      /{d.bills} ໃບ
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )}

          <StatusTableShell
            count={rows.length}
            note={
              truncated
                ? `ສະແດງສູງສຸດ ${ROW_LIMIT} ລາຍການ — ແຄບຊ່ວງວັນ ຫຼື ກັ່ນຕອງເພີ່ມ`
                : "ຮຽງຈາກຂາດຫຼາຍສຸດ ໄປຫານ້ອຍສຸດ"
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[10px] uppercase tracking-wider text-slate-500 dark:border-slate-700">
                    <th className="whitespace-nowrap px-3 py-2">ເລກບິນ</th>
                    <th className="whitespace-nowrap px-3 py-2">ລູກຄ້າ</th>
                    <th className="whitespace-nowrap px-3 py-2">ຄົນຂັບ</th>
                    <th className="whitespace-nowrap px-3 py-2">ເງື່ອນໄຂ</th>
                    <th className="whitespace-nowrap px-3 py-2">ປິດບິນ</th>
                    <th className="whitespace-nowrap px-3 py-2">ຫຼັກຖານ</th>
                    <th className="whitespace-nowrap px-3 py-2">ສະຖານະ</th>
                    <th className="whitespace-nowrap px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-6 text-center text-slate-400">
                        {loading ? "ກຳລັງໂຫຼດ..." : "ບໍ່ມີບິນຕາມເງື່ອນໄຂທີ່ເລືອກ"}
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => {
                      const st = podState(row, row.delivery_condition, requireSignature);
                      const missing = podMissingParts(
                        row,
                        row.delivery_condition,
                        requireSignature
                      );
                      return (
                        <tr
                          key={`${row.doc_no}-${row.bill_no}`}
                          className="border-b border-slate-100 last:border-0 dark:border-slate-800"
                        >
                          <td className="whitespace-nowrap px-3 py-2 font-mono">
                            {row.bill_no}
                          </td>
                          <td className="px-3 py-2">
                            <span
                              className="block max-w-[180px] truncate"
                              title={row.cust_name}
                            >
                              {row.cust_name}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">{row.driver_name}</td>
                          <td className="whitespace-nowrap px-3 py-2 text-slate-500">
                            {podConditionLabel(row.delivery_condition)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-slate-500">
                            {row.closed_at || row.delivery_date}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            <ProofChipRow row={row} requireSignature={requireSignature} />
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                st === "complete"
                                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                  : st === "none"
                                    ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                                    : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                              }`}
                              title={
                                missing.length > 0
                                  ? `ຂາດ: ${missing
                                      .map((p) => POD_PART_LABELS[p])
                                      .join(", ")}`
                                  : undefined
                              }
                            >
                              {POD_STATE_LABELS[st]}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-right">
                            <button
                              type="button"
                              onClick={() =>
                                setOpen({ bill: row.bill_no, doc: row.doc_no })
                              }
                              className="rounded-lg bg-teal-500/10 px-2 py-1 text-[10px] font-semibold text-teal-700 hover:bg-teal-500/20 dark:text-teal-400"
                            >
                              ເບິ່ງຫຼັກຖານ
                            </button>
                            {row.lat_end && row.lng_end && (
                              <a
                                href={podMapsUrl(row.lat_end, row.lng_end)}
                                target="_blank"
                                rel="noreferrer"
                                className="ml-2 text-sky-600 hover:underline dark:text-sky-400"
                              >
                                ແຜນທີ່ <FaExternalLinkAlt className="inline" size={8} />
                              </a>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </StatusTableShell>
        </>
      )}

      {open && (
        <PodProofDialog
          billNo={open.bill}
          docNo={open.doc}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
