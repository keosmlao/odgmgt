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
// Two decimals, because a plan row shared three ways does not divide evenly and
// the third decimal of a kip is noise in a nine-digit column.
const fmt = (v: number) => v > 0 ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "–";
/** Kip runs to nine digits; a projection is a guess and does not deserve them. */
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Resolve a multi-select where ALL is exclusive of everything else.
 *
 * Which way it resolves depends on what just changed: adding a district to a
 * selection that already reads ALL means "these districts, not the whole
 * province", while adding ALL to a list of districts means the whole province.
 * Deciding on `next.includes("ALL")` alone made the district picker impossible
 * to use — it starts at ALL, so every pick fell straight back to it.
 */
const exclusiveAll = (prev: string[], next: string[]) => {
  if (!next.length) return [];
  if (next.includes("ALL") && !prev.includes("ALL")) return ["ALL"];
  const rest = next.filter(v => v !== "ALL");
  return rest.length ? rest : ["ALL"];
};

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
  // Districts keyed by province: several provinces can be assigned in one go and
  // each carries its own list, so one flat array would belong to whichever
  // province was picked last.
  const [amphurs, setAmphurs] = useState<Record<string, any[]>>({});
  const [buList, setBuList] = useState<any[]>([]);
  const [channels, setChannels] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [drawer, setDrawer] = useState(false);
  // `districts[provinceCode]` empty (or missing) means the whole province — the
  // same thing district_code = 'ALL' means in the table.
  const blankForm = { saleId: "", saleName: "", buCode: "", provinceCodes: [] as string[], districts: {} as Record<string, string[]>, channelCodes: [] as string[], months: [] as number[] };
  const [form, setForm] = useState(blankForm);

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

  // Build pivot tree: BU → Channel → Sale → Province → District (monthly columns)
  const tree = useMemo(() => {
    const root: any = {};
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
    });
    /**
     * Every assignment row a node stands for, found by BU / seller / province /
     * district and NOT by the channel branch the node is reached through.
     *
     * A row carries `channel_codes`, not one channel, so the same row appears
     * under several channels at once. Deleting only the ids that fed the branch
     * that was clicked left the row's other channels standing, and the person
     * was still on the board after being deleted. Scoping the delete to what a
     * row actually is makes it complete whichever channel it was clicked from.
     */
    const scopeIds = new Map<string, number[]>();
    const scope = (key: string, id: number) => {
      const seen = scopeIds.get(key);
      if (!seen) scopeIds.set(key, [id]);
      else if (!seen.includes(id)) seen.push(id);
    };
    const chName = (code: string) =>
      code === "ALL" ? t("assignment.everyChannel") : chanMap.get(code) || code;
    /**
     * One assignment cut into the channels its money actually landed in. The
     * server already splits ເປົ້າ by odg_sales_target.sale_channel and ຍອດຂາຍ by
     * the channel of the bill, so nothing is apportioned here — a channel row is
     * the sum of plan rows written for that channel, never a share of a lump.
     *
     * A row that owns nothing still belongs on the board, so it is filed under
     * the channels it was assigned (ທຸກຊ່ອງທາງ when it names none) with zeros:
     * a fresh assignment is visible before any plan is written against it.
     */
    const slices = (item: any) => {
      const plan = item.target_by_channel || {}, act = item.actual_by_channel || {}, roll = item.rollup_by_channel || {};
      const codes = new Set([...Object.keys(plan), ...Object.keys(act), ...Object.keys(roll)]);
      if (!codes.size) {
        const named = (item.channel_codes || []).map(String).filter(Boolean);
        return (named.length ? named : ["ALL"]).map((code: string) => ({ code, val: 0, act: 0, roll: 0 }));
      }
      return [...codes].map(code => ({
        code,
        val: Number(plan[code] || 0),
        act: Number(act[code] || 0),
        roll: Number(roll[code] || 0),
      }));
    };
    for (const item of assignments) {
      const bk = String(item.bu_code), sk = String(item.sale_id), pk = String(item.province_code), dk = item.district_code || "ALL";
      const m = Number(item.month);
      scope(bk, item.id);
      scope(`${bk}/${sk}`, item.id);
      scope(`${bk}/${sk}/${pk}`, item.id);
      scope(`${bk}/${sk}/${pk}/${dk}`, item.id);
      for (const sl of slices(item)) {
        const ck = sl.code;
        const add = (node: any) => {
          node.total += sl.val; node.months[m] += sl.val;
          node.actual += sl.act; node.actMonths[m] += sl.act;
        };
        if (!root[bk]) root[bk] = { key: bk, scopeKey: bk, name: buMap.get(bk) || bk, ...blank(), children: {} };
        add(root[bk]);
        const bu = root[bk];
        // No scopeKey on the channel: a row is not owned by one channel, so
        // "delete this channel" cannot be answered without deleting rows that
        // serve the others too.
        if (!bu.children[ck]) bu.children[ck] = { key: `${bk}|${ck}`, name: chName(ck), ...blank(), children: {} };
        add(bu.children[ck]);
        // The roll-up stops at the person: BU and channel rows are the plan, not
        // the plan plus their own manager's copy of it.
        const chan = bu.children[ck];
        if (!chan.children[sk]) chan.children[sk] = { key: `${bk}|${ck}|${sk}`, scopeKey: `${bk}/${sk}`, name: item.sale_name || "Unknown", role: posMap.get(sk), ...blank(), children: {} };
        add(chan.children[sk]); addRoll(chan.children[sk], m, sl.roll);
        const sale = chan.children[sk];
        if (!sale.children[pk]) sale.children[pk] = { key: `${bk}|${ck}|${sk}|${pk}`, scopeKey: `${bk}/${sk}/${pk}`, name: pk === "ALL" ? t("assignment.allProvinces") : provMap.get(pk) || pk, ...blank(), children: {} };
        add(sale.children[pk]); addRoll(sale.children[pk], m, sl.roll);
        const prov = sale.children[pk];
        if (!prov.children[dk]) prov.children[dk] = { key: `${bk}|${ck}|${sk}|${pk}|${dk}`, scopeKey: `${bk}/${sk}/${pk}/${dk}`, name: dk === "ALL" ? t("app.all") : (item.district_name || dk), ...blank(), children: null };
        add(prov.children[dk]); addRoll(prov.children[dk], m, sl.roll);
      }
    }
    const withIds = (n: any) => ({ ...n, allIds: n.scopeKey ? scopeIds.get(n.scopeKey) || [] : [] });
    const toArr = (o: any) => Object.values(o).sort((a: any, b: any) => b.total - a.total).map(withIds);
    return toArr(root).map((bu: any) => ({
      ...bu,
      children: toArr(bu.children).map((c: any) => ({
        ...c,
        children: toArr(c.children).map((s: any) => ({
          ...s,
          children: toArr(s.children).map((p: any) => ({ ...p, children: toArr(p.children) })),
        })),
      })),
    }));
  }, [assignments, buMap, provMap, chanMap, posMap, t]);

  const toggle = (key: string) => setExpanded(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const expandAll = () => { if (expanded.size > 0) { setExpanded(new Set()); } else { const all = new Set<string>(); tree.forEach((bu: any) => { all.add(bu.key); bu.children.forEach((c: any) => { all.add(c.key); c.children.forEach((s: any) => { all.add(s.key); s.children.forEach((p: any) => all.add(p.key)); }); }); }); setExpanded(all); } };

  const onProvChange = async (vals: string[]) => {
    // A manager covering the whole country is one row with province_code='ALL',
    // not eighteen rows — the reports already read 'ALL' as "any province", and
    // one row per province would have to be re-cut every time a province is
    // added. So ALL replaces the individual picks rather than joining them.
    const next = exclusiveAll(form.provinceCodes, vals);
    setForm(f => ({
      ...f,
      provinceCodes: next,
      // Districts already picked for a province that survived the change are
      // kept: removing a different province should not silently reset them.
      districts: Object.fromEntries(Object.entries(f.districts).filter(([code]) => next.includes(code))),
    }));
    // Districts are offered for every province, not only the capital: erp_amper
    // carries them for all of them, and a seller working three districts of
    // Savannakhet was previously written down as working the whole province.
    const missing = next.filter(code => code !== "ALL" && !amphurs[code]);
    if (!missing.length) return;
    const loaded = await Promise.all(missing.map(async code => {
      try {
        const r = await api.get("/amphur", { params: { province_code: code } });
        return [code, r.data?.data || []] as const;
      } catch { return [code, []] as const; }
    }));
    setAmphurs(prev => ({ ...prev, ...Object.fromEntries(loaded) }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.saleId || !form.buCode || !form.provinceCodes.length || !form.months.length) return;
    setSubmitting(true);
    try {
      // Each province carries its own districts, so the capital can be three
      // districts while Vientiane province is the whole thing — in one save.
      const rows = form.provinceCodes.flatMap(prov => {
        const picked = prov === "ALL" ? [] : form.districts[prov] || [];
        const dists = picked.length ? picked : ["ALL"];
        return form.months.flatMap(month => dists.map(district => ({ province_code: prov, district_code: district, month })));
      });
      await api.post("/sales-assignments", {
        sale_id: form.saleId, sale_name: form.saleName, bu_code: form.buCode,
        channel_codes: form.channelCodes, rows,
      });
      await loadAll();
      setDrawer(false);
      setForm(blankForm);
    } catch { alert("Error saving"); }
    finally { setSubmitting(false); }
  };

  /**
   * Removes every assignment row a node stands for — "this seller, in this BU"
   * is twelve rows, one per month, and a whole BU is hundreds.
   *
   * One request, not one per id: a fan of hundreds of parallel DELETEs against
   * a pool of 50 connections dropped some of them, and the survivors were back
   * on the board at the next load. The reload runs in `finally` too, so a delete
   * that half-fails still leaves the screen showing what the database holds
   * rather than what the click hoped for.
   */
  const removeNode = async (node: any) => {
    const ids: number[] = (node.allIds || []).filter(Boolean);
    if (!ids.length || deleting) return;
    // One assignment row carries every channel it names, so it is removed from
    // all of them at once — not only the channel branch the button was clicked in.
    if (!window.confirm(`${t("assignment.confirmDelete")}\n\n${node.name} — ${ids.length} ${t("assignment.rows")}\n\n${t("assignment.deleteSpansChannels")}`)) return;
    setDeleting(true);
    try {
      await api.delete("/sales-assignments", { data: { ids } });
    } catch { alert(t("app.error")); }
    finally { await loadAll(); setDeleting(false); }
  };

  /**
   * The year read three ways, because "58% of target" says nothing on its own.
   *
   *   grandTotal — the whole year's plan
   *   planToDate — the part of it the calendar has already reached, taken from
   *                the monthly plan itself rather than months-elapsed ÷ 12: the
   *                plan is not flat, and BU 12 alone puts a third of its year in
   *                March–May
   *   projected  — what the year lands on if the rest of it sells at the pace
   *                this much of the plan has been sold at
   */
  const grandTotal = tree.reduce((s: number, b: any) => s + b.total, 0);
  const grandActual = tree.reduce((s: number, b: any) => s + b.actual, 0);
  const planToDate = MONTHS.reduce((s, m) => m.v <= THIS_MONTH ? s + monthTotal(tree, m.v, "months") : s, 0);
  const pace = grandTotal > 0 ? planToDate / grandTotal : 0;
  const achieved = grandTotal > 0 ? grandActual / grandTotal : 0;
  const vsPlan = planToDate > 0 ? grandActual / planToDate : 0;
  const projected = pace > 0 ? grandActual / pace : 0;
  const sellers = new Set(assignments.map((a: any) => String(a.sale_id))).size;
  // Actuals can legitimately be absent — a year that has not started, or a
  // rollup that has not run. Claiming 0% then would be a lie about the selling
  // rather than a fact about the data, so the hero falls back to the plan alone.
  const hasActual = grandActual > 0;
  const tone = vsPlan >= 1
    ? { chip: "bg-[var(--pos-bg)] text-[var(--pos)]", bar: "bg-[var(--pos)]", label: t("kpi.aheadOfPlan") }
    : vsPlan >= 0.8
      ? { chip: "bg-[var(--warn-bg)] text-[var(--warn)]", bar: "bg-[var(--warn)]", label: t("kpi.watch") }
      : { chip: "bg-[var(--neg-bg)] text-[var(--neg)]", bar: "bg-[var(--neg)]", label: t("assignment.behindPlan") };
  const labels = { target: t("kpi.target"), rollup: `${t("kpi.target")} (ລວມ)` };

  // Level styles
  const lvl = [
    {}, // unused
    { bg: "bg-[var(--surface-2)] /50", text: "font-semibold text-[var(--ink)]", badge: "bg-[var(--info-bg)] text-[var(--brand)] dark:bg-blue-900/30 dark:text-blue-300" },
    // The channel. Carried by the brand-tinted "C" and bold brand text rather
    // than a row tint: the first column is sticky, and every tint token here is
    // translucent, so a tinted row would show the months sliding underneath it.
    { bg: "bg-[var(--surface)]", text: "font-semibold text-[var(--brand)]", badge: "bg-[var(--info-bg)] text-[var(--brand)] dark:bg-blue-900/30 dark:text-blue-300" },
    { bg: "bg-[var(--surface)]", text: "font-medium text-[var(--ink-soft)]", badge: "bg-[var(--pos-bg)] text-[var(--pos)]  " },
    { bg: "bg-[var(--surface)]", text: "text-[var(--muted)]", badge: "bg-[var(--surface-2)] text-[var(--muted)]  " },
    { bg: "bg-[var(--surface)]", text: "text-[var(--muted)]", badge: "bg-[var(--surface-2)] text-[var(--muted)]  " },
  ];
  const letters = ["", "B", "C", "S", "P", "D"];
  // Tightened with the 220px Structure column: at pl-20 a district name had
  // 60px of the column left to sit in, which is not a name.
  const indents = ["", "pl-2", "pl-5", "pl-8", "pl-11", "pl-14"];

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
  const districtOptions = useMemo(() => {
    const build = (rows: any[]): Option[] => [
      { value: "ALL", label: t("assignment.wholeProvince") },
      ...rows.map((d: any) => ({ value: String(d.code), label: d.name_1 || String(d.code) })),
    ];
    return Object.fromEntries(Object.entries(amphurs).map(([code, rows]) => [code, build(rows)]));
  }, [amphurs, t]);
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
            <p className="page-sub">BU → Channel → Employee → Province → District</p>
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

      {/* No max-width, unlike the other boards: this one is a whole year wide and
          the columns that matter are the late months, so every pixel of the
          screen is a month the reader does not have to scroll to. */}
      <main className="w-full px-5 py-6 lg:px-8">

        {/* ══ Summary ══
            One card, not a row of tiles: the year's selling, the plan it is
            measured against and the pace it is running at are one sentence, and
            splitting them into separate boxes made the reader do the division
            themselves. The bar carries both halves — the fill is what was sold,
            the notch is where the plan says today should be. */}
        <section className="mb-4 overflow-hidden rounded-[var(--r-lg)] border border-[var(--line)]/70 bg-[var(--surface)] shadow-sm">
          <div className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[11px] font-medium text-[var(--muted)]">
                  {hasActual ? t("assignment.sold") : t("assignment.yearPlan")}
                </p>
                <p className="mt-1.5 flex items-baseline gap-1.5">
                  <span className="text-[28px] font-bold leading-none tracking-tight tabular-nums text-[var(--ink)]">
                    {(hasActual ? grandActual : grandTotal).toLocaleString("en-US")}
                  </span>
                  <span className="text-xs font-medium text-[var(--muted)]">{t("transport.kip")}</span>
                </p>
              </div>
              {hasActual && (
                <div className={`shrink-0 rounded-[var(--r-md)] px-3 py-2 text-center ${tone.chip}`}>
                  <p className="text-lg font-bold leading-none tabular-nums">{pct(vsPlan)}</p>
                  <p className="mt-1 text-[10px] font-medium leading-none">{tone.label}</p>
                </div>
              )}
            </div>

            {hasActual && (
              <>
                {/* The notch sits inside the clipped track on purpose: at the very
                    start or end of the year it should disappear into the cap
                    rather than float past it. */}
                <div className="relative mt-4 h-2.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)] ring-1 ring-inset ring-[var(--line-soft)]">
                  <div className={`h-full rounded-full transition-[width] duration-500 ${tone.bar}`} style={{ width: `${Math.min(100, Math.max(0, achieved * 100))}%` }} />
                  <div
                    className="absolute inset-y-0 w-[3px] rounded-full bg-[var(--ink)]/70"
                    style={{ left: `calc(${Math.min(100, Math.max(0, pace * 100))}% - 1.5px)` }}
                    title={`${t("kpi.target")} ${MONTHS[THIS_MONTH - 1]?.l} — ${planToDate.toLocaleString("en-US")}`}
                  />
                </div>

                <div className="mt-2.5 flex items-center justify-between gap-3 text-[11px]">
                  <span className="text-[var(--muted)]">
                    {t("kpi.target")} <span className="font-semibold tabular-nums text-[var(--ink-soft)]">{grandTotal.toLocaleString("en-US")}</span> {t("transport.kip")}
                  </span>
                  <span className="text-[var(--muted)]">
                    {t("assignment.eoy")} <span className="font-semibold tabular-nums text-[var(--ink-soft)]">{compact.format(projected)}</span>
                  </span>
                </div>
              </>
            )}
          </div>

          <div className="grid grid-cols-3 divide-x divide-[var(--line-soft)] border-t border-[var(--line-soft)] bg-[var(--surface-2)]/60">
            {[
              { n: assignments.length, unit: t("assignment.rows"), label: t("assignment.count") },
              { n: sellers, unit: t("assignment.people"), label: t("assignment.sellers") },
              { n: tree.length, unit: t("assignment.units"), label: t("assignment.bus") },
            ].map(stat => (
              <div key={stat.label} className="px-4 py-3 text-center">
                <p className="flex items-baseline justify-center gap-1">
                  <span className="text-lg font-bold leading-none tabular-nums text-[var(--ink)]">{stat.n.toLocaleString("en-US")}</span>
                  <span className="text-[10px] text-[var(--muted)]">{stat.unit}</span>
                </p>
                <p className="mt-1 text-[10px] text-[var(--muted)]">{stat.label}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Pivot Table */}
        <div className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--line)]/70 bg-[var(--surface)] shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[var(--brand-deep)] text-white">
                  <th className="sticky left-0 z-10 bg-[var(--brand-deep)] px-4 py-2.5 text-left font-medium" style={{ minWidth: 220 }}>Structure</th>
                  <th className="sticky left-[220px] z-10 bg-[var(--brand-deep)] px-3 py-2.5 text-left font-medium" style={{ minWidth: 74 }} />
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
                    <td className="sticky left-[220px] z-10 bg-[var(--surface-2)] px-3 py-1.5 text-left text-[10px] font-medium text-[var(--muted)]">{labels.target}</td>
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
                  {/* One picker per chosen province. ALL covers the country, so it
                      has no districts to narrow. */}
                  {form.provinceCodes.filter(code => code !== "ALL").map(code => {
                    const picked = form.districts[code] || [];
                    const ready = Boolean(amphurs[code]);
                    return (
                      <div key={code}>
                        <label className="mb-1 block text-xs font-medium text-[var(--ink-soft)]">
                          {provMap.get(code) || code}
                        </label>
                        <MultiSearchSelect
                          values={picked.length ? picked : ["ALL"]}
                          options={districtOptions[code] || []}
                          isDisabled={!ready}
                          placeholder={ready ? t("assignment.wholeProvince") : t("app.loading")}
                          // Picking ALL means the whole province, so it replaces
                          // any districts rather than sitting alongside them — and
                          // picking a district clears ALL, which is where the field
                          // starts. Empty is stored as "whole province".
                          onChange={v => setForm(f => {
                            const prev = f.districts[code]?.length ? f.districts[code] : ["ALL"];
                            const next = exclusiveAll(prev, v);
                            const keep = next.length && next[0] !== "ALL" ? next : [];
                            return { ...f, districts: { ...f.districts, [code]: keep } };
                          })}
                        />
                      </div>
                    );
                  })}
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
  const s = lvl[level] || lvl[5];
  // Every row that maps onto whole assignment rows can clear them — BU included.
  // The channel band is the one that cannot: it has no ids of its own, because a
  // row belongs to the channels it names rather than to any one of them.
  const canDelete = node.allIds?.length > 0;
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
  const metricCell = "sticky left-[220px] z-10 px-3 py-1.5 text-left text-[10px] font-medium text-[var(--muted)] whitespace-nowrap";

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
            {canDelete && (
              <button
                type="button"
                onClick={e => { e.stopPropagation(); onDelete(node); }}
                disabled={deleting}
                title={`${node.allIds.length}`}
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
