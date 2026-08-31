"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, ChevronDown, ChevronRight, Download } from "lucide-react";
import api from "@/service/api";
import { downloadCsv } from "@/lib/csv";
import { useLanguage } from "@/context/LanguageContext";
import SaleSyncBadge from "@/components/SaleSyncBadge";
import { PROJECT_BU_CODE, PROJECT_BU_NAME, projectBuSplitApplies } from "@/lib/project-bu.mjs";

/**
 * ສົມທຽບ ເປົ້າ · ຍອດຂາຍ · ຈັດສົ່ງສຳເລັດ.
 *
 * Reads /api/sales-delivery-compare, which is where the two meanings of
 * "ສົ່ງສຳເລັດ" are defined; the notes panel at the foot of the page repeats
 * them for whoever is reading the numbers rather than the code.
 */

/**
 * How completely this month's sales reached buyers. Its own bands, not the
 * Ach% scale above: 100% is the ceiling here, not the plan.
 */
const deliveryTone = (share: number) => {
  const hue = share >= 95 ? "--pos" : share >= 80 ? "--warn" : "--neg";
  return {
    fill: `var(${hue})`,
    // The unfilled track is a lighter step of the FILL's own ramp, not a neutral
    // gray, so the state reads across the whole arc. Mixed against the surface
    // rather than using the --*-bg tokens: those are ~13% alpha, which all but
    // vanishes on the dark surface.
    track: `color-mix(in srgb, var(${hue}) 20%, var(--surface))`,
    label: share >= 95 ? "ດີ" : share >= 80 ? "ຕ້ອງຕິດຕາມ" : "ຄ້າງຫຼາຍ",
  };
};

/**
 * Half-circle meter: one ratio against a fixed limit. The unfilled track is a
 * lighter step of the fill's own ramp so the state reads across the whole arc,
 * and the value is written out as text — the color is never the only cue.
 *
 * `size` only scales the rendered box; every gauge keeps the same 0-100
 * geometry, which is what lets a row of them be compared at a glance.
 */
function Gauge({
  share, caption, detail, size = "lg", empty = false,
}: {
  share: number;
  caption: string;
  detail?: string;
  size?: "lg" | "sm";
  /** Nothing was sold, so there is no share to draw — 0/0 is not 100%. */
  empty?: boolean;
}) {
  const clamped = empty ? 0 : Math.min(100, Math.max(0, share));
  const { fill, track, label } = empty
    ? {
        fill: "transparent",
        track: "color-mix(in srgb, var(--muted) 22%, var(--surface))",
        label: "ບໍ່ມີຍອດຂາຍ",
      }
    : deliveryTone(share);
  const reading = empty ? "–" : `${clamped.toFixed(1)}%`;
  // Semicircle of radius 80 — its length is what the dash array is cut from.
  const arc = Math.PI * 80;
  const path = "M 20 100 A 80 80 0 0 1 180 100";
  const small = size === "sm";
  return (
    <figure className="m-0 flex shrink-0 flex-col items-center">
      <svg
        viewBox="0 0 200 112"
        className={small ? "h-[70px] w-[125px]" : "h-[98px] w-[176px]"}
        role="img"
        aria-label={`${caption} ${reading} — ${label}`}
      >
        <title>{`${caption} ${reading} (${label})${detail ? ` · ${detail}` : ""}`}</title>
        <path d={path} fill="none" stroke={track} strokeWidth={16} strokeLinecap="round" />
        <path
          d={path} fill="none" stroke={fill} strokeWidth={16} strokeLinecap="round"
          strokeDasharray={`${(clamped / 100) * arc} ${arc}`}
        />
        {/* The value is written out — a reader never has to judge it from the
            arc length or the color alone. End ticks are omitted: they collide
            with the rounded caps at the extremes, and 0-100 is the only range
            a half-circle meter ever has. */}
        <text x="100" y="94" textAnchor="middle"
              className={`${empty ? "fill-[var(--muted)]" : "fill-[var(--ink)]"} font-bold ${
                small ? "text-[27px]" : "text-[31px]"
              }`}>
          {reading}
        </text>
      </svg>
      <figcaption className="mt-1.5 text-center text-[11px] font-semibold leading-tight text-[var(--ink-soft)]">
        {caption}
      </figcaption>
      {detail && <p className="mt-0.5 text-[10px] tabular-nums text-[var(--muted)]">{detail}</p>}
    </figure>
  );
}

const num = (v: unknown) => Number(v || 0);
const fmt = (v: unknown) => num(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
const pct = (v: unknown) => `${num(v).toFixed(1)}%`;

/** Green at plan, amber within reach, red otherwise — same scale as /sales-summary. */
const tone = (value: number) =>
  value >= 100
    ? "bg-[var(--pos-bg)] text-[var(--pos)]"
    : value >= 90
      ? "bg-[var(--warn-bg)] text-[var(--warn)]"
      : "bg-[var(--neg-bg)] text-[var(--neg)]";

type Row = {
  key: string;
  label: string;
  target: number;
  actual: number;
  delivered: number;
  pending: number;
  ach_pct: number;
  delivered_pct: number;
  pending_share_pct: number;
  /** Present on the BU tree: ຊ່ອງທາງ under a BU, ພະນັກງານຂາຍ under a channel. */
  children?: Row[];
};

type Section = { rows: Row[]; total: Row };

type ReportMeta = {
  year: number;
  month: number;
  month_label: string;
  /** Latest bill date in the sale table, YYYY-MM-DD — null when there is none. */
  data_through: string | null;
  date_range: string;
  self_pickup_transport: string[];
  project_bu_split: boolean;
  project_bu_name: string;
};

/** Sections are keyed by name (see SECTIONS) so the table loop can index them. */
type Report = { meta: ReportMeta } & Partial<Record<string, Section>>;

/** Shape shared by the /bu and /provinces lookups. */
type LookupRow = { code?: string | number; id?: string | number; name_1?: string; name?: string };

const SECTIONS: { key: string; title: string; sub: string; head: string; tree?: boolean }[] = [
  {
    key: "by_bu", title: "ຕາມ BU → ຊ່ອງທາງ → ພະນັກງານຂາຍ",
    sub: "Business unit, drill down to channel and salesperson", head: "BU · ຊ່ອງທາງ · ພະນັກງານຂາຍ",
    tree: true,
  },
  { key: "by_channel", title: "ຕາມຊ່ອງທາງຂາຍ", sub: "By sales channel", head: "ຊ່ອງທາງ" },
  { key: "by_area", title: "ຕາມແຂວງ", sub: "By province", head: "ແຂວງ" },
];

export default function SalesDeliveryCompare() {
  const { t } = useLanguage();
  const now = new Date();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [bu, setBu] = useState("ALL");
  const [channel, setChannel] = useState("ALL");
  const [province, setProvince] = useState("ALL");
  const [buOptions, setBuOptions] = useState<{ v: string; l: string }[]>([]);
  const [provinceOptions, setProvinceOptions] = useState<{ v: string; l: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<Report | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({
    by_bu: true, by_channel: true, by_area: false,
  });

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  useEffect(() => {
    Promise.all([api.get("/bu"), api.get("/provinces")])
      .then(([b, p]) => {
        setBuOptions((b.data?.data || []).map((r: LookupRow) => ({ v: String(r.code), l: r.name_1 || String(r.code) })));
        setProvinceOptions((p.data?.data || []).map((r: LookupRow) => ({
          v: String(r.code ?? r.id), l: r.name_1 || r.name || String(r.code ?? r.id),
        })));
      })
      .catch(() => {});
  }, []);

  /**
   * ໂຄງການ is picked from the BU list, not the channel list — it is reported as
   * a unit of its own from 2026. Offered only for the years the split covers,
   * so an older year cannot be filtered by a unit that did not exist then.
   */
  const buChoices = useMemo(
    () => (projectBuSplitApplies(year)
      ? [...buOptions, { v: PROJECT_BU_CODE, l: PROJECT_BU_NAME }]
      : buOptions),
    [buOptions, year],
  );

  /** Switching to a year before the split would leave ໂຄງການ selected but gone. */
  useEffect(() => {
    if (bu === PROJECT_BU_CODE && !projectBuSplitApplies(year)) setBu("ALL");
  }, [year, bu]);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get("/sales-delivery-compare", { params: { year, month, bu, channel, province } });
      setData(res.data?.success ? res.data.data : null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [year, month, bu, channel, province]);

  /** Headline figures come from the channel split, which covers the company. */
  const head = (data?.by_channel as Section | undefined) ?? null;

  /** No bill in the month at all — every ratio below is 0/0, not an achievement. */
  const noSales = !!data && !num(head?.total?.actual);

  /** dd-mm-yyyy, the way the header writes the month's own range. */
  const asLaoDate = (iso: string) => iso.split("-").reverse().join("-");

  /**
   * The month picker starts from the browser's clock, which on the 1st — or on
   * a machine whose date runs a day fast — asks for a month the ERP has no bill
   * in yet, and the page reads as if sales had stopped. Fall back once to the
   * month the data actually reaches, and say so; a month picked by hand after
   * that is left alone, empty or not.
   */
  const settled = useRef(false);
  const [fellBackFrom, setFellBackFrom] = useState("");
  useEffect(() => {
    if (settled.current || !data?.meta) return;
    const through = data.meta.data_through;
    if (!noSales || !through) { settled.current = true; return; }
    const [dataYear, dataMonth] = through.split("-").map(Number);
    settled.current = true;
    if (Number(year) * 12 + Number(month) > dataYear * 12 + dataMonth) {
      setFellBackFrom(`${months[Number(month) - 1]} ${year}`);
      setYear(String(dataYear));
      setMonth(String(dataMonth));
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * One card per BU. A BU with no plan and no sales this month is dropped —
   * an empty card is a row of zeros that has to be read past.
   */
  const buCards = useMemo(() => {
    const byBu = data?.by_bu as Section | undefined;
    if (!byBu) return [];
    return byBu.rows.filter((r) => r.actual || r.target);
  }, [data]);

  const exportCsv = () => {
    if (!data) return;
    const headers = [
      "section", "level", "label", "target",
      "sales_this_month", "sales_ach_pct",
      "delivered_this_month", "delivered_ach_pct",
      "sold_this_month_not_yet_delivered",
    ];
    const out: (string | number)[][] = [];
    const push = (section: string, r: Row, level = 0) => {
      out.push([
        section, level, r.label, num(r.target),
        num(r.actual), num(r.ach_pct),
        num(r.delivered), num(r.delivered_pct),
        num(r.pending),
      ]);
    };
    for (const { key, title } of SECTIONS) {
      const section = data[key] as Section | undefined;
      if (!section?.rows?.length) continue;
      // The tree is flattened depth-first, with `level` carrying the nesting
      // so a spreadsheet can group on it.
      const walk = (r: Row, level: number) => {
        push(title, r, level);
        r.children?.forEach((child) => walk(child, level + 1));
      };
      section.rows.forEach((r) => walk(r, 0));
      if (section.total) push(`${title} · TOTAL`, section.total);
    }
    if (out.length) downloadCsv(`sales-delivery-${year}-${month}`, headers, out);
  };

  const toggle = (key: string) => setOpen((prev) => ({ ...prev, [key]: !prev[key] }));

  /**
   * Which tree branches are unfolded. BU rows start open so the channel split
   * is visible without a click; the salesperson level stays folded, or the
   * table opens as a 60-row wall.
   */
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const toggleRow = (key: string) => setOpenRows((prev) => ({ ...prev, [key]: !prev[key] }));
  const isRowOpen = (row: Row, depth: number) => openRows[row.key] ?? depth === 0;

  /** Depth-first walk of the rows currently visible, deepest branches last. */
  const visibleRows = (rows: Row[], depth = 0): { row: Row; depth: number }[] =>
    rows.flatMap((row) => [
      { row, depth },
      ...(row.children?.length && isRowOpen(row, depth) ? visibleRows(row.children, depth + 1) : []),
    ]);

  const sel = "select";

  return (
    <div className="min-h-screen bg-transparent" style={{ fontFamily: '"Noto Sans Lao","Noto Sans",system-ui,sans-serif' }}>

      {/* ══ Header ══ */}
      <header className="page-hd flex-col !items-stretch !gap-0 !p-0">
        <div className="flex items-center justify-between px-5 py-3 lg:px-6">
          <div>
            <p className="eyebrow">Performance report</p>
            <h1 className="page-title">ສົມທຽບຍອດຂາຍ ແລະ ການຈັດສົ່ງ</h1>
            <p className="page-sub flex flex-wrap items-center gap-1.5">
              {data?.meta ? `${data.meta.month_label} ${year} — ${data.meta.date_range}` : t("app.loading")}
              {/* ເວລາອັບເດດ ແລະ ນັບຖອຍຫຼັງຮອບຕໍ່ໄປ. */}
              <SaleSyncBadge onUpdated={load} />
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={exportCsv} className="btn" disabled={!data}>
              <Download size={13} /> {t("app.exportCsv")}
            </button>
            <button onClick={load} className="btn">
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="grid grid-cols-2 gap-3 border-t border-[var(--line-soft)] px-5 py-3 md:grid-cols-5 lg:px-6">
          <div>
            <label className="field-label">{t("filter.year")}</label>
            <select value={year} onChange={(e) => setYear(e.target.value)} className={sel}>
              {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]
                .map(String).sort().reverse()
                .map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label">ເດືອນ</label>
            <select value={month} onChange={(e) => setMonth(e.target.value)} className={sel}>
              {months.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label">{t("filter.bu")}</label>
            <select value={bu} onChange={(e) => setBu(e.target.value)} className={sel}>
              <option value="ALL">{t("app.all")}</option>
              {buChoices.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label">{t("filter.channel")}</label>
            <select value={channel} onChange={(e) => setChannel(e.target.value)} className={sel}>
              <option value="ALL">{t("app.all")}</option>
              <option value="RETAIL">ຂາຍໜ້າຮ້ານ</option>
              <option value="WHOLESALE">ຂາຍສົ່ງ</option>
              <option value="TECH">ຂາຍຊ່າງ</option>
              {/* ໂຄງການ lives in the BU picker from 2026 — see lib/project-bu.mjs */}
              <option value="ONLINE">ຂາຍອອນລາຍ</option>
            </select>
          </div>
          <div>
            <label className="field-label">{t("filter.province")}</label>
            <select value={province} onChange={(e) => setProvince(e.target.value)} className={sel}>
              <option value="ALL">{t("app.all")}</option>
              {provinceOptions.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1480px] space-y-5 px-5 py-6 lg:px-8">

        {loading && (
          <div className="flex items-center justify-center rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface)] py-20">
            <Loader2 className="h-7 w-7 animate-spin text-[var(--brand)]" />
          </div>
        )}

        {/* Why the page is empty, in the page rather than in the reader's head:
            a month with no bill in it is either one that has not started or a
            sync that has stopped, and the last bill date tells them apart. */}
        {!loading && noSales && (
          <div className="rounded-[var(--r-md)] border border-[var(--warn)]/40 bg-[var(--warn-bg)] px-4 py-3 text-[12px] leading-relaxed text-[var(--warn)]">
            <span className="font-semibold">
              ຍັງບໍ່ມີບິນຂາຍໃນ {data?.meta.month_label} {data?.meta.year}
            </span>
            {data?.meta.data_through && ` · ຂໍ້ມູນການຂາຍມີຮອດ ${asLaoDate(data.meta.data_through)}`}
            {" · ເປົ້າໝາຍລຸ່ມນີ້ແມ່ນແຜນຂອງເດືອນ, ຍັງບໍ່ມີຍອດມາທຽບ"}
          </div>
        )}

        {!loading && !!fellBackFrom && (
          <div className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface)] px-4 py-2.5 text-[12px] text-[var(--muted)]">
            {fellBackFrom} ຍັງບໍ່ມີບິນຂາຍ — ສະແດງ {data?.meta.month_label} {data?.meta.year} ແທນ
          </div>
        )}

        {/* ══ Headline ══ */}
        {!loading && head?.total && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "ເປົ້າໝາຍ", value: head.total.target, badge: null as string | null, badgeTone: "" },
              {
                label: "ຍອດຂາຍ", value: head.total.actual,
                badge: pct(head.total.ach_pct), badgeTone: tone(head.total.ach_pct),
              },
              {
                label: "ຈັດສົ່ງສຳເລັດເດືອນນີ້", value: head.total.delivered,
                badge: pct(head.total.delivered_pct), badgeTone: tone(head.total.delivered_pct),
              },
              {
                label: "ຂາຍເດືອນນີ້ ຍັງບໍ່ໄດ້ສົ່ງ", value: head.total.pending,
                badge: `${num(head.total.pending_share_pct).toFixed(0)}% ຂອງຍອດຂາຍ`,
                badgeTone: "bg-[var(--warn-bg)] text-[var(--warn)]",
              },
            ].map((s) => (
              <div key={s.label} className="rounded-[var(--r-md)] border border-[var(--line)]/70 bg-[var(--surface)] p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">{s.label}</span>
                  {s.badge && (
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${s.badgeTone}`}>{s.badge}</span>
                  )}
                </div>
                <p className="mt-2 text-xl font-bold text-[var(--ink)]">{fmt(s.value)}</p>
              </div>
            ))}
          </div>
        )}

        {/* ══ ອັດຕາການຈັດສົ່ງ ══ */}
        {!loading && head?.total && (
          <div className="rounded-[var(--r-md)] border border-[var(--line)]/70 bg-[var(--surface)] px-5 py-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
              <Gauge
                share={100 - num(head.total.pending_share_pct)}
                empty={noSales}
                caption="ລວມທັງບໍລິສັດ"
              />
              <div className="min-w-[200px]">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                  ຍອດຂາຍເດືອນນີ້ທີ່ຍັງບໍ່ໄດ້ສົ່ງເລີຍ
                </p>
                <p className="mt-1 text-2xl font-bold text-[var(--ink)]">{fmt(head.total.pending)}</p>
                <p className="mt-1.5 text-[11px] text-[var(--muted)]">
                  ສົ່ງແລ້ວ <span className="font-semibold text-[var(--ink-soft)]">
                    {fmt(head.total.actual - head.total.pending)}
                  </span> ຈາກຍອດຂາຍ <span className="font-semibold text-[var(--ink-soft)]">
                    {fmt(head.total.actual)}
                  </span>
                </p>
                <p className="mt-0.5 text-[11px] text-[var(--muted)]">
                  ສະຖານະ: <span className="font-semibold text-[var(--ink-soft)]">
                    {noSales ? "ບໍ່ມີຍອດຂາຍ" : deliveryTone(100 - num(head.total.pending_share_pct)).label}
                  </span>
                </p>
              </div>
            </div>

          </div>
        )}

        {/* ══ ບັດແຕ່ລະ BU ══ */}
        {!loading && buCards.length > 0 && (
          <div>
            <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
              ເປົ້າ · ຍອດຂາຍ · ຈັດສົ່ງສຳເລັດ ແຍກແຕ່ລະ BU
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {buCards.map((r) => {
                // Every card's gauge uses the same 0-100 geometry, so the grid
                // is read by comparing arcs rather than re-reading each number.
                const share = 100 - num(r.pending_share_pct);
                return (
                  <div
                    key={r.key}
                    className="rounded-[var(--r-md)] border border-[var(--line)]/70 bg-[var(--surface)] p-4 shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-semibold text-[var(--ink)]">{r.label}</h3>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${tone(num(r.ach_pct))}`}>
                        ຂາຍ {pct(r.ach_pct)}
                      </span>
                    </div>

                    <div className="mt-1 flex items-center gap-4">
                      <Gauge size="sm" share={share} empty={!num(r.actual)} caption="ອັດຕາການຈັດສົ່ງ" />
                      <dl className="min-w-0 flex-1 space-y-1 text-[11px]">
                        <div className="flex items-baseline justify-between gap-2">
                          <dt className="text-[var(--muted)]">ເປົ້າໝາຍ</dt>
                          <dd className="tabular-nums font-semibold text-[var(--ink-soft)]">{fmt(r.target)}</dd>
                        </div>
                        <div className="flex items-baseline justify-between gap-2">
                          <dt className="text-[var(--muted)]">ຍອດຂາຍ</dt>
                          <dd className="tabular-nums font-bold text-[var(--ink)]">{fmt(r.actual)}</dd>
                        </div>
                        <div className="flex items-baseline justify-between gap-2">
                          <dt className="text-[var(--muted)]">ຈັດສົ່ງສຳເລັດ</dt>
                          <dd className="tabular-nums font-semibold text-[var(--ink)]">
                            {fmt(r.delivered)}{" "}
                            <span className="font-normal text-[var(--muted)]">({pct(r.delivered_pct)})</span>
                          </dd>
                        </div>
                        <div className="flex items-baseline justify-between gap-2 border-t border-[var(--line-soft)] pt-1">
                          <dt className="text-[var(--muted)]">ຂາຍແລ້ວຍັງບໍ່ສົ່ງ</dt>
                          <dd className="tabular-nums font-semibold text-[var(--warn)]">
                            {fmt(Math.max(0, num(r.pending)))}
                          </dd>
                        </div>
                      </dl>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ══ Tables ══ */}
        {!loading && data && (
          <div className="space-y-4">
            {SECTIONS.map(({ key, title, sub, head: headLabel, tree }) => {
              const section = data[key] as Section | undefined;
              if (!section?.rows) return null;
              const isOpen = open[key];
              return (
                <div key={key} className="overflow-hidden rounded-[var(--r-md)] border border-[var(--line)]/70 bg-[var(--surface)] shadow-sm">
                  <button
                    onClick={() => toggle(key)}
                    className="flex w-full items-center justify-between px-5 py-3 text-left hover:bg-[var(--surface-2)]"
                  >
                    <div>
                      <h3 className="text-sm font-semibold text-[var(--ink)]">{title}</h3>
                      <p className="text-[11px] text-[var(--muted)]">{sub}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${tone(num(section.total?.ach_pct))}`}>
                        ຂາຍ {pct(section.total?.ach_pct)}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${tone(num(section.total?.delivered_pct))}`}>
                        ສົ່ງ {pct(section.total?.delivered_pct)}
                      </span>
                      {isOpen ? <ChevronDown size={16} className="text-[var(--muted)]" /> : <ChevronRight size={16} className="text-[var(--muted)]" />}
                    </div>
                  </button>

                  {isOpen && (
                    <div className="overflow-x-auto border-t border-[var(--line-soft)]">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-[var(--surface-2)] text-[var(--muted)]">
                            <th className="sticky left-0 z-10 bg-[var(--surface-2)] px-4 py-2 text-left font-semibold">{headLabel}</th>
                            <th className="px-3 py-2 text-right font-semibold">ເປົ້າໝາຍ</th>
                            <th className="border-l border-[var(--line-soft)] px-3 py-2 text-right font-semibold">ຍອດຂາຍ</th>
                            <th className="px-3 py-2 text-center font-semibold">Ach%</th>
                            <th className="border-l border-[var(--line-soft)] px-3 py-2 text-right font-semibold">ຈັດສົ່ງສຳເລັດ</th>
                            <th className="px-3 py-2 text-center font-semibold">Ach%</th>
                            <th className="border-l border-[var(--line-soft)] px-3 py-2 text-right font-semibold text-[var(--muted)]">ຂາຍແລ້ວຍັງບໍ່ສົ່ງ</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--line-soft)] dark:divide-slate-800">
                          {(tree ? visibleRows(section.rows) : section.rows.map((row) => ({ row, depth: 0 })))
                            .map(({ row, depth }) => {
                            const branch = Boolean(row.children?.length);
                            const expanded = branch && isRowOpen(row, depth);
                            return (
                            <tr key={row.key} className="hover:bg-[var(--surface-2)]">
                              <td
                                className={`sticky left-0 z-10 bg-[var(--surface)] py-2.5 pr-3 ${
                                  depth === 0 ? "font-semibold text-[var(--ink)]"
                                    : depth === 1 ? "font-medium text-[var(--ink-soft)]"
                                      : "text-[var(--muted)]"
                                }`}
                                style={{ paddingLeft: `${16 + depth * 18}px` }}
                              >
                                {branch ? (
                                  <button
                                    onClick={() => toggleRow(row.key)}
                                    className="flex items-center gap-1 text-left hover:text-[var(--brand)]"
                                    aria-expanded={expanded}
                                  >
                                    {expanded
                                      ? <ChevronDown size={13} className="shrink-0 text-[var(--muted)]" />
                                      : <ChevronRight size={13} className="shrink-0 text-[var(--muted)]" />}
                                    {row.label}
                                  </button>
                                ) : (
                                  /* Leaves keep the chevron's width so labels stay in one column. */
                                  <span className={tree ? "pl-[17px]" : ""}>{row.label}</span>
                                )}
                              </td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-[var(--muted)]">{fmt(row.target)}</td>
                              <td className="border-l border-[var(--line-soft)] px-3 py-2.5 text-right tabular-nums font-semibold text-[var(--ink)]">{fmt(row.actual)}</td>
                              <td className="px-3 py-2.5 text-center">
                                <span className={`inline-block min-w-[48px] rounded-full px-2 py-0.5 text-[10px] font-bold ${tone(num(row.ach_pct))}`}>{pct(row.ach_pct)}</span>
                              </td>
                              <td className="border-l border-[var(--line-soft)] px-3 py-2.5 text-right tabular-nums font-semibold text-[var(--ink)]">{fmt(row.delivered)}</td>
                              <td className="px-3 py-2.5 text-center">
                                <span className={`inline-block min-w-[48px] rounded-full px-2 py-0.5 text-[10px] font-bold ${tone(num(row.delivered_pct))}`}>{pct(row.delivered_pct)}</span>
                              </td>
                              <td className="border-l border-[var(--line-soft)] px-3 py-2.5 text-right tabular-nums text-[var(--muted)]">{fmt(row.pending)}</td>
                            </tr>
                            );
                          })}
                          {section.total && (
                            <tr className="border-t-2 border-[var(--line)] bg-[var(--surface-2)] font-semibold">
                              <td className="sticky left-0 z-10 bg-[var(--surface-2)] px-4 py-3 text-[var(--ink)]">TOTAL</td>
                              <td className="px-3 py-3 text-right tabular-nums text-[var(--ink-soft)]">{fmt(section.total.target)}</td>
                              <td className="border-l border-[var(--line-soft)] px-3 py-3 text-right tabular-nums text-[var(--ink)]">{fmt(section.total.actual)}</td>
                              <td className="px-3 py-3 text-center">
                                <span className={`inline-block min-w-[48px] rounded-full px-2 py-0.5 text-[10px] font-bold ${tone(num(section.total.ach_pct))}`}>{pct(section.total.ach_pct)}</span>
                              </td>
                              <td className="border-l border-[var(--line-soft)] px-3 py-3 text-right tabular-nums text-[var(--ink)]">{fmt(section.total.delivered)}</td>
                              <td className="px-3 py-3 text-center">
                                <span className={`inline-block min-w-[48px] rounded-full px-2 py-0.5 text-[10px] font-bold ${tone(num(section.total.delivered_pct))}`}>{pct(section.total.delivered_pct)}</span>
                              </td>
                              <td className="border-l border-[var(--line-soft)] px-3 py-3 text-right tabular-nums text-[var(--ink-soft)]">{fmt(section.total.pending)}</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ══ ວິທີນັບ ══ */}
        {!loading && data && (
          <div className="rounded-[var(--r-md)] border border-[var(--line)]/70 bg-[var(--surface)] px-5 py-4 text-[11px] leading-relaxed text-[var(--muted)] shadow-sm">
            <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--ink-soft)]">ວິທີນັບ</p>
            <p>
              • <b>ຍອດຂາຍ</b> ນັບຕາມ <b>ວັນທີ່ເປີດບິນ</b> — ບິນທີ່ລົງເດືອນນີ້.
            </p>
            <p>
              • <b>ຈັດສົ່ງສຳເລັດ</b> ນັບຕາມ <b>ວັນທີ່ສົ່ງເຖິງມືລູກຄ້າ</b> ບໍ່ວ່າຈະຂາຍເດືອນໃດ:
              ຂາຍເດືອນ 6 ສົ່ງເດືອນ 7 → ນັບຢູ່ <b>ເດືອນ 7</b>; ຂາຍເດືອນ 7 ສົ່ງເດືອນ 8 →
              <b> ບໍ່ນັບໃນເດືອນ 7</b> ແຕ່ໄປນັບຢູ່ເດືອນ 8.
            </p>
            <p>
              • ສອງຄໍລຳນີ້ຈຶ່ງເປັນຄົນລະຊຸດບິນ — ຈັດສົ່ງສຳເລັດ ອາດຫຼາຍກວ່າ ຍອດຂາຍ ໄດ້
              ຖ້າເດືອນນັ້ນເຄລຍບິນຄ້າງເກົ່າອອກໄປຫຼາຍ.
            </p>
            <p>
              • ບິນນັບເປັນ &quot;ຮອດມືລູກຄ້າ&quot; ເມື່ອ ມີຖ້ຽວຈັດສົ່ງທີ່ສຳເລັດ (ບິນທະຍອຍສົ່ງນັບຕອນຖ້ຽວສຸດທ້າຍ)
              ຫຼື ເປັນບິນທີ່ <b>{(data.meta?.self_pickup_transport || []).join(" / ")}</b> ຊຶ່ງບໍ່ເຄີຍເຂົ້າລະບົບຂົນສົ່ງ
              — ນັບວັນທີ່ຂອງບິນເປັນວັນຮັບເຄື່ອງ.
            </p>
            <p>
              • <b>ຂາຍແລ້ວຍັງບໍ່ສົ່ງ</b> = ຍອດຂາຍເດືອນນີ້ທີ່ <b>ຍັງບໍ່ຮອດມືລູກຄ້າຈັກເທື່ອ</b> (ຮອດວັນທີ່ເບິ່ງ).
              ບິນເຫຼົ່ານີ້ຈະໄປປະກົດຢູ່ຄໍລຳ ຈັດສົ່ງສຳເລັດ ຂອງເດືອນທີ່ສົ່ງຈິງ.
            </p>
            <p>
              • ໃບຄືນສິນຄ້າ (ຍອດຕິດລົບ) ຫັກອອກຈາກຍອດຂາຍ ແລະ ຈາກ ຂາຍແລ້ວຍັງບໍ່ສົ່ງ —
              ແຖວທີ່ຄືນຫຼາຍກວ່າຄ້າງ ຈຶ່ງເຫັນເລກຕິດລົບໄດ້.
            </p>
            {data.meta?.project_bu_split && (
              <p>
                • ຕັ້ງແຕ່ປີ 2026 <b>{data.meta.project_bu_name}</b> ຖືກຖອດອອກຈາກ ໄຟຟ້າ · ແອ · ປະປາ · ອາໄຫຼ່
                ມາເປັນ <b>BU ຕ່າງຫາກ</b> (ທັງເປົ້າ ແລະ ຍອດຈິງ) ໃນຕາຕະລາງ ຕາມ BU. ປີ 2025 ລົງມາຍັງລາຍງານແບບເກົ່າ.
                ງານໂຄງການຂອງ ສູນບໍລິການ ບໍ່ຍ້າຍ. ນີ້ເປັນການຈັດກຸ່ມສະເພາະໜ້ານີ້ — ໜ້າອື່ນ ແລະ ຖານຂໍ້ມູນຍັງຄືເກົ່າ.
              </p>
            )}
            <p>
              • ເປົ້າໝາຍຂອງ ຂາຍໜ້າຮ້ານ · ໂຄງການ · ຂາຍຊ່າງ · ອອນລາຍ ຖືກປ້ອນເປັນ &quot;ທົ່ວປະເທດ&quot;
              ບໍ່ໄດ້ແຍກແຂວງ ຈຶ່ງມາລວມຢູ່ແຖວ <b>ທົ່ວປະເທດ (ບໍ່ແຍກແຂວງ)</b> ໃນຕາຕະລາງຕາມແຂວງ.
            </p>
            <p>
              • ຕາຕະລາງ <b>ຕາມພະນັກງານຂາຍ</b> ນັບສະເພາະຂອບເຂດທີ່ຄົນນັ້ນຖືກມອບໝາຍ (odg_sales_assignment)
              ແລະ ນັບບິນດຽວກັນພຽງເທື່ອດຽວ ເຖິງວ່າຈະມີຫຼາຍແຖວມອບໝາຍທັບກັນ.
            </p>
          </div>
        )}

        {!loading && !data && (
          <div className="flex items-center justify-center rounded-[var(--r-md)] border border-dashed border-[var(--line)] py-20">
            <p className="text-sm text-[var(--muted)]">{t("label.noData")}</p>
          </div>
        )}
      </main>
    </div>
  );
}
