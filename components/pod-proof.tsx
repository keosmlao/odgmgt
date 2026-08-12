"use client";

import { useEffect, useState } from "react";
import { FaExternalLinkAlt, FaSpinner, FaTimes } from "react-icons/fa";
// Copied from tms/src/components/pod-proof.tsx — data call swapped for the REST
// proxy that forwards to TMS.
import api from "@/service/api";
import {
  POD_PART_LABELS,
  podConditionLabel,
  podProofImages,
  type PodProof,
  type PodRow,
} from "@/lib/pod";

export const podMapsUrl = (lat: string, lng: string) =>
  `https://www.google.com/maps?q=${lat},${lng}`;

const num = (v: string | number | null | undefined) => Number(v ?? 0);

// ຫຼັກຖານໜຶ່ງບິນໜັກ 100–400 KB (base64 ຢູ່ DB). ຟີດສົດ poll ທຸກ 15 ວິນາທີ ຈຶ່ງ
// ຕ້ອງ cache ໄວ້ຕໍ່ບິນ ບໍ່ດັ່ງນັ້ນຮູບເກົ່າຈະຖືກດຶງຄືນທຸກຮອບ. ເກັບເປັນ Promise
// ເພື່ອບໍ່ໃຫ້ການຮ້ອງພ້ອມກັນ 2 ບ່ອນ (card + dialog) ກາຍເປັນ 2 request.
const proofCache = new Map<string, Promise<PodProof | null>>();

export function fetchPodProof(billNo: string, docNo: string): Promise<PodProof | null> {
  const key = `${docNo}|${billNo}`;
  const hit = proofCache.get(key);
  if (hit) return hit;
  const p = (api
    .get("/transport/logistics", { params: { report: "pod-proof", bill: billNo, doc: docNo } })
    .then((r) => (r.data?.data ?? null) as PodProof | null)).catch(
    (e) => {
      proofCache.delete(key); // ລົ້ມແລ້ວໃຫ້ລອງໃໝ່ໄດ້
      throw e;
    }
  );
  proofCache.set(key, p);
  return p;
}

/** ທຸງ ມີ/ບໍ່ມີ — ສີແດງສະເພາະອັນທີ່ "ບັງຄັບ" ແລ້ວຂາດ. */
export function ProofChip({
  label,
  has,
  required,
  count,
}: {
  label: string;
  has: boolean;
  required: boolean;
  count?: number;
}) {
  const tone = has
    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
    : required
      ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
      : "bg-slate-500/10 text-slate-400";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${tone}`}
      title={required ? "ບັງຄັບ" : "ບໍ່ບັງຄັບ"}
    >
      {has ? "✓" : "✕"} {label}
      {has && count !== undefined && count > 1 && (
        <span className="tabular-nums opacity-70">×{count}</span>
      )}
    </span>
  );
}

/** ທຸງ 3 ອັນ (ຮູບ · ລາຍເຊັນ · GPS) ຂອງແຖວໜຶ່ງ. */
export function ProofChipRow({
  row,
  requireSignature,
}: {
  row: PodRow;
  requireSignature: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      <ProofChip
        label={POD_PART_LABELS.photo}
        has={row.has_photo}
        required
        count={row.photo_count}
      />
      <ProofChip
        label={POD_PART_LABELS.signature}
        has={row.has_signature}
        required={requireSignature && row.delivery_condition === "to_customer"}
      />
      <ProofChip label={POD_PART_LABELS.gps} has={row.has_gps} required />
    </div>
  );
}

export function ProofImage({
  src,
  label,
  size = "h-24 w-24",
}: {
  src: string;
  label: string;
  size?: string;
}) {
  const [zoom, setZoom] = useState(false);
  if (!src) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setZoom(true)}
        className={`group relative ${size} shrink-0 overflow-hidden rounded-lg border border-white/20 bg-white/30 transition-all hover:ring-2 hover:ring-emerald-400 dark:border-white/5 dark:bg-white/10`}
        title={label}
      >
        {/* ຮູບເປັນ base64 ຈາກ DB — next/image ຊ່ວຍຫຍັງບໍ່ໄດ້ */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={label} className="h-full w-full object-cover" />
        <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1 py-0.5 text-center text-[9px] font-semibold text-white">
          {label}
        </span>
      </button>
      {zoom && (
        <div
          className="fixed inset-0 z-[60] flex cursor-zoom-out items-center justify-center bg-black/85 p-4"
          onClick={() => setZoom(false)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={label}
            className="max-h-[90vh] max-w-full rounded-lg object-contain"
          />
        </div>
      )}
    </>
  );
}

/** ໜ້າຕ່າງຫຼັກຖານເຕັມຂອງບິນດຽວ. */
export function PodProofDialog({
  billNo,
  docNo,
  onClose,
}: {
  billNo: string;
  docNo: string;
  onClose: () => void;
}) {
  const [proof, setProof] = useState<PodProof | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void fetchPodProof(billNo, docNo)
      .then((data) => {
        if (alive) setProof(data);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : "ໂຫຼດຫຼັກຖານບໍ່ສຳເລັດ");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [billNo, docNo]);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  const images = proof ? podProofImages(proof) : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="glass mt-10 w-full max-w-3xl rounded-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-mono text-base font-bold text-slate-800 dark:text-white">
              {billNo}
            </h2>
            <p className="text-xs text-slate-500">
              {proof ? `${proof.cust_name} · ${proof.driver_name}` : "ກຳລັງໂຫຼດ..."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 hover:bg-slate-500/10"
            aria-label="ປິດ"
          >
            <FaTimes />
          </button>
        </div>

        {loading && (
          <p className="py-8 text-center text-xs text-slate-400">
            <FaSpinner className="mr-2 inline animate-spin" />
            ກຳລັງໂຫຼດຫຼັກຖານ...
          </p>
        )}
        {error && <p className="py-4 text-xs text-rose-500">{error}</p>}
        {!loading && !error && !proof && (
          <p className="py-8 text-center text-xs text-slate-400">ບໍ່ພົບບິນນີ້</p>
        )}

        {proof && (
          <>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] sm:grid-cols-3">
              {(
                [
                  ["ວັນຈັດສົ່ງ", proof.delivery_date || proof.doc_date],
                  ["ໃບງານ", proof.doc_no],
                  ["ເງື່ອນໄຂ", podConditionLabel(proof.delivery_condition)],
                  ["ລົດ", proof.car_name],
                  ["ສາຂາ", proof.transport_name || "—"],
                  ["ເບີໂທ", proof.telephone || "—"],
                  ["ເລີ່ມສົ່ງ", proof.started_at || "—"],
                  ["ຮອດຈຸດສົ່ງ", proof.checkin_at || "—"],
                  ["ປິດບິນ", proof.closed_at || "—"],
                  [
                    "ຈຳນວນ",
                    `ສົ່ງ ${num(proof.delivered_qty)} / ຈັດ ${num(proof.selected_qty)}${
                      num(proof.returned_qty) > 0 ? ` · ຄືນ ${num(proof.returned_qty)}` : ""
                    }`,
                  ],
                  [
                    "ເກັບເງິນ",
                    num(proof.collected_amount) > 0
                      ? `${num(proof.collected_amount).toLocaleString()} ກີບ`
                      : "—",
                  ],
                ] as [string, string][]
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[10px] uppercase tracking-wider text-slate-400">
                    {label}
                  </dt>
                  <dd className="text-slate-700 dark:text-slate-200">{value}</dd>
                </div>
              ))}
            </dl>

            {proof.remark && (
              <p className="mt-3 rounded-lg bg-slate-500/5 p-2 text-[11px] text-slate-600 dark:text-slate-300">
                ໝາຍເຫດ: {proof.remark}
              </p>
            )}

            <div className="mt-4">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                ຮູບ &amp; ລາຍເຊັນ ({images.length})
              </p>
              {images.length === 0 ? (
                <p className="rounded-lg bg-rose-500/5 p-3 text-[11px] text-rose-500">
                  ບິນນີ້ປິດໂດຍບໍ່ມີຮູບ ຫຼື ລາຍເຊັນເລີຍ
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {images.map((img) => (
                    <ProofImage key={img.src.slice(0, 64)} {...img} />
                  ))}
                </div>
              )}
            </div>

            <div className="mt-4 text-[11px]">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                ຈຸດທີ່ກົດສຳເລັດ
              </p>
              {proof.lat_end && proof.lng_end ? (
                <a
                  href={podMapsUrl(proof.lat_end, proof.lng_end)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sky-600 hover:underline dark:text-sky-400"
                >
                  {proof.lat_end}, {proof.lng_end}{" "}
                  <FaExternalLinkAlt className="inline" size={8} />
                </a>
              ) : (
                <span className="text-rose-500">ບໍ່ມີ GPS</span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
