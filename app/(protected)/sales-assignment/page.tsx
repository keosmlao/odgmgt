"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, ChevronDown, ChevronRight, X, Users, MapPin, Calendar } from "lucide-react";
import api from "@/service/api";
import { useLanguage } from "@/context/LanguageContext";

const MONTHS = [
  { v: 1, l: "Jan" }, { v: 2, l: "Feb" }, { v: 3, l: "Mar" }, { v: 4, l: "Apr" },
  { v: 5, l: "May" }, { v: 6, l: "Jun" }, { v: 7, l: "Jul" }, { v: 8, l: "Aug" },
  { v: 9, l: "Sep" }, { v: 10, l: "Oct" }, { v: 11, l: "Nov" }, { v: 12, l: "Dec" },
];
const fmt = (v: number) => v > 0 ? v.toLocaleString("en-US") : "–";

interface Assignment {
  bu_code: string | number;
  sale_id: string | number;
  province_code: string | number;
  district_code?: string | null;
  month: number;
  target_amount?: number | null;
  sale_name?: string;
}
interface SalesUser { id: string | number; name?: string; code?: string }
interface Province { code: string | number; name_1?: string; name?: string }
interface District { code: string | number; name_1?: string; name?: string }
interface BusinessUnit { code: string | number; name_1?: string; name?: string }
interface Channel { code: string | number; name_1?: string; name?: string }

interface BuildNode {
  key: string;
  name: string;
  total: number;
  months: number[];
  children: Record<string, BuildNode> | null;
}
interface TreeNode {
  key: string;
  name: string;
  total: number;
  months: number[];
  children: TreeNode[] | null;
}

interface LevelStyle { bg?: string; text?: string; badge?: string }
interface TreeRowsProps {
  node: TreeNode;
  level: number;
  expanded: Set<string>;
  toggle: (key: string) => void;
  lvl: LevelStyle[];
  letters: string[];
  indents: string[];
}

export default function SalesAssignment() {
  const { t } = useLanguage();
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [users, setUsers] = useState<SalesUser[]>([]);
  const [provinces, setProvinces] = useState<Province[]>([]);
  const [districts, setDistricts] = useState<District[]>([]);
  const [buList, setBuList] = useState<BusinessUnit[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [drawer, setDrawer] = useState(false);
  const [form, setForm] = useState({ saleId: "", saleName: "", buCode: "", provinceCodes: [] as string[], districtCode: "ALL" as string | string[], channelCodes: [] as string[], months: [] as number[] });

  const loadAll = async () => {
    setLoading(true);
    try {
      const [a, u, p, b, c] = await Promise.all([api.get("/sales-assignments"), api.get("/sales-users"), api.get("/provinces"), api.get("/bu"), api.get("/sale-channel")]);
      setAssignments(a.data?.data || []); setUsers(u.data?.data || []); setProvinces(p.data?.data || []); setBuList(b.data?.data || []); setChannels(c.data?.data || []);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };
  useEffect(() => { loadAll(); }, []);

  const provMap = useMemo(() => new Map(provinces.map((p: Province) => [String(p.code), p.name_1 || p.name])), [provinces]);
  const buMap = useMemo(() => new Map(buList.map((b: BusinessUnit) => [String(b.code), b.name_1 || b.name])), [buList]);

  // Build pivot tree: BU → Sale → Province → District (with monthly columns)
  const tree = useMemo(() => {
    const root: Record<string, BuildNode> = {};
    for (const item of assignments) {
      const bk = String(item.bu_code), sk = String(item.sale_id), pk = String(item.province_code), dk = item.district_code || "ALL";
      const m = Number(item.month), val = Number(item.target_amount || 0);
      if (!root[bk]) root[bk] = { key: bk, name: buMap.get(bk) || bk, total: 0, months: new Array(13).fill(0), children: {} };
      root[bk].total += val; root[bk].months[m] += val;
      const bu = root[bk];
      if (!bu.children![sk]) bu.children![sk] = { key: `${bk}-${sk}`, name: item.sale_name || "Unknown", total: 0, months: new Array(13).fill(0), children: {} };
      bu.children![sk].total += val; bu.children![sk].months[m] += val;
      const sale = bu.children![sk];
      if (!sale.children![pk]) sale.children![pk] = { key: `${bk}-${sk}-${pk}`, name: provMap.get(pk) || pk, total: 0, months: new Array(13).fill(0), children: {} };
      sale.children![pk].total += val; sale.children![pk].months[m] += val;
      const prov = sale.children![pk];
      if (!prov.children![dk]) prov.children![dk] = { key: `${bk}-${sk}-${pk}-${dk}`, name: dk === "ALL" ? t("app.all") : dk, total: 0, months: new Array(13).fill(0), children: null };
      prov.children![dk].total += val; prov.children![dk].months[m] += val;
    }
    const toArr = (o: Record<string, BuildNode>): BuildNode[] =>
      Object.values(o).sort((a, b) => b.total - a.total);
    return toArr(root).map((bu) => ({ ...bu, children: toArr(bu.children!).map((s) => ({ ...s, children: toArr(s.children!).map((p) => ({ ...p, children: toArr(p.children!) })) })) })) as unknown as TreeNode[];
  }, [assignments, buMap, provMap, t]);

  const toggle = (key: string) => setExpanded(prev => { const n = new Set(prev); if (n.has(key)) { n.delete(key); } else { n.add(key); } return n; });
  const expandAll = () => { if (expanded.size > 0) { setExpanded(new Set()); } else { const all = new Set<string>(); tree.forEach((bu) => { all.add(bu.key); bu.children!.forEach((s) => { all.add(s.key); s.children!.forEach((p) => all.add(p.key)); }); }); setExpanded(all); } };

  const isCapital = (codes: string[]) => codes.length === 1 && (codes[0] === "01" || (provMap.get(codes[0]) || "").includes("Capital"));
  const onProvChange = async (vals: string[]) => {
    setForm(f => ({ ...f, provinceCodes: vals, districtCode: "ALL" }));
    if (vals.length === 1 && isCapital(vals)) { try { const r = await api.get("/amphur", { params: { province_code: vals[0] } }); setDistricts(r.data?.data || []); } catch { setDistricts([]); } }
    else setDistricts([]);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.saleId || !form.buCode || !form.provinceCodes.length || !form.months.length) return;
    setSubmitting(true);
    try {
      const dists = form.provinceCodes.length === 1 && isCapital(form.provinceCodes) ? (Array.isArray(form.districtCode) ? form.districtCode : [form.districtCode]) : ["ALL"];
      const tasks = form.provinceCodes.flatMap(prov => form.months.flatMap(m => dists.map(dist =>
        api.post("/sales-assignments", { sale_id: form.saleId, sale_name: form.saleName, bu_code: form.buCode, province_code: prov, district_code: dist, channel_codes: form.channelCodes, month: m })
      )));
      await Promise.all(tasks);
      await loadAll();
      setDrawer(false);
      setForm({ saleId: "", saleName: "", buCode: "", provinceCodes: [], districtCode: "ALL", channelCodes: [], months: [] });
    } catch { alert("Error saving"); }
    finally { setSubmitting(false); }
  };

  const grandTotal = tree.reduce((s: number, b) => s + b.total, 0);

  // Level styles
  const lvl = [
    {}, // unused
    { bg: "bg-slate-50 dark:bg-slate-800/50", text: "font-semibold text-slate-900 dark:text-white", badge: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" },
    { bg: "bg-white dark:bg-slate-900", text: "font-medium text-blue-600 dark:text-blue-400", badge: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400" },
    { bg: "bg-white dark:bg-slate-900", text: "font-medium text-slate-600 dark:text-slate-300", badge: "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400" },
    { bg: "bg-white dark:bg-slate-900", text: "text-slate-500 dark:text-slate-400", badge: "bg-slate-50 text-slate-400 dark:bg-slate-800 dark:text-slate-500" },
  ];
  const letters = ["", "B", "S", "P", "D"];
  const indents = ["", "pl-3", "pl-8", "pl-14", "pl-20"];

  const sel = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200";

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950" style={{ fontFamily: '"Noto Sans Lao","Noto Sans",system-ui,sans-serif' }}>

      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-slate-200/50 bg-white/80 backdrop-blur-xl dark:border-slate-800/50 dark:bg-slate-950/80">
        <div className="flex items-center justify-between px-5 py-3 lg:px-6">
          <div>
            <h1 className="text-base font-semibold text-slate-900 dark:text-white">Sales Assignment</h1>
            <p className="text-xs text-slate-500">BU → Employee → Province → District</p>
          </div>
          <div className="flex gap-2">
            <button onClick={expandAll} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
              {expanded.size > 0 ? "Collapse" : "Expand"}
            </button>
            <button onClick={() => setDrawer(true)} className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
              <Plus size={14} /> Add
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1480px] px-5 py-5 lg:px-6">

        {/* Summary cards */}
        <div className="mb-4 grid grid-cols-3 gap-3">
          <div className="rounded-xl border border-slate-200/70 bg-white p-4 shadow-sm dark:border-slate-800/70 dark:bg-slate-900">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Total Assignments</p>
            <p className="mt-1 text-xl font-bold text-slate-900 dark:text-white">{assignments.length}</p>
          </div>
          <div className="rounded-xl border border-slate-200/70 bg-white p-4 shadow-sm dark:border-slate-800/70 dark:bg-slate-900">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Grand Total</p>
            <p className="mt-1 text-xl font-bold text-blue-600 dark:text-blue-400">{grandTotal.toLocaleString("en-US")}</p>
          </div>
          <div className="rounded-xl border border-slate-200/70 bg-white p-4 shadow-sm dark:border-slate-800/70 dark:bg-slate-900">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Business Units</p>
            <p className="mt-1 text-xl font-bold text-slate-900 dark:text-white">{tree.length}</p>
          </div>
        </div>

        {/* Pivot Table */}
        <div className="overflow-hidden rounded-xl border border-slate-200/70 bg-white shadow-sm dark:border-slate-800/70 dark:bg-slate-900">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-900 text-white dark:bg-slate-800">
                  <th className="sticky left-0 z-10 bg-slate-900 px-4 py-2.5 text-left font-medium dark:bg-slate-800" style={{ minWidth: 280 }}>Structure</th>
                  <th className="border-l border-slate-700 px-2 py-2.5 text-right font-medium" style={{ minWidth: 80 }}>Total</th>
                  {MONTHS.map(m => <th key={m.v} className="px-2 py-2.5 text-right font-medium" style={{ minWidth: 64 }}>{m.l}</th>)}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={14} className="py-16 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-blue-500" /></td></tr>
                ) : tree.length === 0 ? (
                  <tr><td colSpan={14} className="py-16 text-center text-slate-400">{t("label.noData")}</td></tr>
                ) : tree.map((bu) => (
                  <TreeRows key={bu.key} node={bu} level={1} expanded={expanded} toggle={toggle} lvl={lvl} letters={letters} indents={indents} />
                ))}
              </tbody>
              {!loading && tree.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold dark:border-slate-700 dark:bg-slate-800">
                    <td className="sticky left-0 z-10 bg-slate-50 px-4 py-3 text-sm text-slate-900 dark:bg-slate-800 dark:text-white">Grand Total</td>
                    <td className="border-l border-slate-200 px-2 py-3 text-right text-sm font-bold text-blue-600 dark:border-slate-700 dark:text-blue-400">{fmt(grandTotal)}</td>
                    {MONTHS.map(m => <td key={m.v} className="px-2 py-3 text-right tabular-nums text-slate-500">{fmt(tree.reduce((s: number, b) => s + b.months[m.v], 0))}</td>)}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      </main>

      {/* ══ Drawer ══ */}
      {drawer && (
        <>
          <div onClick={() => setDrawer(false)} className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm" />
          <div className="fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-white shadow-2xl dark:bg-slate-900 md:w-[440px]">
            {/* Drawer header */}
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-800">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Add Assignment</h2>
                <p className="text-[11px] text-slate-500">ມອບໝາຍພື້ນທີ່ໃຫ້ພະນັກງານຂາຍ</p>
              </div>
              <button onClick={() => setDrawer(false)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><X size={16} /></button>
            </div>

            {/* Drawer form */}
            <form id="assign-form" onSubmit={submit} className="flex-1 space-y-5 overflow-y-auto p-5">
              {/* Section 1: Main */}
              <div>
                <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400"><Users size={12} /> Main Info</div>
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">Business Unit *</label>
                    <select value={form.buCode} onChange={e => setForm(f => ({ ...f, buCode: e.target.value }))} className={sel}>
                      <option value="">Select...</option>
                      {buList.map((b) => <option key={b.code} value={b.code}>{b.name_1 || b.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">Sales Person *</label>
                    <select value={form.saleId} onChange={e => { const u = users.find((u) => String(u.id) === e.target.value); setForm(f => ({ ...f, saleId: e.target.value, saleName: u?.name || u?.code || "" })); }} className={sel}>
                      <option value="">Select...</option>
                      {users.map((u) => <option key={u.id} value={u.id}>{u.name || u.code}</option>)}
                    </select>
                  </div>
                </div>
              </div>

              {/* Section 2: Area */}
              <div>
                <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400"><MapPin size={12} /> Area</div>
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">Province * <span className="text-slate-400">(Ctrl/Cmd to multi-select)</span></label>
                    <select multiple value={form.provinceCodes} onChange={e => onProvChange(Array.from(e.target.selectedOptions, o => o.value))} className={`${sel} h-28`}>
                      {provinces.map((p) => <option key={p.code} value={p.code}>{p.name_1}</option>)}
                    </select>
                  </div>
                  {districts.length > 0 && (
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">District (Capital)</label>
                      <select multiple value={Array.isArray(form.districtCode) ? form.districtCode : [form.districtCode]} onChange={e => { const v = Array.from(e.target.selectedOptions, o => o.value); setForm(f => ({ ...f, districtCode: v.includes("ALL") ? "ALL" : v })); }} className={`${sel} h-20`}>
                        <option value="ALL">{t("app.all")}</option>
                        {districts.map((d) => <option key={d.code} value={d.code}>{d.name_1}</option>)}
                      </select>
                    </div>
                  )}
                </div>
              </div>

              {/* Section 3: Time & Channel */}
              <div>
                <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400"><Calendar size={12} /> Time & Channel</div>
                <div className="space-y-3">
                  <div>
                    <label className="mb-2 block text-xs font-medium text-slate-600 dark:text-slate-300">Months *</label>
                    <div className="grid grid-cols-6 gap-1.5">
                      {MONTHS.map(m => (
                        <button type="button" key={m.v} onClick={() => setForm(f => ({ ...f, months: f.months.includes(m.v) ? f.months.filter(x => x !== m.v) : [...f.months, m.v] }))}
                          className={`rounded-lg py-2 text-xs font-medium transition-colors ${form.months.includes(m.v) ? "bg-blue-600 text-white" : "border border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"}`}>
                          {m.l}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">Sales Channel</label>
                    <select multiple value={form.channelCodes} onChange={e => setForm(f => ({ ...f, channelCodes: Array.from(e.target.selectedOptions, o => o.value) }))} className={`${sel} h-24`}>
                      {channels.map((c) => <option key={c.code} value={c.code}>{c.name_1}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            </form>

            {/* Drawer footer */}
            <div className="border-t border-slate-200 p-5 dark:border-slate-800">
              <button form="assign-form" disabled={submitting || !form.saleId || !form.buCode || !form.provinceCodes.length || !form.months.length}
                className="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                {submitting ? "Processing..." : "Save Assignment"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ── Recursive tree row component ── */
function TreeRows({ node, level, expanded, toggle, lvl, letters, indents }: TreeRowsProps) {
  const isOpen = expanded.has(node.key);
  const hasKids = node.children && node.children.length > 0;
  const s = lvl[level] || lvl[4];

  return (
    <>
      <tr onClick={() => hasKids && toggle(node.key)} className={`cursor-pointer border-b border-slate-100 transition-colors hover:bg-blue-50/50 dark:border-slate-800 dark:hover:bg-blue-900/10 ${s.bg}`}>
        <td className={`sticky left-0 z-10 py-2 pr-4 ${s.bg} border-r border-slate-100 dark:border-slate-800`}>
          <div className={`flex items-center gap-2 ${indents[level]}`}>
            {hasKids ? (isOpen ? <ChevronDown size={12} className="text-slate-400" /> : <ChevronRight size={12} className="text-slate-400" />) : <span className="w-3" />}
            <span className={`flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold ${s.badge}`}>{letters[level]}</span>
            <span className={`truncate text-xs ${s.text}`}>{node.name}</span>
          </div>
        </td>
        <td className={`border-l border-slate-100 px-2 py-2 text-right tabular-nums font-semibold dark:border-slate-800 ${level === 1 ? "text-slate-900 dark:text-white" : "text-slate-600 dark:text-slate-300"}`}>{fmt(node.total)}</td>
        {MONTHS.map(m => (
          <td key={m.v} className={`px-2 py-2 text-right tabular-nums ${node.months[m.v] > 0 ? "text-slate-700 dark:text-slate-300" : "text-slate-300 dark:text-slate-700"}`}>{fmt(node.months[m.v])}</td>
        ))}
      </tr>
      {isOpen && hasKids && node.children!.map((child) => (
        <TreeRows key={child.key} node={child} level={level + 1} expanded={expanded} toggle={toggle} lvl={lvl} letters={letters} indents={indents} />
      ))}
    </>
  );
}
