"use client";

import { useEffect, useState } from "react";
// Copied from tms. The volume figure is computed in TMS (item dimensions,
// vehicle cargo space) and read through the REST proxy, so both apps show the
// same number.
import api from "@/service/api";


// ແຖບພື້ນທີ່ບັນທຸກແບບເຕັມ — ໃຊ້ຮ່ວມກັນທັງໜ້າຮ່າງຖ້ຽວ ແລະ ໜ້າຖ້ຽວຈິງ
// ເພື່ອໃຫ້ dispatcher ເຫັນຮູບແບບດຽວກັນທຸກບ່ອນ.

export interface VolumeSlice {
  key: string;
  label: string;
  m3: number;
  pctOfTruck: number | null;
  pctOfTrip: number;
  lines: number;
  linesUnknown: number;
}

export interface TripVolumeInfo {
  car: string;
  m3Remaining: number;
  remainingPct: number | null;
  deliveredPct: number | null;
  freeM3: number | null;
  byBill: VolumeSlice[];
  m3: number;
  m3Low: number;
  m3High: number;
  estimatedM3: number;
  kg: number | null;
  lines: number;
  linesKnown: number;
  linesEstimated: number;
  linesUnknown: number;
  coveragePct: number;
  capacityM3: number | null;
  usableM3: number | null;
  utilizationPct: number | null;
  weightPct: number | null;
  overloaded: boolean;
  dataSufficient: boolean;
  capacitySource: string;
  longestItemM: number | null;
  cargoLengthM: number | null;
  lengthFits: boolean;
  unknownItems?: Array<{ itemCode: string; itemName: string; unitCode: string; qty: number }>;
}

/** ຕາຕະລາງແຈກແຈງພື້ນທີ່ — ໃຊ້ຮ່ວມກັນລະຫວ່າງ "ຕາມບິນ" ແລະ "ຕາມໝວດ" */
export function VolumeSlices({
  slices,
  hasTruck,
}: {
  slices: VolumeSlice[];
  hasTruck: boolean;
}) {
  if (!slices?.length) return null;
  const max = Math.max(...slices.map((s) => s.pctOfTrip), 1);
  return (
    <div>
      <table className="w-full text-[10px]">
        <tbody>
          {slices.slice(0, 12).map((s) => (
            <tr key={s.key}>
              <td className="w-11 py-0.5 pr-1 text-right font-bold tabular-nums text-slate-700 dark:text-slate-200">
                {hasTruck ? `${(s.pctOfTruck ?? 0).toFixed(1)}%` : `${s.pctOfTrip.toFixed(0)}%`}
              </td>
              <td className="w-14 py-0.5 pr-1.5">
                {/* ແທ່ງທຽບກັນເອງ ບອກໄວວ່າອັນໃດກິນທີ່ຫຼາຍສຸດ */}
                <div className="h-1.5 w-full rounded-full bg-slate-500/10">
                  <div
                    className="h-full rounded-full bg-teal-500/70"
                    style={{ width: `${(s.pctOfTrip / max) * 100}%` }}
                  />
                </div>
              </td>
              <td className="w-12 py-0.5 pr-1.5 text-right tabular-nums text-slate-400">
                {s.m3.toFixed(2)}
              </td>
              <td className="truncate py-0.5 text-slate-600 dark:text-slate-300" title={s.label}>
                {s.label}
                {s.linesUnknown > 0 && (
                  <span
                    className="ml-1 text-amber-600 dark:text-amber-400"
                    title={`${s.linesUnknown} ລາຍການບໍ່ຮູ້ຂະໜາດ — ຄ່ານີ້ຕໍ່າກວ່າຄວາມຈິງ`}
                  >
                    −{s.linesUnknown}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {slices.length > 12 && (
        <p className="text-[9px] text-slate-400">ແລະ ອີກ {slices.length - 12} ລາຍການ</p>
      )}
    </div>
  );
}

/**
 * ແຖບພື້ນທີ່ບັນທຸກ.
 *
 * ສະແດງ m³ ສະເໝີ (ໃຊ້ທຽບຖ້ຽວຕໍ່ຖ້ຽວໄດ້ເລີຍ) ແຕ່ສະແດງ % ຈຸລົດ ແລະ ຄຳເຕືອນ
 * ບັນທຸກເກີນ ສະເພາະເມື່ອຂໍ້ມູນພໍ — ບອກ "ຂໍ້ມູນບໍ່ພໍ" ດີກວ່າໃຫ້ຄົນເຫັນລົດຫວ່າງ
 * ແລ້ວບັນທຸກເພີ່ມຍ້ອນລາຍການທີ່ບໍ່ຮູ້ຂະໜາດ.
 */
export function TripLoadStrip({ v }: { v: TripVolumeInfo }) {
  const pct = v.utilizationPct;
  const barPct = pct === null ? 0 : Math.min(pct, 100);
  const tone =
    pct === null
      ? "bg-slate-400"
      : pct > 100
        ? "bg-rose-500"
        : pct > 85
          ? "bg-amber-500"
          : "bg-emerald-500";

  return (
    <div className="rounded border border-slate-200 bg-white px-2.5 py-2 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[11px] font-bold text-slate-800 dark:text-slate-100">
          {v.estimatedM3 > 0
            ? `${v.m3Low.toFixed(1)}–${v.m3High.toFixed(1)} m³`
            : `${v.m3.toFixed(2)} m³`}
        </span>
        {v.kg !== null && v.kg > 0 && (
          <span className="text-[10px] text-slate-500">{Math.round(v.kg).toLocaleString()} kg</span>
        )}
        {v.usableM3 !== null && v.usableM3 > 0 && (
          <span className="text-[10px] text-slate-400">/ ຈຸ {v.usableM3.toFixed(1)} m³</span>
        )}
        {/* ພື້ນທີ່ວ່າງ — ຕົວເລກທີ່ຕ້ອງການແທ້ຕອນຕັດສິນວ່າຈະໃສ່ບິນຕື່ມ ຫຼື ເປີດຖ້ຽວໃໝ່ */}
        {v.freeM3 !== null && (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
              v.freeM3 < 1
                ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                : v.freeM3 < 3
                  ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            }`}
          >
            ວ່າງ {v.freeM3.toFixed(1)} m³
            {v.freeM3 < 1 && " — ເກືອບເຕັມ"}
          </span>
        )}
        <span className="ml-auto text-[11px] font-bold tabular-nums">
          {pct === null ? (
            <span
              className={!v.car ? "text-amber-600 dark:text-amber-400" : "text-slate-400"}
              title={
                !v.car
                  ? "ເລືອກລົດຢູ່ຂ້າງລຸ່ມ ຈຶ່ງຈະຮູ້ວ່າເຕັມຫຼືຍັງ — ບໍ່ຈຳເປັນຕອນນີ້ ແຕ່ຕ້ອງມີກ່ອນກົດ ພ້ອມອອກ"
                  : v.usableM3
                    ? "ຮູ້ຂະໜາດສິນຄ້າບໍ່ພໍ"
                    : "ລົດຄັນນີ້ຍັງບໍ່ໄດ້ວັດຕູ້"
              }
            >
              {!v.car
                ? "ເລືອກລົດເພື່ອເຫັນ %"
                : v.usableM3
                  ? "ຂໍ້ມູນບໍ່ພໍ"
                  : "ລົດຍັງບໍ່ມີຄວາມຈຸ"}
            </span>
          ) : (
            <span
              className={
                pct > 100
                  ? "text-rose-600 dark:text-rose-400"
                  : pct > 85
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-emerald-600 dark:text-emerald-400"
              }
            >
              {pct.toFixed(0)}% ຂອງລົດ
            </span>
          )}
        </span>
      </div>

      {pct !== null && (
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-500/10">
          <div className={`h-full ${tone}`} style={{ width: `${barPct}%` }} />
        </div>
      )}

      {v.deliveredPct !== null && v.deliveredPct > 0 && (
        <p className="mt-1 flex flex-wrap items-baseline gap-x-2 whitespace-nowrap text-[10px]">
          <span className="font-bold text-sky-700 dark:text-sky-400">
            ຍັງຢູ່ເທິງລົດ
            {v.remainingPct !== null ? ` ${v.remainingPct.toFixed(0)}%` : ""}
          </span>
          <span className="tabular-nums text-slate-400">{v.m3Remaining.toFixed(2)} m³</span>
          <span className="text-emerald-600 dark:text-emerald-400">
            ສົ່ງລົງແລ້ວ {v.deliveredPct.toFixed(0)}%
          </span>
        </p>
      )}

      <p className="mt-1.5 text-[9px] leading-relaxed text-slate-400">
        ຄິດຈາກ {v.linesKnown + v.linesEstimated}/{v.lines} ລາຍການ
        {v.linesEstimated > 0 && ` · ຄາດຄະເນ ${v.linesEstimated}`}
        {v.linesUnknown > 0 && (
          <span className="text-amber-600 dark:text-amber-400">
            {" "}
            · ບໍ່ຮູ້ຂະໜາດ {v.linesUnknown}
          </span>
        )}
        {v.capacitySource === "default" && " · ຄວາມຈຸລົດເປັນຄ່າຄາດຄະເນ"}
      </p>

      {v.overloaded && (
        <p className="mt-1 rounded bg-rose-500/10 px-2 py-1 text-[10px] font-bold text-rose-600 dark:text-rose-400">
          ⚠️ ເກີນຄວາມຈຸລົດ {(v.utilizationPct! - 100).toFixed(0)}% — ຄວນແຍກຖ້ຽວ
        </p>
      )}

      {!v.lengthFits && (
        <p className="mt-1 rounded bg-rose-500/10 px-2 py-1 text-[10px] font-bold text-rose-600 dark:text-rose-400">
          ⚠️ ຂອງຍາວ {v.longestItemM} m ແຕ່ຕູ້ຍາວ {v.cargoLengthM} m — ໃສ່ບໍ່ເຂົ້າ
        </p>
      )}

      {(v.byBill?.length ?? 0) > 0 && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[10px] font-semibold text-slate-500">
            ແຈກແຈງຕາມບິນ
          </summary>
          <div className="mt-1.5">
            <VolumeSlices slices={v.byBill} hasTruck={v.usableM3 !== null} />
          </div>
        </details>
      )}

      {/* ຂໍ້ມູນອາດມາຈາກຫຼາຍ action — ຢ່າຖືວ່າຊ່ອງນີ້ມີສະເໝີ ບໍ່ດັ່ງນັ້ນ
          ໜ້າທັງໜ້າລົ້ມ (ເຄີຍລົ້ມມາແລ້ວ: unknownItems ເປັນ undefined) */}
      {v.linesUnknown > 0 && (v.unknownItems?.length ?? 0) > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[9px] text-slate-400">
            ເບິ່ງລາຍການທີ່ຍັງບໍ່ຮູ້ຂະໜາດ
          </summary>
          <ul className="mt-1 space-y-0.5">
            {(v.unknownItems ?? []).slice(0, 8).map((u) => (
              <li key={u.itemCode} className="truncate text-[9px] text-slate-500">
                <span className="tabular-nums text-slate-400">{u.qty}</span> {u.itemName}
              </li>
            ))}
            {(v.unknownItems?.length ?? 0) > 8 && (
              <li className="text-[9px] text-slate-400">
                ແລະ ອີກ {(v.unknownItems?.length ?? 0) - 8} ລາຍການ
              </li>
            )}
          </ul>
        </details>
      )}
    </div>
  );
}


/**
 * ແຖບພື້ນທີ່ບັນທຸກ ສຳລັບ "ຖ້ຽວທີ່ສົ່ງແລ້ວ" — ດຶງລາຍລະອຽດເມື່ອຂະຫຍາຍແຖວ.
 *
 * ໃຊ້ຮູບແບບດຽວກັບໜ້າຮ່າງຖ້ຽວ (ລວມການແຈກແຈງຕາມບິນ) ເພື່ອໃຫ້ຄົນອ່ານຄືກັນ
 * ທຸກໜ້າ ບໍ່ຕ້ອງຮຽນສອງແບບ.
 */
export function TripLoadPanel({ docNo }: { docNo: string }) {
  const [v, setV] = useState<TripVolumeInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void api
      .get("/transport/trip-volume", { params: { doc: docNo } })
      .then((r) => r.data?.data ?? null)
      .then((data) => alive && setV(data as TripVolumeInfo | null))
      .catch((e) => {
        console.error("getTripVolume", docNo, e);
        if (alive) setError(String((e as Error)?.message ?? e));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [docNo]);

  if (loading) {
    return (
      <p className="rounded border border-slate-200 px-2.5 py-2 text-[10px] text-slate-400 dark:border-slate-800">
        ກຳລັງຄິດພື້ນທີ່ບັນທຸກ...
      </p>
    );
  }
  if (error) {
    return (
      <p className="rounded border border-rose-300 bg-rose-500/5 px-2.5 py-2 text-[10px] text-rose-600 dark:border-rose-800 dark:text-rose-400">
        ຄິດພື້ນທີ່ບັນທຸກບໍ່ໄດ້: {error}
      </p>
    );
  }
  return v ? <TripLoadStrip v={v} /> : null;
}

/**
 * ພື້ນທີ່ບັນທຸກແບບຢູ່ໃນແຖວດຽວ — ສຳລັບຫົວແຖວຖ້ຽວທີ່ຍັງບໍ່ຂະຫຍາຍ.
 *
 * ບອກ 3 ຢ່າງທີ່ຕັດສິນໃຈໄດ້ທັນທີ: ເຕັມປານໃດ · ວ່າງເທົ່າໃດ · ເຊື່ອຖືໄດ້ບໍ.
 * ລາຍລະອຽດທີ່ເຫຼືອລໍໃຫ້ກົດຂະຫຍາຍ.
 */
export function TripLoadInline({ v }: { v?: TripVolumeInfo | { __error: string } | null }) {
  if (!v) return <span className="shrink-0 text-[10px] text-slate-300">…</span>;
  if ("__error" in v) {
    return (
      <span className="shrink-0 text-[10px] text-rose-500" title={v.__error}>
        ຄິດບໍ່ໄດ້
      </span>
    );
  }

  const pct = v.utilizationPct;
  if (pct === null) {
    return (
      <span
        className="shrink-0 whitespace-nowrap text-[10px] text-slate-400"
        title={
          !v.car
            ? "ຍັງບໍ່ເລືອກລົດ"
            : v.usableM3 === null
              ? "ລົດຄັນນີ້ຍັງບໍ່ໄດ້ວັດຕູ້"
              : `ຮູ້ຂະໜາດພຽງ ${v.coveragePct.toFixed(0)}% ຂອງລາຍການ`
        }
      >
        {v.m3.toFixed(1)} m³ · ຂໍ້ມູນບໍ່ພໍ
      </span>
    );
  }

  const tone =
    pct > 100 ? "bg-rose-500" : pct > 85 ? "bg-amber-500" : "bg-emerald-500";
  const text =
    pct > 100
      ? "text-rose-600 dark:text-rose-400"
      : pct > 85
        ? "text-amber-600 dark:text-amber-400"
        : "text-emerald-600 dark:text-emerald-400";

  return (
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-500/15">
        <span className={`block h-full ${tone}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </span>
      <span className={`text-[11px] font-bold tabular-nums ${text}`}>{pct.toFixed(0)}%</span>
      {v.freeM3 !== null && (
        <span
          className={`text-[10px] tabular-nums ${
            v.freeM3 < 1 ? "font-bold text-rose-600 dark:text-rose-400" : "text-slate-400"
          }`}
        >
          ວ່າງ {v.freeM3.toFixed(1)}
        </span>
      )}
      {!v.lengthFits && (
        <span title="ຂອງຍາວກວ່າຕູ້ລົດ" className="text-[10px] text-rose-500">
          ⚠
        </span>
      )}
    </span>
  );
}
