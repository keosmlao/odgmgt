"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  BarChart3,
  ChevronRight,
  Clock3,
  Layers,
  Map as MapIcon,
  RefreshCw,
  Target,
  TrendingUp,
} from "lucide-react";
import api from "@/service/api";
import { useAuth } from "@/context/AuthContext";
import { useLanguage } from "@/context/LanguageContext";
import { REGIONS, regionLabel } from "@/lib/sales-regions.mjs";

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

/** ຜູ້ທີ່ເປີດໜ້ານີ້ໄດ້ — ຕົງກັບ ALLOWED_ROLES ຢູ່ຝັ່ງ API. */
const ALLOWED_ROLES = new Set(["ceo", "gm", "sale_bu_manager", "sale_supervisor"]);

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

  const role = String(user?.role || "").toLowerCase();
  const allowed = !user || ALLOWED_ROLES.has(role);

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
                {user?.full_name || user?.username} · {user?.username} · {scopeLabel} · ຫົວໜ່ວຍ ກີບ
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
                      {full(data.forecast.projected)} <span>ກີບ</span>
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
                        ຄາດການແກ້ອະຄະຕິແລ້ວ · <b>{full(data.forecast.adjusted)}</b> ກີບ
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
