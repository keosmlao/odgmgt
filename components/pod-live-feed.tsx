"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FaCamera,
  FaExternalLinkAlt,
  FaImages,
  FaPause,
  FaPlay,
  FaSpinner,
} from "react-icons/fa";
// Copied from tms/src/components/pod-live-feed.tsx — data call swapped for the
// REST proxy that forwards to TMS.
import api from "@/service/api";
import {
  PodProofDialog,
  ProofChipRow,
  ProofImage,
  fetchPodProof,
  podMapsUrl,
} from "@/components/pod-proof";
import {
  POD_PART_LABELS,
  podAgoLabel,
  podConditionLabel,
  podMissingParts,
  podState,
  type PodLiveRow,
  type PodProof,
} from "@/lib/pod";

const POLL_MS = 15_000;
// ສະແດງ 10 ລາຍການລ່າສຸດ — ຮູບໂຫຼດໃຫ້ຄົບທຸກໃບທີ່ເຫັນ (ໃບໜຶ່ງ 100–400 KB ແລະ
// cache ໄວ້ຕໍ່ບິນ ຈຶ່ງໂຫຼດເທື່ອດຽວ ບໍ່ແມ່ນທຸກຮອບ poll)
const FEED_LIMIT = 10;
const THUMBS_PER_CARD = 3;

// ຟີດນີ້ແມ່ນ "ສົດ" ຢ່າງດຽວ — ບໍ່ມີຕົວເລືອກຍ້ອນຫຼັງ (ອັນນັ້ນຢູ່ແທັບຍ້ອນຫຼັງແລ້ວ).
// 12 ຊົ່ວໂມງພໍກັບໜຶ່ງມື້ເຮັດວຽກ ຈຶ່ງເຫັນຄົບຕັ້ງແຕ່ຖ້ຽວເຊົ້າ.
const LIVE_WINDOW_MINUTES = 720;

export function PodLiveFeed({
  requireSignature,
  driver = "all",
  driverName = "",
  onClearDriver,
}: {
  requireSignature: boolean;
  /** ຮັບຕໍ່ຈາກຕົວກັ່ນຕອງຂອງແທັບຍ້ອນຫຼັງ ເພື່ອບໍ່ໃຫ້ 2 ແທັບບອກຄົນລະເລື່ອງ */
  driver?: string;
  driverName?: string;
  onClearDriver?: () => void;
}) {
  const [rows, setRows] = useState<PodLiveRow[]>([]);
  const [live, setLive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [open, setOpen] = useState<{ bill: string; doc: string } | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, PodProof | "loading">>({});

  // ບິນທີ່ເຄີຍເຫັນແລ້ວ — ໃບທີ່ບໍ່ຢູ່ໃນນີ້ຄືໃບທີ່ຫາກໍເຂົ້າມາ ຈຶ່ງໄຮໄລ້ໃຫ້ເຫັນ
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const data = (
        await api.get("/transport/logistics", {
          params: {
            report: "pod-live",
            minutes: LIVE_WINDOW_MINUTES,
            limit: FEED_LIMIT,
            driver,
            requireSignature: requireSignature ? 1 : 0,
          },
        })
      ).data?.data as { rows: PodLiveRow[] };
      const next = data.rows ?? [];
      setRows(next);
      setFetchedAt(new Date());
      setError(null);

      const keys = new Set(next.map((r) => `${r.doc_no}|${r.bill_no}`));
      if (seen.current === null) {
        seen.current = keys; // ຮອບທຳອິດ — ບໍ່ມີຫຍັງ "ໃໝ່"
      } else {
        const arrived = [...keys].filter((k) => !seen.current!.has(k));
        seen.current = keys;
        if (arrived.length > 0) setFresh(new Set(arrived));
      }
    } catch (e) {
      console.error("[pod-live] load failed:", e);
      setError(e instanceof Error ? e.message : "ໂຫຼດບໍ່ສຳເລັດ");
    } finally {
      setLoading(false);
    }
  }, [driver, requireSignature]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // ໄຮໄລ້ "ໃໝ່" ຢູ່ພຽງໄລຍະໜຶ່ງ — ບໍ່ດັ່ງນັ້ນໃບເກົ່າຈະຄາຂອບຂຽວຢູ່ຈົນກວ່າຈະມີໃບໃໝ່
  useEffect(() => {
    if (fresh.size === 0) return;
    const id = window.setTimeout(() => setFresh(new Set()), 60_000);
    return () => window.clearTimeout(id);
  }, [fresh]);

  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => {
      // ບໍ່ຕ້ອງ poll ຕອນຜູ້ໃຊ້ບໍ່ໄດ້ເບິ່ງ — ປະຢັດທັງ DB ແລະ ແບັດມືຖື
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [live, load]);

  // ໂຫຼດຮູບໃຫ້ໃບໃໝ່ສຸດ (ໃບອື່ນກົດເອົາເອງ)
  useEffect(() => {
    for (const row of rows) {
      const key = `${row.doc_no}|${row.bill_no}`;
      if (!row.has_photo || thumbs[key]) continue;
      setThumbs((t) => ({ ...t, [key]: "loading" }));
      void fetchPodProof(row.bill_no, row.doc_no)
        .then((proof) => {
          if (proof) setThumbs((t) => ({ ...t, [key]: proof }));
        })
        .catch(() =>
          setThumbs((t) => {
            const next = { ...t };
            delete next[key];
            return next;
          })
        );
    }
  }, [rows, thumbs]);

  const loadThumbs = (row: PodLiveRow) => {
    const key = `${row.doc_no}|${row.bill_no}`;
    if (thumbs[key]) return;
    setThumbs((t) => ({ ...t, [key]: "loading" }));
    void fetchPodProof(row.bill_no, row.doc_no).then((proof) => {
      if (proof) setThumbs((t) => ({ ...t, [key]: proof }));
    });
  };

  const elapsed = (row: PodLiveRow) =>
    row.closed_seconds_ago +
    (fetchedAt ? (Date.now() - fetchedAt.getTime()) / 1000 : 0);

  return (
    <div className="space-y-4">
      <div className="glass flex flex-wrap items-center gap-3 rounded-lg p-3">
        <span className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              live ? "animate-pulse bg-emerald-500" : "bg-slate-400"
            }`}
          />
          {live ? "ກຳລັງຕິດຕາມສົດ" : "ຢຸດຊົ່ວຄາວ"}
        </span>
        <button
          type="button"
          onClick={() => setLive((v) => !v)}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-slate-500/10 px-3 text-[11px] font-semibold text-slate-600 hover:bg-slate-500/20 dark:text-slate-300"
        >
          {live ? <FaPause size={9} /> : <FaPlay size={9} />}
          {live ? "ຢຸດ" : "ຕໍ່"}
        </button>
        {driver !== "all" && (
          <button
            type="button"
            onClick={onClearDriver}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-teal-500/10 px-3 text-[11px] font-semibold text-teal-700 hover:bg-teal-500/20 dark:text-teal-400"
            title="ເອົາຕົວກັ່ນຕອງຄົນຂັບອອກ"
          >
            ສະເພາະ {driverName || driver} ✕
          </button>
        )}
        <span className="text-[10px] text-slate-400">
          {loading ? (
            <>
              <FaSpinner className="mr-1 inline animate-spin" />
              ກຳລັງໂຫຼດ...
            </>
          ) : (
            <>
              {rows.length} ລາຍການລ່າສຸດ · ອັບເດດ{" "}
              {fetchedAt?.toLocaleTimeString("lo-LA", { hour12: false }) ?? "—"}
              {live && ` · ທຸກ ${POLL_MS / 1000} ວິ`}
            </>
          )}
        </span>
      </div>

      {error && <p className="text-[11px] text-rose-500">{error}</p>}

      <div className="glass overflow-hidden rounded-lg">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-left text-[10px] uppercase tracking-wider text-slate-500 dark:border-slate-700">
                <th className="whitespace-nowrap px-3 py-2">ປິດເມື່ອ</th>
                <th className="whitespace-nowrap px-3 py-2">ເລກບິນ</th>
                <th className="whitespace-nowrap px-3 py-2">ລູກຄ້າ</th>
                <th className="whitespace-nowrap px-3 py-2">ຄົນຂັບ / ລົດ</th>
                <th className="whitespace-nowrap px-3 py-2">ຮູບທີ່ຖ່າຍ</th>
                <th className="whitespace-nowrap px-3 py-2">ຫຼັກຖານ</th>
                <th className="whitespace-nowrap px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-slate-400">
                    {loading ? "ກຳລັງໂຫຼດ..." : "ຍັງບໍ່ມີບິນທີ່ປິດໃນຊ່ວງເວລານີ້"}
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const key = `${row.doc_no}|${row.bill_no}`;
                  const st = podState(row, row.delivery_condition, requireSignature);
                  const missing = podMissingParts(
                    row,
                    row.delivery_condition,
                    requireSignature
                  );
                  const proof = thumbs[key];
                  const images =
                    proof && proof !== "loading"
                      ? [
                          ...(proof.delivery_images ?? []).map((src, i) => ({
                            src,
                            label: `ຮູບ ${i + 1}`,
                          })),
                          ...(proof.url_img
                            ? [{ src: proof.url_img, label: "ຮູບຫຼັກ" }]
                            : []),
                          ...(proof.sight_img
                            ? [{ src: proof.sight_img, label: "ລາຍເຊັນ" }]
                            : []),
                        ].slice(0, THUMBS_PER_CARD)
                      : [];

                  return (
                    <tr
                      key={key}
                      className={`border-b border-slate-100 last:border-0 dark:border-slate-800 ${
                        fresh.has(key) ? "bg-emerald-500/5" : ""
                      }`}
                    >
                      <td className="whitespace-nowrap px-3 py-2">
                        <span className="font-semibold text-slate-700 dark:text-slate-200">
                          {podAgoLabel(elapsed(row))}
                        </span>
                        <span className="block text-[10px] text-slate-400">
                          {row.closed_at}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono">
                        {row.bill_no}
                        {fresh.has(key) && (
                          <span className="ml-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-600 dark:text-emerald-400">
                            ໃໝ່
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className="block max-w-[200px] truncate"
                          title={row.cust_name}
                        >
                          {row.cust_name}
                        </span>
                        <span className="block text-[10px] text-slate-400">
                          {podConditionLabel(row.delivery_condition)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {row.driver_name}
                        <span className="block text-[10px] text-slate-400">
                          {row.car_name}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {images.length > 0 ? (
                          <div className="flex gap-1.5">
                            {images.map((img) => (
                              <ProofImage
                                key={img.label}
                                src={img.src}
                                label={img.label}
                                size="h-14 w-14"
                              />
                            ))}
                          </div>
                        ) : proof === "loading" ? (
                          <span className="text-[10px] text-slate-400">
                            <FaSpinner className="mr-1 inline animate-spin" />
                            ກຳລັງໂຫຼດ...
                          </span>
                        ) : row.has_photo ? (
                          <button
                            type="button"
                            onClick={() => loadThumbs(row)}
                            className="flex items-center gap-1.5 rounded-lg bg-slate-500/10 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-500/20 dark:text-slate-300"
                          >
                            <FaImages size={9} /> ເບິ່ງຮູບ {row.photo_count || ""}
                          </button>
                        ) : (
                          <span className="flex items-center gap-1 whitespace-nowrap text-[10px] text-rose-500">
                            <FaCamera size={9} /> ບໍ່ໄດ້ຖ່າຍຮູບ
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        <ProofChipRow row={row} requireSignature={requireSignature} />
                        <span
                          className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                            st === "complete"
                              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                              : st === "none"
                                ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                                : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                          }`}
                        >
                          {st === "complete"
                            ? "ຫຼັກຖານຄົບ"
                            : `ຂາດ ${missing.map((p) => POD_PART_LABELS[p]).join(", ")}`}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => setOpen({ bill: row.bill_no, doc: row.doc_no })}
                          className="rounded-lg bg-teal-500/10 px-2 py-1 text-[10px] font-semibold text-teal-700 hover:bg-teal-500/20 dark:text-teal-400"
                        >
                          ລາຍລະອຽດ
                        </button>
                        {row.lat_end && row.lng_end && (
                          <a
                            href={podMapsUrl(row.lat_end, row.lng_end)}
                            target="_blank"
                            rel="noreferrer"
                            className="ml-2 text-[10px] text-sky-600 hover:underline dark:text-sky-400"
                          >
                            ແຜນທີ່ <FaExternalLinkAlt className="inline" size={7} />
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
      </div>

      {open && (
        <PodProofDialog billNo={open.bill} docNo={open.doc} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}
