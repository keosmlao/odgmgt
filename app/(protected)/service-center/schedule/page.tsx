// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
import { Empty } from "@/components/ods/ui";
import { ALL_ACCESS_SESSION, NO_TECH_FILTER } from "@/lib/ods/session-all";
import { query } from "@/lib/ods/db";
import { getDictionary } from "@/lib/ods/i18n/dictionaries";
import { getLocale } from "@/lib/ods/i18n/locale";
import { INSTALL_STAGE_LABEL_SQL, INSTALL_STAGE_SQL } from "@/lib/ods/install-stage";
import { roleOf } from "@/lib/ods/roles";
import { STAGE_LABEL_SQL, STAGE_SQL } from "@/lib/ods/stage";
import { listTechnicians } from "@/lib/ods/technicians";
import { CalendarDays, ChevronLeft, ChevronRight, ExternalLink, MapPin, Navigation, Phone, UserRound } from "lucide-react";
import Link from "next/link";

/**
 * ຄິວງານຊ່າງປະຈຳວັນ — ປະຕິທິນຢູ່ຊ້າຍ, ລາຍລະອຽດຂອງວັນທີ່ເລືອກຢູ່ຂວາ.
 * ຊ່າງເຫັນສະເພາະຄິວຂອງຕົນ; ຜູ້ຈັດງານເຫັນທຸກຄົນ.
 */
export const dynamic = "force-dynamic";

type Row = {
  workflow: "install" | "repair";
  code: string;
  tech: string | null;
  customer: string | null;
  tel: string | null;
  location: string | null;
  item: string | null;
  stage: number;
  stage_label: string;
  remark: string | null;
  lat: number | null;
  lng: number | null;
};

type DayCount = { day: string; jobs: number };
type Props = { searchParams: Promise<{ d?: string }> };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** ຄ່າ sentinel ພາຍໃນ (ໃຊ້ເປັນ key ຂອງ Map + ປຽບທຽບ) — ບໍ່ແມ່ນຂໍ້ຄວາມສະແດງ; ແປຕອນ render */
const NO_TECH = "(ຍັງບໍ່ມີຊ່າງ)";

function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function shift(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function shiftMonth(iso: string, months: number) {
  const [year, month] = iso.split("-").map(Number);
  return isoDate(new Date(Date.UTC(year, month - 1 + months, 1)));
}

function calendarDays(monthStart: string) {
  const first = new Date(`${monthStart}T00:00:00Z`);
  const mondayOffset = (first.getUTCDay() + 6) % 7;
  const start = shift(monthStart, -mondayOffset);
  return Array.from({ length: 42 }, (_, index) => shift(start, index));
}

export default async function SchedulePage({ searchParams }: Props) {
  const params = await searchParams;
  const locale = await getLocale();
  const t = (await getDictionary(locale)).installSchedule;
  const intlLocale = locale === "th" ? "th-TH" : locale === "en" ? "en-US" : "lo-LA";
  const today = isoDate(new Date());
  const day = ISO.test(params.d ?? "") ? params.d! : today;
  const monthStart = `${day.slice(0, 7)}-01`;
  const monthEnd = shiftMonth(monthStart, 1);

  const session = ALL_ACCESS_SESSION;
  const tech = NO_TECH_FILTER;
  const values = tech ? [day, tech] : [day];
  const monthValues = tech ? [monthStart, monthEnd, tech] : [monthStart, monthEnd];

  const [jobsResult, countResult, technicians] = await Promise.all([
    query<Row>(
      `select 'install' as workflow, a.code,
          nullif(a.tech_code,'') as tech,
          c.name_1 as customer, c.tel,
          coalesce(nullif(a.location_inst,''), c.address) as location,
          a.item_name as item,
          (${INSTALL_STAGE_SQL}) as stage,
          (${INSTALL_STAGE_LABEL_SQL}) as stage_label,
          nullif(a.remark,'') as remark,
          a.location_lat as lat, a.location_lng as lng
        from ods_tb_install a
        left join ar_customer c on c.code = a.cust_code
       where a.appoint_date = $1::date
         and a.cancel_date is null
         and a.job_finish is null
         ${tech ? "and a.tech_code = $2" : ""}

       union all

       select 'repair' as workflow, a.code,
          nullif(a.emp_code,'') as tech,
          c.name_1 as customer, c.tel,
          coalesce(nullif(a.location_repair,''), c.address) as location,
          a.name_1 as item,
          (${STAGE_SQL}) as stage,
          (${STAGE_LABEL_SQL}) as stage_label,
          nullif(a.remark,'') as remark,
          a.location_lat as lat, a.location_lng as lng
        from tb_product a
        left join ar_customer c on c.code = a.cust_code
       where a.appoint_date = $1::date
         and a.cancel_start is null
         and a.return_complete is null
         ${tech ? "and a.emp_code = $2" : ""}

       order by tech nulls last, code`,
      values,
    ),
    query<DayCount>(
      `select to_char(q.appoint_date,'YYYY-MM-DD') as day, count(*)::int as jobs
         from (
           select a.appoint_date
             from ods_tb_install a
            where a.appoint_date >= $1::date and a.appoint_date < $2::date
              and a.cancel_date is null and a.job_finish is null
              ${tech ? "and a.tech_code = $3" : ""}
           union all
           select a.appoint_date
             from tb_product a
            where a.appoint_date >= $1::date and a.appoint_date < $2::date
              and a.cancel_start is null and a.return_complete is null
              ${tech ? "and a.emp_code = $3" : ""}
         ) q
        group by q.appoint_date
        order by q.appoint_date`,
      monthValues,
    ),
    listTechnicians(),
  ]);

  const rows = jobsResult.rows;
  const counts = new Map(countResult.rows.map((row) => [row.day, Number(row.jobs)]));
  const monthTotal = countResult.rows.reduce((sum, row) => sum + Number(row.jobs), 0);
  const installTotal = rows.filter((row) => row.workflow === "install").length;
  const repairTotal = rows.length - installTotal;
  const cells = calendarDays(monthStart);
  const selectedLabel = new Intl.DateTimeFormat(intlLocale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));
  const monthLabel = new Intl.DateTimeFormat(intlLocale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${monthStart}T00:00:00Z`));

  const byTech = new Map<string, Row[]>();
  for (const row of rows) {
    const who = row.tech ?? NO_TECH;
    byTech.set(who, [...(byTech.get(who) ?? []), row]);
  }
  const technicianNames = new Map<string, string>();
  for (const technician of technicians) {
    technicianNames.set(technician.code.toLowerCase(), technician.name);
    technicianNames.set(technician.employee_code.toLowerCase(), technician.name);
  }
  const technicianName = (code: string) =>
    code === NO_TECH ? code : technicianNames.get(code.toLowerCase()) ?? code;
  const canSeeAll = roleOf(session) !== "technical";

  return (
    <div className="space-y-4 pb-8">
      <header className="relative overflow-hidden rounded-[28px] bg-[#003260] px-5 py-6 text-white shadow-lg shadow-slate-200 sm:px-7">
        <div className="absolute -right-16 -top-20 size-56 rounded-full bg-brand-400/15 blur-2xl" />
        <div className="absolute bottom-0 right-1/3 size-32 rounded-full bg-brand-500/10 blur-2xl" />
        <div className="relative flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/10 px-3 py-1 text-[11px] font-bold text-brand-200">
              <CalendarDays className="size-3.5" />
              SERVICE OPERATIONS
            </div>
            <h1 className="text-2xl font-black tracking-tight sm:text-3xl">{t.title}</h1>
            <p className="mt-1.5 max-w-2xl text-sm text-slate-300">
              {t.subtitle}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:min-w-[430px]">
            {[
              { label: t.allJobs, value: rows.length, tone: "text-white" },
              { label: t.installWord, value: installTotal, tone: "text-brand-300" },
              { label: t.repairWord, value: repairTotal, tone: "text-brand-orange-300" },
            ].map((stat) => (
              <div key={stat.label} className="rounded-2xl border border-white/10 bg-white/[0.08] px-3 py-3 backdrop-blur">
                <p className={`text-2xl font-black ${stat.tone}`}>{stat.value}</p>
                <p className="mt-0.5 text-[10px] font-semibold text-slate-300">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
      </header>

      <div className="grid items-start gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        {/* ຊ້າຍ: ປະຕິທິນ */}
        <aside className="overflow-hidden rounded-[24px] border border-slate-200/80 bg-white shadow-[0_12px_35px_rgba(15,23,42,0.08)] xl:sticky xl:top-20">
          <div className="flex items-center justify-between bg-gradient-to-b from-slate-50 to-white px-5 py-4">
            <Link
              href={`/installations/schedule?d=${shiftMonth(monthStart, -1)}`}
              title={t.prevMonth}
              className="grid size-9 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:-translate-x-0.5 hover:border-brand-300 hover:text-brand-800"
            >
              <ChevronLeft className="size-4" />
            </Link>
            <div className="text-center">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-brand-700">{t.calendarLabel}</p>
              <h2 className="mt-0.5 text-base font-black text-slate-900">{monthLabel}</h2>
            </div>
            <Link
              href={`/installations/schedule?d=${shiftMonth(monthStart, 1)}`}
              title={t.nextMonth}
              className="grid size-9 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:translate-x-0.5 hover:border-brand-300 hover:text-brand-800"
            >
              <ChevronRight className="size-4" />
            </Link>
          </div>

          <div className="border-y border-slate-100 px-4 pb-5 pt-2">
            <div className="mb-1 grid grid-cols-7 border-b border-slate-100 pb-1">
              {t.weekdays.map((label: string, index: number) => (
                <span key={`${label}-${index}`} className={`py-2 text-center text-[10px] font-black ${index >= 5 ? "text-brand-orange-700" : "text-slate-400"}`}>
                  {label}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-y-1">
              {cells.map((date) => {
                const inMonth = date.startsWith(day.slice(0, 7));
                const selected = date === day;
                const isToday = date === today;
                const count = counts.get(date) ?? 0;
                return (
                  <Link
                    key={date}
                    href={`/installations/schedule?d=${date}`}
                    aria-current={selected ? "date" : undefined}
                    className={`relative mx-auto flex size-10 flex-col items-center justify-center rounded-[13px] text-xs font-bold transition ${
                      selected
                        ? "bg-[#003260] text-white shadow-lg shadow-slate-300"
                        : inMonth
                          ? "text-slate-700 hover:bg-brand-50 hover:text-brand-800"
                          : "text-slate-300 hover:bg-slate-50"
                    } ${isToday && !selected ? "bg-brand-50 text-brand-800 ring-1 ring-inset ring-brand-200" : ""}`}
                  >
                    <span>{Number(date.slice(-2))}</span>
                    {count > 0 && (
                      <span className={`absolute -bottom-1 min-w-4 rounded-full px-1 text-center text-[8px] font-black ring-2 ring-white ${selected ? "bg-brand-600 text-white" : "bg-brand-orange-300 text-brand-900"}`}>
                        {count}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between bg-slate-50/80 px-5 py-3.5">
            <span className="text-[10px] font-semibold text-slate-500">{t.monthThis} {monthTotal} {t.jobsWord}</span>
            {day !== today && (
              <Link href="/installations/schedule" className="rounded-lg bg-white px-2.5 py-1 text-[11px] font-bold text-brand-800 shadow-sm ring-1 ring-slate-200 hover:bg-brand-50">
                {t.today}
              </Link>
            )}
          </div>
        </aside>

        {/* ຂວາ: ລາຍລະອຽດວັນທີ່ເລືອກ */}
        <section className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[24px] border border-slate-200/80 bg-white px-5 py-4 shadow-sm">
            <div>
              <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">{t.selectedDate}</p>
              <h2 className="flex items-center gap-2 text-lg font-black text-slate-900">
                <span className="grid size-9 place-items-center rounded-xl bg-brand-50 text-brand-800"><CalendarDays className="size-5" /></span>
                {selectedLabel}
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <Link href={`/installations/schedule?d=${shift(day, -1)}`} aria-label={t.prevDay} className="grid size-9 place-items-center rounded-xl border border-slate-200 text-slate-500 hover:border-brand-300 hover:text-brand-800">
                <ChevronLeft className="size-4" />
              </Link>
              <Link href={`/installations/schedule?d=${shift(day, 1)}`} aria-label={t.nextDay} className="grid size-9 place-items-center rounded-xl border border-slate-200 text-slate-500 hover:border-brand-300 hover:text-brand-800">
                <ChevronRight className="size-4" />
              </Link>
            </div>
          </div>

          {rows.length > 0 && (
            <div>
              <div className="mb-2 flex items-center justify-between px-1">
                <h3 className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">{t.loadByTech}</h3>
                <span className="text-[10px] font-semibold text-slate-400">{byTech.size} {t.teamTech}</span>
              </div>
              <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                {[...byTech.entries()].map(([who, techJobs]) => {
                  const installs = techJobs.filter((job) => job.workflow === "install").length;
                  const repairs = techJobs.length - installs;
                  const isNoTech = who === NO_TECH;
                  const displayName = isNoTech ? t.noTechParen : technicianName(who);
                  const high = techJobs.length >= 4;
                  return (
                    <div key={who} className={`flex items-center gap-3 px-3.5 py-2.5 ${high ? "bg-brand-orange-50/40" : ""}`}>
                      <span className={`grid size-8 shrink-0 place-items-center rounded-xl ${high ? "bg-brand-orange-50 text-brand-orange-700" : "bg-brand-50 text-brand-800"}`}><UserRound className="size-4" /></span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-black text-slate-800">{displayName}
                          {!isNoTech && displayName !== who && <span className="ml-1.5 text-[10px] font-medium text-slate-400">{t.codeLabel} {who}</span>}
                        </p>
                        {high && canSeeAll && <p className="text-[10px] font-bold text-brand-orange-700">{t.highLoadWarn}</p>}
                      </div>
                      <span className="shrink-0 rounded-lg bg-brand-50 px-2 py-0.5 text-[10px] font-bold text-brand-800">{t.installWord} {installs}</span>
                      <span className="shrink-0 rounded-lg bg-brand-orange-100 px-2 py-0.5 text-[10px] font-bold text-brand-900">{t.repairWord} {repairs}</span>
                      <span className={`shrink-0 rounded-xl px-2.5 py-1 text-xs font-black tabular-nums ${high ? "bg-brand-orange-700 text-white" : "bg-[#003260] text-white"}`}>
                        {techJobs.length} {t.jobsWord}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {rows.length === 0 ? (
            <div className="rounded-[24px] border border-dashed border-slate-300 bg-white p-10 shadow-sm"><Empty>{t.noJobsSelected}</Empty></div>
          ) : (
            <div className="space-y-4">
              {[...byTech.entries()].map(([who, techJobs]) => (
                <section key={who} className="overflow-hidden rounded-[24px] border border-slate-200/80 bg-white shadow-sm">
                  <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50/70 px-4 py-3">
                    <span className="grid size-8 place-items-center rounded-xl bg-white text-brand-800 shadow-sm ring-1 ring-slate-200"><UserRound className="size-4" /></span>
                    <h3 className="text-sm font-black text-slate-800">{who === NO_TECH ? t.noTechParen : technicianName(who)}</h3>
                    {who !== NO_TECH && technicianName(who) !== who && <span className="text-[10px] text-slate-400">({who})</span>}
                    <span className={`ml-auto rounded-lg px-2 py-1 text-[10px] font-black ${techJobs.length >= 4 ? "bg-brand-orange-100 text-brand-orange-700" : "bg-slate-200 text-slate-600"}`}>
                      {techJobs.length} {t.jobsWord}
                    </span>
                  </div>

                  <div className="divide-y divide-slate-100">
                    {techJobs.map((job) => (
                      <article
                        key={`${job.workflow}:${job.code}`}
                        className={`grid gap-3 border-l-[3px] p-4 transition hover:bg-slate-50/70 md:grid-cols-[minmax(0,1fr)_auto] md:items-center ${job.workflow === "install" ? "border-l-brand-600" : "border-l-brand-orange-500"}`}
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Link href={job.workflow === "install" ? `/installations/${job.code}` : `/service/${job.code}`} className="text-base font-black text-slate-900 hover:text-brand-800">
                              {job.code}
                            </Link>
                            <span className={`rounded-lg px-2 py-0.5 text-[10px] font-black ${job.workflow === "install" ? "bg-brand-50 text-brand-800" : "bg-brand-orange-100 text-brand-900"}`}>
                              {job.workflow === "install" ? t.installWord : t.repairWord}
                            </span>
                            <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{job.stage_label}</span>
                          </div>
                          <div className="mt-2 grid min-w-0 gap-x-5 gap-y-2 lg:grid-cols-[minmax(220px,1fr)_minmax(180px,0.8fr)]">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-bold text-slate-800" title={job.item ?? undefined}>{job.item ?? "-"}</p>
                              <p className="mt-0.5 truncate text-xs text-slate-500" title={job.customer ?? undefined}>{job.customer ?? "-"}</p>
                            </div>
                            <div className="min-w-0">
                              {job.location && <p className="truncate text-xs font-medium text-slate-600" title={job.location}><MapPin className="mr-1 inline size-3.5 text-brand-600" />{job.location}</p>}
                              {job.remark && <p className="mt-0.5 truncate text-[11px] text-slate-400" title={job.remark}>{job.remark}</p>}
                            </div>
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-wrap gap-2 border-t border-slate-100 pt-3 md:border-l md:border-t-0 md:pl-4 md:pt-0">
                          <Link href={job.workflow === "install" ? `/installations/${job.code}` : `/service/${job.code}`} className="inline-flex items-center gap-1 rounded-xl bg-[#003260] px-3 py-2 text-[11px] font-bold text-white hover:bg-slate-700">
                            <ExternalLink className="size-3.5" /> {t.viewJob}
                          </Link>
                          {job.tel && <a href={`tel:${job.tel}`} className="inline-flex items-center gap-1 rounded-xl bg-brand-50 px-3 py-2 text-[11px] font-bold text-brand-800"><Phone className="size-3.5" /> {job.tel}</a>}
                          {job.lat != null && job.lng != null && (
                            <a href={`https://www.google.com/maps/dir/?api=1&destination=${job.lat},${job.lng}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-xl bg-brand-50 px-3 py-2 text-[11px] font-bold text-brand-700">
                              <Navigation className="size-3.5" /> {t.navigate}
                            </a>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
