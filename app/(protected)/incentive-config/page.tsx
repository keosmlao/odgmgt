"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarClock, ChevronDown, Coins, Eye, EyeOff, RefreshCw, Search, Settings2 } from "lucide-react";
import api from "@/service/api";
import { useLanguage } from "@/context/LanguageContext";
import { fmtDate } from "@/components/ui";

type TableBlock = {
  table: string;
  period: string | null;
  scoped: boolean;
  total: number;
  shown: number;
  columns: string[];
  rows: Record<string, unknown>[];
};

type Payload = {
  meta: { year: number; month: number; all: boolean };
  config: Record<string, unknown> | null;
  sections: { key: string; tables: TableBlock[] }[];
};

/** Human titles + the columns worth showing first for each config table. */
const TABLE_META: Record<string, { title: string; hint?: string; hide?: string[]; groupBy?: string }> = {
  app_incentive_category: { title: "ໝວດສິນຄ້າ ແລະ ນ້ຳໜັກ", hint: "ໝວດໃດຢູ່ກຸ່ມໃດ ແລະ ນັບຄະແນນແນວໃດ" },
  app_incentive_pointmap_category: { title: "ກຸ່ມຂອງຕາຕະລາງຄະແນນ", hide: ["created_at"] },
  app_incentive_point_rule: {
    title: "ກົດໃຫ້ຄະແນນ (ຕາມໝວດ · ແບຣນ · ຂະໜາດ)",
    hint: "ໃຊ້ຕອນຄິດຄະແນນຂອງແຕ່ລະລາຍການຂາຍ",
    hide: ["id", "created_at", "updated_at"],
    groupBy: "category_code",
  },
  app_incentive_point_map: { title: "ຕາຕະລາງຄະແນນ (ຮຸ່ນເກົ່າ)", groupBy: "category_code" },
  app_incentive_role_commission: {
    title: "ເງິນຖານຄ່າຄອມ ແຍກຕາມຕຳແໜ່ງ ແລະ ໝວດສິນຄ້າ",
    hint: "ຈຳນວນນີ້ຈະຖືກຄູນກັບອັດຕາຈ່າຍຕາມ % ຜົນງານ",
    hide: ["id"],
  },
  app_incentive_commission_tier: {
    title: "ວິທີຄິດອັດຕາຄ່າຄອມຕາມ % ຜົນງານ",
    hint: "ຕ່ຳກວ່າ 80% ບໍ່ໄດ້ຄ່າຄອມ · 80–100% ປັດລົງ · ເກີນ 100% ປັດຂຶ້ນ",
    hide: ["id"],
  },
  app_commission_tier: { title: "ຂັ້ນຄອມມິດຊັນ ຕາມພະແນກ", hide: ["id", "created_at"] },
  app_incentive_role_commission_audit: { title: "ປະຫວັດການແກ້ໄຂຄອມມິດຊັນ", hide: ["id"] },
  app_incentive_unit_reward: { title: "ລາງວັນຕໍ່ໜ່ວຍ", hint: "ຂາຍຄົບຈຳນວນທີ່ກຳນົດ ໄດ້ເງິນເພີ່ມຕໍ່ໜ່ວຍ" },
  app_incentive_special_reward: { title: "ລາງວັນພິເສດ", hint: "ບັນລຸເປົ້າທີ່ກຳນົດ ໄດ້ເງິນກ້ອນ" },
  app_incentive_status_multiplier: { title: "ຕົວຄູນຕາມສະຖານະສິນຄ້າ" },
  app_incentive_product_status: { title: "ສະຖານະສິນຄ້າ (ໃຊ້ຢູ່)", hide: ["updated_at"] },
  app_incentive_product_status_rule: { title: "ສະຖານະສິນຄ້າ ຕາມຊ່ວງເວລາ", hide: ["updated_at"] },
  app_incentive_design_token: { title: "ຄຳສັບແບບສິນຄ້າ" },
  app_incentive_size_token: { title: "ຄຳສັບຂະໜາດ" },
  app_incentive_sale_alias: { title: "ຊື່ຜູ້ຂາຍ → ລະຫັດພະນັກງານ" },
};

/** snake_case → readable label. */
const COLUMN_LABEL: Record<string, string> = {
  category_code: "ລະຫັດໝວດ",
  category_name: "ໝວດສິນຄ້າ",
  group_code: "ກຸ່ມ",
  brand_code: "ແບຣນ",
  design_token: "ແບບ",
  size_token: "ຂະໜາດ",
  size_name: "ຂະໜາດ",
  design_name: "ແບບ",
  points: "ຄະແນນ",
  weight: "ນ້ຳໜັກ",
  is_active: "ໃຊ້ງານ",
  is_special: "ພິເສດ",
  pointmap_category: "ກຸ່ມຄະແນນ",
  sda_subtype: "ປະເພດຍ່ອຍ",
  effective_from: "ເລີ່ມ",
  effective_to: "ຮອດ",
  effect_month: "ເດືອນ",
  position_code: "ຕຳແໜ່ງ",
  base_amount: "ເງິນຖານຄ່າຄອມ",
  from_pct: "ຕັ້ງແຕ່ %",
  min_pct: "ຕັ້ງແຕ່ %",
  rate_pct: "ອັດຕາ %",
  mode: "ວິທີຄິດອັດຕາ",
  round_step: "ຂັ້ນປັດ (%)",
  department_code: "ພະແນກ",
  old_amount: "ຄ່າເກົ່າ",
  new_amount: "ຄ່າໃໝ່",
  changed_by: "ຜູ້ແກ້",
  changed_at: "ວັນທີແກ້",
  reward_code: "ລະຫັດ",
  description: "ເງື່ອນໄຂ",
  item_match: "ເງື່ອນໄຂສິນຄ້າ",
  low_min_qty: "ຂັ້ນຕ່ຳ (ໜ່ວຍ)",
  low_reward: "ລາງວັນຂັ້ນຕ່ຳ",
  high_min_qty: "ຂັ້ນສູງ (ໜ່ວຍ)",
  high_reward: "ລາງວັນຂັ້ນສູງ",
  target_amount: "ເປົ້າ",
  reward_amount: "ລາງວັນ",
  split_by_share: "ແບ່ງຕາມສັດສ່ວນ",
  status_code: "ສະຖານະ",
  multiplier: "ຕົວຄູນ",
  item_code: "ລະຫັດສິນຄ້າ",
  item_name: "ຊື່ສິນຄ້າ",
  item_brand: "ແບຣນ",
  note: "ໝາຍເຫດ",
  salename: "ຊື່ຜູ້ຂາຍ",
  employee_code: "ລະຫັດພະນັກງານ",
  code: "ລະຫັດ",
  label: "ຊື່",
  sort_order: "ລຳດັບ",
};

const MONTHS = ["ມັງກອນ", "ກຸມພາ", "ມີນາ", "ເມສາ", "ພຶດສະພາ", "ມິຖຸນາ", "ກໍລະກົດ", "ສິງຫາ", "ກັນຍາ", "ຕຸລາ", "ພະຈິກ", "ທັນວາ"];
const PCT_COLUMNS = new Set(["from_pct", "min_pct", "rate_pct", "round_step", "low_max_pct", "standard_max_pct"]);
const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}T/.test(value);
const num = (value: unknown) => Number(String(value ?? "").replace(/,/g, ""));

const POSITION_LABEL: Record<string, string> = {
  "11": "ຜູ້ຈັດການ",
  "12": "ຫົວໜ້າໜ່ວຍງານ",
  "13": "ພະນັກງານຂາຍ",
};

const GROUP_LABEL: Record<string, string> = {
  AIR: "ເຄື່ອງປັບອາກາດ",
  CE_SDA: "ເຄື່ອງໃຊ້ໄຟຟ້າ ແລະ ສິນຄ້າຂະໜາດນ້ອຍ",
  ALL: "ລວມທຸກໝວດ",
  ONLINE: "ການຂາຍອອນລາຍ",
};

const MODE_LABEL: Record<string, string> = {
  zero: "ບໍ່ຈ່າຍຄ່າຄອມ",
  round_down: "ປັດອັດຕາລົງ",
  round_up: "ປັດອັດຕາຂຶ້ນ",
  exact: "ໃຊ້ % ຜົນງານຈິງ",
};

/** Product status codes, with the tone that matches how the multiplier pays. */
const STATUS_LABEL: Record<string, { label: string; tone: string }> = {
  current: { label: "ປົກກະຕິ", tone: "pill-muted" },
  special_no_bonus: { label: "ບໍ່ໃຫ້ຄະແນນ", tone: "pill-neg" },
  special_min_bonus: { label: "ໃຫ້ຄະແນນເຄິ່ງດຽວ", tone: "pill-warn" },
  special_promo_max: { label: "ໂປຣໂມຊັນ ເພີ່ມຄະແນນ", tone: "pill-pos" },
};

function renderCell(column: string, value: unknown) {
  if (value === null || value === undefined || value === "") return <span style={{ color: "var(--muted)" }}>—</span>;

  if (typeof value === "boolean") {
    return <span className={`pill ${value ? "pill-pos" : "pill-muted"}`}>{value ? "ໃຊ້" : "ປິດ"}</span>;
  }
  if (typeof value === "string" && isDate(value)) return fmtDate(value);
  if (column === "position_code") return POSITION_LABEL[String(value)] || String(value);
  if (column === "group_code") return GROUP_LABEL[String(value)] || String(value);
  if (column === "mode") return MODE_LABEL[String(value)] || String(value);
  if (column === "status_code") {
    const status = STATUS_LABEL[String(value)];
    return status ? <span className={`pill ${status.tone}`}>{status.label}</span> : String(value);
  }
  if (column === "multiplier") return `×${num(value)}`;
  if (PCT_COLUMNS.has(column)) return `${(num(value) * 100).toFixed(0)}%`;

  const parsed = num(value);
  if (Number.isFinite(parsed) && /^-?[\d.,]+$/.test(String(value))) {
    return parsed.toLocaleString("en-US", { maximumFractionDigits: 4 });
  }
  return String(value);
}

/** Groups the point rules into one small matrix per category: brand × size. */
function PointMatrix({ rows, month, year, t }: { rows: Record<string, unknown>[]; month: string; year: string; t: (key: string) => string }) {
  const byCategory = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = String(row.category_code ?? "-");
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key)!.push(row);
  }

  return (
    <div className="space-y-4">
      {[...byCategory.entries()].map(([category, list]) => {
        const sizes = [...new Set(list.map((row) => String(row.size_token ?? "")))].filter(Boolean).sort();
        const brands = [...new Set(list.map((row) => `${row.brand_code ?? "-"}|${row.design_token ?? ""}`))].sort();
        const value = (brandKey: string, size: string) => {
          const [brand, design] = brandKey.split("|");
          const hit = list.find(
            (row) =>
              String(row.brand_code ?? "-") === brand &&
              String(row.design_token ?? "") === design &&
              String(row.size_token ?? "") === size,
          );
          return hit ? Number(hit.points) : null;
        };
        const max = Math.max(...list.map((row) => Number(row.points || 0)), 1);

        return (
          <div key={category}>
            <p className="mb-1.5 flex items-center gap-2 text-[12px] font-bold" style={{ color: "var(--ink)" }}>
              <span className="pill">{category}</span>
              <span style={{ color: "var(--muted)", fontWeight: 500 }}>
                {brands.length} {t("incentiveCfg.brands")} · {sizes.length} {t("incentiveCfg.sizes")}
              </span>
            </p>
            <div className="tbl-scroll">
              <table className="tbl" style={{ minWidth: 120 + sizes.length * 78 }}>
                <thead>
                  <tr>
                    <th style={{ minWidth: 150 }}>{t("incentiveCfg.brandDesign")}</th>
                    {sizes.map((size) => (
                      <th key={size}>{size}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {brands.map((brandKey) => {
                    const [brand, design] = brandKey.split("|");
                    return (
                      <tr key={brandKey}>
                        <td>
                          <span className="font-semibold" style={{ color: "var(--ink)" }}>{brand}</span>
                          {design && <span className="pill pill-muted ml-1.5">{design}</span>}
                        </td>
                        {sizes.map((size) => {
                          const points = value(brandKey, size);
                          if (points === null) return <td key={size} style={{ color: "var(--line)" }}>·</td>;
                          const strength = Math.min(1, points / max);
                          return (
                            <td key={size} style={{ fontWeight: 700, color: "var(--ink)" }}>
                              <span
                                className="inline-block rounded-[var(--r-xs)] px-1.5 py-0.5"
                                style={{ background: `color-mix(in srgb, var(--brand) ${Math.round(strength * 26)}%, transparent)` }}
                              >
                                {points}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      {!byCategory.size && <p className="page-sub py-3 text-center">{`${t("label.noData")} — ${month}/${year}`}</p>}
    </div>
  );
}

/** Categories read better as grouped chips than as a 7-column table. */
function CategoryCards({ rows, t }: { rows: Record<string, unknown>[]; t: (key: string) => string }) {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = String(row.group_code ?? "-");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {[...groups.entries()].map(([group, list]) => (
        <div key={group} className="rounded-[var(--r-md)] border p-3" style={{ borderColor: "var(--line)" }}>
          <p className="mb-2 flex items-center gap-2 text-[12px] font-bold" style={{ color: "var(--ink)" }}>
            <span className="pill">{group}</span>
            <span style={{ color: "var(--muted)", fontWeight: 500 }}>{list.length} {t("incentiveCfg.categories")}</span>
          </p>
          <div className="space-y-1">
            {list.map((row) => (
              <div key={String(row.category_code)} className="flex items-center justify-between gap-2 text-[12px]">
                <span className="truncate" style={{ color: "var(--ink-soft)" }}>
                  <span className="num mr-1.5" style={{ color: "var(--muted)" }}>{String(row.category_code)}</span>
                  {String(row.category_name ?? "")}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {row.pointmap_category ? (
                    <span className="pill pill-muted">{String(row.pointmap_category)}</span>
                  ) : (
                    <span className="pill pill-neg">{t("incentiveCfg.noPointMap")}</span>
                  )}
                  {Number(row.weight) !== 1 && <span className="pill pill-warn">×{Number(row.weight)}</span>}
                  {row.is_active === false && <span className="pill pill-neg">{t("access.disabled")}</span>}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

type IncentiveSection = "points" | "rewards" | "product" | "mapping";

export function IncentiveConfigPage({ sectionKey = "points" }: { sectionKey?: IncentiveSection }) {
  const { t } = useLanguage();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const now = new Date();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [allPeriods, setAllPeriods] = useState(false);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [groupPick, setGroupPick] = useState<Record<string, string>>({});
  const [tablePick, setTablePick] = useState<Partial<Record<IncentiveSection, string>>>({});
  const [statusPick, setStatusPick] = useState<Record<string, string>>({});
  const [brandPick, setBrandPick] = useState<Record<string, string>>({});

  /** The endpoint is cached for 5 minutes, so the refresh button skips it. */
  const load = async (fresh = false) => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/incentive-config", {
        params: { year, month, ...(allPeriods ? { all: 1 } : {}), ...(fresh ? { nocache: 1 } : {}) },
      });
      if (res.data?.success) setData(res.data.data);
      else {
        // A manual refresh should not blank a valid screen on a transient error.
        if (!fresh) setData(null);
        setError(res.data?.error || t("app.error"));
      }
    } catch {
      if (!fresh) setData(null);
      setError(t("app.error"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month, allPeriods]);

  const section = useMemo(
    () => data?.sections.find((item) => item.key === sectionKey) || null,
    [data, sectionKey],
  );
  const selectedTable = section?.tables.some((block) => block.table === tablePick[sectionKey])
    ? tablePick[sectionKey]
    : section?.tables[0]?.table;
  const config = data?.config || {};
  const currency = String(config.currency_code || "THB");

  const bands = [
    { label: "ຂັ້ນຕ່ຳ", range: `≤ ${(num(config.low_max_pct) * 100).toFixed(0)}%`, mul: num(config.low_multiplier), tone: "pill-neg" },
    { label: "ມາດຕະຖານ", range: `≤ ${(num(config.standard_max_pct) * 100).toFixed(0)}%`, mul: num(config.standard_multiplier), tone: "pill-warn" },
    { label: "ເກີນເປົ້າ", range: `> ${(num(config.standard_max_pct) * 100).toFixed(0)}%`, mul: num(config.high_multiplier), tone: "pill-pos" },
  ];

  return (
    <div className="min-h-screen">
      <header className="page-hd">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-[var(--r-md)] bg-[var(--brand-deep)] text-white">
            <Settings2 size={19} />
          </span>
          <div>
            <p className="eyebrow">ກົດເກນຜົນຕອບແທນ</p>
            <h1 className="page-title">{t("incentiveCfg.title")}</h1>
            <p className="page-sub">{t("incentiveCfg.subtitle")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="field-label">{t("incentiveCfg.effective")}</label>
            <div className="flex gap-1.5">
              <select className="select w-20" value={year} onChange={(e) => setYear(e.target.value)}>
                {[0, 1, 2].map((back) => {
                  const value = String(new Date().getFullYear() - back);
                  return <option key={value} value={value}>{value}</option>;
                })}
              </select>
              <select className="select w-20" value={month} onChange={(e) => setMonth(e.target.value)}>
                {MONTHS.map((label, index) => (
                  <option key={label} value={String(index + 1)}>{label}</option>
                ))}
              </select>
            </div>
          </div>
          <button
            className={`btn ${allPeriods ? "btn-primary" : ""}`}
            onClick={() => setAllPeriods((prev) => !prev)}
            title={t("incentiveCfg.allPeriodsHint")}
          >
            <CalendarClock size={13} /> {allPeriods ? t("incentiveCfg.allPeriods") : t("incentiveCfg.thisMonthOnly")}
          </button>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: "var(--muted)" }} />
            <input
              className="input w-48 pl-7"
              placeholder={t("incentiveCfg.search")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button onClick={() => load(true)} className="btn">
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> {t("monthSummary.refresh")}
          </button>
        </div>
      </header>

      <div className="page">
        {error && (
          <div className="mb-3 rounded-[var(--r-md)] border px-3 py-2 text-[12px] font-medium"
               style={{ borderColor: "var(--neg)", background: "var(--neg-bg)", color: "var(--neg)" }}>
            {error}
          </div>
        )}

        {data && (
          <>
            {/* ── How a reward is built, in one row ── */}
            <div className="mb-3 grid gap-3 lg:grid-cols-3">
              <div className="card stat stat-featured p-3.5">
                <span className="stat-label flex items-center gap-1.5"><Coins size={12} /> {t("incentiveCfg.pointValue")}</span>
                <p className="stat-value">
                  {num(config.base_amount).toLocaleString()} <span className="text-sm font-semibold opacity-70">{currency}</span>
                </p>
                <p className="stat-sub">{t("incentiveCfg.formula")}</p>
              </div>

              <div className="card p-3.5">
                <p className="stat-label mb-2">{t("incentiveCfg.bandTitle")}</p>
                <div className="space-y-1.5">
                  {bands.map((band) => (
                    <div key={band.label} className="flex items-center justify-between gap-2 text-[12px]">
                      <span style={{ color: "var(--ink-soft)" }}>{band.label}</span>
                      <span className="num" style={{ color: "var(--muted)" }}>{band.range}</span>
                      <span className={`pill ${band.tone}`}>×{band.mul}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="card p-3.5">
                <p className="stat-label mb-2">{t("incentiveCfg.commission")}</p>
                <div className="space-y-1.5 text-[12px]">
                  <div className="flex justify-between"><span style={{ color: "var(--ink-soft)" }}>{t("incentiveCfg.commissionBase")}</span><span className="num font-semibold">{num(config.commission_base).toLocaleString()} {currency}</span></div>
                  <div className="flex justify-between"><span style={{ color: "var(--ink-soft)" }}>{t("incentiveCfg.commissionMin")}</span><span className="num font-semibold">{(num(config.commission_min_pct) * 100).toFixed(0)}%</span></div>
                  <div className="flex justify-between"><span style={{ color: "var(--ink-soft)" }}>{t("incentiveCfg.commissionPivot")}</span><span className="num font-semibold">{(num(config.commission_pivot_pct) * 100).toFixed(0)}%</span></div>
                  <div className="flex justify-between"><span style={{ color: "var(--ink-soft)" }}>{t("incentiveCfg.roundStep")}</span><span className="num font-semibold">{num(config.commission_round_step)}</span></div>
                </div>
              </div>
            </div>

            {section && section.tables.length > 0 && (
              <div className="tabs mb-3" role="tablist" aria-label={t(`incentiveCfg.${sectionKey}`)}>
                {section.tables.map((block) => {
                  const meta = TABLE_META[block.table] || { title: block.table };
                  const isSelected = block.table === selectedTable;
                  return (
                    <button
                      key={block.table}
                      type="button"
                      role="tab"
                      aria-selected={isSelected}
                      className={`tab ${isSelected ? "is-active" : ""}`}
                      onClick={() => setTablePick((prev) => ({ ...prev, [sectionKey]: block.table }))}
                    >
                      {meta.title}
                      <span className={`pill ${isSelected ? "" : "pill-muted"}`}>{block.total}</span>
                    </button>
                  );
                })}
              </div>
            )}

            <div>
              {section?.tables.filter((block) => block.table === selectedTable).map((block) => {
                const meta = TABLE_META[block.table] || { title: block.table };
                const expanded = showAll[block.table];
                const hidden = new Set(expanded ? [] : meta.hide || []);
                const columns = block.columns.filter((column) => !hidden.has(column));

                const term = search.trim().toLowerCase();
                const groupValue = groupPick[block.table] || "";
                const groups = meta.groupBy
                  ? [...new Set(block.rows.map((row) => String(row[meta.groupBy!] ?? "")))].sort()
                  : [];
                const statuses = [...new Set(block.rows.map((row) => String(row.status_code ?? "")))]
                  .filter(Boolean)
                  .sort((a, b) => {
                    const order = Object.keys(STATUS_LABEL);
                    const aIndex = order.indexOf(a);
                    const bIndex = order.indexOf(b);
                    return (aIndex < 0 ? order.length : aIndex) - (bIndex < 0 ? order.length : bIndex);
                  });
                const selectedStatus = statuses.includes(statusPick[block.table]) ? statusPick[block.table] : "";
                const brands = [...new Set(block.rows.map((row) => String(row.item_brand ?? "")))]
                  .filter(Boolean)
                  .sort((a, b) => a.localeCompare(b));
                const selectedBrand = brands.includes(brandPick[block.table]) ? brandPick[block.table] : "";
                const statusRows = selectedBrand
                  ? block.rows.filter((row) => String(row.item_brand ?? "") === selectedBrand)
                  : block.rows;

                const visible = block.rows.filter((row) => {
                  if (selectedStatus && String(row.status_code ?? "") !== selectedStatus) return false;
                  if (selectedBrand && String(row.item_brand ?? "") !== selectedBrand) return false;
                  if (groupValue && String(row[meta.groupBy!] ?? "") !== groupValue) return false;
                  if (!term) return true;
                  // The status shows in Lao, so searching in Lao has to find it too.
                  const status = STATUS_LABEL[String(row.status_code ?? "")]?.label ?? "";
                  if (status.includes(term)) return true;
                  return Object.values(row).some((value) => String(value ?? "").toLowerCase().includes(term));
                });

                return (
                  <section key={block.table} className="card" role="tabpanel">
                    <div className="card-hd">
                      <div className="min-w-0">
                        <h3 className="card-title">{meta.title}</h3>
                        {meta.hint && <p className="page-sub ml-3.5">{meta.hint}</p>}
                      </div>
                      <div className="flex items-center gap-2">
                        {groups.length > 1 && (
                          <select
                            className="select w-32"
                            value={groupValue}
                            onChange={(e) => setGroupPick((prev) => ({ ...prev, [block.table]: e.target.value }))}
                          >
                            <option value="">{t("app.all")} ({groups.length})</option>
                            {groups.map((group) => (
                              <option key={group} value={group}>{group}</option>
                            ))}
                          </select>
                        )}
                        {brands.length > 1 && (
                          <select
                            className="select w-40"
                            value={selectedBrand}
                            aria-label="Filter by brand"
                            onChange={(e) => setBrandPick((prev) => ({ ...prev, [block.table]: e.target.value }))}
                          >
                            <option value="">ທຸກແບຣນ ({brands.length})</option>
                            {brands.map((brand) => (
                              <option key={brand} value={brand}>{brand}</option>
                            ))}
                          </select>
                        )}
                        {block.period && (
                          <span className={`pill ${block.scoped ? "pill-pos" : "pill-muted"}`}>
                            {block.scoped
                              ? `${t("incentiveCfg.inForce")} ${MONTHS[Number(month) - 1]} ${year}`
                              : t("incentiveCfg.allPeriods")}
                          </span>
                        )}
                        <span className="pill pill-muted num">{visible.length}/{block.total}</span>
                        {(meta.hide?.length || 0) > 0 || ["app_incentive_category", "app_incentive_point_rule"].includes(block.table) ? (
                          <button
                            className="btn btn-ghost btn-icon"
                            title={expanded ? t("incentiveCfg.lessColumns") : t("incentiveCfg.moreColumns")}
                            onClick={() => setShowAll((prev) => ({ ...prev, [block.table]: !prev[block.table] }))}
                          >
                            {expanded ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        ) : null}
                      </div>
                    </div>
                    {statuses.length > 1 && (
                      <div className="border-b px-[var(--pad-card)] py-2" style={{ borderColor: "var(--line-soft)" }}>
                        <div className="tabs" role="tablist" aria-label="ແຍກຕາມສະຖານະ">
                          <button
                            type="button"
                            role="tab"
                            aria-selected={!selectedStatus}
                            className={`tab ${!selectedStatus ? "is-active" : ""}`}
                            onClick={() => setStatusPick((prev) => ({ ...prev, [block.table]: "" }))}
                          >
                            {t("app.all")}
                            <span className={`pill ${!selectedStatus ? "" : "pill-muted"}`}>{statusRows.length}</span>
                          </button>
                          {statuses.map((statusCode) => {
                            const status = STATUS_LABEL[statusCode];
                            const count = statusRows.filter((row) => String(row.status_code ?? "") === statusCode).length;
                            const isSelected = selectedStatus === statusCode;
                            return (
                              <button
                                key={statusCode}
                                type="button"
                                role="tab"
                                aria-selected={isSelected}
                                className={`tab ${isSelected ? "is-active" : ""}`}
                                onClick={() => setStatusPick((prev) => ({ ...prev, [block.table]: statusCode }))}
                              >
                                {status?.label || statusCode}
                                <span className={`pill ${isSelected ? "" : status?.tone || "pill-muted"}`}>{count}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {block.table === "app_incentive_category" && !expanded ? (
                      <div className="card-bd">
                        <CategoryCards rows={visible} t={t} />
                      </div>
                    ) : block.table === "app_incentive_point_rule" && !expanded ? (
                      <div className="card-bd" style={{ maxHeight: 520, overflowY: "auto" }}>
                        <PointMatrix rows={visible} month={month} year={year} t={t} />
                      </div>
                    ) : (
                    <div className="card-bd-flush tbl-scroll" style={{ maxHeight: 420, overflowY: "auto" }}>
                      <table className="tbl" style={{ minWidth: Math.max(420, columns.length * 130) }}>
                        <thead>
                          <tr>
                            {columns.map((column) => (
                              <th key={column} style={column === "item_name" ? { textAlign: "left" } : undefined}>
                                {COLUMN_LABEL[column] || column}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {visible.map((row, index) => (
                            <tr key={index}>
                              {columns.map((column) => (
                                <td
                                  key={column}
                                  {...(column === "item_name"
                                    ? {
                                        title: String(row[column] ?? ""),
                                        style: { textAlign: "left" as const, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" },
                                      }
                                    : {})}
                                >
                                  {renderCell(column, row[column])}
                                </td>
                              ))}
                            </tr>
                          ))}
                          {!visible.length && (
                            <tr>
                              <td colSpan={columns.length || 1} style={{ textAlign: "center", color: "var(--muted)", padding: "1.25rem" }}>
                                {t("label.noData")}
                                {/* An empty month usually means the rules expired, not that there are none. */}
                                {block.scoped && block.total > 0 && !term && (
                                  <button className="btn btn-ghost ml-2" onClick={() => setAllPeriods(true)}>
                                    <CalendarClock size={12} /> ມີ {block.total} ແຖວໃນຊ່ວງອື່ນ · ເບິ່ງທຸກຊ່ວງເວລາ
                                  </button>
                                )}
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    )}
                    {block.shown < block.total && (
                      <div className="card-bd flex items-center gap-1.5 py-2 text-[11px]" style={{ color: "var(--muted)" }}>
                        <ChevronDown size={12} /> {t("incentiveCfg.truncated")} {block.shown}/{block.total}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>

            <p className="mt-3 text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
              {t("incentiveCfg.note")}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default function IncentiveConfigIndexPage() {
  return <IncentiveConfigPage />;
}
