"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { TripLoadCell, useTripVolumes } from "@/components/trip-load-cell";
import { TripLoadPanel } from "@/components/trip-load-strip";
import Link from "@/components/tms-link";
import {
  FaBoxOpen,
  FaBroadcastTower,
  FaCheckCircle,
  FaChevronDown,
  FaChevronRight,
  FaClock,
  FaMapMarkerAlt,
  FaPrint,
  FaRoute,
  FaSearch,
  FaSpinner,
  FaTimesCircle,
  FaTrash,
  FaTruckMoving,
} from "react-icons/fa";
// Copied from tms — read calls go through the REST proxy to TMS; the two
// operational actions (delete a trip, move a bill) stay in TMS, where the
// operator has their own session.
import api from "@/service/api";
import { runInTms } from "@/lib/tms-actions";
import { useConfirm } from "@/components/confirm-dialog";
import { StatusPageHeader, StatusStatGrid } from "@/components/status-page-shell";
import { WhatsappLink, buildBillWhatsappMessage } from "@/components/whatsapp-link";
// Ported from server actions: getBillsWaitingSentDetails, deleteJob, getJobBillsWithProducts

function ImageThumb({ src, label }: { src: string; label: string }) {
  const [open, setOpen] = useState(false);
  if (!src) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group relative h-10 w-10 overflow-hidden rounded-lg border border-white/20 dark:border-white/5 bg-white/30 dark:bg-white/10 hover:ring-2 hover:ring-sky-400 transition-all shrink-0"
        title={label}
      >
        <img src={src} alt={label} className="h-full w-full object-cover" />
        <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent text-[8px] font-semibold text-white px-1 py-0.5 text-center">
          {label}
        </span>
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 cursor-zoom-out"
          onClick={() => setOpen(false)}
        >
          <img src={src} alt={label} className="max-w-full max-h-[90vh] object-contain rounded-lg" />
        </div>
      )}
    </>
  );
}

function collectDeliveryImages(detail: {
  url_img?: string;
  sight_img?: string;
  recipt_img?: string;
  recipt_sign_img?: string;
  delivery_images?: string[];
}): Array<{ src: string; label: string }> {
  const out: Array<{ src: string; label: string }> = [];
  const seen = new Set<string>();
  const push = (src: string | undefined | null, label: string) => {
    if (!src) return;
    if (seen.has(src)) return;
    seen.add(src);
    out.push({ src, label });
  };
  if (Array.isArray(detail.delivery_images)) {
    detail.delivery_images.forEach((src, i) => push(src, `ຮູບ ${i + 1}`));
  }
  push(detail.recipt_img, "ຮູບຮັບເຄື່ອງ");
  push(detail.recipt_sign_img, "ລາຍເຊັນຮັບເຄື່ອງ");
  push(detail.url_img, "ຮູບຫຼັກ");
  push(detail.sight_img, "ລາຍເຊັນ");
  return out;
}

export interface InProgressJob {
  doc_date: string;
  doc_no: string;
  date_logistic: string;
  created_at: string;
  active_sent_start: string;
  active_sent_start_raw: string | null;
  car: string;
  driver: string;
  item_bill: number;
  user_created: string;
  approve_user: string;
  waiting_bill_count: number;
  inprogress_bill_count: number;
  completed_bill_count: number;
  cancelled_bill_count: number;
  miles_start: string;
  lat_start: string;
  lng_start: string;
  current_lat: string;
  current_lng: string;
  current_location_time: string;
  transport_name: string;
}

export interface InProgressBillDetail {
  bill_no: string;
  bill_date: string;
  customer: string;
  cust_area?: string;
  telephone: string;
  count_item: number;
  recipt_job: string;
  sent_start: string;
  sent_end: string;
  remark: string;
  bill_status: string;
  phase: string;
  partial_delivery?: boolean;
  remaining_qty_total?: number | string;
  delivered_qty_total?: number | string;
  url_img?: string;
  sight_img?: string;
  delivery_images?: string[];
  forward_transport_code?: string;
  forward_transport_name?: string;
  delivery_condition?: string;
}

// Mandatory per-bill delivery condition (ເງື່ອນໄຂການຈັດສົ່ງ), mirroring the
// options offered on jobs/add. Kept in sync with DELIVERY_CONDITIONS there.
const DELIVERY_CONDITION_LABELS: Record<string, string> = {
  to_customer: "ສົ່ງລູກຄ້າ",
  to_branch: "ສົ່ງສາຂາ",
  to_carrier: "ສົ່ງຂົນສົ່ງ",
  to_bus: "ຝາກລົດເມ",
};

function getDeliveryConditionStyle(code: string) {
  switch (code) {
    case "to_customer":
      return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    case "to_branch":
      return "bg-sky-500/10 text-sky-600 dark:text-sky-400";
    case "to_carrier":
      return "bg-violet-500/10 text-violet-600 dark:text-violet-400";
    case "to_bus":
      return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
    default:
      return "bg-slate-500/10 text-slate-600 dark:text-slate-400";
  }
}

// Resolve the condition to show: prefer the stored value, else infer from a
// forward branch (older bills predate the column), else default to to_customer.
function resolveDeliveryCondition(detail: InProgressBillDetail): string {
  if (detail.delivery_condition) return detail.delivery_condition;
  if (detail.forward_transport_code) return "to_branch";
  return "to_customer";
}

interface Product {
  item_code: string;
  item_name: string;
  qty: number;
  unit_code: string;
}

interface BillWithProducts {
  bill_no: string;
  bill_date: string;
  cust_code: string;
  cust_name: string;
  count_item: number;
  telephone: string;
  products: Product[];
}

interface BillsInProgressClientProps {
  initialJobs?: InProgressJob[];
}

function toNumber(value: number | string | null | undefined) {
  return Number(value ?? 0);
}

function formatDuration(isoString: string | null, now: Date): string {
  if (!isoString) return "-";
  
  const startDate = new Date(isoString);
  const diffMs = now.getTime() - startDate.getTime();
  
  if (diffMs < 0) return "-";
  
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
  
  if (hours > 0) {
    return `${hours}ຊ ${minutes}ນ ${seconds}ວ`;
  }
  if (minutes > 0) {
    return `${minutes}ນ ${seconds}ວ`;
  }
  return `${seconds}ວ`;
}

function LiveDuration({ startTime }: { startTime: string | null }) {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    if (!startTime) return;
    
    const interval = setInterval(() => {
      setNow(new Date());
    }, 1000);
    
    return () => clearInterval(interval);
  }, [startTime]);

  return (
    <span className="text-[11px] text-amber-600 font-medium font-mono">
      {formatDuration(startTime, now)}
    </span>
  );
}

function parseDDMMYYYYHHMM(dateStr: string): Date | null {
  const match = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, dd, mm, yyyy, hh, mi] = match;
  return new Date(+yyyy, +mm - 1, +dd, +hh, +mi);
}

function formatElapsed(diffMs: number): string {
  if (diffMs < 0) return "-";
  const totalSeconds = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (days > 0) {
    return `${days}ມື້ ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function ElapsedTimer({ createdAt }: { createdAt: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const created = parseDDMMYYYYHHMM(createdAt);
  if (!created) return <span>-</span>;

  const diffMs = now - created.getTime();

  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-600 dark:text-sky-400 text-[10px] font-mono font-semibold tabular-nums">
      <FaClock size={8} className="animate-pulse" />
      {formatElapsed(diffMs)}
    </span>
  );
}

function getBillPhaseStyle(phase: string) {
  switch (phase) {
    case "inprogress":
      return "bg-sky-500/10 text-sky-600 dark:text-sky-400";
    case "done":
      return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    case "partial":
      return "bg-orange-500/10 text-orange-600 dark:text-orange-400";
    case "forwarded":
      return "bg-sky-500/10 text-sky-600 dark:text-sky-400";
    case "cancel":
      return "bg-rose-500/10 text-rose-600 dark:text-rose-400";
    default:
      return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
  }
}

function sortDetails(details: InProgressBillDetail[]) {
  const order: Record<string, number> = {
    inprogress: 0,
    waiting: 1,
    done: 2,
    cancel: 3,
  };

  return [...details].sort((a, b) => {
    const phaseDiff = (order[a.phase] ?? 99) - (order[b.phase] ?? 99);
    if (phaseDiff !== 0) return phaseDiff;
    return a.bill_no.localeCompare(b.bill_no);
  });
}

export default function BillsInProgressClient({
  initialJobs = [],
}: BillsInProgressClientProps) {
  const [jobs, setJobs] = useState<InProgressJob[]>(initialJobs);
  const confirm = useConfirm();
  const [searchText, setSearchText] = useState("");
  const [selectedTransport, setSelectedTransport] = useState<string>("all");
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null);
  const [detailsByDoc, setDetailsByDoc] = useState<
    Record<string, InProgressBillDetail[]>
  >({});
  const [loadingDoc, setLoadingDoc] = useState<string | null>(null);
  const [billsWithProducts, setBillsWithProducts] = useState<
    Record<string, BillWithProducts[]>
  >({});
  const [deletingDoc, setDeletingDoc] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // "ແກ້ເປັນສົ່ງສາຂາ" — re-classify a still-in-delivery to_customer stop as a
  // branch forward, the same correction the completed page already allows.
  const [branches, setBranches] = useState<{ code: string; name_1: string }[]>([]);
  const [reclassifyKey, setReclassifyKey] = useState<string | null>(null);
  const [reclassifyBranch, setReclassifyBranch] = useState("");
  const [reclassifyBusy, setReclassifyBusy] = useState(false);
  const perPage = 20;

  const fetchJobs = () => {
    setLoading(true);
    setLoadError(null);
    void api.get("/transport/bills", { params: { list: "in-progress" } }).then((r) => r.data?.data)
      .then((data) => setJobs((data ?? []) as InProgressJob[]))
      .catch((e: any) => {
        console.error(e);
        setLoadError(e?.response?.data?.error ?? e?.message ?? "Unknown error");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchJobs();
  }, []);

  useEffect(() => {
    void api.get("/transport/bills", { params: { list: "branches" } }).then((r) => r.data?.data)
      .then((data) => setBranches((data ?? []) as { code: string; name_1: string }[]))
      .catch(() => setBranches([]));
  }, []);

  const refreshDetails = async (docNo: string) => {
    try {
      const details = (await api.get("/transport/bills", { params: { list: "details", doc: 
        docNo
       } }).then((r) => r.data?.data)) as InProgressBillDetail[];
      setDetailsByDoc((current) => ({ ...current, [docNo]: sortDetails(details) }));
    } catch (error) {
      console.error(error);
    }
  };

  const handleReclassify = async (docNo: string, billNo: string) => {
    if (!reclassifyBranch) {
      void confirm({ title: "ກະລຸນາເລືອກສາຂາ", message: "ເລືອກສາຂາປາຍທາງກ່ອນ", tone: "warning", single: true });
      return;
    }
    const branch = branches.find((b) => b.code === reclassifyBranch);
    const ok = await confirm({
      title: "ແກ້ເປັນສົ່ງສາຂາ",
      message: `ປ່ຽນບິນ ${billNo} ຈາກ 'ສົ່ງລູກຄ້າ' ເປັນ 'ສົ່ງສາຂາ → ${branch?.name_1 ?? reclassifyBranch}' ໂດຍໃຊ້ຂໍ້ມູນເດີມ? ບິນຈະຖືກປິດການສົ່ງໃນຖ້ຽວນີ້ ແລະກັບເຂົ້າຄິວຂອງສາຂາປາຍທາງເພື່ອຈັດສົ່ງຕໍ່ຫາລູກຄ້າ.`,
      tone: "warning",
      confirmLabel: "ປ່ຽນ",
    });
    if (!ok) return;
    setReclassifyBusy(true);
    try {
      await runInTms(`/bills-inprogress`, "ຍ້າຍສາຂາຕ້ອງເຮັດຢູ່ TMS — ເປີດ TMS ບໍ?");
      setReclassifyKey(null);
      setReclassifyBranch("");
      // The bill left this trip's active queue, so refresh both the expanded
      // detail rows and the job-list counts (the trip may even fall off here).
      await refreshDetails(docNo);
      fetchJobs();
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : "ປ່ຽນບໍ່ສຳເລັດ";
      void confirm({ title: "ຜິດພາດ", message, tone: "warning", single: true });
    } finally {
      setReclassifyBusy(false);
    }
  };

  const transportOptions = useMemo(() => {
    const transports = new Set<string>();
    jobs.forEach((job) => {
      if (job.transport_name && job.transport_name !== "-") {
        transports.add(job.transport_name);
      }
    });
    return Array.from(transports).sort();
  }, [jobs]);

  const filteredJobs = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();

    let result = jobs;

    if (selectedTransport !== "all") {
      result = result.filter((job) => job.transport_name === selectedTransport);
    }

    if (!keyword) {
      return result;
    }

    return result.filter((job) =>
      [
        job.doc_no,
        job.doc_date,
        job.date_logistic,
        job.active_sent_start,
        job.car,
        job.driver,
        job.user_created,
        job.approve_user,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(keyword)
    );
  }, [jobs, searchText, selectedTransport]);

  const summary = useMemo(() => {
    return filteredJobs.reduce(
      (result, job) => {
        result.jobs += 1;
        result.inprogress += toNumber(job.inprogress_bill_count);
        result.waiting += toNumber(job.waiting_bill_count);
        result.completed += toNumber(job.completed_bill_count);
        result.cancelled += toNumber(job.cancelled_bill_count);
        return result;
      },
      { jobs: 0, inprogress: 0, waiting: 0, completed: 0, cancelled: 0 }
    );
  }, [filteredJobs]);

  const totalPages = Math.max(1, Math.ceil(filteredJobs.length / perPage));
  const pagedJobs = filteredJobs.slice(
    (currentPage - 1) * perPage,
    currentPage * perPage
  );

  // % ພື້ນທີ່ບັນທຸກ — ດຶງເປັນກ້ອນດຽວຕໍ່ໜ້າ
  const { volumes, failed: volumesFailed } = useTripVolumes(pagedJobs.map((j) => j.doc_no));

  const handleDelete = async (docNo: string) => {
    if (!await confirm({ title: "ລຶບຖ້ຽວ", message: `ຕ້ອງການລົບຖ້ຽວ ${docNo} ແທ້ບໍ?`, tone: "danger", confirmLabel: "ລຶບ" })) return;

    setDeletingDoc(docNo);
    try {
      await runInTms(`/jobs`, "ລຶບຖ້ຽວຕ້ອງເຮັດຢູ່ TMS — ເປີດ TMS ບໍ?");
      setJobs((current) => current.filter((job) => job.doc_no !== docNo));
      if (expandedDoc === docNo) setExpandedDoc(null);
    } catch (error) {
      console.error(error);
      void confirm({ title: "ຜິດພາດ", message: "ລຶບບໍ່ສຳເລັດ", tone: "warning", single: true });
    } finally {
      setDeletingDoc(null);
    }
  };

  const toggleDetails = async (docNo: string) => {
    if (expandedDoc === docNo) {
      setExpandedDoc(null);
      return;
    }

    setExpandedDoc(docNo);

    if (detailsByDoc[docNo]) {
      return;
    }

    setLoadingDoc(docNo);
    try {
      const [details, products] = await Promise.all([
        api.get("/transport/bills", { params: { list: "details", doc: docNo } }).then((r) => r.data?.data) as Promise<InProgressBillDetail[]>,
        api.get("/transport/bills", { params: { list: "job-products", doc: docNo } }).then((r) => r.data?.data) as Promise<BillWithProducts[]>,
      ]);
      setDetailsByDoc((current) => ({
        ...current,
        [docNo]: sortDetails(details),
      }));
      setBillsWithProducts((current) => ({
        ...current,
        [docNo]: products,
      }));
    } catch (error) {
      console.error(error);
      setDetailsByDoc((current) => ({
        ...current,
        [docNo]: [],
      }));
    } finally {
      setLoadingDoc(null);
    }
  };

  return (
    <div className="space-y-5">
      <StatusPageHeader
        title="ກຳລັງຈັດສົ່ງ"
        subtitle="ຖ້ຽວທີ່ເລີ່ມຈັດສົ່ງແລ້ວ ແລະຍັງມີບິນທີ່ກຳລັງດຳເນີນການ"
        icon={<FaTruckMoving />}
        tone="sky"
      />

      <StatusStatGrid
        columns={5}
        stats={[
          { label: "ຖ້ຽວດຳເນີນການ", value: summary.jobs, icon: <FaTruckMoving />, tone: "slate" },
          { label: "ບິນກຳລັງສົ່ງ", value: summary.inprogress, icon: <FaRoute />, tone: "sky" },
          { label: "ບິນລໍຖ້າຕໍ່", value: summary.waiting, icon: <FaClock />, tone: "amber" },
          { label: "ບິນສົ່ງແລ້ວ", value: summary.completed, icon: <FaCheckCircle />, tone: "emerald" },
          { label: "ບິນຍົກເລີກ", value: summary.cancelled, icon: <FaTimesCircle />, tone: "rose" },
        ]}
      />

      {transportOptions.length > 0 && (
        <div className="glass rounded-lg p-3">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                setSelectedTransport("all");
                setCurrentPage(1);
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                selectedTransport === "all"
                  ? "glass-heavy glow-primary text-teal-600 dark:text-teal-400"
                  : "bg-white/30 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:bg-white/50 dark:hover:bg-white/10"
              }`}
            >
              ທັງໝົດ
            </button>
            {transportOptions.map((transport) => (
              <button
                key={transport}
                onClick={() => {
                  setSelectedTransport(transport);
                  setCurrentPage(1);
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  selectedTransport === transport
                    ? "bg-sky-600 text-white"
                    : "bg-sky-500/10 text-sky-600 dark:text-sky-400 hover:bg-sky-500/20"
                }`}
              >
                {transport}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="glass rounded-lg p-4">
        <div className="max-w-md">
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1.5">
            <FaSearch className="inline mr-1.5 text-slate-400" size={11} />
            ຄົ້ນຫາ
          </label>
          <input
            type="text"
            value={searchText}
            onChange={(event) => {
              setSearchText(event.target.value);
              setCurrentPage(1);
            }}
            placeholder="ຄົ້ນຫາເລກຖ້ຽວ, ລົດ, ຄົນຂັບ..."
            className="w-full px-3 py-2 glass-input rounded-lg text-xs text-slate-700 dark:text-slate-200 transition-all"
          />
        </div>
      </div>

      <div className="glass rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200/30 dark:border-white/5 flex items-center justify-between">
          <p className="text-xs text-slate-500">
            ພົບ <span className="font-semibold text-slate-700">{filteredJobs.length}</span> ລາຍການ
          </p>
          <p className="text-[11px] text-slate-400">ສະເພາະຂໍ້ມູນປີ 2026</p>
        </div>

        {loading ? (
          <div className="py-14 text-center">
            <div className="w-14 h-14 mx-auto rounded-lg bg-slate-500/10 flex items-center justify-center mb-3 animate-pulse">
              <FaBoxOpen className="text-slate-400 dark:text-slate-500 text-xl" />
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400">ກຳລັງໂຫຼດ...</p>
          </div>
        ) : loadError ? (
          <div className="py-14 text-center">
            <div className="w-14 h-14 mx-auto rounded-lg bg-red-500/10 flex items-center justify-center mb-3">
              <FaBoxOpen className="text-red-400 text-xl" />
            </div>
            <p className="text-sm text-red-600 dark:text-red-400">ໂຫຼດຂໍ້ມູນບໍ່ສຳເລັດ: {loadError}</p>
          </div>
        ) : filteredJobs.length === 0 ? (
          <div className="py-14 text-center">
            <div className="w-14 h-14 mx-auto rounded-lg bg-slate-500/10 flex items-center justify-center mb-3">
              <FaBoxOpen className="text-slate-400 dark:text-slate-500 text-xl" />
            </div>
            <p className="text-sm text-slate-500">
              {searchText.trim() ? "ບໍ່ພົບຂໍ້ມູນຕາມຄໍາຄົ້ນຫາ" : "ບໍ່ມີຖ້ຽວກຳລັງຈັດສົ່ງ"}
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-white/30 dark:bg-white/5 border-b border-slate-200/30 dark:border-white/5">
                    <th className="px-4 py-3 whitespace-nowrap text-left font-semibold text-slate-600">ເລກທີ / ວັນທີ</th>
                    <th className="px-4 py-3 whitespace-nowrap text-left font-semibold text-slate-600">ເລີ່ມສົ່ງ</th>
                    <th className="px-4 py-3 whitespace-nowrap text-left font-semibold text-slate-600">ໄມລ / ເວລາ</th>
                    <th className="px-4 py-3 whitespace-nowrap text-left font-semibold text-slate-600">ຕຳແໜ່ງ</th>
                    <th className="px-4 py-3 whitespace-nowrap text-left font-semibold text-slate-600">ລົດ / ຄົນຂັບ</th>
                    <th className="px-4 py-3 whitespace-nowrap text-left font-semibold text-slate-600">ຄວາມຄືບໜ້າບິນ</th>
                    <th className="px-4 py-3 whitespace-nowrap text-left font-semibold text-slate-600">ສ້າງ / ອະນຸມັດ</th>
                    <th className="px-4 py-3 whitespace-nowrap text-left font-semibold text-slate-600">% ທີ່ຂົນ</th>
                    <th className="px-4 py-3 whitespace-nowrap text-left font-semibold text-slate-600">ສະຖານະ</th>
                    <th className="px-4 py-3 whitespace-nowrap text-center font-semibold text-slate-600">ຈັດການ</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedJobs.map((job) => {
                    const details = detailsByDoc[job.doc_no] ?? [];
                    const isExpanded = expandedDoc === job.doc_no;

                    return (
                      <Fragment key={job.doc_no}>
                        <tr className="border-b border-slate-200/20 dark:border-white/5 hover:bg-white/30 dark:hover:bg-white/5 transition-colors">
                          <td className="px-4 py-3 whitespace-nowrap">
                            <button
                              onClick={() => void toggleDetails(job.doc_no)}
                              className="flex items-center gap-2 text-left"
                            >
                              <span className="w-5 h-5 rounded-md bg-white/30 dark:bg-white/10 text-slate-500 dark:text-slate-400 flex items-center justify-center">
                                {isExpanded ? <FaChevronDown size={10} /> : <FaChevronRight size={10} />}
                              </span>
                              <span>
                                <span className="block font-semibold text-slate-800">{job.doc_no}</span>
                                <span className="block text-[11px] text-slate-500">{job.doc_date}</span>
                              </span>
                            </button>
                          </td>
                          <td className="px-4 py-3 text-slate-600 whitespace-nowrap">
                            <div className="space-y-1">
                              <p className="font-medium text-sky-700">{job.active_sent_start}</p>
                              <p className="text-[11px] text-slate-400">ວັນຈັດສົ່ງ {job.date_logistic}</p>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-600 whitespace-nowrap">
                            <div className="space-y-1">
                              {job.miles_start ? (
                                <p className="font-medium text-slate-800">{job.miles_start} ກມ</p>
                              ) : (
                                <p className="text-slate-400">-</p>
                              )}
                              <LiveDuration startTime={job.active_sent_start_raw} />
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-600 whitespace-nowrap">
                            <div className="space-y-1">
                              {job.current_lat && job.current_lng ? (
                                <>
                                  <a
                                    href={`https://www.google.com/maps?q=${job.current_lat},${job.current_lng}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-emerald-600 hover:text-emerald-700 text-xs font-medium"
                                  >
                                    <FaMapMarkerAlt size={10} />
                                    ເບິ່ງແຜນທີ່
                                  </a>
                                  {job.current_location_time && (
                                    <p className="text-[10px] text-slate-400">
                                      {job.current_location_time}
                                    </p>
                                  )}
                                </>
                              ) : job.lat_start && job.lng_start ? (
                                <a
                                  href={`https://www.google.com/maps?q=${job.lat_start},${job.lng_start}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700 text-xs font-medium"
                                >
                                  <FaMapMarkerAlt size={10} />
                                  ຈຸດເລີ່ມ
                                </a>
                              ) : (
                                <p className="text-slate-400">-</p>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-700 whitespace-nowrap">
                            <div className="space-y-1">
                              {job.transport_name && job.transport_name !== "-" && (
                                <p className="text-[10px] text-sky-600 font-medium">{job.transport_name}</p>
                              )}
                              <p className="font-medium">{job.car}</p>
                              <p className="text-[11px] text-slate-500">{job.driver}</p>
                              {job.car && (
                                <Link
                                   href={`/tracking/cars-map?focus=${encodeURIComponent(job.car)}`}
                                  onClick={(event) => event.stopPropagation()}
                                  className="inline-flex items-center gap-1 rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-sky-600 hover:bg-sky-500/20 transition-colors"
                                  title="ຕິດຕາມລົດສົດໃນແຜນທີ່"
                                >
                                  <FaBroadcastTower size={9} />
                                  ຕິດຕາມລົດ
                                </Link>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <div className="flex flex-wrap gap-1.5">
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400 text-[10px] font-semibold">
                                <FaRoute size={9} />
                                ກຳລັງສົ່ງ {toNumber(job.inprogress_bill_count)}
                              </span>
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px] font-semibold">
                                <FaClock size={9} />
                                ລໍ {toNumber(job.waiting_bill_count)}
                              </span>
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-semibold">
                                <FaCheckCircle size={9} />
                                ສົ່ງແລ້ວ {toNumber(job.completed_bill_count)}
                              </span>
                              {toNumber(job.cancelled_bill_count) > 0 && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-rose-500/10 text-rose-600 dark:text-rose-400 text-[10px] font-semibold">
                                  <FaTimesCircle size={9} />
                                  ຍົກເລີກ {toNumber(job.cancelled_bill_count)}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-600 whitespace-nowrap">
                            <div className="space-y-1">
                              <p className="text-[11px]">ສ້າງ: <span className="font-medium text-slate-700">{job.user_created}</span></p>
                              <p className="text-[11px]">ອະນຸມັດ: <span className="font-medium text-slate-700">{job.approve_user}</span></p>
                              <p className="text-[11px] text-slate-400 mb-0.5">ເພີ່ມຖ້ຽວ {job.created_at}</p>
                              <ElapsedTimer createdAt={job.created_at} />
                            </div>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <TripLoadCell v={volumes[job.doc_no]} failed={volumesFailed} />
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-semibold bg-sky-500/10 text-sky-600 dark:text-sky-400">
                              <span className="w-1.5 h-1.5 rounded-full bg-sky-500" />
                              ກຳລັງຈັດສົ່ງ
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center whitespace-nowrap">
                            <div className="flex items-center justify-center gap-1.5">
                              {job.car && (
                                <Link
                                   href={`/tracking/cars-map?focus=${encodeURIComponent(job.car)}`}
                                  className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-sky-600 hover:bg-sky-50 hover:text-sky-700 dark:text-sky-400 dark:hover:bg-sky-500/10 transition-colors"
                                  title={`ຕິດຕາມລົດ ${job.car}`}
                                  aria-label={`ຕິດຕາມລົດ ${job.car}`}
                                >
                                  <FaBroadcastTower size={12} />
                                </Link>
                              )}
                              <a
                                href={`/jobs/print/${encodeURIComponent(job.doc_no)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-white/10 transition-colors"
                                title={`ພິມໃບຈັດຖ້ຽວ ${job.doc_no}`}
                              >
                                <FaPrint size={12} />
                              </a>
                              <button
                                onClick={() => void handleDelete(job.doc_no)}
                                disabled={deletingDoc === job.doc_no}
                                className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-rose-500 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                title={`ລົບຖ້ຽວ ${job.doc_no}`}
                              >
                                {deletingDoc === job.doc_no ? (
                                  <FaSpinner className="animate-spin" size={12} />
                                ) : (
                                  <FaTrash size={12} />
                                )}
                              </button>
                            </div>
                          </td>
                        </tr>

                        {isExpanded && (
                          <tr>
                            <td colSpan={10} className="px-0 py-0 bg-slate-50/60">
                              <div className="px-4 pt-3">
                                <TripLoadPanel docNo={job.doc_no} />
                              </div>
                              <div className="m-3 rounded-lg glass overflow-hidden">
                                <div className="px-4 py-3 bg-white/30 dark:bg-white/5 border-b border-slate-200/30 dark:border-white/5 flex items-center justify-between">
                                  <div>
                                    <p className="text-xs font-semibold text-slate-700">
                                      ລາຍການບິນໃນຖ້ຽວ {job.doc_no}
                                    </p>
                                    <p className="text-[11px] text-slate-500">
                                      ເລີ່ມຈັດສົ່ງ {job.active_sent_start}
                                    </p>
                                  </div>
                                  <button
                                    onClick={() => setExpandedDoc(null)}
                                    className="px-2 py-1 text-[11px] text-slate-500 hover:text-slate-700"
                                  >
                                    ປິດ
                                  </button>
                                </div>

                                <div className="p-3">
                                  {loadingDoc === job.doc_no ? (
                                    <div className="py-8 flex items-center justify-center gap-2 text-xs text-slate-400">
                                      <FaSpinner className="animate-spin" size={12} />
                                      ກຳລັງໂຫຼດ...
                                    </div>
                                  ) : details.length === 0 ? (
                                    <div className="py-8 text-center text-xs text-slate-400">
                                      ບໍ່ພົບລາຍການບິນ
                                    </div>
                                  ) : (
                                    <div className="space-y-2">
                                      {details.map((detail, idx) => {
                                        const billProducts = (billsWithProducts[job.doc_no] ?? []).find(
                                          (b) => b.bill_no === detail.bill_no
                                        );
                                        return (
                                          <div key={`${job.doc_no}-${detail.bill_no}`} className="glass-subtle rounded-lg overflow-hidden">
                                            <div className="px-3 py-2.5 bg-white/30 dark:bg-white/5 border-b border-slate-200/30 dark:border-white/5">
                                              <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-2">
                                                  <span className="w-5 h-5 rounded bg-sky-500/10 text-sky-600 dark:text-sky-400 flex items-center justify-center text-[10px] font-bold">
                                                    {idx + 1}
                                                  </span>
                                                  <div>
                                                    <p className="text-xs font-semibold text-slate-800">{detail.bill_no}</p>
                                                    <p className="text-[10px] text-slate-500">{detail.bill_date} · {detail.customer}</p>
                                                    {detail.cust_area && (
                                                      <p className="text-[10px] text-slate-400">📍 {detail.cust_area}</p>
                                                    )}
                                                  </div>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${getBillPhaseStyle(detail.phase)}`}>
                                                    {detail.bill_status}
                                                  </span>
                                                  <span className="text-[10px] font-medium text-sky-600 dark:text-sky-400 bg-sky-500/10 px-2 py-0.5 rounded">
                                                    {toNumber(detail.count_item)} ລາຍການ
                                                  </span>
                                                </div>
                                              </div>
                                              {(() => {
                                                const condition = resolveDeliveryCondition(detail);
                                                return (
                                                  <div className="flex items-center gap-1.5 mt-1.5 ml-7">
                                                    <span className="text-[10px] text-slate-400">ເງື່ອນໄຂ:</span>
                                                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${getDeliveryConditionStyle(condition)}`}>
                                                      <FaTruckMoving size={9} />
                                                      {DELIVERY_CONDITION_LABELS[condition] ?? condition}
                                                      {condition === "to_branch" && detail.forward_transport_name
                                                        ? ` → ${detail.forward_transport_name}`
                                                        : ""}
                                                    </span>
                                                  </div>
                                                );
                                              })()}
                                              {detail.telephone && (
                                                <p className="text-[10px] text-slate-400 mt-1 ml-7 flex items-center gap-1.5">
                                                  <span>ໂທ: {detail.telephone}</span>
                                                  <WhatsappLink
                                                    phone={detail.telephone}
                                                    message={buildBillWhatsappMessage({
                                                      billNo: detail.bill_no,
                                                      customerName: detail.customer,
                                                      trackingUrl: `/track?bill=${encodeURIComponent(detail.bill_no)}`,
                                                    })}
                                                  />
                                                </p>
                                              )}
                                              <div className="flex gap-4 mt-1.5 ml-7 text-[10px] text-slate-400">
                                                <span>ເບີກ: {detail.recipt_job}</span>
                                                <span>ເລີ່ມ: {detail.sent_start}</span>
                                                <span>ຈົບ: {detail.sent_end}</span>
                                              </div>
                                              {(() => {
                                                const images = collectDeliveryImages(detail);
                                                if (images.length === 0) return null;
                                                return (
                                                  <div className="flex flex-wrap items-center gap-2 mt-2 ml-7">
                                                    {images.map((image, idx) => (
                                                      <ImageThumb key={`${detail.bill_no}-${idx}`} src={image.src} label={image.label} />
                                                    ))}
                                                  </div>
                                                );
                                              })()}
                                              {detail.remark && (
                                                <p className="text-[10px] text-rose-500 mt-1 ml-7">{detail.remark}</p>
                                              )}
                                              {detail.phase !== "cancel" && !detail.forward_transport_code &&
                                                (() => {
                                                  const key = `${job.doc_no}::${detail.bill_no}`;
                                                  if (reclassifyKey !== key) {
                                                    return (
                                                      <div className="mt-2 ml-7">
                                                        <button
                                                          type="button"
                                                          onClick={() => {
                                                            setReclassifyKey(key);
                                                            setReclassifyBranch("");
                                                          }}
                                                          className="inline-flex items-center gap-1 rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-[9px] font-semibold text-sky-700 hover:bg-sky-100 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-300"
                                                          title="ແກ້ເປັນສົ່ງສາຂາ ໂດຍໃຊ້ຂໍ້ມູນເດີມ"
                                                        >
                                                          ⇄ ແກ້ເປັນສົ່ງສາຂາ
                                                        </button>
                                                      </div>
                                                    );
                                                  }
                                                  return (
                                                    <div className="mt-2 ml-7 flex flex-wrap items-center gap-1">
                                                      <select
                                                        value={reclassifyBranch}
                                                        onChange={(e) => setReclassifyBranch(e.target.value)}
                                                        disabled={reclassifyBusy}
                                                        className="h-6 rounded border border-slate-300 bg-white px-1 text-[10px] dark:border-slate-700 dark:bg-slate-800"
                                                      >
                                                        <option value="">- ສາຂາປາຍທາງ -</option>
                                                        {branches.map((b) => (
                                                          <option key={b.code} value={b.code}>
                                                            {b.name_1} ({b.code})
                                                          </option>
                                                        ))}
                                                      </select>
                                                      <button
                                                        type="button"
                                                        disabled={reclassifyBusy || !reclassifyBranch}
                                                        onClick={() => void handleReclassify(job.doc_no, detail.bill_no)}
                                                        className="inline-flex items-center gap-1 rounded bg-sky-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
                                                      >
                                                        {reclassifyBusy && <FaSpinner className="animate-spin" size={9} />}
                                                        ຢືນຢັນ
                                                      </button>
                                                      <button
                                                        type="button"
                                                        disabled={reclassifyBusy}
                                                        onClick={() => {
                                                          setReclassifyKey(null);
                                                          setReclassifyBranch("");
                                                        }}
                                                        className="rounded px-1.5 py-0.5 text-[10px] text-slate-500 hover:text-slate-700"
                                                      >
                                                        ຍົກເລີກ
                                                      </button>
                                                    </div>
                                                  );
                                                })()}
                                            </div>
                                            {billProducts && billProducts.products.length > 0 && (
                                              <div className="p-2">
                                                <table className="w-full text-[10px]">
                                                  <thead>
                                                    <tr className="text-slate-400 dark:text-slate-500 border-b border-slate-200/30 dark:border-white/5">
                                                      <th className="text-left py-1 pl-2 pr-1 font-medium w-6">#</th>
                                                      <th className="text-left py-1 px-1 font-medium">ລະຫັດ</th>
                                                      <th className="text-left py-1 px-1 font-medium">ຊື່ສິນຄ້າ</th>
                                                      <th className="text-right py-1 px-1 font-medium">ຈຳນວນ</th>
                                                      <th className="text-left py-1 pl-1 pr-2 font-medium">ຫົວໜ່ວຍ</th>
                                                    </tr>
                                                  </thead>
                                                  <tbody>
                                                    {billProducts.products.map((product, pIdx) => (
                                                      <tr key={`${detail.bill_no}-${product.item_code}-${pIdx}`} className="border-b border-slate-200/20 dark:border-white/5 last:border-0">
                                                        <td className="py-1 pl-2 pr-1 text-slate-400">{pIdx + 1}</td>
                                                        <td className="py-1 px-1 font-mono text-[9px] text-slate-500">{product.item_code}</td>
                                                        <td className="py-1 px-1 text-slate-700">{product.item_name}</td>
                                                        <td className="py-1 px-1 text-right font-semibold text-sky-600">{product.qty}</td>
                                                        <td className="py-1 pl-1 pr-2 text-slate-500">{product.unit_code}</td>
                                                      </tr>
                                                    ))}
                                                  </tbody>
                                                </table>
                                              </div>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-slate-200/30 dark:border-white/5">
                <p className="text-[11px] text-slate-500">
                  ສະແດງ {(currentPage - 1) * perPage + 1}-{Math.min(currentPage * perPage, filteredJobs.length)} ຈາກ {filteredJobs.length}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setCurrentPage((value) => Math.max(1, value - 1))}
                    disabled={currentPage === 1}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg glass text-slate-600 dark:text-slate-300 hover:bg-white/30 dark:hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    ກ່ອນ
                  </button>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    onClick={() => setCurrentPage((value) => Math.min(totalPages, value + 1))}
                    disabled={currentPage === totalPages}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg glass text-slate-600 dark:text-slate-300 hover:bg-white/30 dark:hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    ຕໍ່ໄປ
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
