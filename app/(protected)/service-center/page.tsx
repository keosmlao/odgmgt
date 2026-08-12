// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
import { Elapsed } from "@/components/ods/elapsed";
import { DashboardAutoRefresh } from "@/components/ods/dashboard-auto-refresh";
import { LinkPending } from "@/components/ods/link-pending";
import { RowLink } from "@/components/ods/row-link";
import { ALL_ACCESS_SESSION, NO_TECH_FILTER } from "@/lib/ods/session-all";
import { installStatuses, pipelineOf, repairStatuses, type StatusDef } from "@/lib/ods/dashboard-status";
import {
  type Counts,
  type DashboardData,
  getDashboard,
  type StageAge,
  type StaleJob,
  type TechLoad,
} from "@/lib/ods/dashboard";
import { elapsedTone } from "@/lib/ods/elapsed-tone";
import { type Dictionary, getDictionary } from "@/lib/ods/i18n/dictionaries";
import { getLocale } from "@/lib/ods/i18n/locale";
import { REPEAT_DAYS, type RepeatJob } from "@/lib/ods/repeat";
import { APPROVER_SIDE, canAccess, ROLE_LABEL, type Role, roleOf } from "@/lib/ods/roles";
import {
  AlertCircle,
  ArrowRight,
  Ban,
  CalendarClock,
  CalendarDays,
  ClipboardCheck,
  Frown,
  HardHat,
  PackageCheck,
  PackageOpen,
  PackageX,
  Plus,
  Radar,
  Smartphone,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  ShoppingCart,
  Smile,
  Timer,
  TrendingDown,
  TrendingUp,
  Truck,
  UserCheck,
  Wallet,
  Users,
  Wrench,
} from "lucide-react";
import Link from "next/link";

/**
 * ໜ້າລວມ — "ມີຫຍັງຕ້ອງລົງມື" ບໍ່ແມ່ນ "ມີຫຍັງເກີດຂຶ້ນແດ່".
 *
 * ── 3 ຢ່າງທີ່ອອກແບບໃໝ່ ──
 * ① ສະແດງ**ຕາມສິດ**: ບັດຈະຂຶ້ນກໍ່ຕໍ່ເມື່ອຜູ້ນັ້ນ canAccess ໜ້າປາຍທາງຂອງມັນ.
 *    ແຕ່ກ່ອນຊ່າງເຫັນຕົວເລກ "ລໍຖ້າສະເໜີລາຄາ" ທັງທີ່ກົດເຂົ້າໄປແລ້ວເດັ້ງ /forbidden.
 * ② ກອງ**ຕາມຜູ້ໃຊ້**: ຊ່າງເຫັນສະເພາະວຽກຂອງຕົນ (ຄືກັບທຸກໜ້າອື່ນ) — ແຕ່ກ່ອນໜ້ານີ້
 *    ບໍ່ກອງເລີຍ ⇒ ຊ່າງເຫັນຍອດຂອງທັງບໍລິສັດ ແລ້ວກົດເຂົ້າໄປເຫັນແຕ່ວຽກຕົນ (ຕົວເລກຫຼົ້ນກັນ).
 * ③ ແຍກ "ຄິວຕ້ອງລົງມື" (ອາດຊ້ຳກັນໄດ້) ອອກຈາກ "ຂັ້ນໄດ" (ບໍ່ຊ້ຳ ລວມກັນໄດ້ຍອດພໍດີ)
 *    ⇒ ບໍ່ມີການນັບຊ້ຳໃນແຖບຂັ້ນໄດ.
 */
export const dynamic = "force-dynamic";

type Dict = Dictionary["dashboard"];

/* ── ບັດ "ຕ້ອງລົງມື" ──────────────────────────────────────────── */

type Alert = {
  label: string;
  value: number;
  detail?: string;
  href: string;
  icon: typeof Wrench;
  /** ແດງ = ຄວນລົງມືດຽວນີ້ · ເຫຼືອງ = ຄ້າງລໍ */
  tone: "red" | "amber";
};

const TONE = {
  red: { card: "border-brand-orange-400 bg-white hover:border-brand-orange-400", icon: "bg-brand-orange-50 text-brand-orange-700", value: "text-brand-orange-700", bar: "bg-brand-orange-700" },
  amber: { card: "border-brand-orange-400 bg-white hover:border-brand-orange-400", icon: "bg-brand-orange-100 text-brand-900", value: "text-brand-900", bar: "bg-brand-orange-300" },
};

function alertsFor(role: Role, data: DashboardData, canQc: boolean, t: Dict): Alert[] {
  const all: Alert[] = [
    /**
     * ດ່ານກວດຮັບຄຸນນະພາບ — ຂຶ້ນສະເພາະຜູ້ທີ່ **ຜູ້ຈັດການກຳນົດໃຫ້ກວດ** (ods_qc_role).
     * canAccess ບອກບໍ່ໄດ້ (ເສັ້ນທາງ /qc ເປີດໃຫ້ທຸກຄົນໃນ RULES ໂດຍເຈດຕະນາ — ເບິ່ງ lib/roles)
     * ⇒ ຖ້າບໍ່ກັນດ້ວຍ canQc ຊ່າງຈະເຫັນບັດແລ້ວກົດເຂົ້າໄປຕົກ /forbidden.
     */
    ...(canQc
      ? ([
          {
            label: t.alertQcRepairLabel,
            value: data.repair["wait-qc"] ?? 0,
            detail: t.alertQcRepairDetail,
            href: "/qc",
            icon: ShieldCheck,
            tone: "amber",
          },
          {
            label: t.alertQcInstallLabel,
            value: data.install["wait-qc"] ?? 0,
            detail: t.alertQcInstallDetail,
            href: "/qc",
            icon: ShieldCheck,
            tone: "amber",
          },
        ] as Alert[])
      : []),
    {
      label: t.alertSlaLabel,
      value: data.slaLate,
      detail: t.alertSlaDetail,
      href: "/checking",
      icon: Timer,
      tone: "red",
    },
    {
      /**
       * "ໜີ້ອາໄຫຼ່" — ຂອງອອກຈາກສາງໄປແລ້ວ ງານຖືກຍົກເລີກ ແຕ່ບໍ່ມີໃບສົ່ງຄືນ.
       * ຕະຫຼອດ 3 ປີບໍ່ເຄີຍມີໃຜເຫັນເລກນີ້ ເພາະໃບເບີກປົນຢູ່ໃນລາຍການລວມ 4,600+ ໃບ.
       */
      label: t.alertCancelledSparesLabel,
      value: data.cancelledSpares.docs,
      detail: `${data.cancelledSpares.lines.toLocaleString()} ${t.alertCancelledSparesDetail}`,
      href: "/stock/receive-returns",
      icon: PackageX,
      tone: "red",
    },
    {
      label: t.alertQuotesLabel,
      value: data.approvals.quotes,
      href: "/approvals/quotations",
      icon: ClipboardCheck,
      tone: "amber",
    },
    {
      label: t.alertCancelReqLabel,
      value: data.cancelRequests,
      href: "/approvals/cancellations",
      icon: Ban,
      tone: "amber",
    },
    {
      label: t.alertPurchaseLabel,
      value: data.approvals.purchases,
      href: "/approvals/purchase-requests",
      icon: ShoppingCart,
      tone: "amber",
    },
    {
      label: t.alertCustomerApprovalLabel,
      value: data.approvals.customer,
      href: "/quotations/customer-approval",
      icon: UserCheck,
      tone: "amber",
    },
    {
      /**
       * ສັນຍາວັນນັດໄວ້ກັບລູກຄ້າແລ້ວ ແຕ່ວັນນັດຜ່ານໄປ ແລະ ຍັງບໍ່ໄດ້ຕິດຕັ້ງ.
       * appoint_date ຖືກຂຽນຢູ່ຕອນຈັດຊ່າງ ແຕ່ບໍ່ເຄີຍມີໜ້າໃດເຕືອນເມື່ອມັນຜ່ານໄປ.
       */
      label: t.alertOverdueApptLabel,
      value: data.overdueAppointments,
      detail: t.alertOverdueApptDetail,
      href: "/installations/work",
      icon: CalendarClock,
      tone: "red",
    },
    {
      // ຂັ້ນທີ່ວຽກຕິດດົນທີ່ສຸດຂອງລະບົບ — ຈຳນວນຢ່າງດຽວບໍ່ບອກຄວາມຮ້າຍແຮງ ຈຶ່ງໃສ່ອາຍຸນຳ
      label: t.alertOnOrderLabel,
      value: data.onOrder.n,
      detail: `${t.longest} ${Math.floor(data.onOrder.max_seconds / 86400).toLocaleString()} ${t.days}`,
      // ໜ້າ /stock/arrivals ຖືກລົບ — ຄວາມຄືບໜ້າຈິງອ່ານຈາກ ERP ຢູ່ໜ້າສະຖານະຂັ້ນ 7
      href: "/work/repair/purchasing",
      icon: Truck,
      tone: "red",
    },
    {
      // ໜ້າວຽກຫຼັກຂອງສາງ — ແປກທີ່ໜ້າລວມບໍ່ເຄີຍສະແດງ (ສາງເຫັນພຽງບັດດຽວ)
      label: t.alertWarehouseRepairLabel,
      value: data.warehouse.repair_lines,
      detail: t.alertWarehouseRepairDetail,
      href: "/stock/dispatch",
      icon: PackageCheck,
      tone: "amber",
    },
    {
      label: t.alertWarehouseInstallLabel,
      value: data.warehouse.install_docs,
      href: "/installations/dispatch",
      icon: PackageCheck,
      tone: "amber",
    },
    {
      // ສາງເບີກອອກໃຫ້ແລ້ວ ແຕ່ຊ່າງຍັງບໍ່ໄປຮັບ ⇒ ອາໄຫຼ່ຢູ່ນອກສາງ ແລະ ວຽກຄ້າງລໍຢູ່
      label: t.alertPickupRepairLabel,
      value: data.pickup.repair_docs,
      detail: t.alertPickupRepairDetail,
      href: "/stock/requests/pickup",
      icon: PackageOpen,
      tone: "amber",
    },
    {
      label: t.alertPickupInstallLabel,
      value: data.pickup.install_docs,
      href: "/installations/spare-pickup",
      icon: PackageOpen,
      tone: "amber",
    },
    {
      label: t.alertAcceptInstallLabel,
      value: data.install["wait-accept"] ?? 0,
      href: "/installations/accept",
      icon: HardHat,
      tone: "amber",
    },
    {
      label: t.alertUnassignedRepairLabel,
      value: data.unassigned.repair,
      detail: t.alertUnassignedRepairDetail,
      href: "/service",
      icon: UserCheck,
      tone: "red",
    },
    {
      label: t.alertUnassignedInstallLabel,
      value: data.unassigned.install,
      detail: t.alertUnassignedInstallDetail,
      href: "/installations/assign",
      icon: UserCheck,
      tone: "red",
    },

    /* ── ຄິວຫຼັກຂອງ CS (ຝ່າຍບໍລິການ) ──
     * ບັດຂ້າງເທິງລ້ວນເປັນຂອງ ຊ່າງ · ສາງ · ຜູ້ອະນຸມັດ ⇒ CS ບໍ່ເຫັນຫຍັງເລີຍ.
     * ອັນນີ້ຄືວຽກທີ່ CS ຕ້ອງລົງມືເອງ ແລະ ເປັນຄໍຂວດຖ້າບໍ່ມີໃຜເຮັດ.
     *
     * ⚠️ ເຄີຍມີບັດ "ລໍຖ້າຈັດຊ່າງ (ຕິດຕັ້ງ)" (install["wait-assign"]) ຢູ່ນີ້ ແຕ່ຖືກຖອດ
     * (17-07-2026): ມັນນັບ**ວຽກຊຸດດຽວກັນເປັນະ**ກັບບັດ "ວຽກຕິດຕັ້ງຍັງບໍ່ມີຊ່າງ"
     * ຂ້າງເທິງ (ຢືນຢັນຂໍ້ມູນຈິງ: 9 = 9 · ບໍ່ຕ່າງກັນຈັກໜ່ວຍ) ແລະ ໄປໜ້າດຽວກັນ
     * (/installations/assign) ⇒ ຄົນເຫັນເລກ 9 ສອງບ່ອນ ຄິດວ່າມີ 18 ວຽກ.
     * ບັດທີ່ເຫຼືອເປັນສີແດງ ແລະ ຖືກນັບໃນ criticalTotal ຢູ່ແລ້ວ. */
    {
      label: t.alertReturnLabel,
      value: data.repair["wait-return"] ?? 0,
      detail: t.alertReturnDetail,
      // ໜ້າລາຍການ /returns ຖືກລົບ (ຊ້ຳກັບຄິວນີ້) — ບັດນີ້ພາໄປຄິວໂດຍກົງ
      href: "/work/repair/wait-return",
      icon: PackageCheck,
      tone: "amber",
    },
    {
      label: t.alertCloseInstallLabel,
      value: data.install["wait-close"] ?? 0,
      detail: t.alertCloseInstallDetail,
      href: "/installations/close",
      icon: ClipboardCheck,
      tone: "amber",
    },
  ];

  // ບໍ່ໂຊຕົວເລກທີ່ກົດເຂົ້າໄປບໍ່ໄດ້ ແລະ ບໍ່ໂຊສູນ (ໜ້າລວມຕ້ອງເປັນ "ວຽກທີ່ຕ້ອງເຮັດ")
  return all.filter((alert) => alert.value > 0 && canAccess(role, alert.href.split("?")[0]));
}

/* ── ແຖບຂັ້ນໄດ ─────────────────────────────────────────────── */

/**
 * ຂັ້ນໄດ — ຂັ້ນລ້ວນໆ (ບໍ່ຫຼົ້ນກັນ) ຈຶ່ງລວມກັນໄດ້ຍອດພໍດີ ແລະ ແຖບສ່ວນແບ່ງມີຄວາມໝາຍ.
 * ຄິວທີ່ຕັດຂວາງຂັ້ນ (ເຊັ່ນ "ລໍຖ້າຊ່າງຮັບງານ") ຢູ່ໃນບັດ "ຕ້ອງລົງມື" ບໍ່ແມ່ນຢູ່ນີ້.
 */
function Pipeline({
  workflow,
  statuses,
  counts,
  ages,
  role,
  t,
}: {
  workflow: "repair" | "install";
  statuses: Record<string, StatusDef>;
  counts: Counts;
  ages: StageAge;
  role: Role;
  t: Dict;
}) {
  /**
   * **ລວມຂັ້ນອາໄຫຼ່ເປັນແຖວດຽວ ຄືກັບເມນູ sidebar**.
   * ເມນູລວມ "ກຳລັງເບີກອາໄຫຼ່ + ກຳລັງສັ່ງຊື້" (ສ້ອມ) ແລະ "ລໍເບີກ + ລໍຮັບ" (ຕິດຕັ້ງ)
   * ເປັນຂັ້ນດຽວ (/work/spares · /work/install-spares) ແຕ່ dashboard ຍັງແຍກ
   * ⇒ ຄົນອ່ານ 2 ບ່ອນແລ້ວນັບບໍ່ຕົງກັນ. ດຽວນີ້ລວມຢູ່ນີ້ຄືກັນ ພ້ອມລິ້ງໄປໜ້າດຽວກັນ.
   */
  const SPARE = workflow === "repair"
    ? { slugs: ["withdrawing", "purchasing"], href: "/work/spares", label: "ອາໄຫຼ່ (ເບີກ · ສັ່ງຊື້)" }
    : { slugs: ["wait-register", "wait-pick"], href: "/work/install-spares", label: "ອາໄຫຼ່ (ເບີກ · ຮັບ)" };

  const raw = pipelineOf(statuses);
  const spareTotal = raw.reduce((sum, [slug]) => (SPARE.slugs.includes(slug) ? sum + (counts[slug] ?? 0) : sum), 0);
  const spareAt = raw.findIndex(([slug]) => SPARE.slugs.includes(slug));
  const stages: typeof raw = [];
  raw.forEach(([slug, def], index) => {
    if (!SPARE.slugs.includes(slug)) return void stages.push([slug, def]);
    // ວາງແຖວລວມໄວ້ບ່ອນຂັ້ນທຳອິດຂອງກຸ່ມ ⇒ ລຳດັບ pipeline ຍັງຖືກ
    if (index === spareAt) stages.push([SPARE.slugs[0], { ...def, label: SPARE.label }]);
  });
  /**
   * ⚠️ ນັບຈາກ **raw** ບໍ່ແມ່ນ `stages` — ແຖວອາໄຫຼ່ທີ່ລວມແລ້ວໃຊ້ slug ຂອງຂັ້ນທຳອິດ
   * ⇒ `counts[slug]` ຈະໄດ້ພຽງຂັ້ນນັ້ນ ແລະ **ຕົກຂັ້ນທີ 2 ໄປ** (ພົບ: ລວມ 75 ແທນ 86).
   */
  const total = raw.reduce((sum, [slug]) => sum + (counts[slug] ?? 0), 0);
  const peak = Math.max(
    1,
    spareTotal,
    ...raw.filter(([slug]) => !SPARE.slugs.includes(slug)).map(([slug]) => counts[slug] ?? 0),
  );

  return (
    <div className="space-y-1">
      {stages.map(([slug, def]) => {
        const merged = slug === SPARE.slugs[0];
        const value = merged ? spareTotal : (counts[slug] ?? 0);
        const href = merged ? SPARE.href : `/work/${workflow}/${slug}`;
        const width = (value / peak) * 100;
        // ຄໍຂວດ = ຂັ້ນທີ່ກອງວຽກໄວ້ຫຼາຍສຸດ (ແລະ ບໍ່ແມ່ນສູນ)
        const isPeak = value > 0 && value === peak && total > 0;
        /**
         * ອາຍຸຂອງຂັ້ນ — "ວຽກທີ່ຄ້າງຢູ່ຂັ້ນນີ້ດົນສຸດ".
         * ຈຳນວນຢ່າງດຽວຫຼອກຕາ: 3 ວຽກຄ້າງ 19 ມື້ ຮ້າຍແຮງກວ່າ 29 ວຽກຄ້າງ 7 ມື້.
         */
        const age = value > 0 ? (ages[def.stage as number]?.max ?? null) : null;
        const tone = elapsedTone(age);

        const row = (
          <>
            <span className="w-36 shrink-0 truncate text-xs text-slate-600" title={def.label}>
              {def.label}
            </span>
            <span className="relative h-5 flex-1 overflow-hidden rounded bg-slate-100">
              <span
                className={`absolute inset-y-0 left-0 rounded ${isPeak ? "bg-brand-orange-300" : "bg-brand-400"}`}
                style={{ width: `${width}%` }}
                aria-hidden
              />
            </span>
            {/* ຄ້າງດົນສຸດຢູ່ຂັ້ນນີ້ — ສີເຕືອນຕາມເກນດຽວກັນກັບທຸກໜ້າ (elapsedTone) */}
            <span className="w-24 shrink-0 text-right">
              {age != null ? (
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${tone.chip}`}>
                  {Math.floor(age / 86400).toLocaleString()} {t.days}
                </span>
              ) : null}
            </span>
            <b
              className={`w-10 shrink-0 text-right text-xs tabular-nums ${
                value > 0 ? "text-slate-900" : "text-slate-300"
              }`}
            >
              {value.toLocaleString()}
            </b>
          </>
        );

        // ກົດເຂົ້າໄປໄດ້ກໍ່ຕໍ່ເມື່ອມີສິດເປີດໜ້າລາຍລະອຽດ
        return canAccess(role, href) ? (
          <Link
            key={slug}
            href={href}
            className="flex items-center gap-2 rounded px-1 py-0.5 transition hover:bg-slate-50"
          >
            {row}
            <LinkPending className="size-3 shrink-0 text-slate-300" />
          </Link>
        ) : (
          <div key={slug} className="flex items-center gap-2 px-1 py-0.5">
            {row}
            <span className="size-3 shrink-0" />
          </div>
        );
      })}

      <p className="border-t border-slate-100 pt-1.5 text-right text-[11px] text-slate-400">
        {t.pipelineLegend}<b>{t.longest}</b> · {t.total}{" "}
        <b className="text-slate-700">{total.toLocaleString()}</b> {t.pendingJobs}
      </p>
    </div>
  );
}

/* ── ຕາຕະລາງ "ຄ້າງດົນສຸດ" ─────────────────────────────────────── */

/**
 * ວຽກທີ່ຖືກລືມ — ຮຽງ **ເກົ່າສຸດກ່ອນ**.
 * ໜ້າລວມເກົ່າຮຽງ "ໃໝ່ສຸດກ່ອນ" ເຊິ່ງເປັນວຽກທີ່ຫາກໍ່ເປີດ = ດ່ວນນ້ອຍທີ່ສຸດ.
 * ທັງສອງໜ້າລາຍລະອຽດ (/service/<code> ແລະ /installations/<code>) ເປີດໄດ້ທຸກ role.
 */
/**
 * ສ້ອມຊ້ຳ — ເຄື່ອງໜ່ວຍດຽວກັນ (serial ດຽວກັນ) ກັບມາສ້ອມອີກພາຍໃນ 30 ມື້ ນັບແຕ່ສົ່ງຄືນ.
 *
 * ນີ້ຄື "ຄຸນນະພາບການສ້ອມ" ທີ່ບໍ່ເຄີຍມີໃຜວັດ: ຄ່າຄອມຖືກຈ່າຍສອງເທື່ອ ໃຫ້ວຽກທີ່ຈິງໆແມ່ນ
 * ຄັ້ງດຽວ ແລະ ລູກຄ້າຫອບເຄື່ອງມາສອງເທື່ອ. ເບິ່ງເງື່ອນໄຂຢູ່ lib/repeat.ts
 */
function RepeatPanel({ rows, t }: { rows: RepeatJob[]; t: Dict }) {
  return (
    <article className="overflow-hidden rounded-2xl border border-brand-orange-400 bg-white shadow-sm">
      <h2 className="flex items-center gap-2 border-b border-brand-orange-300 bg-brand-orange-100 px-5 py-4 text-sm font-bold text-brand-900">
        <RotateCcw className="size-4" />
        {t.repeatTitle} {REPEAT_DAYS} {t.days}
        <span className="rounded-full bg-brand-orange-300 px-2 py-0.5 text-[11px] text-brand-900">{rows.length}</span>
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
              <th className="whitespace-nowrap px-3 py-2.5 font-semibold">{t.colNewDoc}</th>
              <th className="whitespace-nowrap px-3 py-2.5 font-semibold">{t.colOldDoc}</th>
              <th className="whitespace-nowrap px-3 py-2.5 font-semibold">{t.colGap}</th>
              <th className="whitespace-nowrap px-3 py-2.5 font-semibold">{t.customer}</th>
              <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Serial</th>
              <th className="whitespace-nowrap px-3 py-2.5 font-semibold">{t.repeatTechCol}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.code} className="border-b border-slate-100 transition last:border-0 hover:bg-brand-orange-100/40">
                <td className="px-3 py-2.5">
                  <Link href={`/service/${encodeURIComponent(row.code)}`} className="font-bold text-brand-800 hover:underline">
                    #{row.code}
                  </Link>
                </td>
                <td className="px-3 py-2.5">
                  <Link href={`/service/${encodeURIComponent(row.prev_code)}`} className="font-semibold text-slate-600 hover:underline">
                    #{row.prev_code}
                  </Link>
                  <span className="ml-1 text-slate-400">{row.prev_returned}</span>
                </td>
                <td className="whitespace-nowrap px-3 py-2.5">
                  <span className="rounded-full bg-brand-orange-300 px-2 py-0.5 font-semibold text-brand-900">
                    {row.days_between} {t.days}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-slate-600">{row.customer ?? "-"}</td>
                <td className="px-3 py-2.5 text-slate-500">{row.sn}</td>
                <td className="px-3 py-2.5 text-slate-600">
                  {row.tech ?? "-"} / {row.prev_tech ?? "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function PriorityBacklog({
  repairs,
  installs,
  t,
}: {
  repairs: StaleJob[];
  installs: StaleJob[];
  t: Dict;
}) {
  const rows = [
    ...repairs.map((row) => ({ ...row, workflow: "repair" as const })),
    ...installs.map((row) => ({ ...row, workflow: "install" as const })),
  ]
    .sort((a, b) => b.elapsed_seconds - a.elapsed_seconds)
    .slice(0, 10);

  return (
    <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h2 className="text-sm font-bold text-slate-900">{t.priorityBacklog}</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">{t.priorityBacklogSubtitle}</p>
        </div>
        <span className="rounded-full bg-brand-orange-50 px-2.5 py-1 text-[10px] font-bold text-brand-orange-700">
          TOP {rows.length}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
              <th className="whitespace-nowrap px-3 py-2.5 font-semibold">{t.colNumber}</th>
              <th className="whitespace-nowrap px-3 py-2.5 font-semibold">{t.jobType}</th>
              <th className="whitespace-nowrap px-3 py-2.5 font-semibold">{t.colPending}</th>
              <th className="whitespace-nowrap px-3 py-2.5 font-semibold">{t.customer}</th>
              <th className="whitespace-nowrap px-3 py-2.5 font-semibold">{t.colProduct}</th>
              <th className="whitespace-nowrap px-3 py-2.5 font-semibold">{t.tech}</th>
              <th className="whitespace-nowrap px-3 py-2.5 font-semibold">{t.colStage}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const tone = elapsedTone(row.elapsed_seconds);
              const href =
                row.workflow === "repair"
                  ? `/service/${encodeURIComponent(row.code)}`
                  : `/installations/${encodeURIComponent(row.code)}`;
              return (
                <RowLink key={`${row.workflow}:${row.code}`} href={href} className="border-b border-slate-100 transition last:border-0 hover:bg-brand-50/40">
                  <td className="relative whitespace-nowrap px-3 py-2.5 font-bold text-brand">
                    <span className={`absolute inset-y-0 left-0 w-1 ${tone.bar}`} aria-hidden />
                    <Link href={href} className="hover:underline">
                      {row.code}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      row.workflow === "repair"
                        ? "bg-brand-50 text-brand-600"
                        : "bg-brand-orange-50 text-brand-orange-700"
                    }`}>
                      {row.workflow === "repair" ? t.repairJob : t.installJob}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <Elapsed
                      seconds={row.elapsed_seconds}
                      className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold ${tone.chip}`}
                    />
                  </td>
                  <td className="max-w-40 truncate px-3 py-2.5 text-slate-600" title={row.customer ?? ""}>
                    {row.customer || "-"}
                  </td>
                  <td className="max-w-48 truncate px-3 py-2.5 text-slate-600" title={row.product ?? ""}>
                    {row.product || "-"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{row.who || "-"}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                      {row.stage}
                    </span>
                  </td>
                </RowLink>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="py-10 text-center text-xs text-slate-400">{t.noPending}</p>}
      </div>
    </article>
  );
}

/**
 * ຜົນງານ 30 ມື້ — ເປີດ vs ປິດ.
 * ຈຳນວນຄ້າງຢ່າງດຽວບອກບໍ່ໄດ້ວ່າ **ກຳລັງດີຂຶ້ນ ຫຼື ຊຸດໂຊມລົງ**: ຄ້າງ 98 ວຽກ ຈະໝາຍຄວາມ
 * ຕ່າງກັນສິ້ນເຊີງ ຖ້າເດືອນນີ້ປິດໄດ້ຫຼາຍກວ່າເປີດ (ກຳລັງລົງ) ຫຼື ໜ້ອຍກວ່າ (ກຳລັງທ້ວມ).
 */
function Throughput({ label, opened, closed, t }: { label: string; opened: number; closed: number; t: Dict }) {
  const delta = opened - closed;
  const growing = delta > 0;
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-xs font-semibold text-slate-700">{label}</p>
        <p className="mt-0.5 text-[11px] text-slate-500">
          {t.opened} <b className="text-slate-700">{opened.toLocaleString()}</b> · {t.closed}{" "}
          <b className="text-slate-700">{closed.toLocaleString()}</b>
        </p>
      </div>
      <span
        className={`flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-bold ${
          growing ? "bg-brand-orange-50 text-brand-orange-700" : "bg-brand-50 text-brand-800"
        }`}
      >
        {growing ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}
        {delta > 0 ? "+" : ""}
        {delta.toLocaleString()}
      </span>
    </div>
  );
}

/**
 * ພາລະງານຕໍ່ຊ່າງ — **ຫົວໜ້າຊ່າງ ແລະ ຜູ້ຈັດການເທົ່ານັ້ນ** (APPROVER_SIDE).
 *
 * ບໍ່ມີໜ້າໃດໃນລະບົບບອກໄດ້ວ່າ "ໃຜຖືວຽກຄ້າງເທົ່າໃດ" ທັງທີ່ຂໍ້ມູນຈິງບໍ່ສົມດຸນຮ້າຍແຮງ:
 * ຊ່າງຄົນນຶ່ງຖື 41 ວຽກ (ດົນສຸດ 327 ມື້) ອີກຄົນຖື 4. ຫົວໜ້າຊ່າງຈຶ່ງແບ່ງງານໃໝ່ບໍ່ຖືກ.
 * ບໍ່ໂຊໃຫ້ຊ່າງທົ່ວໄປ — ບໍ່ແມ່ນຂໍ້ມູນທີ່ເຂົາຕ້ອງໃຊ້ ແລະ ເປັນການປຽບທຽບກັນເອງ.
 */
function TechLoadPanel({ rows, t }: { rows: TechLoad[]; t: Dict }) {
  if (rows.length === 0) return null;
  const peak = Math.max(1, ...rows.map((row) => row.jobs));

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-700">
        <Users className="size-4 text-slate-400" />
        {t.techLoadTitle}
      </h2>
      <div className="space-y-1">
        {rows.map((row) => {
          const tone = elapsedTone(row.oldest_seconds);
          return (
            <div key={row.tech} className="flex items-center gap-2 px-1 py-0.5">
              <span className="w-28 shrink-0 truncate text-xs text-slate-600" title={row.tech}>
                {row.tech}
              </span>
              <span className="relative h-5 flex-1 overflow-hidden rounded bg-slate-100">
                <span
                  className="absolute inset-y-0 left-0 rounded bg-brand-500"
                  style={{ width: `${(row.jobs / peak) * 100}%` }}
                  aria-hidden
                />
              </span>
              <span className="w-24 shrink-0 text-right">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${tone.chip}`}>
                  {Math.floor(row.oldest_seconds / 86400).toLocaleString()} {t.days}
                </span>
              </span>
              <b className="w-10 shrink-0 text-right text-xs tabular-nums text-slate-900">{row.jobs}</b>
            </div>
          );
        })}
      </div>
      <p className="mt-2 border-t border-slate-100 pt-1.5 text-right text-[11px] text-slate-400">
        {t.techLoadLegend}<b>{t.longest}</b>
      </p>
    </section>
  );
}

/* ── ແບບປະເມີນລູກຄ້າ ──────────────────────────────────────────── */

/**
 * ⚠️ ມາດຕາສ່ວນ **1 = ດີສຸດ · 4 = ແຍ່ສຸດ** — **ຕໍ່າກວ່າ = ດີກວ່າ** (ກັບຫົວຈາກດາວຄະແນນ).
 * ທຸກຕົວເລກໃນແຜງນີ້ຈຶ່ງຕ້ອງບອກທິດໃຫ້ຊັດ ບໍ່ດັ່ງນັ້ນຄົນອ່ານຈະຕີຄວາມກັບກັນ.
 *
 * ຄະແນນລວມສະສົມອັນດຽວ (1.23) **ເຊື່ອງ 3 ຢ່າງທີ່ສຳຄັນກວ່າ** ໄວ້ໝົດ:
 *   · ແນວໂນ້ມ — ຂໍ້ມູນຈິງຊຸດໂຊມລົງ 1.11 → 1.42 ໃນ 3 ເດືອນ
 *   · ຂໍ້ໃດແຍ່ — ຄະແນນຕໍ່ຄຳຖາມ (ການແຕ່ງກາຍ? ຄວາມສະອາດ?)
 *   · ໃຜບໍ່ພໍໃຈ — ງານທີ່ລູກຄ້າໃຫ້ຄະແນນ ≥3 ຄວນຕິດຕາມ
 */
const scoreTone = (value: number) =>
  value >= 2.5 ? "text-brand-orange-700" : value >= 1.5 ? "text-brand-900" : "text-brand-800";

function FeedbackPanel({ data, score, t }: { data: DashboardData; score: number; t: Dict }) {
  const trend = data.feedbackTrend;
  const peak = Math.max(1, ...data.feedbackTopics.map((topic) => topic.avg_points));
  // ຊຸດໂຊມ = ເດືອນລ່າສຸດແຍ່ກວ່າເດືອນກ່ອນ (ຕົວເລກສູງຂຶ້ນ = ແຍ່ລົງ)
  const last = trend.at(-1);
  const prev = trend.at(-2);
  const worsening = last && prev ? last.avg_points > prev.avg_points : false;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
          <Smile className="size-4" />
        </span>
        <div className="min-w-40 flex-1">
          <h2 className="text-sm font-bold text-slate-700">{t.feedbackTitle}</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {t.from} {data.feedback.jobs.toLocaleString()} {t.jobsWord} ·{" "}
            <b className="text-slate-700">{t.scaleNote}</b> {t.lowerBetter}
          </p>
        </div>
        <div className="text-right">
          <p className={`text-3xl font-bold ${scoreTone(score)}`}>{score.toFixed(2)}</p>
          <p className="text-[11px] text-slate-400">{t.totalScore}</p>
        </div>
      </div>

      {/* ລູກຄ້າບໍ່ພໍໃຈ — ຄວນຕິດຕາມ */}
      {data.feedback.unhappy_jobs > 0 && (
        <Link
          href="/reports/customer-feedback"
          className="mb-3 flex items-center gap-2 rounded-lg border border-brand-orange-400 bg-brand-orange-50 px-3 py-2 text-xs text-brand-orange-700 transition hover:bg-brand-orange-100"
        >
          <Frown className="size-4 shrink-0" />
          <span className="flex-1">
            <b>{data.feedback.unhappy_jobs.toLocaleString()} {t.jobsWord}</b> {t.unhappyNote}
          </span>
          <LinkPending className="size-3.5" />
        </Link>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ແນວໂນ້ມ 6 ເດືອນ */}
        {trend.length > 1 && (
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-slate-600">
              {t.trend6mo}
              {worsening ? (
                <span className="flex items-center gap-0.5 rounded bg-brand-orange-50 px-1.5 py-0.5 text-[10px] font-semibold text-brand-orange-700">
                  <TrendingUp className="size-3" /> {t.worsening}
                </span>
              ) : (
                <span className="flex items-center gap-0.5 rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold text-brand-800">
                  <TrendingDown className="size-3" /> {t.improving}
                </span>
              )}
            </p>
            {/* ແທ່ງສູງ = ຄະແນນສູງ = ແຍ່ (ຕໍ່າ=ດີ) ⇒ ສີແດງເມື່ອສູງ */}
            <div className="flex h-24 items-end gap-1.5">
              {trend.map((month) => (
                <div key={month.month} className="flex flex-1 flex-col items-center gap-1">
                  <span className={`text-[10px] font-bold ${scoreTone(month.avg_points)}`}>
                    {month.avg_points.toFixed(2)}
                  </span>
                  <div
                    className={`w-full rounded-t ${
                      month.avg_points >= 2.5
                        ? "bg-brand-orange-400"
                        : month.avg_points >= 1.5
                          ? "bg-brand-orange-300"
                          : "bg-brand-400"
                    }`}
                    // ມາດຕາສ່ວນ 1-4 → ຄວາມສູງ (4 = ເຕັມ)
                    style={{ height: `${Math.max(6, (month.avg_points / 4) * 100)}%` }}
                    title={`${month.jobs} ${t.jobsWord}`}
                  />
                  <span className="text-[10px] text-slate-400">{month.month}</span>
                </div>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-slate-400">{t.barHighNote}</p>
          </div>
        )}

        {/* ຄະແນນແຍກຕາມຄຳຖາມ — ຮຽງແຍ່ສຸດກ່ອນ */}
        {data.feedbackTopics.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-bold text-slate-600">{t.scorePerQuestion}</p>
            <div className="space-y-1">
              {data.feedbackTopics.map((topic) => (
                <div key={topic.line_number} className="flex items-center gap-2">
                  <span className="w-40 shrink-0 truncate text-[11px] text-slate-600" title={topic.name}>
                    {topic.name}
                  </span>
                  <span className="relative h-4 flex-1 overflow-hidden rounded bg-slate-100">
                    <span
                      className={`absolute inset-y-0 left-0 rounded ${
                        topic.avg_points >= 2.5
                          ? "bg-brand-orange-400"
                          : topic.avg_points >= 1.5
                            ? "bg-brand-orange-300"
                            : "bg-brand-400"
                      }`}
                      style={{ width: `${(topic.avg_points / peak) * 100}%` }}
                      aria-hidden
                    />
                  </span>
                  <b className={`w-10 shrink-0 text-right text-[11px] tabular-nums ${scoreTone(topic.avg_points)}`}>
                    {topic.avg_points.toFixed(2)}
                  </b>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/* ── ໜ້າ ─────────────────────────────────────────────────────── */

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const params = await searchParams;
  const days = [1, 7, 30, 90].includes(Number(params.range)) ? Number(params.range) : 30;
  const session = ALL_ACCESS_SESSION;
  const role = roleOf(session);
  // ຊ່າງເຫັນສະເພາະວຽກຂອງຕົນ — ກົດເກນອັນດຽວກັບທຸກໜ້າ (lib/scope)
  const tech = NO_TECH_FILTER;
  const t = (await getDictionary(await getLocale())).dashboard;

  // The QC workflow panel is not ported: its action pulls in ODSS's push /
  // notify / chatter stack, which has side effects that do not belong in a
  // read-only management view. Alerts fall back to "no QC backlog signal".
  const { data, error } = await getDashboard(tech, days);
  const qc: unknown[] = [];
  const repair: Counts = data?.repair ?? {};
  const install: Counts = data?.install ?? {};
  const alerts = data
    ? alertsFor(role, data, qc.length > 0, t).sort((a, b) => {
        if (a.tone !== b.tone) return a.tone === "red" ? -1 : 1;
        return b.value - a.value;
      })
    : [];

  const score = data?.feedback.avg_points ?? null;
  const oldestRepair = data?.oldest.repair_seconds ?? 0;
  const oldestInstall = data?.oldest.install_seconds ?? 0;
  const actionTotal = alerts.reduce((sum, alert) => sum + alert.value, 0);
  const updatedAt = new Intl.DateTimeFormat("lo-LA", {
    timeZone: "Asia/Vientiane",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
  const kpis = [
    { label: t.kpiRepairPending, value: repair.total ?? 0, tone: "text-brand-600", bg: "bg-brand-50" },
    { label: t.kpiInstallPending, value: install.total ?? 0, tone: "text-brand-orange-700", bg: "bg-brand-orange-50" },
    { label: t.overSla, value: data?.sla.late ?? 0, tone: "text-brand-orange-700", bg: "bg-brand-orange-50" },
    { label: t.kpiActionItems, value: actionTotal, tone: "text-brand-900", bg: "bg-brand-orange-100" },
  ];
  const criticalTotal = (data?.sla.critical ?? 0) + (data?.overdueAppointments ?? 0) + (data?.unassigned.repair ?? 0) + (data?.unassigned.install ?? 0);
  const health = criticalTotal === 0 ? { label: t.healthNormal, detail: t.healthNoCrisis, tone: "text-brand-800", ring: "bg-brand-700" }
    : criticalTotal < 10 ? { label: t.healthWatch, detail: `${criticalTotal} ${t.criticalItems}`, tone: "text-brand-900", ring: "bg-brand-orange-500" }
      : { label: t.healthAct, detail: `${criticalTotal} ${t.criticalItems}`, tone: "text-brand-orange-700", ring: "bg-brand-orange-700" };
  const quickActions = [
    { label: t.quickReceiveNew, href: "/service/new", icon: Plus },
    { label: t.quickNewInstall, href: "/installations/new", icon: Plus },
    { label: t.quickChecking, href: "/checking", icon: ClipboardCheck },
    { label: t.quickDispatch, href: "/stock/dispatch", icon: PackageCheck },
    { label: t.quickAssign, href: "/installations/assign", icon: Users },
  ].filter((item) => canAccess(role, item.href));

  return (
    <div className="w-full space-y-8 pb-8">
      <DashboardAutoRefresh />

      {/* ── Hero — ສູນຄວບຄຸມວຽກ ── */}
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-navy via-brand-900 to-brand-800 px-5 py-6 text-white shadow-2xl shadow-brand-900/20 sm:px-8 sm:py-7">
        {/* ຊາຍພື້ນລາຍຕາລະອຽດ + ແສງສະຫວ່າງ */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.06]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,.7) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.7) 1px, transparent 1px)",
            backgroundSize: "34px 34px",
          }}
          aria-hidden
        />
        <div className="pointer-events-none absolute -right-16 -top-24 size-72 rounded-full bg-brand-400/20 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-24 left-1/4 size-56 rounded-full bg-brand-orange-500/10 blur-3xl" aria-hidden />

        <div className="relative flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            {/* ສະບາຍດີຜູ້ໃຊ້ດ້ວຍຊື່ — username = ຕົວຕົນ ERP (nickname/ຊື່ເຕັມ) */}
            <p className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-300">
              <span className="inline-block size-1.5 rounded-full bg-brand-orange-300" aria-hidden />
              {session?.username ? `${t.greeting}, ${session.username}` : "ODIEN Service Operations"}
            </p>
            <h1 className="text-2xl font-bold tracking-tight sm:text-[28px]">{t.controlCenter}</h1>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-300">
              <span className="rounded-md bg-white/10 px-2 py-0.5 font-medium text-brand-100">{ROLE_LABEL[role]}</span>
              <span className="text-slate-500">·</span>
              <span>{tech ? t.showOwnJobs : t.showAllJobs}</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-slate-400">{t.updated} {updatedAt}</span>
            <Link href={`/dashboard?range=${days}`} className="grid size-10 place-items-center rounded-xl border border-white/15 bg-white/10 text-white transition hover:bg-white/20" title={t.refreshData}><RefreshCw className="size-4" /></Link>
            <Link
              href="/dashboard/tracking"
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-white/15 bg-white/10 px-4 text-xs font-semibold text-white backdrop-blur transition hover:bg-white/20"
            >
              <Radar className="size-4" /> {t.trackJobs} <LinkPending className="size-3.5" />
            </Link>
            {/* ດາວໂຫຼດແອັບຊ່າງ — ເນັ້ນ (ຂຽວ) ໃຫ້ຫາງ່າຍ ບໍ່ຕ້ອງເຂົ້າເມນູ */}
            <Link
              href="/download"
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-400 px-4 text-xs font-bold text-brand-900 shadow-lg shadow-brand-900/30 transition hover:bg-brand-300"
            >
              <Smartphone className="size-4" /> {t.downloadApp} <LinkPending className="size-3.5" />
            </Link>
          </div>
        </div>

        {/* ແຖບ KPI ຢູ່ໃນ hero — ປະຫຍຸດ ບໍ່ແຍກບັດ */}
        <div className="relative mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 sm:grid-cols-4">
          {kpis.map((kpi) => (
            <div key={kpi.label} className="bg-white/[0.04] px-4 py-3.5 backdrop-blur-sm">
              <div className={`mb-2 h-1 w-8 rounded-full ${kpi.bg}`} />
              <p className="text-2xl font-bold tracking-tight tabular-nums text-white">{kpi.value.toLocaleString()}</p>
              <p className="mt-0.5 text-[11px] font-medium text-slate-400">{kpi.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ຄິວຫຼັກຢູ່ເທິງ: ເປີດໜ້າມາແລ້ວຮູ້ທັນທີວ່າຕ້ອງເຄຍຫຍັງກ່ອນ */}
      {alerts.length > 0 && (
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
            <div>
              <h2 className="text-base font-bold text-slate-900">{t.actionNeeded}</h2>
              <p className="mt-0.5 text-[11px] text-slate-500">{t.actionNeededSubtitle}</p>
            </div>
            <span className="rounded-full bg-brand-900 px-3 py-1 text-[10px] font-bold text-white">
              {actionTotal.toLocaleString()} {t.kpiActionItems}
            </span>
          </div>
          <div className="grid gap-px bg-slate-100 sm:grid-cols-2 xl:grid-cols-3">
            {alerts.map(({ label, value, detail, href, icon: Icon, tone }, index) => {
              const colors = TONE[tone];
              return (
                <Link
                  key={label}
                  href={href}
                  className="group relative flex min-h-28 items-center gap-3 bg-white p-4 transition hover:z-10 hover:bg-slate-50"
                >
                  <span className={`absolute inset-y-0 left-0 w-1 ${colors.bar}`} />
                  <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${colors.icon}`}>
                    <Icon className="size-4.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-slate-400">#{index + 1}</span>
                      <p className="truncate text-xs font-semibold text-slate-700">{label}</p>
                    </div>
                    {detail && <p className="mt-1 truncate text-[11px] text-slate-500">{detail}</p>}
                  </div>
                  <p className={`shrink-0 text-3xl font-bold tracking-tight ${colors.value}`}>{value.toLocaleString()}</p>
                  <ArrowRight className="size-3.5 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-600" />
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {!error && alerts.length === 0 && (
        <p className="rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-xs font-semibold text-brand-800">
          {t.noPendingWork}
        </p>
      )}

      <section className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="pointer-events-none absolute -bottom-16 -right-12 size-40 rounded-full bg-brand-100/70 blur-3xl" />
          <div className="relative flex flex-wrap items-center gap-5">
            <div className={`grid size-16 shrink-0 place-items-center rounded-2xl ${health.ring} text-white shadow-lg shadow-slate-200`}>
              <span className="text-2xl font-black">{criticalTotal}</span>
            </div>
            <div className="min-w-48 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Operational health</p>
              <h2 className={`mt-1 text-xl font-bold ${health.tone}`}>{health.label}</h2>
              <p className="mt-1 text-xs text-slate-500">{health.detail} · {t.healthBasis}</p>
            </div>
            <Link href="/dashboard/tracking" className="inline-flex items-center gap-1.5 rounded-xl bg-brand-900 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-brand-800">{t.viewOverview} <ArrowRight className="size-3.5" /></Link>
          </div>
        </div>

        {quickActions.length > 0 && <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-3"><h2 className="text-sm font-bold text-slate-800">{t.dailyShortcuts}</h2><p className="mt-0.5 text-[11px] text-slate-500">{t.shortcutsSubtitle}</p></div>
          <div className="grid grid-cols-2 gap-2">
            {quickActions.slice(0, 6).map(({ label, href, icon: Icon }) => <Link key={href} href={href} className="group flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2.5 text-xs font-semibold text-slate-700 transition hover:border-brand-200 hover:bg-brand-50 hover:text-brand-900"><span className="grid size-7 place-items-center rounded-lg bg-white text-slate-500 shadow-sm group-hover:text-brand-800"><Icon className="size-3.5" /></span><span className="truncate">{label}</span></Link>)}
          </div>
        </div>}
      </section>

      {data && ["/installations/work", "/checking", "/work"].some((path) => canAccess(role, path)) && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
            <div><h2 className="text-base font-bold text-slate-900">{t.todayJobs}</h2><p className="mt-0.5 text-[11px] text-slate-500">{t.todayJobsSubtitle}</p></div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {canAccess(role, "/installations/work") && <Link href="/installations/work" className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 transition hover:border-brand-300 hover:bg-brand-50"><p className="text-xs font-semibold text-slate-600">{t.todayAppointments}</p><p className="mt-1 text-2xl font-bold tabular-nums text-brand-800">{data.today.appointments.toLocaleString()}</p></Link>}
            {canAccess(role, "/checking") && <Link href="/checking" className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 transition hover:border-brand-300 hover:bg-brand-50"><p className="text-xs font-semibold text-slate-600">{t.todayChecking}</p><p className="mt-1 text-2xl font-bold tabular-nums text-brand-600">{data.today.checking.toLocaleString()}</p></Link>}
            {canAccess(role, "/work") && <Link href="/work/repair/repairing" className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 transition hover:border-brand-orange-300 hover:bg-brand-orange-50"><p className="text-xs font-semibold text-slate-600">{t.todayRepairing}</p><p className="mt-1 text-2xl font-bold tabular-nums text-brand-orange-700">{data.today.repairing.toLocaleString()}</p></Link>}
          </div>
          {(data.sla.warning > 0 || data.sla.late > 0) && canAccess(role, "/checking") && <div className="mt-3 flex flex-wrap gap-2 text-[11px]"><Link href="/checking?sla=warning&sort=elapsed&dir=desc" className="rounded-full bg-brand-orange-300 px-2.5 py-1 font-semibold text-brand-900 hover:bg-brand-orange-300">{t.nearSla} {data.sla.warning}</Link><Link href="/checking?sla=late&sort=elapsed&dir=desc" className="rounded-full bg-brand-orange-100 px-2.5 py-1 font-semibold text-brand-orange-700 hover:bg-brand-orange-200">{t.overSla} {data.sla.late}</Link><Link href="/checking?sla=critical&sort=elapsed&dir=desc" className="rounded-full bg-brand-orange-700 px-2.5 py-1 font-semibold text-white hover:bg-brand-orange-700">{t.critical} {data.sla.critical}</Link></div>}
        </section>
      )}

      {data && canAccess(role, "/installations/work") && data.upcomingAppointments.length > 0 && (
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
            <span className="grid size-9 place-items-center rounded-xl bg-brand-50 text-brand-800"><CalendarDays className="size-4" /></span>
            <div className="flex-1"><h2 className="text-sm font-bold text-slate-800">{t.upcoming7days}</h2><p className="text-[11px] text-slate-500">{t.upcomingSubtitle}</p></div>
          </div>
          <div className="grid divide-y divide-slate-100 md:grid-cols-2 md:divide-x md:divide-y-0">
            {data.upcomingAppointments.map((item: (typeof data.upcomingAppointments)[number]) => (
              <Link key={item.code} href={`/installations/${encodeURIComponent(item.code)}`} className="flex min-w-0 items-center gap-3 border-b border-slate-100 px-5 py-3 transition hover:bg-brand-50/40">
                <div className="w-20 shrink-0 text-center"><p className="text-xs font-bold text-slate-800">{item.appoint_date}</p>{item.same_day_jobs > 1 && <span className="mt-1 inline-block rounded bg-brand-orange-100 px-1.5 py-0.5 text-[9px] font-bold text-brand-orange-700">{t.overlapAppointment} {item.same_day_jobs}</span>}</div>
                <div className="min-w-0 flex-1"><p className="truncate text-xs font-bold text-brand">{item.code} · {item.customer || "-"}</p><p className="mt-0.5 truncate text-[11px] text-slate-500">{item.product || "-"}</p></div>
                <span className="max-w-24 truncate text-[10px] font-semibold text-slate-500">{item.tech || t.noTechYet}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {error && (
        <p className="flex items-center gap-2 rounded-lg border border-brand-orange-400 bg-brand-orange-50 px-3 py-2 text-xs text-brand-orange-700">
          <AlertCircle className="size-4 shrink-0" />
          {t.loadError}
        </p>
      )}

      {/* ② ຂັ້ນໄດ — ບໍ່ຫຼົ້ນກັນ ລວມກັນໄດ້ຍອດພໍດີ */}
      <section className="grid gap-4 xl:grid-cols-2">
        <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-3 flex items-center gap-2">
            <Wrench className="size-4 text-slate-400" />
            <h2 className="text-sm font-bold text-slate-700">{t.repairPipeline}</h2>
            <span className="ml-auto flex items-center gap-1 text-[11px] text-slate-400">
              {t.longestPending}
              <Elapsed
                seconds={oldestRepair}
                className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${elapsedTone(oldestRepair).chip}`}
              />
            </span>
          </div>
          <Pipeline
            workflow="repair"
            statuses={repairStatuses}
            counts={repair}
            ages={data?.repairAge ?? {}}
            role={role}
            t={t}
          />
        </article>

        <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-3 flex items-center gap-2">
            <HardHat className="size-4 text-slate-400" />
            <h2 className="text-sm font-bold text-slate-700">{t.installPipeline}</h2>
            <span className="ml-auto flex items-center gap-1 text-[11px] text-slate-400">
              {t.longestPending}
              <Elapsed
                seconds={oldestInstall}
                className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${elapsedTone(oldestInstall).chip}`}
              />
            </span>
          </div>
          <Pipeline
            workflow="install"
            statuses={installStatuses}
            counts={install}
            ages={data?.installAge ?? {}}
            role={role}
            t={t}
          />
        </article>
      </section>

      {/* ພາລະງານຕໍ່ຊ່າງ — ຫົວໜ້າຊ່າງ/ຜູ້ຈັດການ ໃຊ້ແບ່ງງານ */}
      {data && APPROVER_SIDE.includes(role) && <TechLoadPanel rows={data.techLoad} t={t} />}

      {/* ຜົນງານ 30 ມື້ — ບອກທິດທາງ ບໍ່ແມ່ນແຕ່ຍອດ */}
      {data && !tech && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-bold text-slate-800">{t.performance} {days} {t.daysAgoCompare}</h2>
            <div className="flex overflow-hidden rounded-lg border border-slate-200">
              {[1, 7, 30, 90].map((value) => <Link key={value} href={`/dashboard?range=${value}`} className={`px-2.5 py-1.5 text-[10px] font-semibold ${days === value ? "bg-brand-900 text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`}>{value} {t.days}</Link>)}
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Throughput
              label={t.throughputRepair}
              opened={data.throughput.repair_opened}
              closed={data.throughput.repair_closed}
              t={t}
            />
            <Throughput
              label={t.throughputInstall}
              opened={data.throughput.install_opened}
              closed={data.throughput.install_closed}
              t={t}
            />
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            {t.throughputNote}
          </p>
        </section>
      )}

      {/* ຄ່າຄອມເດືອນນີ້ — ຊ່າງເຫັນຂອງຕົນ · ຄົນອື່ນເຫັນລວມ */}
      {data && canAccess(role, "/reports/technician-income") && (data.payout.assigned_thb > 0 || data.payout.orphan_thb > 0) && (
        <Link
          href="/reports/technician-income"
          className="flex flex-wrap items-center gap-4 rounded-2xl border border-brand-200 bg-gradient-to-r from-white to-brand-50/60 p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md sm:p-6"
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-800">
            <Wallet className="size-5" />
          </span>
          <div className="min-w-48 flex-1">
            <p className="text-sm font-bold text-slate-700">
              {tech ? t.myIncomeMonth : t.techCommissionMonth}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {t.from} {data.payout.jobs.toLocaleString()} {t.payoutJobsClosed}
            </p>
            {/* ເງິນທີ່ຍັງບໍ່ມີເຈົ້າຂອງ — ບໍ່ຢູ່ໃນຍອດຂວາ ຈຶ່ງຕ້ອງບອກ ບໍ່ດັ່ງນັ້ນຫາຍງຽບໆ */}
            {data.payout.orphan_thb > 0 && (
              <p className="mt-1 text-[11px] font-semibold text-brand-900">
                ⚠ {t.orphanMore} {data.payout.orphan_thb.toLocaleString("en-US", { minimumFractionDigits: 2 })} {t.baht}
                {" "}{t.orphanNote}
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="text-3xl font-bold tabular-nums text-slate-900">
              {data.payout.assigned_thb.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </p>
            <p className="text-[11px] text-slate-400">{t.baht}</p>
          </div>
        </Link>
      )}

      {/* ③ ແບບປະເມີນລູກຄ້າ — ມາດຕາສ່ວນກັບຫົວ (1 ດີສຸດ) ຈຶ່ງຕ້ອງບອກໃຫ້ຊັດທຸກບ່ອນ */}
      {data && score != null && <FeedbackPanel data={data} score={score} t={t} />}

      {/* ④ ຄິວດຽວ: ວຽກສ້ອມ + ຕິດຕັ້ງ ທີ່ຄ້າງດົນສຸດ */}
      <PriorityBacklog repairs={data?.staleRepairs ?? []} installs={data?.staleInstalls ?? []} t={t} />

      {/* ⑤ ສ້ອມຊ້ຳ — ເຄື່ອງໜ່ວຍດຽວກັນກັບມາພາຍໃນ 30 ມື້ = ຄັ້ງກ່ອນສ້ອມບໍ່ຈົບ */}
      {(data?.repeats.length ?? 0) > 0 && <RepeatPanel rows={data!.repeats} t={t} />}

      <p className="text-center text-[11px] text-slate-400">
        {t.footerNote}
      </p>
    </div>
  );
}
