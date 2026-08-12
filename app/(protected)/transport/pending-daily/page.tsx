"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import {
  FaBox,
  FaBoxOpen,
  FaBuilding,
  FaCalendar,
  FaChevronDown,
  FaChevronRight,
  FaFileExcel,
  FaFileInvoice,
  FaListUl,
  FaSearch,
  FaSpinner,
  FaTruck,
} from "react-icons/fa";
import { FIXED_YEAR_END, FIXED_YEAR_START, getFixedTodayDate } from "@/lib/fixed-year";
// Copied from tms — only the data calls are swapped for the REST proxy, which
// forwards to TMS so the figures stay the ones TMS computes.
import api from "@/service/api";
import { exportToExcel } from "@/lib/excel-export";

// Per-bill row returned by getReportPendingDaily. Frontend pivots these by
// (date, department, transport) for the grouped view.
interface PendingRow {
  send_date: string | null;
  send_date_display: string;
  department: string;
  transport_code: string;
  transport: string;
  doc_no: string;
  customer: string;
  sale: string;
  remaining_count: number;
  remaining_qty_total: number;
  scheduled_date_display: string;
  action_status: string;
  source_type: string;
}

interface PendingReportData {
  rows: PendingRow[];
  days: string[];
  departments: string[];
  transports: string[];
  totals: { bills: number; items: number; qty: number };
}

type GroupBy = "date_dept_transport" | "department" | "transport";

interface BillProduct {
  item_code: string;
  item_name: string;
  qty: number | string;
  unit_code: string;
}

function fmtNum(n: number) {
  return n.toLocaleString("en-US");
}

export default function PendingDailyReportPage() {
  const [data, setData] = useState<PendingReportData | null>(null);
  const [fromDate, setFromDate] = useState(() => getFixedTodayDate());
  const [toDate, setToDate] = useState(() => getFixedTodayDate());
  const [loading, setLoading] = useState(true);
  const [groupBy, setGroupBy] = useState<GroupBy>("date_dept_transport");
  const [searchText, setSearchText] = useState("");
  const [deptFilter, setDeptFilter] = useState<string>("all");
  const [transportFilter, setTransportFilter] = useState<string>("all");
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null);
  const [productsByDoc, setProductsByDoc] = useState<Record<string, BillProduct[]>>({});
  const [loadingDoc, setLoadingDoc] = useState<string | null>(null);

  const toggleDetails = async (docNo: string) => {
    if (expandedDoc === docNo) {
      setExpandedDoc(null);
      return;
    }
    setExpandedDoc(docNo);
    if (productsByDoc[docNo]) return; // cached
    setLoadingDoc(docNo);
    try {
      const products = (await api.get("/transport/logistics", { params: { report: "bill-products", doc: docNo } })).data?.data;
      setProductsByDoc((c) => ({ ...c, [docNo]: (products as BillProduct[]) ?? [] }));
    } catch (e) {
      console.error(e);
      setProductsByDoc((c) => ({ ...c, [docNo]: [] }));
    } finally {
      setLoadingDoc(null);
    }
  };

  const fetchData = () => {
    setLoading(true);
    api.get("/transport/logistics", { params: { report: "pending-daily", from: fromDate, to: toDate } }).then((r) => r.data?.data)
      .then((d) => setData(d as PendingReportData))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredRows = useMemo(() => {
    if (!data) return [];
    const q = searchText.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (deptFilter !== "all" && r.department !== deptFilter) return false;
      if (transportFilter !== "all" && r.transport !== transportFilter) return false;
      if (!q) return true;
      return (
        r.doc_no.toLowerCase().includes(q) ||
        r.customer.toLowerCase().includes(q) ||
        r.department.toLowerCase().includes(q) ||
        r.transport.toLowerCase().includes(q)
      );
    });
  }, [data, searchText, deptFilter, transportFilter]);

  // Pivot: groupKey -> { bills, items, qty, rows[] }. The key shape depends
  // on the active groupBy so a single render path covers all three views.
  const grouped = useMemo(() => {
    const map = new Map<string, { label: string; sub: string; bills: number; items: number; qty: number; rows: PendingRow[] }>();
    for (const r of filteredRows) {
      let key: string;
      let label: string;
      let sub: string;
      if (groupBy === "department") {
        key = r.department;
        label = r.department;
        sub = "ພະແນກ";
      } else if (groupBy === "transport") {
        key = r.transport;
        label = r.transport;
        sub = "ຂົນສົ່ງ";
      } else {
        key = `${r.send_date_display}|${r.department}|${r.transport}`;
        label = `${r.send_date_display} · ${r.department} · ${r.transport}`;
        sub = "ວັນ · ພະແນກ · ຂົນສົ່ງ";
      }
      const g = map.get(key) ?? { label, sub, bills: 0, items: 0, qty: 0, rows: [] };
      g.bills += 1;
      g.items += r.remaining_count;
      g.qty += r.remaining_qty_total;
      g.rows.push(r);
      map.set(key, g);
    }
    return Array.from(map.entries()).map(([key, g]) => ({ key, ...g }));
  }, [filteredRows, groupBy]);

  const filteredTotals = useMemo(() => {
    return filteredRows.reduce(
      (acc, r) => {
        acc.bills += 1;
        acc.items += r.remaining_count;
        acc.qty += r.remaining_qty_total;
        return acc;
      },
      { bills: 0, items: 0, qty: 0 }
    );
  }, [filteredRows]);

  const handleExport = () => {
    if (filteredRows.length === 0) return;
    // Mirror the on-screen columns + add total counts. Excel cells get the
    // raw label / number so users can pivot/sort in their own workbook.
    exportToExcel(
      `pending-bills_${fromDate}_to_${toDate}`,
      filteredRows.map((r, i) => ({
        no: i + 1,
        send_date: r.send_date_display,
        department: r.department,
        transport: r.transport,
        doc_no: r.doc_no,
        customer: r.customer,
        sale: r.sale,
        scheduled_date: r.scheduled_date_display,
        remaining_count: r.remaining_count,
        remaining_qty: r.remaining_qty_total,
      })),
      [
        { key: "no", header: "#", width: 6 },
        { key: "send_date", header: "ວັນຈັດສົ່ງ", width: 14 },
        { key: "department", header: "ພະແນກ", width: 22 },
        { key: "transport", header: "ຂົນສົ່ງ", width: 22 },
        { key: "doc_no", header: "ເລກບິນ", width: 16 },
        { key: "customer", header: "ລູກຄ້າ", width: 30 },
        { key: "sale", header: "ພະນັກງານຂາຍ", width: 18 },
        { key: "scheduled_date", header: "ກຳນົດສົ່ງ", width: 14 },
        { key: "remaining_count", header: "ລາຍການເຫຼືອ", width: 12 },
        { key: "remaining_qty", header: "ຈຳນວນເຫຼືອ", width: 12 },
      ]
    );
  };

  return (
    <div className="space-y-5">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-lg bg-[#003260] p-5 shadow-xl">
        <div
          className="absolute inset-0 opacity-20"
          style={{
            backgroundImage:
              "radial-gradient(circle at 10% 10%, #f6921e 0%, transparent 35%), radial-gradient(circle at 90% 80%, #5ea9e4 0%, transparent 35%)",
          }}
        />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-lg bg-white/10 backdrop-blur flex items-center justify-center ring-1 ring-white/20">
              <FaFileInvoice className="text-amber-300" size={18} />
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-amber-300">
                Pending Bills · Daily
              </p>
              <h1 className="text-xl sm:text-2xl font-bold text-white leading-tight">
                ລາຍງານບິນຄ້າງສົ່ງປະຈຳວັນ
              </h1>
              <p className="text-[11px] text-slate-300 mt-0.5">
                ແຍກຕາມພະແນກ ແລະ ຂົນສົ່ງ
              </p>
            </div>
          </div>
          {data && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-amber-500/20 to-orange-500/20 backdrop-blur border border-white/10 px-3 py-1.5 ring-1 ring-amber-300/30 text-[11px] text-amber-100">
                <span className="opacity-80">ບິນທັງໝົດ</span>
                <span className="font-bold text-white tabular-nums">{fmtNum(filteredTotals.bills)}</span>
              </span>
              <span className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-sky-500/20 to-cyan-500/20 backdrop-blur border border-white/10 px-3 py-1.5 ring-1 ring-sky-300/30 text-[11px] text-sky-100">
                <span className="opacity-80">ລາຍການເຫຼືອ</span>
                <span className="font-bold text-white tabular-nums">{fmtNum(filteredTotals.items)}</span>
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Filter form */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          fetchData();
        }}
        className="glass rounded-lg p-4"
      >
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
          <div>
            <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
              <FaCalendar size={10} /> ຈາກວັນທີ
            </label>
            <input
              type="date"
              value={fromDate}
              min={FIXED_YEAR_START}
              max={FIXED_YEAR_END}
              onChange={(e) => setFromDate(e.target.value)}
              className="w-full px-3 py-2 glass-input rounded-lg text-xs"
            />
          </div>
          <div>
            <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
              <FaCalendar size={10} /> ຫາວັນທີ
            </label>
            <input
              type="date"
              value={toDate}
              min={FIXED_YEAR_START}
              max={FIXED_YEAR_END}
              onChange={(e) => setToDate(e.target.value)}
              className="w-full px-3 py-2 glass-input rounded-lg text-xs"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={loading}
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-amber-600 hover:bg-amber-700 px-4 py-2 text-xs font-semibold text-white shadow-sm disabled:opacity-50 transition-colors"
            >
              {loading ? <FaSpinner className="animate-spin" size={11} /> : <FaSearch size={11} />}
              ດຶງຂໍ້ມູນ
            </button>
            <button
              type="button"
              onClick={handleExport}
              disabled={loading || !data || filteredRows.length === 0}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 px-3 py-2 text-xs font-semibold text-white shadow-sm disabled:opacity-50 transition-colors"
              title="Export to Excel"
            >
              <FaFileExcel size={12} /> Excel
            </button>
          </div>
        </div>
      </form>

      {/* Grouping + filters */}
      {data && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex items-center gap-1 rounded-lg glass p-1">
            {([
              { key: "date_dept_transport" as const, label: "ວັນ × ພະແນກ × ຂົນສົ່ງ" },
              { key: "department" as const, label: "ພະແນກ" },
              { key: "transport" as const, label: "ຂົນສົ່ງ" },
            ]).map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setGroupBy(opt.key)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all ${
                  groupBy === opt.key
                    ? "glass-heavy text-amber-600 dark:text-amber-400"
                    : "text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <select
            value={deptFilter}
            onChange={(e) => setDeptFilter(e.target.value)}
            className="rounded-lg glass-input px-3 py-1.5 text-xs"
          >
            <option value="all">ທຸກພະແນກ</option>
            {data.departments.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <select
            value={transportFilter}
            onChange={(e) => setTransportFilter(e.target.value)}
            className="rounded-lg glass-input px-3 py-1.5 text-xs"
          >
            <option value="all">ທຸກຂົນສົ່ງ</option>
            {data.transports.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <div className="relative flex-1 min-w-[200px]">
            <FaSearch className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-300" size={12} />
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="ຄົ້ນຫາ: ເລກບິນ, ລູກຄ້າ..."
              className="w-full pl-9 pr-3 py-1.5 glass-input rounded-lg text-xs"
            />
          </div>
        </div>
      )}

      {/* Body */}
      {loading && !data ? (
        <div className="flex items-center justify-center gap-2 py-16 rounded-lg glass">
          <FaSpinner className="animate-spin text-amber-500" size={14} />
          <span className="text-sm text-slate-500">ກຳລັງໂຫຼດ...</span>
        </div>
      ) : !data || filteredRows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 rounded-lg glass">
          <FaListUl className="text-slate-300 text-3xl mb-2" />
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">ບໍ່ມີຂໍ້ມູນ</p>
          <p className="text-xs text-slate-400 mt-1">ລອງປ່ຽນຊ່ວງວັນທີ</p>
        </div>
      ) : (
        <div className="space-y-3">
          {grouped.map((g) => (
            <div key={g.key} className="rounded-lg glass overflow-hidden">
              <div className="px-5 py-3 bg-amber-500/10 border-b border-slate-200/30 dark:border-white/5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">{g.sub}</p>
                  <p className="text-sm font-bold text-slate-800 dark:text-white truncate">{g.label}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-600/15 px-2.5 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-400 tabular-nums">
                    <FaFileInvoice size={9} /> {fmtNum(g.bills)} ບິນ
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2.5 py-0.5 text-[10px] font-bold text-sky-700 dark:text-sky-400 tabular-nums">
                    <FaBoxOpen size={9} /> {fmtNum(g.items)} ລາຍການ
                  </span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-white/30 dark:bg-white/5 text-[10px] font-semibold uppercase tracking-wider text-slate-500 border-b border-slate-200/30 dark:border-white/5">
                      <th className="px-3 py-2 text-left w-8" />
                      <th className="px-3 py-2 text-left w-10">#</th>
                      <th className="px-3 py-2 text-left">ເລກບິນ</th>
                      <th className="px-3 py-2 text-left">ລູກຄ້າ</th>
                      {groupBy !== "department" && (
                        <th className="px-3 py-2 text-left">ພະແນກ</th>
                      )}
                      {groupBy !== "transport" && (
                        <th className="px-3 py-2 text-left">ຂົນສົ່ງ</th>
                      )}
                      <th className="px-3 py-2 text-left">ວັນຈັດສົ່ງ</th>
                      <th className="px-3 py-2 text-right">ລາຍການ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200/30 dark:divide-white/5">
                    {g.rows.map((r, i) => {
                      const isOpen = expandedDoc === r.doc_no;
                      const isLoading = loadingDoc === r.doc_no;
                      const products = productsByDoc[r.doc_no];
                      const colSpan = 6 + (groupBy !== "department" ? 1 : 0) + (groupBy !== "transport" ? 1 : 0);
                      return (
                        <Fragment key={`${r.doc_no}-${i}`}>
                          <tr
                            className={`cursor-pointer hover:bg-white/30 dark:hover:bg-white/5 ${
                              isOpen ? "bg-amber-500/5" : ""
                            }`}
                            onClick={() => toggleDetails(r.doc_no)}
                          >
                            <td className="px-3 py-2 text-slate-400">
                              {isLoading ? (
                                <FaSpinner className="animate-spin" size={10} />
                              ) : isOpen ? (
                                <FaChevronDown size={10} />
                              ) : (
                                <FaChevronRight size={10} />
                              )}
                            </td>
                            <td className="px-3 py-2 text-[10px] text-slate-400 tabular-nums">{i + 1}</td>
                            <td className="px-3 py-2 text-xs font-bold text-slate-900 dark:text-white">
                              {r.doc_no}
                            </td>
                            <td className="px-3 py-2 text-xs text-slate-700 dark:text-slate-200 truncate max-w-[200px]" title={r.customer}>
                              {r.customer}
                            </td>
                            {groupBy !== "department" && (
                              <td className="px-3 py-2 text-xs text-slate-600">
                                <span className="inline-flex items-center gap-1">
                                  <FaBuilding size={9} className="text-emerald-500" />
                                  {r.department}
                                </span>
                              </td>
                            )}
                            {groupBy !== "transport" && (
                              <td className="px-3 py-2 text-xs text-slate-600">
                                <span className="inline-flex items-center gap-1">
                                  <FaTruck size={9} className="text-sky-500" />
                                  {r.transport}
                                </span>
                              </td>
                            )}
                            <td className="px-3 py-2 text-xs text-slate-600 whitespace-nowrap">
                              {r.send_date_display}
                            </td>
                            <td className="px-3 py-2 text-xs text-right tabular-nums font-semibold text-amber-700 dark:text-amber-400">
                              {fmtNum(r.remaining_count)}
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="bg-amber-500/[0.04]">
                              <td colSpan={colSpan} className="px-5 py-3">
                                {isLoading ? (
                                  <div className="flex items-center gap-2 text-xs text-slate-500 py-2">
                                    <FaSpinner className="animate-spin" size={11} /> ກຳລັງໂຫຼດລາຍລະອຽດ...
                                  </div>
                                ) : !products || products.length === 0 ? (
                                  <div className="text-xs text-slate-400 py-2">ບໍ່ມີລາຍການສິນຄ້າ</div>
                                ) : (
                                  <div className="rounded-md border border-slate-200/40 dark:border-white/5 bg-white/60 dark:bg-white/5 divide-y divide-slate-200/30 dark:divide-white/5">
                                    {products.map((p, pi) => (
                                      <div key={`${p.item_code}-${pi}`} className="px-3 py-1.5 flex items-center gap-2 text-[11px]">
                                        <FaBox size={9} className="text-amber-500 shrink-0" />
                                        <span className="text-[10px] text-slate-400 tabular-nums w-6">{pi + 1}</span>
                                        <span className="font-mono text-[10px] text-slate-500">{p.item_code}</span>
                                        <span className="flex-1 text-slate-700 dark:text-slate-300 truncate" title={p.item_name}>
                                          {p.item_name || p.item_code}
                                        </span>
                                        <span className="tabular-nums font-semibold text-amber-700 dark:text-amber-400">
                                          {Number(p.qty).toLocaleString("en-US")}
                                        </span>
                                        <span className="text-[10px] text-slate-400 shrink-0">{p.unit_code}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
