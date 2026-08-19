"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, ChevronDown, ChevronRight, X, Users, MapPin, Calendar, Trash2 } from "lucide-react";
import api from "@/service/api";
import { SearchSelect, MultiSearchSelect, type Option } from "@/components/SearchSelect";
import { useLanguage } from "@/context/LanguageContext";

const MONTHS = [
  { v: 1, l: "Jan" }, { v: 2, l: "Feb" }, { v: 3, l: "Mar" }, { v: 4, l: "Apr" },
  { v: 5, l: "May" }, { v: 6, l: "Jun" }, { v: 7, l: "Jul" }, { v: 8, l: "Aug" },
  { v: 9, l: "Sep" }, { v: 10, l: "Oct" }, { v: 11, l: "Nov" }, { v: 12, l: "Dec" },
];
const fmt = (v: number) => v > 0 ? v.toLocaleString("en-US") : "–";

/**
 * The month being lived through. The grid is a whole year wide, and the column
 * that decides today's decisions is somewhere in the middle of it.
 */
const THIS_MONTH = new Date().getMonth() + 1;
/** Marks the live column down the whole table, header and totals included. */
/** Sums one month across the BU rows, for either metric. */
const monthTotal = (tree: any[], month: number, key: "months" | "actMonths") =>
  tree.reduce((sum: number, bu: any) => sum + (bu[key][month] || 0), 0);

const nowCol = (month: number) =>
  month === THIS_MONTH ? " bg-[var(--info-bg)]/70 border-x border-[var(--brand)]/25" : "";

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
  const [deleting, setDeleting] = useState(false);
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
  const chanMap = useMemo(() => new Map(channels.map((c: any) => [String(c.code), c.name_1 || c.name || String(c.code)])), [channels]);
  // sale_id is an odg_employee.employee_code, so the roster answers "what is
  // this person's job" without the assignment table having to carry it.
  const posMap = useMemo(
    () => new Map(users.map((u: any) => [String(u.id), { title: u.position || "", isManager: Boolean(u.is_manager) }])),
    [users],
  );
  const buMap = useMemo(() => new Map(buList.map((b: any) => [String(b.code), b.name_1 || b.name])), [buList]);

  // Build pivot tree: BU → Sale → Province → District (with monthly columns)
  const tree = useMemo(() => {
    const root: any = {};
    /**
     * Channels roll up the tree, so a seller's row answers "which channels does
     * this person cover" without expanding to the leaf. An assignment with no
     * channels means every channel, and that has to stay distinguishable from
     * one that names them — hence the separate `allCh` flag rather than an
     * empty set, which would read the same as "none".
     */
    const mark = (node: any, codes: string[]) => {
      if (!codes.length) node.allCh = true;
      else for (const code of codes) node.ch.add(String(code));
    };
    /**
     * A manager's ເປົ້າ is a roll-up of the plan their sellers hold, not a target
     * of their own, so it is accumulated in `roll` and never in `total`. Adding
     * it to `total` would count the same plan twice — once on the manager, once
     * on the seller who actually carries it.
     */
    const addRoll = (node: any, month: number, amount: number) => {
      node.roll += amount;
      node.rollMonths[month] += amount;
    };
    const blank = () => ({
      total: 0, months: new Array(13).fill(0),
      roll: 0, rollMonths: new Array(13).fill(0),
      actual: 0, actMonths: new Array(13).fill(0),
      ids: [], ch: new Set(),
    });
    for (const item of assignments) {
      const bk = String(item.bu_code), sk = String(item.sale_id), pk = String(item.province_code), dk = item.district_code || "ALL";
      const m = Number(item.month), val = Number(item.target_amount || 0), act = Number(item.actual_amount || 0);
      const roll = Number(item.rollup_amount || 0);
      const codes: string[] = (item.channel_codes || []).map(String).filter(Boolean);
      // Every node keeps the assignment rows underneath it, so a delete button
      // removes exactly what its row shows — no re-deriving the filter later.
      if (!root[bk]) root[bk] = { key: bk, name: buMap.get(bk) || bk, ...blank(), children: {} };
      root[bk].total += val; root[bk].months[m] += val; root[bk].actual += act; root[bk].actMonths[m] += act; root[bk].ids.push(item.id); mark(root[bk], codes);
      const bu = root[bk];
      if (!bu.children[sk]) bu.children[sk] = { key: `${bk}-${sk}`, name: item.sale_name || "Unknown", role: posMap.get(sk), ...blank(), children: {} };
      bu.children[sk].total += val; bu.children[sk].months[m] += val; bu.children[sk].actual += act; bu.children[sk].actMonths[m] += act; bu.children[sk].ids.push(item.id); mark(bu.children[sk], codes);
      // The roll-up stops at the person: a BU row is the plan, not the plan plus
      // its own manager's copy of it.
      addRoll(bu.children[sk], m, roll);
      const sale = bu.children[sk];
      if (!sale.children[pk]) sale.children[pk] = { key: `${bk}-${sk}-${pk}`, name: pk === "ALL" ? t("assignment.allProvinces") : provMap.get(pk) || pk, ...blank(), children: {} };
      sale.children[pk].total += val; sale.children[pk].months[m] += val; sale.children[pk].actual += act; sale.children[pk].actMonths[m] += act; sale.children[pk].ids.push(item.id); mark(sale.children[pk], codes);
      addRoll(sale.children[pk], m, roll);
      const prov = sale.children[pk];
      if (!prov.children[dk]) prov.children[dk] = { key: `${bk}-${sk}-${pk}-${dk}`, name: dk === "ALL" ? t("app.all") : (item.district_name || dk), ...blank(), children: null };
      prov.children[dk].total += val; prov.children[dk].months[m] += val; prov.children[dk].actual += act; prov.children[dk].actMonths[m] += act; prov.children[dk].ids.push(item.id); mark(prov.children[dk], codes);
      addRoll(prov.children[dk], m, roll);
    }
    // Resolve the codes to names once here, so the row component just renders.
    const label = (n: any) => ({
      ...n,
      chNames: n.allCh
        ? [t("assignment.everyChannel")]
        : [...n.ch].map((c: any) => chanMap.get(String(c)) || String(c)).sort(),
    });
    const toArr = (o: any) => Object.values(o).sort((a: any, b: any) => b.total - a.total).map(label);
    return toArr(root).map((bu: any) => ({ ...bu, children: toArr(bu.children).map((s: any) => ({ ...s, children: toArr(s.children).map((p: any) => ({ ...p, children: toArr(p.children) })) })) }));
  }, [assignments, buMap, provMap, chanMap, posMap, t]);

  const toggle = (key: string) => setExpanded(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const expandAll = () => { if (expanded.size > 0) { setExpanded(new Set()); } else { const all = new Set<string>(); tree.forEach((bu: any) => { all.add(bu.key); bu.children.forEach((s: any) => { all.add(s.key); s.children.forEach((p: any) => all.add(p.key)); }); }); setExpanded(all); } };

  const isCapital = (codes: string[]) => codes.length === 1 && (codes[0] === "01" || (provMap.get(codes[0]) || "").includes("Capital"));
  const onProvChange = async (vals: string[]) => {
    // A manager covering the whole country is one row with province_code='ALL',
    // not eighteen rows — the reports already read 'ALL' as "any province", and
    // one row per province would have to be re-cut every time a province is
    // added. So ALL replaces the individual picks rather than joining them.
    const next = vals.includes("ALL") ? ["ALL"] : vals;
    setForm(f => ({ ...f, provinceCodes: next, districtCode: "ALL" }));
    if (next.length === 1 && isCapital(next)) { try { const r = await api.get("/amphur", { params: { province_code: next[0] } }); setDistricts(r.data?.data || []); } catch { setDistricts([]); } }
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

  /**
   * Removes every assignment row beneath a node — "this seller, in this BU" is
   * twelve rows, one per month, and deleting them one at a time was only
   * possible by calling the API by hand.
   */
  const removeNode = async (node: any) => {
    const ids: number[] = [...new Set(node.ids as number[])].filter(Boolean);
    if (!ids.length || deleting) return;
    if (!window.confirm(`${t("assignment.confirmDelete")}\n\n${node.name} — ${ids.length} ${t("assignment.rows")}`)) return;
    setDeleting(true);
    try {
      await Promise.all(ids.map(id => api.delete(`/sales-assignments/${id}`)));
      await loadAll();
    } catch { alert(t("app.error")); }
    finally { setDeleting(false); }
  };

  const grandTotal = tree.reduce((s: number, b: any) => s + b.total, 0);
  const labels = { target: t("kpi.target"), rollup: `${t("kpi.target")} (ລວມ)` };

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

  // Option lists for the drawer's dropdowns. The seller carries their code in
  // the label: the roster repeats names, and the code is what gets stored.
  const buOptions: Option[] = useMemo(
    () => buList.map((b: any) => ({ value: String(b.code), label: b.name_1 || b.name || String(b.code) })),
    [buList],
  );
  const userOptions: Option[] = useMemo(
    () => users.map((u: any) => ({ value: String(u.id), label: `${u.code} · ${u.name || u.code}` })),
    [users],
  );
  const provinceOptions: Option[] = useMemo(
    () => [
      { value: "ALL", label: t("assignment.allProvinces") },
      ...provinces.map((p: any) => ({ value: String(p.code), label: p.name_1 || String(p.code) })),
    ],
    [provinces, t],
  );
  const districtOptions: Option[] = useMemo(
    () => [
      { value: "ALL", label: t("app.all") },
      ...districts.map((d: any) => ({ value: String(d.code), label: d.name_1 || String(d.code) })),
    ],
    [districts, t],
  );
  const channelOptions: Option[] = useMemo(
    () => channels.map((c: any) => ({ value: String(c.code), label: c.name_1 || String(c.code) })),
    [channels],
  );

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
        <div className="mb-4 grid grid-cols-2 gap-3">
          <div className="rounded-[var(--r-md)] border border-[var(--line)]/70 bg-[var(--surface)] p-4 shadow-sm /70">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">Total Assignments</p>
            <p className="mt-1 text-xl font-bold text-[var(--ink)]">{assignments.length}</p>
          </div>
          <div className="rounded-[var(--r-md)] border border-[var(--line)]/70 bg-[var(--surface)] p-4 shadow-sm /70">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">{t("kpi.target")}</p>
            <p className="mt-1 text-xl font-bold text-[var(--brand)]">{grandTotal.toLocaleString("en-US")}</p>
          </div>
        </div>

        {/* Pivot Table */}
        <div className="overflow-hidden rounded-[var(--r-md)] border border-[var(--line)]/70 bg-[var(--surface)] shadow-sm /70">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[var(--brand-deep)] text-white">
                  <th className="sticky left-0 z-10 bg-[var(--brand-deep)] px-4 py-2.5 text-left font-medium" style={{ minWidth: 280 }}>Structure</th>
                  <th className="sticky left-[280px] z-10 bg-[var(--brand-deep)] px-3 py-2.5 text-left font-medium" style={{ minWidth: 74 }} />
                  <th className="border-l border-[var(--line)] px-2 py-2.5 text-right font-medium" style={{ minWidth: 92 }}>Total</th>
                  {MONTHS.map(m => (
                    <th
                      key={m.v}
                      className={`px-2 py-2.5 text-right font-medium${m.v === THIS_MONTH ? " border-x border-white/25 bg-white/15" : ""}`}
                      style={{ minWidth: 64 }}
                    >
                      {m.l}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={15} className="py-16 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-[var(--brand)]" /></td></tr>
                ) : tree.length === 0 ? (
                  <tr><td colSpan={15} className="py-16 text-center text-[var(--muted)]">{t("label.noData")}</td></tr>
                ) : tree.map((bu: any) => (
                  <TreeRows key={bu.key} node={bu} level={1} expanded={expanded} toggle={toggle} lvl={lvl} letters={letters} indents={indents} onDelete={removeNode} deleting={deleting} labels={labels} />
                ))}
              </tbody>
              {!loading && tree.length > 0 && (
                <tfoot className="border-t-2 border-[var(--line)] bg-[var(--surface-2)] font-semibold">
                  {/* Same single row as the body, so the eye runs straight down. */}
                  <tr>
                    <td className="sticky left-0 z-10 bg-[var(--surface-2)] px-4 align-top text-sm text-[var(--ink)]">
                      <span className="inline-block py-3">Grand Total</span>
                    </td>
                    <td className="sticky left-[280px] z-10 bg-[var(--surface-2)] px-3 py-1.5 text-left text-[10px] font-medium text-[var(--muted)]">{labels.target}</td>
                    <td className="border-l border-[var(--line)] px-2 py-1.5 text-right tabular-nums font-bold text-[var(--brand)]">{fmt(grandTotal)}</td>
                    {MONTHS.map(m => <td key={m.v} className={`px-2 py-1.5 text-right tabular-nums text-[var(--ink)]${nowCol(m.v)}`}>{fmt(monthTotal(tree, m.v, "months"))}</td>)}
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
                    <SearchSelect
                      value={form.buCode}
                      options={buOptions}
                      onChange={v => setForm(f => ({ ...f, buCode: v }))}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--ink-soft)]">Sales Person *</label>
                    <SearchSelect
                      value={form.saleId}
                      options={userOptions}
                      placeholder="ພິມຊື່ ຫຼື ລະຫັດ..."
                      onChange={v => {
                        const u = users.find((u: any) => String(u.id) === v);
                        setForm(f => ({ ...f, saleId: v, saleName: u?.name || u?.code || "" }));
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Section 2: Area */}
              <div>
                <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]"><MapPin size={12} /> Area</div>
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--ink-soft)]">Province *</label>
                    <MultiSearchSelect
                      values={form.provinceCodes}
                      options={provinceOptions}
                      placeholder="ເລືອກແຂວງ..."
                      onChange={onProvChange}
                    />
                  </div>
                  {districts.length > 0 && (
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[var(--ink-soft)]">District (Capital)</label>
                      <MultiSearchSelect
                        values={Array.isArray(form.districtCode) ? form.districtCode : [form.districtCode]}
                        options={districtOptions}
                        placeholder={t("app.all")}
                        // Picking ALL means the whole province, so it replaces any
                        // districts rather than sitting alongside them.
                        onChange={v => setForm(f => ({ ...f, districtCode: (v.includes("ALL") || !v.length ? "ALL" : v) as any }))}
                      />
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
                    <MultiSearchSelect
                      values={form.channelCodes}
                      options={channelOptions}
                      placeholder={t("assignment.allChannels")}
                      onChange={v => setForm(f => ({ ...f, channelCodes: v }))}
                    />
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
function TreeRows({ node, level, expanded, toggle, lvl, letters, indents, onDelete, deleting, labels }: any) {
  const isOpen = expanded.has(node.key);
  const hasKids = node.children && node.children.length > 0;
  const s = lvl[level] || lvl[4];
  // Not on the BU row: "delete every assignment in ໄຟຟ້າ" is never a single
  // intent, and it is the one click nobody could undo.
  const canDelete = level >= 2 && node.ids?.length > 0;
  const click = () => hasKids && toggle(node.key);
  /**
   * A manager owns no plan of their own, so their row shows the roll-up of what
   * their sellers carry — italic and labelled differently, because it is already
   * counted inside the BU total above it and must not be read as an addition.
   */
  const isRollup = node.total === 0 && node.roll > 0;
  const shown = isRollup ? node.roll : node.total;
  const shownMonths = isRollup ? node.rollMonths : node.months;
  const numCell = "px-2 py-1.5 text-right tabular-nums";
  const metricCell = "sticky left-[280px] z-10 px-3 py-1.5 text-left text-[10px] font-medium text-[var(--muted)] whitespace-nowrap";

  return (
    <>
      {/* One row per entity: the plan alone. ຍອດຂາຍ and ບັນລຸ are off the board
          for now — the tree still reads as one line per person. */}
      <tr onClick={click} className={`group cursor-pointer border-b border-[var(--line)] transition-colors hover:bg-[var(--info-bg)]/50 dark:hover:bg-blue-900/10 ${s.bg}`}>
        <td className={`sticky left-0 z-10 py-2 pr-4 align-top ${s.bg} border-b border-r border-[var(--line-soft)]`}>
          <div className={`flex items-center gap-2 ${indents[level]}`}>
            {hasKids ? (isOpen ? <ChevronDown size={12} className="text-[var(--muted)]" /> : <ChevronRight size={12} className="text-[var(--muted)]" />) : <span className="w-3" />}
            <span className={`flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold ${s.badge}`}>{letters[level]}</span>
            <span className={`truncate text-xs ${s.text}`}>{node.name}</span>
            {/* Job title of the person responsible. A manager's scope is read
                differently from a seller's, so the two are told apart on sight. */}
            {node.role?.title && (
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold leading-none ${
                  node.role.isManager
                    ? "bg-[var(--warn-bg)] text-[var(--warn)]"
                    : "bg-[var(--info-bg)] text-[var(--brand)]"
                }`}
              >
                {node.role.title}
              </span>
            )}
            {/* Which sales channels this row covers. Rolled up from the rows
                beneath, so it reads without expanding the tree. */}
            {node.chNames?.length > 0 && (
              <span className="flex shrink-0 flex-wrap items-center gap-1">
                {node.chNames.map((name: string) => (
                  <span
                    key={name}
                    className="rounded px-1.5 py-0.5 text-[9px] font-medium leading-none bg-[var(--surface-2)] text-[var(--muted)]"
                  >
                    {name}
                  </span>
                ))}
              </span>
            )}
            {canDelete && (
              <button
                type="button"
                onClick={e => { e.stopPropagation(); onDelete(node); }}
                disabled={deleting}
                title={`${node.ids.length}`}
                className="ml-auto shrink-0 rounded p-1 text-[var(--muted)] opacity-0 transition hover:bg-[var(--neg-bg)] hover:text-[var(--neg)] focus:opacity-100 group-hover:opacity-100 disabled:opacity-40"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        </td>

        <td className={`${metricCell} ${s.bg}`}>{isRollup ? labels.rollup : labels.target}</td>
        <td className={`${numCell} border-l border-[var(--line-soft)] font-semibold ${isRollup ? "italic text-[var(--muted)]" : level === 1 ? "text-[var(--ink)]" : "text-[var(--ink-soft)]"}`}>{fmt(shown)}</td>
        {MONTHS.map(m => (
          <td key={m.v} className={`${numCell} ${isRollup ? "italic text-[var(--muted)]" : shownMonths[m.v] > 0 ? "text-[var(--ink-soft)]" : "text-[var(--muted)]"}${nowCol(m.v)}`}>{fmt(shownMonths[m.v])}</td>
        ))}
      </tr>

      {isOpen && hasKids && node.children.map((child: any) => (
        <TreeRows key={child.key} node={child} level={level + 1} expanded={expanded} toggle={toggle} lvl={lvl} letters={letters} indents={indents} onDelete={onDelete} deleting={deleting} labels={labels} />
      ))}
    </>
  );
}
