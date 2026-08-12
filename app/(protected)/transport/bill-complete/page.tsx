"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { TripLoadCell, useTripVolumes } from "@/components/trip-load-cell";
import { TripLoadPanel } from "@/components/trip-load-strip";
import {
  FaBoxOpen,
  FaCheckCircle,
  FaChevronDown,
  FaChevronRight,
  FaFlagCheckered,
  FaPrint,
  FaSearch,
  FaSpinner,
  FaTimesCircle,
  FaUserCheck,
  FaTrash,
} from "react-icons/fa";
// Copied from tms — read calls go through the REST proxy to TMS; the two
// operational actions (delete a trip, move a bill) stay in TMS, where the
// operator has their own session.
import api from "@/service/api";
import { runInTms } from "@/lib/tms-actions";
import { useConfirm } from "@/components/confirm-dialog";
import { getFixedTodayDate, FIXED_YEAR_START, FIXED_YEAR_END } from "@/lib/fixed-year";
import { StatusPageHeader, StatusStatGrid } from "@/components/status-page-shell";
import { WhatsappLink, buildBillWhatsappMessage } from "@/components/whatsapp-link";
// Ported from server actions: getBillsWaitingSentDetails, deleteJob

function ImageThumb({ src, label }: { src: string; label: string }) {
  const [open, setOpen] = useState(false);
  if (!src) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group relative h-10 w-10 overflow-hidden rounded-lg border border-white/20 dark:border-white/5 bg-white/30 dark:bg-white/10 hover:ring-2 hover:ring-emerald-400 transition-all"
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

export interface CompletedJob {
  doc_date: string;
  doc_no: string;
  date_logistic: string;
  created_at: string;
  finished_at: string;
  driver_closed_at: string;
  admin_closed_at: string;
  car: string;
  driver: string;
  item_bill: number;
  user_created: string;
  approve_user: string;
  completed_bill_count: number;
  cancelled_bill_count: number;
  job_status: number;
}

export interface CompletedBillDetail {
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
  selected_qty_total?: number | string;
  delivered_qty_total?: number | string;
  returned_qty_total?: number | string;
  remaining_qty_total?: number | string;
  remaining_item_count?: number | string;
  url_img?: string;
  sight_img?: string;
  delivery_images?: string[];
  duration_seconds?: number | string | null;
  distance_km?: number | string | null;
  forward_transport_code?: string;
  forward_transport_name?: string;
}

function formatDurationSeconds(value: number | string | null | undefined) {
  if (value == null) return "-";
  const total = Math.max(0, Math.trunc(Number(value)));
  if (!Number.isFinite(total) || total === 0) return "-";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}ຊ`);
  if (m > 0) parts.push(`${m}ນ`);
  if (h === 0) parts.push(`${s}ວ`);
  return parts.join(" ");
}

function formatDistanceKm(value: number | string | null | undefined) {
  if (value == null) return "-";
  const num = Number(value);
  if (!Number.isFinite(num) || num === 0) return "-";
  if (num < 1) return `${Math.round(num * 1000)} m`;
  return `${num.toFixed(2)} ກມ`;
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

interface BillCompleteClientProps {
  initialJobs?: CompletedJob[];
}

function toNumber(value: number | string | null | undefined) {
  return Number(value ?? 0);
}

function getJobCloseState(jobStatus: number) {
  if (jobStatus >= 4) {
    return {
      label: "admin ປິດແລ້ວ",
      className: "bg-slate-500/10 text-slate-600 dark:text-slate-300",
    };
  }

  if (jobStatus === 3) {
    return {
      label: "ລໍ admin ປິດ",
      className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    };
  }

  return {
    label: "ລໍຄົນຂັບປິດງານ",
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  };
}

function getBillPhaseStyle(phase: string) {
  switch (phase) {
    case "done":
      return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    case "partial":
      return "bg-orange-500/10 text-orange-600 dark:text-orange-400";
    case "forwarded":
      return "bg-sky-500/10 text-sky-600 dark:text-sky-400";
    case "cancel":
      return "bg-rose-500/10 text-rose-600 dark:text-rose-400";
    case "inprogress":
      return "bg-sky-500/10 text-sky-600 dark:text-sky-400";
    default:
      return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
  }
}

function sortDetails(details: CompletedBillDetail[]) {
  const order: Record<string, number> = {
    done: 0,
    partial: 1,
    forwarded: 2,
    cancel: 3,
    inprogress: 4,
    waiting: 5,
  };

  return [...details].sort((a, b) => {
    const diff = (order[a.phase] ?? 99) - (order[b.phase] ?? 99);
    if (diff !== 0) return diff;
    return a.bill_no.localeCompare(b.bill_no);
  });
}

export default function BillCompleteClient({
  initialJobs = [],
}: BillCompleteClientProps) {
  const [jobs, setJobs] = useState<CompletedJob[]>(initialJobs);
  const confirm = useConfirm();
  const [searchText, setSearchText] = useState("");
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null);
  const [detailsByDoc, setDetailsByDoc] = useState<
    Record<string, CompletedBillDetail[]>
  >({});
  const [billsWithProducts, setBillsWithProducts] = useState<
    Record<string, BillWithProducts[]>
  >({});
  const [loadingDoc, setLoadingDoc] = useState<string | null>(null);
  const [deletingDoc, setDeletingDoc] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState(getFixedTodayDate());
  const [toDate, setToDate] = useState(getFixedTodayDate());
  // "ແກ້ເປັນສົ່ງສາຂາ" — re-classify a completed to_customer stop as a branch forward.
  const [branches, setBranches] = useState<{ code: string; name_1: string }[]>([]);
  const [reclassifyKey, setReclassifyKey] = useState<string | null>(null);
  const [reclassifyBranch, setReclassifyBranch] = useState("");
  const [reclassifyBusy, setReclassifyBusy] = useState(false);
  const perPage = 20;

  const fetchJobs = (from: string, to: string) => {
    setLoading(true);
    setLoadError(null);
    void api.get("/transport/bills", { params: { list: "complete", from: from, to } }).then((r) => r.data?.data)
      .then((data) => setJobs((data ?? []) as CompletedJob[]))
      .catch((e) => {
        console.error(e);
        setLoadError(e?.response?.data?.error ?? e?.message ?? "Unknown error");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchJobs(fromDate, toDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
       } }).then((r) => r.data?.data)) as CompletedBillDetail[];
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
      message: `ປ່ຽນບິນ ${billNo} ຈາກ 'ສົ່ງລູກຄ້າ' ເປັນ 'ສົ່ງສາຂາ → ${branch?.name_1 ?? reclassifyBranch}' ໂດຍໃຊ້ຂໍ້ມູນເດີມ? ບິນຈະກັບເຂົ້າຄິວຂອງສາຂາປາຍທາງເພື່ອຈັດສົ່ງຕໍ່ຫາລູກຄ້າ.`,
      tone: "warning",
      confirmLabel: "ປ່ຽນ",
    });
    if (!ok) return;
    setReclassifyBusy(true);
    try {
      await runInTms(`/bills-inprogress`, "ຍ້າຍສາຂາຕ້ອງເຮັດຢູ່ TMS — ເປີດ TMS ບໍ?");
      setReclassifyKey(null);
      setReclassifyBranch("");
      await refreshDetails(docNo);
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : "ປ່ຽນບໍ່ສຳເລັດ";
      void confirm({ title: "ຜິດພາດ", message, tone: "warning", single: true });
    } finally {
      setReclassifyBusy(false);
    }
  };

  const filteredJobs = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();

    if (!keyword) {
      return jobs;
    }

    return jobs.filter((job) =>
      [
        job.doc_no,
        job.doc_date,
        job.date_logistic,
        job.finished_at,
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
  }, [jobs, searchText]);

  const summary = useMemo(() => {
    return filteredJobs.reduce(
      (result, job) => {
        result.jobs += 1;
        result.completed += toNumber(job.completed_bill_count);
        result.cancelled += toNumber(job.cancelled_bill_count);
        if (job.job_status === 3) {
          result.waitingAdmin += 1;
        } else if (job.job_status >= 4) {
          result.adminClosed += 1;
        } else {
          result.waitingDriver += 1;
        }
        return result;
      },
      {
        jobs: 0,
        completed: 0,
        cancelled: 0,
        waitingDriver: 0,
        waitingAdmin: 0,
        adminClosed: 0,
      }
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
        api.get("/transport/bills", { params: { list: "details", doc: docNo } }).then((r) => r.data?.data) as Promise<CompletedBillDetail[]>,
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
        title="ຈັດສົ່ງສຳເລັດ"
        subtitle="ຖ້ຽວທີ່ບໍ່ມີບິນຄ້າງແລ້ວ ແລະລໍປິດງານ ຫຼື ປິດແລ້ວ"
        icon={<FaFlagCheckered />}
        tone="emerald"
      />

      <StatusStatGrid
        columns={5}
        stats={[
          { label: "ຖ້ຽວທີ່ຈົບແລ້ວ", value: summary.jobs, icon: <FaFlagCheckered />, tone: "slate" },
          { label: "ບິນສົ່ງສຳເລັດ", value: summary.completed, icon: <FaCheckCircle />, tone: "emerald" },
          { label: "ບິນຍົກເລີກ", value: summary.cancelled, icon: <FaTimesCircle />, tone: "rose" },
          { label: "ລໍ admin ປິດ", value: summary.waitingAdmin, icon: <FaBoxOpen />, tone: "amber" },
          { label: "admin ປິດແລ້ວ", value: summary.adminClosed, icon: <FaUserCheck />, tone: "slate" },
        ]}
      />

      <div className="glass rounded-lg p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            fetchJobs(fromDate, toDate);
          }}
          className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end"
        >
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1.5">ຈາກ</label>
            <input
              type="date"
              value={fromDate}
              min={FIXED_YEAR_START}
              max={FIXED_YEAR_END}
              onChange={(e) => setFromDate(e.target.value)}
              className="w-full px-3 py-2 glass-input rounded-lg text-xs text-slate-700 dark:text-slate-200 transition-all"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1.5">ຫາ</label>
            <input
              type="date"
              value={toDate}
              min={FIXED_YEAR_START}
              max={FIXED_YEAR_END}
              onChange={(e) => setToDate(e.target.value)}
              className="w-full px-3 py-2 glass-input rounded-lg text-xs text-slate-700 dark:text-slate-200 transition-all"
            />
          </div>
          <div>
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
              placeholder="ເລກຖ້ຽວ, ລົດ, ຄົນຂັບ..."
              className="w-full px-3 py-2 glass-input rounded-lg text-xs text-slate-700 dark:text-slate-200 transition-all"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="h-9 px-4 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
          >
            {loading ? <FaSpinner className="animate-spin" size={11} /> : <FaSearch size={11} />}
            ຄົ້ນຫາ
          </button>
        </form>
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
              {searchText.trim() ? "ບໍ່ພົບຂໍ້ມູນຕາມຄໍາຄົ້ນຫາ" : "ບໍ່ມີຖ້ຽວຈັດສົ່ງສຳເລັດ"}
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-white/30 dark:bg-white/5 border-b border-slate-200/30 dark:border-white/5">
                    <th className="px-4 py-3 whitespace-nowrap text-left font-semibold text-slate-600">ເລກທີ / ວັນທີ</th>
                    <th className="px-4 py-3 whitespace-nowrap text-left font-semibold text-slate-600">ຈົບການສົ່ງ</th>
                    <th className="px-4 py-3 whitespace-nowrap text-left font-semibold text-slate-600">ລົດ / ຄົນຂັບ</th>
                    <th className="px-4 py-3 whitespace-nowrap text-left font-semibold text-slate-600">ຜົນການສົ່ງ</th>
                    <th className="px-4 py-3 whitespace-nowrap text-left font-semibold text-slate-600">% ທີ່ຂົນ</th>
                    <th className="px-4 py-3 whitespace-nowrap text-left font-semibold text-slate-600">ສະຖານະການປິດ</th>
                    <th className="px-4 py-3 whitespace-nowrap text-left font-semibold text-slate-600">ສ້າງ / ອະນຸມັດ</th>
                    <th className="px-4 py-3 whitespace-nowrap text-center font-semibold text-slate-600">ລົບ</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedJobs.map((job) => {
                    const details = detailsByDoc[job.doc_no] ?? [];
                    const isExpanded = expandedDoc === job.doc_no;
                    const closeState = getJobCloseState(job.job_status);

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
                              <p className="font-medium text-emerald-700">{job.finished_at}</p>
                              <p className="text-[11px] text-slate-400">ວັນຈັດສົ່ງ {job.date_logistic}</p>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-700 whitespace-nowrap">
                            <div className="space-y-1">
                              <p className="font-medium">{job.car}</p>
                              <p className="text-[11px] text-slate-500">{job.driver}</p>
                            </div>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <div className="flex flex-wrap gap-1.5">
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-semibold">
                                <FaCheckCircle size={9} />
                                ສຳເລັດ {toNumber(job.completed_bill_count)}
                              </span>
                              {toNumber(job.cancelled_bill_count) > 0 && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-rose-500/10 text-rose-600 dark:text-rose-400 text-[10px] font-semibold">
                                  <FaTimesCircle size={9} />
                                  ຍົກເລີກ {toNumber(job.cancelled_bill_count)}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <TripLoadCell v={volumes[job.doc_no]} failed={volumesFailed} />
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <div className="space-y-1">
                              <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-semibold ${closeState.className}`}>
                                <FaUserCheck size={9} />
                                {closeState.label}
                              </span>
                              {job.driver_closed_at !== "-" && (
                                <p className="text-[10px] text-slate-500">ຄົນຂັບປິດ: {job.driver_closed_at}</p>
                              )}
                              {job.admin_closed_at !== "-" && (
                                <p className="text-[10px] text-slate-500">admin ປິດ: {job.admin_closed_at}</p>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-600 whitespace-nowrap">
                            <div className="space-y-1">
                              <p className="text-[11px]">ສ້າງ: <span className="font-medium text-slate-700">{job.user_created}</span></p>
                              <p className="text-[11px]">ອະນຸມັດ: <span className="font-medium text-slate-700">{job.approve_user}</span></p>
                              <p className="text-[11px] text-slate-400">ເພີ່ມຖ້ຽວ {job.created_at}</p>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-center whitespace-nowrap">
                            <div className="inline-flex items-center justify-center gap-1">
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
                            <td colSpan={8} className="px-0 py-0 bg-slate-50/60">
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
                                      ສົ່ງຈົບ {job.finished_at}
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
                                    <div className="overflow-x-auto">
                                      <table className="w-full text-[11px]">
                                        <thead>
                                          <tr className="border-b border-slate-200/30 dark:border-white/5 text-slate-500 dark:text-slate-400">
                                            <th className="py-2 pr-3 text-left font-medium">ເລກບິນ</th>
                                            <th className="py-2 pr-3 text-left font-medium">ວັນບິນ</th>
                                            <th className="py-2 pr-3 text-left font-medium">ລູກຄ້າ</th>
                                            <th className="py-2 pr-3 text-left font-medium">ຈຳນວນລາຍການ</th>
                                            <th className="py-2 pr-3 text-left font-medium">ເລີ່ມສົ່ງ</th>
                                            <th className="py-2 pr-3 text-left font-medium">ຈົບສົ່ງ</th>
                                            <th className="py-2 pr-3 text-left font-medium">ເວລາ / ໄລຍະທາງ</th>
                                            <th className="py-2 pr-3 text-left font-medium">ຮູບ / ລາຍເຊັນ</th>
                                            <th className="py-2 text-left font-medium">ສະຖານະ</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {details.map((detail) => {
                                            const billProducts = (billsWithProducts[job.doc_no] ?? []).find(
                                              (bp) => bp.bill_no === detail.bill_no
                                            );
                                            return (
                                            <Fragment key={`${job.doc_no}-${detail.bill_no}`}>
                                            <tr className="border-b border-slate-200/20 dark:border-white/5 last:border-0">
                                              <td className="py-2 pr-3">
                                                <p className="font-semibold text-slate-700">{detail.bill_no}</p>
                                                {detail.forward_transport_code && (
                                                  <span className="mt-0.5 inline-block px-1.5 py-0.5 rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400 text-[9px] font-semibold">
                                                    ສົ່ງຕໍ່ {detail.forward_transport_name || detail.forward_transport_code}
                                                  </span>
                                                )}
                                              </td>
                                              <td className="py-2 pr-3 text-slate-500">{detail.bill_date}</td>
                                              <td className="py-2 pr-3">
                                                <div className="space-y-0.5">
                                                  <p className="text-slate-700">{detail.customer}</p>
                                                  {detail.cust_area && (
                                                    <p className="text-[10px] text-slate-400">📍 {detail.cust_area}</p>
                                                  )}
                                                  {detail.telephone && (
                                                    <p className="text-[10px] text-slate-400 flex items-center gap-1.5">
                                                      <span>{detail.telephone}</span>
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
                                                </div>
                                              </td>
                                              <td className="py-2 pr-3 text-slate-600">{toNumber(detail.count_item)}</td>
                                              <td className="py-2 pr-3 text-slate-500">{detail.sent_start}</td>
                                              <td className="py-2 pr-3 text-slate-500">{detail.sent_end}</td>
                                              <td className="py-2 pr-3">
                                                <div className="flex flex-col gap-0.5 text-[10px]">
                                                  <span className="font-semibold text-teal-600">
                                                    ⏱ {formatDurationSeconds(detail.duration_seconds)}
                                                  </span>
                                                  <span className="font-semibold text-emerald-600">
                                                    📍 {formatDistanceKm(detail.distance_km)}
                                                  </span>
                                                </div>
                                              </td>
                                              <td className="py-2 pr-3">
                                                {(() => {
                                                  const images = collectDeliveryImages(detail);
                                                  return images.length > 0 ? (
                                                    <div className="flex flex-wrap items-center gap-1.5">
                                                      {images.map((image, idx) => (
                                                        <ImageThumb key={`${detail.bill_no}-${idx}`} src={image.src} label={image.label} />
                                                      ))}
                                                    </div>
                                                  ) : (
                                                    <span className="text-slate-300">-</span>
                                                  );
                                                })()}
                                              </td>
                                              <td className="py-2">
                                                <div className="space-y-1">
                                                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${getBillPhaseStyle(detail.phase)}`}>
                                                    {detail.bill_status}
                                                  </span>
                                                  {(toNumber(detail.returned_qty_total) > 0 ||
                                                    toNumber(detail.remaining_qty_total) > 0) && (
                                                    <p className="text-[10px] text-slate-500">
                                                      ສົ່ງ {toNumber(detail.delivered_qty_total)}
                                                      {toNumber(detail.returned_qty_total) > 0 &&
                                                        ` · ຄືນສາງ ${toNumber(detail.returned_qty_total)}`}
                                                      {toNumber(detail.remaining_qty_total) > 0 &&
                                                        ` · ຄ້າງ ${toNumber(detail.remaining_qty_total)}`}
                                                      {` / ${toNumber(detail.selected_qty_total)}`}
                                                    </p>
                                                  )}
                                                  {detail.remark && (
                                                    <p className="text-[10px] text-rose-500">{detail.remark}</p>
                                                  )}
                                                  {detail.phase !== "cancel" && !detail.forward_transport_code &&
                                                    (() => {
                                                      const key = `${job.doc_no}::${detail.bill_no}`;
                                                      if (reclassifyKey !== key) {
                                                        return (
                                                          <button
                                                            type="button"
                                                            onClick={() => {
                                                              setReclassifyKey(key);
                                                              setReclassifyBranch("");
                                                            }}
                                                            className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[9px] font-semibold text-emerald-700 hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
                                                            title="ແກ້ເປັນສົ່ງສາຂາ ໂດຍໃຊ້ຂໍ້ມູນເດີມ"
                                                          >
                                                            ⇄ ແກ້ເປັນສົ່ງສາຂາ
                                                          </button>
                                                        );
                                                      }
                                                      return (
                                                        <div className="flex flex-wrap items-center gap-1">
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
                                                            className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
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
                                              </td>
                                            </tr>
                                            {billProducts && billProducts.products.length > 0 && (
                                              <tr className="bg-white/30 dark:bg-white/5 border-b border-slate-200/30 dark:border-white/5">
                                                <td colSpan={9} className="p-2 pl-6">
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
                                                          <td className="py-1 px-1 text-right font-semibold text-emerald-600">{product.qty}</td>
                                                          <td className="py-1 pl-1 pr-2 text-slate-500">{product.unit_code}</td>
                                                        </tr>
                                                      ))}
                                                    </tbody>
                                                  </table>
                                                </td>
                                              </tr>
                                            )}
                                            </Fragment>
                                            );
                                          })}
                                        </tbody>
                                      </table>
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
