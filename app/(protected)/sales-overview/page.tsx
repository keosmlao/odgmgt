"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  BarChart3,
  Boxes,
  CalendarDays,
  ChevronRight,
  Clock3,
  Layers,
  Map as MapIcon,
  Percent,
  RefreshCw,
  Route,
  Ruler,
  ShieldCheck,
  Siren,
  Target,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import api from "@/service/api";
import { useAuth } from "@/context/AuthContext";
import { useLanguage } from "@/context/LanguageContext";
import { REGIONS, regionLabel } from "@/lib/sales-regions.mjs";
import { isExecutive } from "@/lib/home-route";

/**
 * ພາບລວມການຂາຍ — ໜ້າຂອງຜູ້ບໍລິຫານ ແລະ ຄົນທີ່ຖືກອະນຸຍາດ.
 *
 * ຄຳຖາມດຽວຢູ່ເທິງສຸດ: ເດືອນນີ້ຈະຈົບຢູ່ໃສ ຖ້າຄວາມໄວຍັງເທົ່າເກົ່າ ແລະ ຫ່າງຈາກເປົ້າ
 * ເທົ່າໃດ. ຕົວກັ່ນຕອງ (ປີ · ເດືອນ · ພາກ · BU · ຊ່ອງທາງ) ຫັ່ນຕົວເລກອັນດຽວກັນນັ້ນ
 * ບໍ່ແມ່ນເອົາຕົວເລກຊຸດໃໝ່ມາວາງ — ຈຶ່ງບໍ່ມີເລກສອງຊຸດໃຫ້ຖຽງກັນ.
 *
 * ໜ້ານີ້ຢືມໂຄງ Lightning (sf-*) ຂອງໜ້າ dashboard ມາໃຊ້ຄືນ ເພື່ອສອງໜ້າຢູ່ໃນ
 * ພາສາອອກແບບອັນດຽວກັນ.
 */

type Rank = { code: string; label: string; amount: number; share: number };

type Payload = {
  meta: {
    year: number;
    month: number;
    mode: "month" | "ytd";
    region: string;
    last_year: number;
    data_through: string | null;
    running_month: boolean;
  };
  days: { total: number; elapsed: number; remaining: number; cut_day: number };
  forecast: {
    projected: number;
    adjusted: number;
    bias_pct: number;
    bias_months: number;
    target: number;
    pct_of_target: number;
    shortfall: number;
    booked: number;
    from_pace: number;
  };
  month: {
    actual: number;
    target: number;
    pct: number;
    gap: number;
    per_day_actual: number;
    per_day_target: number;
    per_day_required: number;
    speed_up_pct: number;
    last_year: number;
    growth: number;
    bills: number;
    avg_bill: number;
  };
  ytd: { actual: number; target: number; pct: number; last_year: number; growth: number };
  scope: { actual: number; target: number; pct: number; last_year: number; growth: number };
  by_bu: Rank[];
  by_channel: Rank[];
  by_region: { code: string; amount: number }[];
  daily: {
    rows: { day: number; amount: number; bills: number; cumulative: number }[];
    best: { day: number; amount: number; bills: number } | null;
    per_day_target: number;
  };
  trend: { year: number; months: number[] }[];
  sellers: (Rank & { bills: number })[];
  customers: { rows: (Rank & { bills: number })[]; count: number; top_share: number };
  margin: {
    amount: number;
    discount: number;
    discount_pct: number;
    profit: number;
    gp_pct: number;
    bills: number;
  };
  ar: {
    balance: number;
    overdue: number;
    customers: number;
    buckets: { label: string; amount: number }[];
    top: { label: string; amount: number; days: number }[];
  } | null;
  stock: {
    value: number;
    items: number;
    dead_value: number;
    dead_items: number;
    over_360: number;
  } | null;
  gaps: { label: string; target: number; actual: number; gap: number; pct: number }[];
  accuracy: {
    year: number;
    month: number;
    projected: number;
    actual: number;
    error_pct: number;
  }[];
  dimensions: {
    provinces: { code: string; label: string; amount: number }[];
    branches: { code: string; label: string; amount: number }[];
    groups: { code: string; label: string; amount: number }[];
  };
  visits: {
    totals: {
      visits: number;
      people: number;
      customers: number;
      completed: number;
      open_visits: number;
      order_amount: number;
      collection_amount: number;
    };
    people: {
      employee_code: string;
      name: string;
      visits: number;
      customers: number;
      completed: number;
    }[];
    outcomes: { label: string; visits: number }[];
    quality: {
      visits: number;
      checklist: number;
      stock: number;
      photo: number;
      score: number;
    } | null;
    types: { label: string; visits: number }[];
    first_day: string | null;
    last_day: string | null;
  } | null;
  leak: {
    returns: number;
    return_bills: number;
    loss_lines: number;
    loss_lines_profit: number;
    deep_discount: number;
  } | null;
};

const MONTHS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

const BU_CHIPS = [
  { code: "ALL", label: "ທຸກ BU" },
  { code: "11", label: "ໄຟຟ້າ" },
  { code: "12", label: "ແອ" },
  { code: "13", label: "ປະປາ" },
  { code: "14", label: "ອາໄຫຼ່" },
  { code: "15", label: "ໄຟຟ້ານ້ອຍ" },
  { code: "16", label: "ສູນບໍລິການ" },
  { code: "17", label: "ອອນລາຍ" },
];

const CHANNEL_CHIPS = [
  { code: "ALL", label: "ທຸກຊ່ອງທາງ" },
  { code: "101", label: "ຂາຍໜ້າຮ້ານ" },
  { code: "102", label: "ຂາຍສົ່ງ" },
  { code: "103", label: "ຂາຍໂຄງການ" },
  { code: "106", label: "ຂາຍຊ່າງ" },
  { code: "107", label: "ຂາຍອອນລາຍ" },
  { code: "104", label: "ພະນັກງານ" },
];

const full = (value: number) => Math.round(Number(value || 0)).toLocaleString("en-US");

/** ຫຍໍ້ໃຫ້ອ່ານໄວ — ໃຊ້ໃນແຖບ ແລະ ບ່ອນແຄບ, ບໍ່ໃຊ້ກັບຕົວເລກຫຼັກ. */
const short = (value: number) => {
  const n = Number(value || 0);
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return full(n);
};

const pct = (value: number) => `${Math.round(Number(value || 0))}%`;

const tone = (value: number) => {
  const n = Number(value || 0);
  if (n >= 100) return "pos";
  if (n >= 90) return "warn";
  return "neg";
};

const STORE_KEY = "odg_sales_overview_filters";

export default function SalesOverview() {
  const { user, hydrated } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [mode, setMode] = useState<"month" | "ytd">("month");
  const [region, setRegion] = useState("ALL");
  const [bu, setBu] = useState("ALL");
  const [channel, setChannel] = useState("ALL");

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [restored, setRestored] = useState(false);

  /** ຜູ້ທີ່ເປີດໜ້ານີ້ໄດ້ — ຕົງກັບ ALLOWED_ROLES ຢູ່ຝັ່ງ API. */
  const allowed = !user || isExecutive(user);

  /** ຄົນທີ່ບໍ່ມີສິດພິມ URL ເຂົ້າມາ — ສົ່ງກັບ; API ກໍ່ປະຕິເສດຢູ່ແລ້ວ. */
  useEffect(() => {
    if (hydrated && user && !allowed) router.replace("/dashboard");
  }, [hydrated, user, allowed, router]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (saved) {
        if (saved.year) setYear(Number(saved.year));
        if (saved.month) setMonth(Number(saved.month));
        if (saved.mode) setMode(saved.mode === "ytd" ? "ytd" : "month");
        if (saved.region) setRegion(String(saved.region));
        if (saved.bu) setBu(String(saved.bu));
        if (saved.channel) setChannel(String(saved.channel));
      }
    } catch {
      localStorage.removeItem(STORE_KEY);
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    localStorage.setItem(STORE_KEY, JSON.stringify({ year, month, mode, region, bu, channel }));
  }, [restored, year, month, mode, region, bu, channel]);

  const load = async (force = false) => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/sales-overview", {
        params: { year, month, mode, region, bu, channel, ...(force ? { refresh: 1 } : {}) },
      });
      if (res.data?.success) setData(res.data.data);
      else {
        setData(null);
        setError(res.data?.error || t("app.error"));
      }
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      setData(null);
      setError(status === 403 ? "ບໍ່ມີສິດເບິ່ງໜ້ານີ້" : t("app.error"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!restored || !hydrated || !allowed) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored, hydrated, allowed, year, month, mode, region, bu, channel]);

  const years = useMemo(() => {
    const current = new Date().getFullYear();
    return [current, current - 1, current - 2];
  }, []);

  const scopeLabel = useMemo(() => {
    const place = region === "ALL" ? "ທົ່ວປະເທດ" : regionLabel(region);
    return `${place} · ${year}-${MONTHS[month - 1]}`;
  }, [region, year, month]);

  /** ແຖບຄາດການ: ຂາຍແລ້ວ ແລະ ສ່ວນທີ່ຄວາມໄວປັດຈຸບັນຈະພາໄປຮອດ. */
  const bar = useMemo(() => {
    if (!data) return { booked: 0, pace: 0 };
    const scale = Math.max(data.forecast.target, data.forecast.projected, 1);
    return {
      booked: (data.forecast.booked / scale) * 100,
      pace: (data.forecast.from_pace / scale) * 100,
    };
  }, [data]);

  const highlights = data
    ? [
        {
          label: "ຄາດການສິ້ນເດືອນ",
          value: short(data.forecast.projected),
          sub: `${pct(data.forecast.pct_of_target)} ຂອງເປົ້າ`,
          tone: tone(data.forecast.pct_of_target),
        },
        {
          label: "ຍອດຈິງເດືອນນີ້",
          value: short(data.month.actual),
          sub: `${data.days.elapsed}/${data.days.total} ວັນຂາຍ`,
        },
        {
          label: "ຍັງຂາດ",
          value: short(data.month.gap),
          sub: `${data.days.remaining} ວັນທີ່ເຫຼືອ`,
          tone: data.month.gap ? "neg" : "pos",
        },
        {
          label: "ຕ້ອງໄດ້ / ວັນ",
          value: short(data.month.per_day_required),
          sub: `ໄດ້ຈິງ ${short(data.month.per_day_actual)}`,
          tone: data.month.speed_up_pct > 0 ? "warn" : "pos",
        },
        {
          label: "ສະສົມ YTD",
          value: short(data.ytd.actual),
          sub: `${pct(data.ytd.pct)} ຂອງ ${short(data.ytd.target)}`,
        },
        {
          label: `ທຽບ ${data.meta.last_year}`,
          value: pct(data.scope.growth),
          sub: short(data.scope.last_year),
          tone: data.scope.growth >= 100 ? "pos" : "neg",
        },
      ]
    : [];

  if (hydrated && user && !allowed) return null;

  const chipRow = (
    label: string,
    items: { code: string; label: string }[],
    value: string,
    onPick: (code: string) => void,
  ) => (
    <div className="so-row">
      <span className="so-row-label">{label}</span>
      <div className="so-chips">
        {items.map((item) => (
          <button
            key={item.code}
            type="button"
            onClick={() => onPick(item.code)}
            className={`so-chip ${value === item.code ? "is-active" : ""}`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );

  const rankRows = (list: Rank[]) => (
    <>
      {list.slice(0, 8).map((item) => (
        <div key={item.code} className="so-rank">
          <span className="so-rank-label" title={item.label}>
            {item.label}
          </span>
          <span className="so-rank-bar">
            <span style={{ width: `${Math.max(2, Math.min(100, item.share))}%` }} />
          </span>
          <span className="so-rank-value">{short(item.amount)}</span>
          <span className="so-rank-share">{pct(item.share)}</span>
        </div>
      ))}
      {!list.length && <p className="so-empty">ບໍ່ມີຂໍ້ມູນ</p>}
    </>
  );

  const scopeWord = mode === "ytd" ? "ສະສົມ" : "ເດືອນນີ້";

  /** ແຖວອັນດັບຈາກລາຍການທີ່ມີແຕ່ຍອດ — ຄິດສ່ວນແບ່ງໃຫ້ເອງ. */
  const amountRanks = (list: { code: string; label: string; amount: number }[]) => {
    const total = list.reduce((sum, row) => sum + row.amount, 0);
    return list.map((row) => ({ ...row, share: (row.amount / Math.max(1, total)) * 100 }));
  };

  /**
   * ສຸຂະພາບ 360°: ຫົກຕົວທີ່ບອກວ່າທຸລະກິດແຂງແຮງ ຫຼື ບໍ່ — ອ່ານແຖວດຽວແທນການ
   * ໄລ່ເບິ່ງທຸກກາດຂ້າງເທິງ. ເກນສີ: ຂຽວ = ດີ · ເຫຼືອງ = ເຝົ້າ · ແດງ = ຕ້ອງແກ້.
   */
  const health = data
    ? [
        {
          label: "ບັນລຸເປົ້າ",
          value: pct(data.month.pct),
          tone: tone(data.month.pct),
        },
        {
          label: "ເຕີບໂຕ",
          value: pct(data.scope.growth),
          tone: data.scope.growth >= 100 ? "pos" : data.scope.growth >= 95 ? "warn" : "neg",
        },
        {
          label: "GP",
          value: `${data.margin.gp_pct.toFixed(1)}%`,
          tone: data.margin.gp_pct >= 22 ? "pos" : data.margin.gp_pct >= 18 ? "warn" : "neg",
        },
        {
          label: "ໜີ້ເກີນກຳນົດ",
          value: data.ar
            ? pct((data.ar.overdue / Math.max(1, data.ar.balance)) * 100)
            : "–",
          tone: data.ar && data.ar.overdue / Math.max(1, data.ar.balance) > 0.5 ? "neg" : "warn",
        },
        {
          label: "ສະຕັອກຂາຍບໍ່ອອກ",
          value: data.stock
            ? pct((data.stock.dead_value / Math.max(1, data.stock.value)) * 100)
            : "–",
          tone:
            data.stock && data.stock.dead_value / Math.max(1, data.stock.value) > 0.2
              ? "neg"
              : "warn",
        },
        {
          label: "ພຶ່ງລູກຄ້າໃຫຍ່",
          value: pct(data.customers.top_share),
          tone: data.customers.top_share > 30 ? "warn" : "pos",
        },
      ]
    : [];

  return (
    <div className="sf-app min-h-screen bg-transparent">
      {/* ══ ຫົວໜ້າແບບ Lightning ══ */}
      <header className="sf-hd">
        <div className="sf-crumb">
          <BarChart3 size={11} />
          <span>ຝ່າຍຂາຍ</span>
          <ChevronRight size={11} />
          <span className="font-semibold text-[var(--ink-soft)]">ພາບລວມການຂາຍ</span>
        </div>

        <div className="sf-ph">
          <div className="sf-ph-id">
            <span className="sf-icon">
              <Target size={18} />
            </span>
            <div className="min-w-0">
              <h1 className="sf-ph-title truncate">ພາບລວມການຂາຍ</h1>
              <p className="sf-ph-meta">
                {user?.full_name || user?.username} · {user?.username} · {scopeLabel} · ຫົວໜ່ວຍ ບາດ
                {data?.meta.data_through && (
                  <>
                    {" "}
                    · <Clock3 size={10} className="inline" /> ຂໍ້ມູນ {data.meta.data_through}
                  </>
                )}
              </p>
            </div>
          </div>

          <div className="sf-group">
            <button onClick={() => load(true)} className="btn" disabled={loading}>
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> ໂຫຼດໃໝ່
            </button>
          </div>
        </div>

        {data && (
          <div className="sf-hl">
            {highlights.map((item) => (
              <div key={item.label} className="sf-hl-item">
                <p className="sf-hl-label">{item.label}</p>
                <p
                  className="sf-hl-value"
                  style={item.tone ? { color: `var(--${item.tone})` } : undefined}
                >
                  {item.value}
                </p>
                <p className="sf-hl-sub">{item.sub}</p>
              </div>
            ))}
          </div>
        )}

        <div className="sf-tabs">
          <button
            onClick={() => setMode("month")}
            className={`sf-tab ${mode === "month" ? "is-active" : ""}`}
          >
            ເດືອນດຽວ · {MONTHS[month - 1]}
          </button>
          <button
            onClick={() => setMode("ytd")}
            className={`sf-tab ${mode === "ytd" ? "is-active" : ""}`}
          >
            ສະສົມ YTD · 1–{month}
          </button>
        </div>
      </header>

      <main className="page">
        {/* ══ ຕົວກັ່ນຕອງ ══ */}
        <div className="so-filters">
          {chipRow(
            "ປີ",
            years.map((y) => ({ code: String(y), label: String(y) })),
            String(year),
            (code) => setYear(Number(code)),
          )}
          {chipRow(
            "ເດືອນ",
            MONTHS.map((label, index) => ({ code: String(index + 1), label })),
            String(month),
            (code) => setMonth(Number(code)),
          )}
          {chipRow(
            "ພາກ",
            [
              { code: "ALL", label: "ທົ່ວປະເທດ" },
              ...REGIONS.map((item: { key: string; label: string }) => ({
                code: item.key,
                label: item.label,
              })),
              { code: "U", label: "ບໍ່ລະບຸ" },
            ],
            region,
            setRegion,
          )}
          {chipRow("BU", BU_CHIPS, bu, setBu)}
          {chipRow("ຊ່ອງທາງ", CHANNEL_CHIPS, channel, setChannel)}
        </div>

        {error && (
          <div className="so-error">
            <AlertTriangle size={14} /> {error}
          </div>
        )}

        {loading && !data && <div className="skeleton mt-3 h-[24rem]" />}

        {data && (
          <div className={loading ? "ms-busy" : ""}>
            {/* ══ ① ຄາດການສິ້ນເດືອນ ══ */}
            <section className="sf-widget mt-3">
              <div className="sf-widget-hd">
                <div className="min-w-0 flex-1">
                  <h3 className="sf-widget-title">
                    <TrendingUp size={13} /> ① ຄາດການສິ້ນເດືອນ · {data.meta.year}-
                    {MONTHS[data.meta.month - 1]}
                  </h3>
                  <p className="sf-widget-sub">
                    ຄວາມໄວ {data.days.elapsed} ວັນທຳອິດ ພາໄປຮອດໃສ ເມື່ອຄົບ {data.days.total} ວັນຂາຍ
                  </p>
                </div>
                <span className={`pill ${data.forecast.shortfall ? "pill-neg" : "pill-pos"}`}>
                  {data.forecast.shortfall
                    ? `ຄາດວ່າຂາດ ${full(data.forecast.shortfall)}`
                    : `ຄາດວ່າເກີນເປົ້າ ${full(data.forecast.projected - data.forecast.target)}`}
                </span>
              </div>

              <div className="sf-widget-bd">
                <div className="so-hero">
                  <div>
                    <p className="so-hero-label">ຄາດການ</p>
                    <p className="so-hero-value">
                      {full(data.forecast.projected)} <span>ບາດ</span>
                    </p>
                    <p className="so-hero-sub">
                      ຈາກເປົ້າ <b>{full(data.forecast.target)}</b> ·{" "}
                      <b style={{ color: `var(--${tone(data.forecast.pct_of_target)})` }}>
                        {pct(data.forecast.pct_of_target)}
                      </b>{" "}
                      · ຜ່ານມາ {data.days.elapsed}/{data.days.total} ວັນຂາຍ
                    </p>

                    <div className="so-bar">
                      <span className="is-booked" style={{ width: `${bar.booked}%` }} />
                      <span className="is-pace" style={{ width: `${bar.pace}%` }} />
                    </div>
                    <div className="so-legend">
                      <span>
                        <i className="is-booked" /> ຂາຍແລ້ວ {short(data.forecast.booked)}
                      </span>
                      <span>
                        <i className="is-pace" /> ຄາດຈາກຄວາມໄວ {short(data.forecast.from_pace)}
                      </span>
                    </div>

                    <div className="so-bias">
                      <p>
                        ຄາດການແກ້ອະຄະຕິແລ້ວ · <b>{full(data.forecast.adjusted)}</b> ບາດ
                      </p>
                      <p className="so-bias-note">
                        {data.forecast.bias_months} ເດືອນຫຼ້າສຸດ ຄາດການ
                        {data.forecast.bias_pct >= 0 ? "ຕໍ່າກວ່າ" : "ສູງກວ່າ"}ຈິງສະເລ່ຍ{" "}
                        <b>{Math.abs(data.forecast.bias_pct).toFixed(1)}%</b> — ວັດ ນະ ວັນທີ{" "}
                        {data.days.cut_day} ຂອງເດືອນຄືກັນ
                      </p>
                    </div>
                  </div>

                  <div className="so-kpis">
                    <div>
                      <p className="so-kpi-label">ຍອດຈິງ</p>
                      <p className="so-kpi-value">{full(data.month.actual)}</p>
                      <p className="so-kpi-note">{pct(data.month.pct)} ຂອງເປົ້າ</p>
                    </div>
                    <div>
                      <p className="so-kpi-label">ຍັງຂາດ</p>
                      <p className="so-kpi-value">{full(data.month.gap)}</p>
                      <p className="so-kpi-note">{data.days.remaining} ວັນທີ່ເຫຼືອ</p>
                    </div>
                    <div>
                      <p className="so-kpi-label">ໄດ້ຈິງ / ວັນ</p>
                      <p className="so-kpi-value">{full(data.month.per_day_actual)}</p>
                      <p className="so-kpi-note">ເປົ້າ/ວັນ {short(data.month.per_day_target)}</p>
                    </div>
                    <div>
                      <p className="so-kpi-label">ຕ້ອງໄດ້ / ວັນ</p>
                      <p
                        className="so-kpi-value"
                        style={{
                          color: data.month.speed_up_pct > 0 ? "var(--neg)" : "var(--pos)",
                        }}
                      >
                        {full(data.month.per_day_required)}
                      </p>
                      <p className="so-kpi-note">
                        {data.month.speed_up_pct > 0
                          ? `ຕ້ອງໄວຂຶ້ນ ${pct(data.month.speed_up_pct)}`
                          : "ຄວາມໄວພຽງພໍ"}
                      </p>
                    </div>
                    <div>
                      <p className="so-kpi-label">ສະສົມ ມ.ກ–ເດືອນນີ້</p>
                      <p className="so-kpi-value" style={{ color: "var(--warn)" }}>
                        {full(data.ytd.actual)}
                      </p>
                      <p className="so-kpi-note">
                        {pct(data.ytd.pct)} ຂອງ {short(data.ytd.target)}
                      </p>
                    </div>
                    <div>
                      <p className="so-kpi-label">ບິນເດືອນນີ້</p>
                      <p className="so-kpi-value">{full(data.month.bills)}</p>
                      <p className="so-kpi-note">ສະເລ່ຍ/ບິນ {short(data.month.avg_bill)}</p>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* ══ ② ແຍກຕາມ BU · ③ ແຍກຕາມຊ່ອງທາງ ══ */}
            <div className="so-grid mt-3">
              <section className="sf-widget">
                <div className="sf-widget-hd">
                  <div className="min-w-0 flex-1">
                    <h3 className="sf-widget-title">
                      <Layers size={13} /> ② ແຍກຕາມ BU · {scopeWord}
                    </h3>
                    <p className="sf-widget-sub">{data.by_bu.length} ລາຍການ</p>
                  </div>
                </div>
                <div className="sf-widget-bd">{rankRows(data.by_bu)}</div>
              </section>

              <section className="sf-widget">
                <div className="sf-widget-hd">
                  <div className="min-w-0 flex-1">
                    <h3 className="sf-widget-title">
                      <Layers size={13} /> ③ ແຍກຕາມຊ່ອງທາງ · {scopeWord}
                    </h3>
                    <p className="sf-widget-sub">{data.by_channel.length} ລາຍການ</p>
                  </div>
                </div>
                <div className="sf-widget-bd">{rankRows(data.by_channel)}</div>
              </section>
            </div>

            {/* ══ ④ ແຍກຕາມພາກ · ⑤ ທຽບປີກ່ອນ ══ */}
            <div className="so-grid mt-3">
              <section className="sf-widget">
                <div className="sf-widget-hd">
                  <div className="min-w-0 flex-1">
                    <h3 className="sf-widget-title">
                      <MapIcon size={13} /> ④ ແຍກຕາມພາກ · {scopeWord}
                    </h3>
                    <p className="sf-widget-sub">ນະຄອນຫຼວງແຍກອອກຈາກພາກກາງ</p>
                  </div>
                </div>
                <div className="sf-widget-bd">
                  {rankRows(
                    data.by_region.map((row) => {
                      const total = data.by_region.reduce((sum, item) => sum + item.amount, 0);
                      return {
                        code: row.code,
                        label: regionLabel(row.code),
                        amount: row.amount,
                        share: (row.amount / Math.max(1, total)) * 100,
                      };
                    }),
                  )}
                </div>
              </section>

              <section className="sf-widget">
                <div className="sf-widget-hd">
                  <div className="min-w-0 flex-1">
                    <h3 className="sf-widget-title">
                      <TrendingUp size={13} /> ⑤ ທຽບປີກ່ອນ · {scopeWord}
                    </h3>
                    <p className="sf-widget-sub">
                      {data.meta.year} ທຽບ {data.meta.last_year}
                    </p>
                  </div>
                  <span className={`pill ${data.scope.growth >= 100 ? "pill-pos" : "pill-neg"}`}>
                    {data.scope.growth >= 100 ? "▲" : "▼"} {pct(data.scope.growth)}
                  </span>
                </div>
                <div className="sf-widget-bd">
                  <div className="so-compare">
                    <div>
                      <p className="so-kpi-label">ປີນີ້ {data.meta.year}</p>
                      <p className="so-kpi-value">{full(data.scope.actual)}</p>
                    </div>
                    <div>
                      <p className="so-kpi-label">ປີກ່ອນ {data.meta.last_year}</p>
                      <p className="so-kpi-value" style={{ color: "var(--muted)" }}>
                        {full(data.scope.last_year)}
                      </p>
                    </div>
                    <div>
                      <p className="so-kpi-label">ເປົ້າ</p>
                      <p className="so-kpi-value">{full(data.scope.target)}</p>
                      <p className="so-kpi-note">{pct(data.scope.pct)} ຂອງເປົ້າ</p>
                    </div>
                    <div>
                      <p className="so-kpi-label">ຕ່າງຈາກປີກ່ອນ</p>
                      <p
                        className="so-kpi-value"
                        style={{
                          color:
                            data.scope.actual >= data.scope.last_year
                              ? "var(--pos)"
                              : "var(--neg)",
                        }}
                      >
                        {full(data.scope.actual - data.scope.last_year)}
                      </p>
                    </div>
                  </div>
                </div>
              </section>
            </div>

            {/* ══ ⑥ ລາຍວັນ ══ */}
            <section className="sf-widget mt-3">
              <div className="sf-widget-hd">
                <div className="min-w-0 flex-1">
                  <h3 className="sf-widget-title">
                    <CalendarDays size={13} /> ⑥ ລາຍວັນ · {data.meta.year}-
                    {MONTHS[data.meta.month - 1]}
                  </h3>
                  <p className="sf-widget-sub">
                    ເສັ້ນຂີດ = ເປົ້າຕໍ່ວັນ {short(data.daily.per_day_target)} · ວັນອາທິດປິດ
                  </p>
                </div>
                {data.daily.best && (
                  <span className="pill pill-pos">
                    ວັນດີສຸດ {data.daily.best.day} · {short(data.daily.best.amount)}
                  </span>
                )}
              </div>
              <div className="sf-widget-bd">
                <div className="so-days">
                  {data.daily.rows.map((row) => {
                    const peak = Math.max(
                      ...data.daily.rows.map((item) => item.amount),
                      data.daily.per_day_target,
                      1,
                    );
                    return (
                      <span
                        key={row.day}
                        className="so-day"
                        title={`ວັນທີ ${row.day} · ${full(row.amount)} · ${row.bills} ບິນ`}
                      >
                        <i
                          style={{
                            height: `${Math.max(2, (row.amount / peak) * 100)}%`,
                            background:
                              row.amount >= data.daily.per_day_target
                                ? "var(--pos)"
                                : "var(--brand)",
                          }}
                        />
                        <b>{row.day}</b>
                      </span>
                    );
                  })}
                  <span
                    className="so-day-target"
                    style={{
                      bottom: `${
                        (data.daily.per_day_target /
                          Math.max(
                            ...data.daily.rows.map((item) => item.amount),
                            data.daily.per_day_target,
                            1,
                          )) *
                        100
                      }%`,
                    }}
                  />
                </div>
                {!data.daily.rows.length && <p className="so-empty">ບໍ່ມີຂໍ້ມູນ</p>}
              </div>
            </section>

            {/* ══ ⑦ 3 ປີ ══ */}
            <section className="sf-widget mt-3">
              <div className="sf-widget-hd">
                <div className="min-w-0 flex-1">
                  <h3 className="sf-widget-title">
                    <TrendingUp size={13} /> ⑦ ສາມປີ · ລາຍເດືອນ
                  </h3>
                  <p className="sf-widget-sub">
                    {data.trend.map((row) => row.year).join(" · ")} — ເດືອນຕໍ່ເດືອນ
                  </p>
                </div>
              </div>
              <div className="sf-widget-bd">
                <div className="so-trend">
                  {MONTHS.map((label, index) => {
                    const peak = Math.max(
                      ...data.trend.flatMap((row) => row.months),
                      1,
                    );
                    return (
                      <span key={label} className="so-trend-col">
                        <span className="so-trend-bars">
                          {data.trend.map((row, order) => (
                            <i
                              key={row.year}
                              className={`is-y${order}`}
                              style={{
                                height: `${Math.max(1, (row.months[index] / peak) * 100)}%`,
                              }}
                              title={`${row.year}-${label} · ${full(row.months[index])}`}
                            />
                          ))}
                        </span>
                        <b>{label}</b>
                      </span>
                    );
                  })}
                </div>
                <div className="so-legend">
                  {data.trend.map((row, order) => (
                    <span key={row.year}>
                      <i className={`is-y${order}`} /> {row.year} · {short(
                        row.months.reduce((sum, value) => sum + value, 0),
                      )}
                    </span>
                  ))}
                </div>
              </div>
            </section>

            {/* ══ ⑧ ທິມຂາຍ · ⑨ ລູກຄ້າ ══ */}
            <div className="so-grid mt-3">
              <section className="sf-widget">
                <div className="sf-widget-hd">
                  <div className="min-w-0 flex-1">
                    <h3 className="sf-widget-title">
                      <Users size={13} /> ⑧ ທິມຂາຍ · {scopeWord}
                    </h3>
                    <p className="sf-widget-sub">12 ອັນດັບທຳອິດ ຕາມຍອດຂາຍ</p>
                  </div>
                </div>
                <div className="sf-widget-bd">{rankRows(data.sellers)}</div>
              </section>

              <section className="sf-widget">
                <div className="sf-widget-hd">
                  <div className="min-w-0 flex-1">
                    <h3 className="sf-widget-title">
                      <Users size={13} /> ⑨ ລູກຄ້າ · {scopeWord}
                    </h3>
                    <p className="sf-widget-sub">
                      {full(data.customers.count)} ລູກຄ້າ · 12 ລາຍໃຫຍ່ກວມ{" "}
                      {pct(data.customers.top_share)}
                    </p>
                  </div>
                </div>
                <div className="sf-widget-bd">{rankRows(data.customers.rows)}</div>
              </section>
            </div>

            {/* ══ ⑩ ສ່ວນຫຼຸດ & ກຳໄລ · ⑪ ໜີ້ຄ້າງ ══ */}
            <div className="so-grid mt-3">
              <section className="sf-widget">
                <div className="sf-widget-hd">
                  <div className="min-w-0 flex-1">
                    <h3 className="sf-widget-title">
                      <Percent size={13} /> ⑩ ສ່ວນຫຼຸດ & ກຳໄລ · {scopeWord}
                    </h3>
                    <p className="sf-widget-sub">ສ່ວນຫຼຸດຄິດຈາກລາຄາກ່ອນຫຼຸດ</p>
                  </div>
                </div>
                <div className="sf-widget-bd">
                  <div className="so-compare">
                    <div>
                      <p className="so-kpi-label">ສ່ວນຫຼຸດ</p>
                      <p className="so-kpi-value">{full(data.margin.discount)}</p>
                      <p className="so-kpi-note">
                        {data.margin.discount_pct.toFixed(1)}% ຂອງລາຄາເຕັມ
                      </p>
                    </div>
                    <div>
                      <p className="so-kpi-label">ກຳໄລຂັ້ນຕົ້ນ</p>
                      <p className="so-kpi-value" style={{ color: "var(--pos)" }}>
                        {full(data.margin.profit)}
                      </p>
                      <p className="so-kpi-note">GP {data.margin.gp_pct.toFixed(1)}%</p>
                    </div>
                    <div>
                      <p className="so-kpi-label">ຍອດຂາຍ</p>
                      <p className="so-kpi-value">{full(data.margin.amount)}</p>
                      <p className="so-kpi-note">{full(data.margin.bills)} ບິນ</p>
                    </div>
                    <div>
                      <p className="so-kpi-label">ສະເລ່ຍຕໍ່ບິນ</p>
                      <p className="so-kpi-value">
                        {full(data.margin.amount / Math.max(1, data.margin.bills))}
                      </p>
                    </div>
                  </div>
                </div>
              </section>

              {data.ar && (
                <section className="sf-widget">
                  <div className="sf-widget-hd">
                    <div className="min-w-0 flex-1">
                      <h3 className="sf-widget-title">
                        <Wallet size={13} /> ⑪ ໜີ້ຄ້າງຮັບ
                      </h3>
                      <p className="sf-widget-sub">
                        ທັງບໍລິສັດ · {full(data.ar.customers)} ລູກໜີ້ · ບໍ່ຂຶ້ນກັບຕົວກັ່ນຕອງ
                      </p>
                    </div>
                    <span className="pill pill-neg">ເກີນກຳນົດ {short(data.ar.overdue)}</span>
                  </div>
                  <div className="sf-widget-bd">
                    {rankRows(
                      data.ar.buckets.map((bucket) => ({
                        code: bucket.label,
                        label: bucket.label,
                        amount: bucket.amount,
                        share: (bucket.amount / Math.max(1, data.ar!.balance)) * 100,
                      })),
                    )}
                    <p className="so-kpi-note mt-2">
                      ລູກໜີ້ໃຫຍ່ສຸດ:{" "}
                      {data.ar.top
                        .slice(0, 3)
                        .map((row) => `${row.label} ${short(row.amount)}`)
                        .join(" · ")}
                    </p>
                  </div>
                </section>
              )}
            </div>

            {/* ══ ⑫ ສະຕັອກ ══ */}
            {data.stock && (
              <section className="sf-widget mt-3">
                <div className="sf-widget-hd">
                  <div className="min-w-0 flex-1">
                    <h3 className="sf-widget-title">
                      <Boxes size={13} /> ⑫ ສະຕັອກ
                    </h3>
                    <p className="sf-widget-sub">
                      ທັງບໍລິສັດ · ຂາຍບໍ່ອອກ = ບໍ່ມີການຂາຍ 90 ວັນ
                    </p>
                  </div>
                  <span className="pill pill-warn">
                    ຂາຍບໍ່ອອກ {pct((data.stock.dead_value / Math.max(1, data.stock.value)) * 100)}
                  </span>
                </div>
                <div className="sf-widget-bd">
                  <div className="so-compare">
                    <div>
                      <p className="so-kpi-label">ມູນຄ່າສະຕັອກ</p>
                      <p className="so-kpi-value">{full(data.stock.value)}</p>
                      <p className="so-kpi-note">{full(data.stock.items)} ລາຍການ</p>
                    </div>
                    <div>
                      <p className="so-kpi-label">ຂາຍບໍ່ອອກ 90 ວັນ</p>
                      <p className="so-kpi-value" style={{ color: "var(--neg)" }}>
                        {full(data.stock.dead_value)}
                      </p>
                      <p className="so-kpi-note">{full(data.stock.dead_items)} ລາຍການ</p>
                    </div>
                    <div>
                      <p className="so-kpi-label">ຄ້າງເກີນ 360 ວັນ</p>
                      <p className="so-kpi-value">{full(data.stock.over_360)}</p>
                    </div>
                    <div>
                      <p className="so-kpi-label">ສະຕັອກ ຕໍ່ ຍອດຂາຍເດືອນ</p>
                      <p className="so-kpi-value">
                        {(data.stock.value / Math.max(1, data.month.actual)).toFixed(1)}×
                      </p>
                      <p className="so-kpi-note">ຍິ່ງສູງ ຍິ່ງຄ້າງທຶນ</p>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* ══ ⑬ ຊ່ອງຫວ່າງ · ⑭ ຄວາມແມ່ນຄາດການ ══ */}
            <div className="so-grid mt-3">
              {data.gaps.length > 0 && (
                <section className="sf-widget">
                  <div className="sf-widget-hd">
                    <div className="min-w-0 flex-1">
                      <h3 className="sf-widget-title">
                        <Siren size={13} /> ⑬ ຊ່ອງຫວ່າງ · {scopeWord}
                      </h3>
                      <p className="sf-widget-sub">ຕົກເປົ້າຫຼາຍສຸດ ຮຽງຈາກຫຼາຍໄປໜ້ອຍ</p>
                    </div>
                  </div>
                  <div className="sf-widget-bd">
                    {data.gaps
                      .filter((row) => row.gap > 0)
                      .slice(0, 8)
                      .map((row) => (
                        <div key={row.label} className="so-rank">
                          <span className="so-rank-label" style={{ width: "9rem" }} title={row.label}>
                            {row.label}
                          </span>
                          <span className="so-rank-bar">
                            <span
                              style={{
                                width: `${Math.max(2, Math.min(100, row.pct))}%`,
                                background: `var(--${tone(row.pct)})`,
                              }}
                            />
                          </span>
                          <span className="so-rank-value" style={{ color: "var(--neg)" }}>
                            −{short(row.gap)}
                          </span>
                          <span className="so-rank-share">{pct(row.pct)}</span>
                        </div>
                      ))}
                  </div>
                </section>
              )}

              <section className="sf-widget">
                <div className="sf-widget-hd">
                  <div className="min-w-0 flex-1">
                    <h3 className="sf-widget-title">
                      <Ruler size={13} /> ⑭ ຄວາມແມ່ນຂອງຄາດການ
                    </h3>
                    <p className="sf-widget-sub">
                      ຄາດການ ນະ ວັນທີ {data.days.cut_day} ທຽບຍອດຈິງທີ່ອອກມາ · 12 ເດືອນຫຼ້າສຸດ
                    </p>
                  </div>
                  <span className="pill pill-muted">
                    ສະເລ່ຍ {data.forecast.bias_pct >= 0 ? "+" : ""}
                    {data.forecast.bias_pct.toFixed(1)}%
                  </span>
                </div>
                <div className="sf-widget-bd">
                  {data.accuracy.map((row) => (
                    <div key={`${row.year}-${row.month}`} className="so-rank">
                      <span className="so-rank-label" style={{ width: "4.5rem" }}>
                        {row.year}-{MONTHS[row.month - 1]}
                      </span>
                      <span className="so-rank-bar">
                        <span
                          style={{
                            width: `${Math.min(100, Math.abs(row.error_pct) * 3)}%`,
                            background: Math.abs(row.error_pct) > 15 ? "var(--warn)" : "var(--pos)",
                          }}
                        />
                      </span>
                      <span className="so-rank-value">{short(row.actual)}</span>
                      <span className="so-rank-share">
                        {row.error_pct >= 0 ? "+" : ""}
                        {row.error_pct.toFixed(0)}%
                      </span>
                    </div>
                  ))}
                  {!data.accuracy.length && <p className="so-empty">ບໍ່ມີຂໍ້ມູນ</p>}
                </div>
              </section>
            </div>

            {/* ══ ⑮ ມິຕິ ══ */}
            <section className="sf-widget mt-3">
              <div className="sf-widget-hd">
                <div className="min-w-0 flex-1">
                  <h3 className="sf-widget-title">
                    <Layers size={13} /> ⑮ ມິຕິອື່ນ · {scopeWord}
                  </h3>
                  <p className="sf-widget-sub">ແຂວງ · ສາຂາ · ກຸ່ມສິນຄ້າ</p>
                </div>
              </div>
              <div className="sf-widget-bd so-trio">
                <div>
                  <p className="so-kpi-label">ແຂວງ</p>
                  {rankRows(amountRanks(data.dimensions.provinces))}
                </div>
                <div>
                  <p className="so-kpi-label">ສາຂາທີ່ອອກບິນ</p>
                  {rankRows(amountRanks(data.dimensions.branches))}
                </div>
                <div>
                  <p className="so-kpi-label">ກຸ່ມສິນຄ້າ</p>
                  {rankRows(amountRanks(data.dimensions.groups))}
                </div>
              </div>
            </section>

            {/* ══ ⑯ ຮົ່ວໄຫຼ · ⑰ ສຸຂະພາບ 360° ══ */}
            <div className="so-grid mt-3">
              {data.leak && (
                <section className="sf-widget">
                  <div className="sf-widget-hd">
                    <div className="min-w-0 flex-1">
                      <h3 className="sf-widget-title">
                        <Siren size={13} /> ⑯ ຮົ່ວໄຫຼ · {scopeWord}
                      </h3>
                      <p className="sf-widget-sub">ເງິນທີ່ອອກຈາກຍອດໂດຍບໍ່ໄດ້ຕັ້ງໃຈ</p>
                    </div>
                  </div>
                  <div className="sf-widget-bd">
                    <div className="so-compare">
                      <div>
                        <p className="so-kpi-label">ສິນຄ້າສົ່ງຄືນ</p>
                        <p className="so-kpi-value" style={{ color: "var(--neg)" }}>
                          {full(Math.abs(data.leak.returns))}
                        </p>
                        <p className="so-kpi-note">{full(data.leak.return_bills)} ບິນ</p>
                      </div>
                      <div>
                        <p className="so-kpi-label">ແຖວທີ່ຂາດທຶນ</p>
                        <p className="so-kpi-value" style={{ color: "var(--neg)" }}>
                          {full(Math.abs(data.leak.loss_lines_profit))}
                        </p>
                        <p className="so-kpi-note">{full(data.leak.loss_lines)} ແຖວ</p>
                      </div>
                      <div>
                        <p className="so-kpi-label">ຫຼຸດເກີນ 10%</p>
                        <p className="so-kpi-value" style={{ color: "var(--warn)" }}>
                          {full(data.leak.deep_discount)}
                        </p>
                      </div>
                      <div>
                        <p className="so-kpi-label">ລວມຮົ່ວໄຫຼ</p>
                        <p className="so-kpi-value">
                          {full(
                            Math.abs(data.leak.returns) +
                              Math.abs(data.leak.loss_lines_profit) +
                              data.leak.deep_discount,
                          )}
                        </p>
                        <p className="so-kpi-note">
                          {pct(
                            ((Math.abs(data.leak.returns) +
                              Math.abs(data.leak.loss_lines_profit) +
                              data.leak.deep_discount) /
                              Math.max(1, data.margin.amount)) *
                              100,
                          )}{" "}
                          ຂອງຍອດຂາຍ
                        </p>
                      </div>
                    </div>
                  </div>
                </section>
              )}

              <section className="sf-widget">
                <div className="sf-widget-hd">
                  <div className="min-w-0 flex-1">
                    <h3 className="sf-widget-title">
                      <ShieldCheck size={13} /> ⑰ ສຸຂະພາບ 360°
                    </h3>
                    <p className="sf-widget-sub">ຫົກຕົວທີ່ບອກສະພາບລວມ</p>
                  </div>
                </div>
                <div className="sf-widget-bd">
                  <div className="so-health">
                    {health.map((item) => (
                      <div key={item.label}>
                        <span className={`so-dot is-${item.tone}`} />
                        <p className="so-kpi-label">{item.label}</p>
                        <p className="so-kpi-value" style={{ color: `var(--${item.tone})` }}>
                          {item.value}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            </div>

            {/* ══ ⑱ Call card — ການເຂົ້າພົບລູກຄ້າ ══ */}
            {data.visits && (
              <section className="sf-widget mt-3">
                <div className="sf-widget-hd">
                  <div className="min-w-0 flex-1">
                    <h3 className="sf-widget-title">
                      <Route size={13} /> ⑱ Call card · ການເຂົ້າພົບລູກຄ້າ · {scopeWord}
                    </h3>
                    <p className="sf-widget-sub">
                      ຈາກແອັບພະນັກງານຂາຍ (salewole)
                      {data.visits.first_day &&
                        ` · ບັນທຶກ ${data.visits.first_day} ຫາ ${data.visits.last_day}`}
                    </p>
                  </div>
                  <span className="pill pill-muted">
                    {full(data.visits.totals.visits)} ຄັ້ງ · {data.visits.totals.people} ຄົນ
                  </span>
                </div>
                <div className="sf-widget-bd">
                  <div className="so-compare">
                    <div>
                      <p className="so-kpi-label">ຈຳນວນຄັ້ງ</p>
                      <p className="so-kpi-value">{full(data.visits.totals.visits)}</p>
                      <p className="so-kpi-note">
                        {full(data.visits.totals.customers)} ລູກຄ້າ · {data.visits.totals.people}{" "}
                        ພະນັກງານ
                      </p>
                    </div>
                    <div>
                      <p className="so-kpi-label">ປິດງານແລ້ວ</p>
                      <p className="so-kpi-value" style={{ color: "var(--pos)" }}>
                        {pct(
                          (data.visits.totals.completed /
                            Math.max(1, data.visits.totals.visits)) *
                            100,
                        )}
                      </p>
                      <p className="so-kpi-note">
                        ຄ້າງບໍ່ເຊັກເອົາ {full(data.visits.totals.open_visits)} ຄັ້ງ
                      </p>
                    </div>
                    <div>
                      <p className="so-kpi-label">ຄັ້ງຕໍ່ພະນັກງານ</p>
                      <p className="so-kpi-value">
                        {(
                          data.visits.totals.visits / Math.max(1, data.visits.totals.people)
                        ).toFixed(1)}
                      </p>
                      <p className="so-kpi-note">ໃນຂອບເຂດທີ່ເລືອກ</p>
                    </div>
                    <div>
                      <p className="so-kpi-label">ອໍເດີ / ເກັບເງິນ ທີ່ບັນທຶກ</p>
                      <p className="so-kpi-value">
                        {short(data.visits.totals.order_amount)} /{" "}
                        {short(data.visits.totals.collection_amount)}
                      </p>
                      <p className="so-kpi-note">ຕົວເລກທີ່ພະນັກງານພິມເອງ</p>
                    </div>
                  </div>

                  <div className="so-trio mt-3">
                    <div>
                      <p className="so-kpi-label">ພະນັກງານ</p>
                      {rankRows(
                        amountRanks(
                          data.visits.people.map((row) => ({
                            code: row.employee_code,
                            label: row.name,
                            amount: row.visits,
                          })),
                        ).map((row) => ({ ...row, bills: 0 })),
                      )}
                    </div>
                    <div>
                      <p className="so-kpi-label">ຜົນຂອງການພົບ</p>
                      {rankRows(
                        amountRanks(
                          data.visits.outcomes.map((row) => ({
                            code: row.label,
                            label: row.label,
                            amount: row.visits,
                          })),
                        ),
                      )}
                    </div>
                    <div>
                      <p className="so-kpi-label">ຮູບແບບ</p>
                      {rankRows(
                        amountRanks(
                          data.visits.types.map((row) => ({
                            code: row.label,
                            label: row.label,
                            amount: row.visits,
                          })),
                        ),
                      )}
                    </div>
                  </div>

                  {data.visits.quality && data.visits.quality.visits > 0 && (
                    <div className="so-quality mt-3">
                      <div>
                        <p className="so-kpi-label">ຄຸນນະພາບການເຂົ້າພົບ (Perfect Store)</p>
                        <p className="so-kpi-note">
                          ສູດດຽວກັບ salewole · ນັບສະເພາະການໄປຮອດຮ້ານທີ່ເຊັກເອົາແລ້ວ (
                          {data.visits.quality.visits} ຄັ້ງ)
                        </p>
                      </div>
                      <div className="so-quality-cells">
                        {[
                          { label: "ຄະແນນຮວມ", value: data.visits.quality.score },
                          { label: "Checklist", value: data.visits.quality.checklist },
                          { label: "ສຳຫຼວດສະຕັອກ", value: data.visits.quality.stock },
                          { label: "ຮູບ", value: data.visits.quality.photo },
                        ].map((cell) => (
                          <div key={cell.label}>
                            <p className="so-kpi-label">{cell.label}</p>
                            <p
                              className="so-kpi-value"
                              style={{
                                color:
                                  cell.value >= 70
                                    ? "var(--pos)"
                                    : cell.value >= 40
                                      ? "var(--warn)"
                                      : "var(--neg)",
                              }}
                            >
                              {pct(cell.value)}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {data.visits.totals.visits < 50 && (
                    <p className="so-kpi-note mt-2">
                      ⚠️ ຂໍ້ມູນຍັງໜ້ອຍ ({full(data.visits.totals.visits)} ຄັ້ງ) — ຫາກໍເລີ່ມເກັບ,
                      ຍັງບໍ່ພຽງພໍທີ່ຈະສະຫຼຸບຜົນງານທິມ
                    </p>
                  )}
                </div>
              </section>
            )}

            <p className="so-note">
              ຍອດຈິງຈາກ odg_sale_detail (ນັບຕາມເດືອນທີ່ອະນຸມັດໃຫ້) · ເປົ້າຈາກ odg_sales_target ·
              ວັນຂາຍບໍ່ນັບວັນອາທິດ · ເມື່ອເລືອກພາກ ຈະນັບສະເພາະເປົ້າທີ່ຕັ້ງເປັນລາຍແຂວງ
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
