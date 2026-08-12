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

export default function SalesAssignment() {
  const { t } = useLanguage();
  const [assignments, setAssignments] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [provinces, setProvinces] = useState<any[]>([]);
  const [districts, setDistricts] = useState<any[]>([]);
  const [buList, setBuList] = useState<any[]>([]);
  const [channels, setChannels] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [drawer, setDrawer] = useState(false);
  const [form, setForm] = useState({ saleId: "", saleName: "", buCode: "", provinceCodes: [] as string[], districtCode: "ALL", channelCodes: [] as string[], months: [] as number[] });

  const loadAll = async () => {
    setLoading(true);
    try {
      const [a, u, p, b, c] = await Promise.all([api.get("/sales-assignments"), api.get("/sales-users"), api.get("/provinces"), api.get("/bu"), api.get("/sale-channel")]);
      setAssignments(a.data?.data || []); setUsers(u.data?.data || []); setProvinces(p.data?.data || []); setBuList(b.data?.data || []); setChannels(c.data?.data || []);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };
  useEffect(() => { loadAll(); }, []);

  const provMap = useMemo(() => new Map(provinces.map((p: any) => [String(p.code), p.name_1 || p.name])), [provinces]);
  const buMap = useMemo(() => new Map(buList.map((b: any) => [String(b.code), b.name_1 || b.name])), [buList]);

  // Build pivot tree: BU → Sale → Province → District (with monthly columns)
  const tree = useMemo(() => {
    const root: any = {};
    for (const item of assignments) {
      const bk = String(item.bu_code), sk = String(item.sale_id), pk = String(item.province_code), dk = item.district_code || "ALL";
      const m = Number(item.month), val = Number(item.target_amount || 0);
      if (!root[bk]) root[bk] = { key: bk, name: buMap.get(bk) || bk, total: 0, months: new Array(13).fill(0), children: {} };
      root[bk].total += val; root[bk].months[m] += val;
      const bu = root[bk];
      if (!bu.children[sk]) bu.children[sk] = { key: `${bk}-${sk}`, name: item.sale_name || "Unknown", total: 0, months: new Array(13).fill(0), children: {} };
      bu.children[sk].total += val; bu.children[sk].months[m] += val;
      const sale = bu.children[sk];
      if (!sale.children[pk]) sale.children[pk] = { key: `${bk}-${sk}-${pk}`, name: provMap.get(pk) || pk, total: 0, months: new Array(13).fill(0), children: {} };
      sale.children[pk].total += val; sale.children[pk].months[m] += val;
      const prov = sale.children[pk];
      if (!prov.children[dk]) prov.children[dk] = { key: `${bk}-${sk}-${pk}-${dk}`, name: dk === "ALL" ? t("app.all") : dk, total: 0, months: new Array(13).fill(0), children: null };
      prov.children[dk].total += val; prov.children[dk].months[m] += val;
    }
    const toArr = (o: any) => Object.values(o).sort((a: any, b: any) => b.total - a.total);
    return toArr(root).map((bu: any) => ({ ...bu, children: toArr(bu.children).map((s: any) => ({ ...s, children: toArr(s.children).map((p: any) => ({ ...p, children: toArr(p.children) })) })) }));
  }, [assignments, buMap, provMap, t]);

  const toggle = (key: string) => setExpanded(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const expandAll = () => { if (expanded.size > 0) { setExpanded(new Set()); } else { const all = new Set<string>(); tree.forEach((bu: any) => { all.add(bu.key); bu.children.forEach((s: any) => { all.add(s.key); s.children.forEach((p: any) => all.add(p.key)); }); }); setExpanded(all); } };

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

  const grandTotal = tree.reduce((s: number, b: any) => s + b.total, 0);

  // Level styles
  const lvl = [
    {}, // unused
    { bg: "bg-[var(--surface-2)] /50", text: "font-semibold text-[var(--ink)]", badge: "bg-[var(--info-bg)] text-[var(--brand)] dark:bg-blue-900/30 dark:text-blue-300" },
    { bg: "bg-[var(--surface)]", text: "font-medium text-[var(--brand)]", badge: "bg-[var(--surface-2)] text-[var(--ink-soft)]  " },
    { bg: "bg-[var(--surface)]", text: "font-medium text-[var(--ink-soft)]", badge: "bg-[var(--pos-bg)] text-[var(--pos)]  " },
    { bg: "bg-[var(--surface)]", text: "text-[var(--muted)]", badge: "bg-[var(--surface-2)] text-[var(--muted)]  " },
  ];
  const letters = ["", "B", "S", "P", "D"];
  const indents = ["", "pl-3", "pl-8", "pl-14", "pl-20"];

  const sel = "select";

  return (
    <div className="min-h-screen bg-transparent" style={{ fontFamily: '"Noto Sans Lao","Noto Sans",system-ui,sans-serif' }}>

      {/* Header */}
      <header className="page-hd flex-col !items-stretch !gap-0 !p-0">
        <div className="flex items-center justify-between px-5 py-3 lg:px-6">
          <div>
            <p className="eyebrow">Team operations</p>
            <h1 className="page-title">Sales Assignment</h1>
            <p className="page-sub">BU → Employee → Province → District</p>
          </div>
          <div className="flex gap-2">
            <button onClick={expandAll} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs font-medium text-[var(--ink-soft)] hover:bg-[var(--surface-2)]">
              {expanded.size > 0 ? "Collapse" : "Expand"}
            </button>
            <button onClick={() => setDrawer(true)} className="flex items-center gap-1 rounded-lg bg-[var(--brand-deep)] px-3 py-1.5 text-xs font-medium text-white hover:brightness-110">
              <Plus size={14} /> Add
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1480px] px-5 py-6 lg:px-8">

        {/* Summary cards */}
        <div className="mb-4 grid grid-cols-3 gap-3">
          <div className="rounded-[var(--r-md)] border border-[var(--line)]/70 bg-[var(--surface)] p-4 shadow-sm /70">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">Total Assignments</p>
            <p className="mt-1 text-xl font-bold text-[var(--ink)]">{assignments.length}</p>
          </div>
          <div className="rounded-[var(--r-md)] border border-[var(--line)]/70 bg-[var(--surface)] p-4 shadow-sm /70">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">Grand Total</p>
            <p className="mt-1 text-xl font-bold text-[var(--brand)]">{grandTotal.toLocaleString("en-US")}</p>
          </div>
          <div className="rounded-[var(--r-md)] border border-[var(--line)]/70 bg-[var(--surface)] p-4 shadow-sm /70">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">Business Units</p>
            <p className="mt-1 text-xl font-bold text-[var(--ink)]">{tree.length}</p>
          </div>
        </div>

        {/* Pivot Table */}
        <div className="overflow-hidden rounded-[var(--r-md)] border border-[var(--line)]/70 bg-[var(--surface)] shadow-sm /70">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[var(--brand-deep)] text-white">
                  <th className="sticky left-0 z-10 bg-[var(--brand-deep)] px-4 py-2.5 text-left font-medium" style={{ minWidth: 280 }}>Structure</th>
                  <th className="border-l border-[var(--line)] px-2 py-2.5 text-right font-medium" style={{ minWidth: 80 }}>Total</th>
                  {MONTHS.map(m => <th key={m.v} className="px-2 py-2.5 text-right font-medium" style={{ minWidth: 64 }}>{m.l}</th>)}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={14} className="py-16 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-[var(--brand)]" /></td></tr>
                ) : tree.length === 0 ? (
                  <tr><td colSpan={14} className="py-16 text-center text-[var(--muted)]">{t("label.noData")}</td></tr>
                ) : tree.map((bu: any) => (
                  <TreeRows key={bu.key} node={bu} level={1} expanded={expanded} toggle={toggle} lvl={lvl} letters={letters} indents={indents} />
                ))}
              </tbody>
              {!loading && tree.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 border-[var(--line)] bg-[var(--surface-2)] font-semibold">
                    <td className="sticky left-0 z-10 bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--ink)]">Grand Total</td>
                    <td className="border-l border-[var(--line)] px-2 py-3 text-right text-sm font-bold text-[var(--brand)]">{fmt(grandTotal)}</td>
                    {MONTHS.map(m => <td key={m.v} className="px-2 py-3 text-right tabular-nums text-[var(--muted)]">{fmt(tree.reduce((s: number, b: any) => s + b.months[m.v], 0))}</td>)}
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
          <div className="fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-[var(--surface)] shadow-2xl md:w-[440px]">
            {/* Drawer header */}
            <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
              <div>
                <h2 className="text-sm font-semibold text-[var(--ink)]">Add Assignment</h2>
                <p className="text-[11px] text-[var(--muted)]">ມອບໝາຍພື້ນທີ່ໃຫ້ພະນັກງານຂາຍ</p>
              </div>
              <button onClick={() => setDrawer(false)} className="rounded-lg p-1.5 text-[var(--muted)] hover:bg-[var(--surface-2)]"><X size={16} /></button>
            </div>

            {/* Drawer form */}
            <form id="assign-form" onSubmit={submit} className="flex-1 space-y-5 overflow-y-auto p-5">
              {/* Section 1: Main */}
              <div>
                <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]"><Users size={12} /> Main Info</div>
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--ink-soft)]">Business Unit *</label>
                    <select value={form.buCode} onChange={e => setForm(f => ({ ...f, buCode: e.target.value }))} className={sel}>
                      <option value="">Select...</option>
                      {buList.map((b: any) => <option key={b.code} value={b.code}>{b.name_1 || b.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--ink-soft)]">Sales Person *</label>
                    <select value={form.saleId} onChange={e => { const u = users.find((u: any) => String(u.id) === e.target.value); setForm(f => ({ ...f, saleId: e.target.value, saleName: u?.name || u?.code || "" })); }} className={sel}>
                      <option value="">Select...</option>
                      {users.map((u: any) => <option key={u.id} value={u.id}>{u.name || u.code}</option>)}
                    </select>
                  </div>
                </div>
              </div>

              {/* Section 2: Area */}
              <div>
                <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]"><MapPin size={12} /> Area</div>
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--ink-soft)]">Province * <span className="text-[var(--muted)]">(Ctrl/Cmd to multi-select)</span></label>
                    <select multiple value={form.provinceCodes} onChange={e => onProvChange(Array.from(e.target.selectedOptions, o => o.value))} className={`${sel} h-28`}>
                      {provinces.map((p: any) => <option key={p.code} value={p.code}>{p.name_1}</option>)}
                    </select>
                  </div>
                  {districts.length > 0 && (
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[var(--ink-soft)]">District (Capital)</label>
                      <select multiple value={Array.isArray(form.districtCode) ? form.districtCode : [form.districtCode]} onChange={e => { const v = Array.from(e.target.selectedOptions, o => o.value); setForm(f => ({ ...f, districtCode: v.includes("ALL") ? "ALL" : v as any })); }} className={`${sel} h-20`}>
                        <option value="ALL">{t("app.all")}</option>
                        {districts.map((d: any) => <option key={d.code} value={d.code}>{d.name_1}</option>)}
                      </select>
                    </div>
                  )}
                </div>
              </div>

              {/* Section 3: Time & Channel */}
              <div>
                <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]"><Calendar size={12} /> Time & Channel</div>
                <div className="space-y-3">
                  <div>
                    <label className="mb-2 block text-xs font-medium text-[var(--ink-soft)]">Months *</label>
                    <div className="grid grid-cols-6 gap-1.5">
                      {MONTHS.map(m => (
                        <button type="button" key={m.v} onClick={() => setForm(f => ({ ...f, months: f.months.includes(m.v) ? f.months.filter(x => x !== m.v) : [...f.months, m.v] }))}
                          className={`rounded-lg py-2 text-xs font-medium transition-colors ${form.months.includes(m.v) ? "bg-[var(--brand-deep)] text-white" : "border border-[var(--line)] text-[var(--muted)] hover:bg-[var(--surface-2)] "}`}>
                          {m.l}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--ink-soft)]">Sales Channel</label>
                    <select multiple value={form.channelCodes} onChange={e => setForm(f => ({ ...f, channelCodes: Array.from(e.target.selectedOptions, o => o.value) }))} className={`${sel} h-24`}>
                      {channels.map((c: any) => <option key={c.code} value={c.code}>{c.name_1}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            </form>

            {/* Drawer footer */}
            <div className="border-t border-[var(--line)] p-5">
              <button form="assign-form" disabled={submitting || !form.saleId || !form.buCode || !form.provinceCodes.length || !form.months.length}
                className="w-full rounded-lg bg-[var(--brand-deep)] py-2.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed">
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
function TreeRows({ node, level, expanded, toggle, lvl, letters, indents }: any) {
  const isOpen = expanded.has(node.key);
  const hasKids = node.children && node.children.length > 0;
  const s = lvl[level] || lvl[4];

  return (
    <>
      <tr onClick={() => hasKids && toggle(node.key)} className={`cursor-pointer border-b border-[var(--line-soft)] transition-colors hover:bg-[var(--info-bg)]/50 dark:hover:bg-blue-900/10 ${s.bg}`}>
        <td className={`sticky left-0 z-10 py-2 pr-4 ${s.bg} border-r border-[var(--line-soft)]`}>
          <div className={`flex items-center gap-2 ${indents[level]}`}>
            {hasKids ? (isOpen ? <ChevronDown size={12} className="text-[var(--muted)]" /> : <ChevronRight size={12} className="text-[var(--muted)]" />) : <span className="w-3" />}
            <span className={`flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold ${s.badge}`}>{letters[level]}</span>
            <span className={`truncate text-xs ${s.text}`}>{node.name}</span>
          </div>
        </td>
        <td className={`border-l border-[var(--line-soft)] px-2 py-2 text-right tabular-nums font-semibold ${level === 1 ? "text-[var(--ink)]" : "text-[var(--ink-soft)]"}`}>{fmt(node.total)}</td>
        {MONTHS.map(m => (
          <td key={m.v} className={`px-2 py-2 text-right tabular-nums ${node.months[m.v] > 0 ? "text-[var(--ink-soft)] " : "text-[var(--muted)] dark:text-[var(--ink-soft)]"}`}>{fmt(node.months[m.v])}</td>
        ))}
      </tr>
      {isOpen && hasKids && node.children.map((child: any) => (
        <TreeRows key={child.key} node={child} level={level + 1} expanded={expanded} toggle={toggle} lvl={lvl} letters={letters} indents={indents} />
      ))}
    </>
  );
}
