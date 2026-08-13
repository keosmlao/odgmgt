"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarCheck2,
  CalendarClock,
  CalendarDays,
  CalendarX2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileSpreadsheet,
  LayoutList,
  MapPin,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Search,
  TableProperties,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import api from "@/service/api";
import { useLanguage } from "@/context/LanguageContext";
import { exportToExcel } from "@/lib/excel-export";
import { addDays, getLaoToday } from "@/lib/lao-date";

type Meeting = {
  id: number;
  meeting_date: string;
  start_time: string | null;
  end_time: string | null;
  title: string;
  attendees: string | null;
  room: string | null;
  status: "confirmed" | "postponed" | "cancelled";
  note: string | null;
  department_codes: string[];
  employee_codes: string[];
  department_names: string[];
  employee_names: string[];
  is_updated: boolean;
};

type Department = { code: string; name: string; people: number };
type Employee = {
  code: string;
  name: string;
  full_name: string | null;
  department_code: string | null;
  department_name: string | null;
};

type Payload = {
  from: string;
  to: string;
  meetings: Meeting[];
  rooms: string[];
  departments: Department[];
  employees: Employee[];
  can_edit: boolean;
};

/** Blank meeting the form starts from; `id` is null until it is saved. */
type Draft = {
  id: number | null;
  meeting_date: string;
  start_time: string;
  end_time: string;
  title: string;
  attendees: string;
  room: string;
  status: Meeting["status"];
  note: string;
  department_codes: string[];
  employee_codes: string[];
};

/**
 * Monday-first day keys. The colour of each day is what makes the printed
 * board readable at a glance — it is the one thing everyone recognises from
 * the spreadsheet this page replaces.
 */
const DAYS = [
  { key: "mtg.dayMon", bg: "#c9a227" },
  { key: "mtg.dayTue", bg: "#b8607f" },
  { key: "mtg.dayWed", bg: "#3f8f6b" },
  { key: "mtg.dayThu", bg: "#c07f3a" },
  { key: "mtg.dayFri", bg: "#2b70b5" },
  { key: "mtg.daySat", bg: "#6f66b8" },
  { key: "mtg.daySun", bg: "#6b7f94" },
];

/** Spare lines kept under every day, as on the paper sheet. */
const BLANK_ROWS_PER_DAY = 1;

const STATUS_PILL: Record<Meeting["status"], { label: string; tone: string }> = {
  confirmed: { label: "mtg.statusConfirmed", tone: "pill-pos" },
  postponed: { label: "mtg.statusPostponed", tone: "pill-warn" },
  cancelled: { label: "mtg.statusCancelled", tone: "pill-neg" },
};

/** Monday of the week the given YYYY-MM-DD falls in. */
function weekStart(ymd: string) {
  const [year, month, day] = ymd.split("-").map(Number);
  const weekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  return addDays(ymd, -weekday);
}

const dayMonth = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
const fullDate = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;

const timeRange = (meeting: { start_time: string | null; end_time: string | null }) => {
  if (!meeting.start_time) return "";
  return meeting.end_time ? `${meeting.start_time}-${meeting.end_time}` : meeting.start_time;
};

const emptyDraft = (date: string): Draft => ({
  id: null,
  meeting_date: date,
  start_time: "",
  end_time: "",
  title: "",
  attendees: "",
  room: "",
  status: "confirmed",
  note: "",
  department_codes: [],
  employee_codes: [],
});

const draftFromMeeting = (meeting: Meeting): Draft => ({
  id: meeting.id,
  meeting_date: meeting.meeting_date,
  start_time: meeting.start_time || "",
  end_time: meeting.end_time || "",
  title: meeting.title,
  attendees: meeting.attendees || "",
  room: meeting.room || "",
  status: meeting.status,
  note: meeting.note || "",
  department_codes: meeting.department_codes || [],
  employee_codes: meeting.employee_codes || [],
});

/** What the API sends back when a room or a person is already taken. */
type Conflict = {
  code?: "room_conflict" | "people_conflict";
  room?: string;
  people?: string[];
  extra?: number;
  title?: string;
  time?: string;
};

type ViewMode = "agenda" | "sheet";
type StatusFilter = "all" | Meeting["status"];

function conflictMessage(conflict: Conflict | undefined, t: (key: string) => string) {
  if (conflict?.code === "room_conflict") {
    return `${t("mtg.clashRoom")}: ${conflict.room} · ${conflict.time} — ${conflict.title}`;
  }
  if (conflict?.code === "people_conflict") {
    const names = (conflict.people || []).join(", ");
    const more = conflict.extra ? ` ${t("mtg.clashMore")} ${conflict.extra}` : "";
    return `${t("mtg.clashPeople")}: ${names}${more} · ${conflict.time} — ${conflict.title}`;
  }
  return "";
}

/** What goes in the attendee cell: departments, then people, then guests. */
const attendeeText = (meeting: Meeting) =>
  [...meeting.department_names, ...meeting.employee_names, meeting.attendees || ""]
    .filter(Boolean)
    .join(" + ");

export default function MeetingSchedulePage() {
  const { t } = useLanguage();
  const today = getLaoToday();
  const [from, setFrom] = useState(() => weekStart(today));
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [view, setView] = useState<ViewMode>("agenda");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/meeting-schedule", { params: { from } });
      if (res.data?.success) setData(res.data.data);
      else {
        setData(null);
        setError(res.data?.message || res.data?.error || t("app.error"));
      }
    } catch {
      setData(null);
      setError(t("app.error"));
    } finally {
      setLoading(false);
    }
  }, [from, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const canEdit = Boolean(data?.can_edit);
  const columns = canEdit ? 7 : 6;

  /** The seven day buckets of the week, each with its meetings in time order. */
  const week = useMemo(() => {
    const meetings = data?.meetings || [];
    return DAYS.map((day, index) => {
      const date = addDays(from, index);
      return { ...day, date, meetings: meetings.filter((meeting) => meeting.meeting_date === date) };
    });
  }, [data, from]);

  const total = data?.meetings.length || 0;
  const todayMeetings = data?.meetings.filter((meeting) => meeting.meeting_date === today).length || 0;
  const updatedMeetings = data?.meetings.filter((meeting) => meeting.is_updated).length || 0;
  const changedMeetings = data?.meetings.filter((meeting) => meeting.status !== "confirmed").length || 0;

  const filteredWeek = useMemo(() => {
    const term = search.trim().toLowerCase();
    return week.map((day) => ({
      ...day,
      meetings: day.meetings.filter((meeting) => {
        if (statusFilter !== "all" && meeting.status !== statusFilter) return false;
        if (!term) return true;
        return [
          meeting.title,
          attendeeText(meeting),
          meeting.room,
          meeting.note,
          timeRange(meeting),
        ].some((value) => String(value || "").toLowerCase().includes(term));
      }),
    }));
  }, [search, statusFilter, week]);

  const filteredTotal = filteredWeek.reduce((sum, day) => sum + day.meetings.length, 0);
  const defaultDraftDate = today >= from && today <= addDays(from, 6) ? today : from;

  const save = async () => {
    if (!draft) return;
    const body = { ...draft, start_time: draft.start_time || null, end_time: draft.end_time || null };
    try {
      const res = draft.id
        ? await api.put("/meeting-schedule", body)
        : await api.post("/meeting-schedule", body);
      if (!res.data?.success) {
        setError(res.data?.message || t("app.error"));
        return;
      }
      setDraft(null);
      setError("");
      // The saved meeting may have moved to another week; jump to where it is.
      const target = weekStart(draft.meeting_date);
      if (target === from) await load();
      else setFrom(target);
    } catch (err: unknown) {
      const payload = (err as { response?: { data?: Conflict & { message?: string } } })?.response?.data;
      setError(conflictMessage(payload, t) || payload?.message || t("app.error"));
    }
  };

  const remove = async (id: number) => {
    try {
      const res = await api.delete("/meeting-schedule", { params: { id } });
      if (!res.data?.success) {
        setError(res.data?.message || t("app.error"));
        return;
      }
      setDraft(null);
      await load();
    } catch {
      setError(t("app.error"));
    }
  };

  const exportExcel = () => {
    const rows = week.flatMap((day) =>
      day.meetings.map((meeting) => ({
        date: fullDate(meeting.meeting_date),
        day: t(day.key),
        time: timeRange(meeting),
        title: meeting.title,
        attendees: attendeeText(meeting),
        room: meeting.room || "",
        status: t(STATUS_PILL[meeting.status].label),
        note: meeting.note || "",
      })),
    );
    exportToExcel(`meeting-schedule-${from}`, rows, [
      { key: "date", header: t("mtg.date"), width: 14 },
      { key: "day", header: t("mtg.day"), width: 12 },
      { key: "time", header: t("mtg.time"), width: 14 },
      { key: "title", header: t("mtg.detail"), width: 42 },
      { key: "attendees", header: t("mtg.attendees"), width: 40 },
      { key: "room", header: t("mtg.room"), width: 16 },
      { key: "status", header: t("mtg.status"), width: 12 },
      { key: "note", header: t("mtg.note"), width: 26 },
    ]);
  };

  const printSheet = () => {
    setView("sheet");
    window.setTimeout(() => window.print(), 0);
  };

  return (
    <div className="min-h-screen">
      <header className="page-hd">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-[var(--r-md)] bg-[var(--brand-deep)] text-white">
            <CalendarDays size={19} />
          </span>
          <div>
            <p className="eyebrow">{t("mtg.eyebrow")}</p>
            <h1 className="page-title">{t("mtg.title")}</h1>
            <p className="page-sub">
              {dayMonth(from)}–{fullDate(addDays(from, 6))} · {total} {t("mtg.meetings")}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <button className="btn btn-icon" onClick={() => setFrom(addDays(from, -7))} title={t("mtg.prevWeek")}>
              <ChevronLeft size={14} />
            </button>
            <button className="btn" onClick={() => setFrom(weekStart(today))}>
              {t("mtg.thisWeek")}
            </button>
            <button className="btn btn-icon" onClick={() => setFrom(addDays(from, 7))} title={t("mtg.nextWeek")}>
              <ChevronRight size={14} />
            </button>
          </div>
          <button className="btn" onClick={() => void load()}>
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> {t("monthSummary.refresh")}
          </button>
          <button className="btn" onClick={exportExcel} disabled={!total}>
            <FileSpreadsheet size={13} /> Excel
          </button>
          <button className="btn" onClick={printSheet}>
            <Printer size={13} /> {t("mtg.print")}
          </button>
          {canEdit && (
            <button className="btn btn-primary" onClick={() => setDraft(emptyDraft(defaultDraftDate))}>
              <Plus size={13} /> {t("mtg.add")}
            </button>
          )}
        </div>
      </header>

      <div className="page">
        {error && (
          <div
            className="mb-3 rounded-[var(--r-md)] border px-3 py-2 text-[12px] font-medium"
            style={{ borderColor: "var(--neg)", background: "var(--neg-bg)", color: "var(--neg)" }}
          >
            {error}
          </div>
        )}
        {!canEdit && data && (
          <p className="mb-2 text-[11px]" style={{ color: "var(--muted)" }}>
            {t("mtg.readOnly")}
          </p>
        )}

        <div className="agenda-summary print:hidden">
          <div className="agenda-stat is-primary">
            <span className="agenda-stat-icon"><CalendarDays size={16} /></span>
            <div><strong>{total}</strong><span>{t("mtg.totalWeek")}</span></div>
          </div>
          <div className="agenda-stat">
            <span className="agenda-stat-icon"><CalendarCheck2 size={16} /></span>
            <div><strong>{todayMeetings}</strong><span>{t("mtg.todayMeetings")}</span></div>
          </div>
          <div className="agenda-stat">
            <span className="agenda-stat-icon"><CalendarClock size={16} /></span>
            <div><strong>{updatedMeetings}</strong><span>{t("mtg.updatedMeetings")}</span></div>
          </div>
          <div className="agenda-stat">
            <span className="agenda-stat-icon"><CalendarX2 size={16} /></span>
            <div><strong>{changedMeetings}</strong><span>{t("mtg.changedMeetings")}</span></div>
          </div>
        </div>

        <div className="agenda-toolbar print:hidden">
          <div className="tabs agenda-view-switch">
            <button className={`tab ${view === "agenda" ? "is-active" : ""}`} onClick={() => setView("agenda")}>
              <LayoutList size={13} /> {t("mtg.agendaView")}
            </button>
            <button className={`tab ${view === "sheet" ? "is-active" : ""}`} onClick={() => setView("sheet")}>
              <TableProperties size={13} /> {t("mtg.sheetView")}
            </button>
          </div>

          {view === "agenda" && (
            <div className="agenda-filters">
              <div className="agenda-search">
                <Search size={13} />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("mtg.search")} />
                {search && <button onClick={() => setSearch("")} aria-label={t("mtg.cancel")}><X size={12} /></button>}
              </div>
              <select className="select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                <option value="all">{t("mtg.statusAll")}</option>
                {(Object.keys(STATUS_PILL) as Meeting["status"][]).map((status) => (
                  <option key={status} value={status}>{t(STATUS_PILL[status].label)}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {view === "agenda" ? (
          <section className="agenda-board">
            {filteredWeek.map((day) => (
              <article className={`agenda-day ${day.date === today ? "is-today" : ""}`} key={day.date}>
                <header className="agenda-day-head">
                  <span className="agenda-day-marker" style={{ background: day.bg }} />
                  <div>
                    <h2>{t(day.key)}</h2>
                    <p>{fullDate(day.date)}{day.date === today ? ` · ${t("momentum.today")}` : ""}</p>
                  </div>
                  <span className="agenda-day-count">{day.meetings.length}</span>
                  {canEdit && (
                    <button className="agenda-add-day print:hidden" onClick={() => setDraft(emptyDraft(day.date))} title={t("mtg.add")}>
                      <Plus size={14} />
                    </button>
                  )}
                </header>

                <div className="agenda-day-body">
                  {day.meetings.length ? day.meetings.map((meeting) => (
                    <div className={`agenda-meeting is-${meeting.status}`} key={meeting.id}>
                      <div className="agenda-time">
                        <Clock3 size={13} />
                        <strong>{timeRange(meeting) || t("mtg.timePending")}</strong>
                      </div>
                      <div className="agenda-meeting-main">
                        <div className="agenda-meeting-title">
                          <h3>{meeting.title}</h3>
                          <span className={`pill ${STATUS_PILL[meeting.status].tone}`}>
                            {t(STATUS_PILL[meeting.status].label)}
                          </span>
                          {meeting.is_updated && <span className="pill pill-neg">{t("mtg.updated")}</span>}
                        </div>
                        {attendeeText(meeting) && (
                          <p><UsersRound size={12} /> <span>{attendeeText(meeting)}</span></p>
                        )}
                        {meeting.note && <p className="agenda-note">{meeting.note}</p>}
                      </div>
                      <div className="agenda-place">
                        {meeting.room && <span><MapPin size={12} /> {meeting.room}</span>}
                      </div>
                      {canEdit && (
                        <button className="agenda-edit print:hidden" onClick={() => setDraft(draftFromMeeting(meeting))} title={t("mtg.edit")}>
                          <Pencil size={14} />
                        </button>
                      )}
                    </div>
                  )) : (
                    <button
                      className="agenda-empty"
                      disabled={!canEdit}
                      onClick={canEdit ? () => setDraft(emptyDraft(day.date)) : undefined}
                    >
                      <span>{search || statusFilter !== "all" ? t("mtg.noMatches") : t("mtg.noMeetings")}</span>
                      {canEdit && !search && statusFilter === "all" && <small><Plus size={11} /> {t("mtg.add")}</small>}
                    </button>
                  )}
                </div>
              </article>
            ))}
            {(search || statusFilter !== "all") && (
              <p className="agenda-result-count">{filteredTotal} {t("mtg.results")}</p>
            )}
          </section>
        ) : (
        <section className="card agenda-sheet-view">
          <div className="sheet-wrap card-bd-flush">
            <table className="sheet">
              <caption>
                <div className="sheet-title">
                  <span className="sheet-title-icon"><CalendarDays size={15} /></span>
                  <span>
                    <small>{t("mtg.eyebrow")}</small>
                    <strong>{dayMonth(from)}–{dayMonth(addDays(from, 6))}/{from.slice(0, 4)}</strong>
                  </span>
                  <span className="sheet-title-count">{total} {t("mtg.meetings")}</span>
                </div>
              </caption>
              <thead>
                <tr>
                  <th style={{ width: 170 }}>{t("mtg.date")}</th>
                  <th style={{ width: 96 }}>{t("mtg.time")}</th>
                  <th style={{ minWidth: 220 }}>{t("mtg.detail")}</th>
                  <th style={{ minWidth: 240 }}>{t("mtg.attendees")}</th>
                  <th style={{ width: 130 }}>{t("mtg.room")}</th>
                  <th style={{ width: 120 }}>{t("mtg.status")}</th>
                  {canEdit && <th className="print:hidden" style={{ width: 48 }} />}
                </tr>
              </thead>
              <tbody>
                {week.map((day) => {
                  // Spare lines under each day, as on the paper sheet — on
                  // screen they double as the quickest way to book a meeting.
                  const rows: (Meeting | null)[] = [...day.meetings];
                  while (rows.length < day.meetings.length + BLANK_ROWS_PER_DAY) rows.push(null);

                  return (
                    <Fragment key={day.date}>
                      {rows.map((meeting, index) => (
                        <tr
                          key={meeting ? meeting.id : `blank-${day.date}-${index}`}
                          className={
                            meeting
                              ? `sheet-row ${meeting.status === "cancelled" ? "is-cancelled" : ""}`
                              : "sheet-blank"
                          }
                        >
                          {index === 0 && (
                            <td
                              className="sheet-day"
                              rowSpan={rows.length}
                              style={{ ["--day" as string]: day.bg }}
                            >
                              <span className="sheet-day-name">
                                {t(day.key)}
                                {day.date === today && <span className="sheet-today">{t("momentum.today")}</span>}
                              </span>
                              <span className="sheet-day-date">{fullDate(day.date)}</span>
                              {Boolean(day.meetings.length) && (
                                <span className="sheet-day-count">
                                  {day.meetings.length} {t("mtg.meetings")}
                                </span>
                              )}
                            </td>
                          )}

                          {meeting ? (
                            <>
                              <td className="sheet-time">{timeRange(meeting)}</td>
                              <td>
                                <span className="sheet-topic">{meeting.title}</span>
                                {meeting.note && <span className="sheet-note">{meeting.note}</span>}
                              </td>
                              <td>
                                {attendeeText(meeting) ? (
                                  <span className="sheet-people">
                                    {meeting.department_names.map((name, position) => (
                                      <Fragment key={name}>
                                        {position > 0 && " + "}
                                        <b>{name}</b>
                                      </Fragment>
                                    ))}
                                    {[...meeting.employee_names, meeting.attendees || ""]
                                      .filter(Boolean)
                                      .map((name, position) => (
                                        <Fragment key={name}>
                                          {(position > 0 || meeting.department_names.length > 0) && " + "}
                                          {name}
                                        </Fragment>
                                      ))}
                                  </span>
                                ) : (
                                  <span className="sheet-empty">—</span>
                                )}
                              </td>
                              <td>
                                {meeting.room ? (
                                  <span className="sheet-room">
                                    <MapPin size={12} /> {meeting.room}
                                  </span>
                                ) : (
                                  <span className="sheet-empty">—</span>
                                )}
                              </td>
                              <td>
                                {meeting.status === "confirmed" ? (
                                  <span className="sheet-ok">✓</span>
                                ) : (
                                  <span className={`pill ${STATUS_PILL[meeting.status].tone}`}>
                                    {t(STATUS_PILL[meeting.status].label)}
                                  </span>
                                )}
                                {meeting.is_updated && <span className="sheet-update">{t("mtg.updated")}</span>}
                              </td>
                              {canEdit && (
                                <td className="print:hidden" style={{ textAlign: "center" }}>
                                  <button
                                    className="sheet-edit"
                                    title={t("mtg.edit")}
                                    onClick={() => setDraft(draftFromMeeting(meeting))}
                                  >
                                    <Pencil size={13} />
                                  </button>
                                </td>
                              )}
                            </>
                          ) : (
                            <td colSpan={columns - 1}>
                              {canEdit && (
                                <button onClick={() => setDraft(emptyDraft(day.date))}>
                                  <Plus size={12} /> {t("mtg.add")}
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
        )}
      </div>

      {draft && (
        <MeetingForm
          draft={draft}
          rooms={data?.rooms || []}
          departments={data?.departments || []}
          employees={data?.employees || []}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSave={save}
          onDelete={remove}
          t={t}
        />
      )}
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"));
const MINUTES = Array.from({ length: 12 }, (_, step) => String(step * 5).padStart(2, "0"));

/**
 * Hour and minute pickers rather than <input type="time">: that control follows
 * the browser locale and shows AM/PM on many machines. The board is 24-hour.
 */
function TimePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [hour, minute] = value ? value.split(":") : ["", ""];
  const emit = (nextHour: string, nextMinute: string) =>
    onChange(nextHour ? `${nextHour}:${nextMinute || "00"}` : "");

  return (
    <div className="flex items-center gap-1">
      <select className="select w-full" value={hour} onChange={(event) => emit(event.target.value, minute)}>
        <option value="">--</option>
        {HOURS.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <span style={{ color: "var(--muted)" }}>:</span>
      <select
        className="select w-full"
        value={minute}
        disabled={!hour}
        onChange={(event) => emit(hour, event.target.value)}
      >
        {MINUTES.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}

function MeetingForm({
  draft,
  rooms,
  departments,
  employees,
  onChange,
  onClose,
  onSave,
  onDelete,
  t,
}: {
  draft: Draft;
  rooms: string[];
  departments: Department[];
  employees: Employee[];
  onChange: (draft: Draft) => void;
  onClose: () => void;
  onSave: () => void;
  onDelete: (id: number) => void;
  t: (key: string) => string;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [search, setSearch] = useState("");
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });

  const pickedEmployees = draft.employee_codes
    .map((code) => employees.find((employee) => employee.code === code))
    .filter(Boolean) as Employee[];

  const matches = (() => {
    const term = search.trim().toLowerCase();
    if (!term) return [];
    return employees
      .filter((employee) => !draft.employee_codes.includes(employee.code))
      .filter((employee) =>
        [employee.code, employee.name, employee.full_name, employee.department_name]
          .some((field) => String(field ?? "").toLowerCase().includes(term)),
      )
      .slice(0, 30);
  })();

  const invalid =
    !draft.title.trim() ||
    !draft.meeting_date ||
    (Boolean(draft.end_time) && !draft.start_time) ||
    (Boolean(draft.start_time) && Boolean(draft.end_time) && draft.end_time < draft.start_time);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0, 20, 38, 0.5)" }}>
      <div
        className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-y-auto rounded-[var(--r-md)]"
        style={{ background: "var(--surface)", boxShadow: "var(--sh-3)" }}
      >
        <div className="card-hd">
          <h3 className="card-title">{draft.id ? t("mtg.edit") : t("mtg.add")}</h3>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label={t("mtg.cancel")}>
            <X size={15} />
          </button>
        </div>

        <div className="card-bd grid gap-3">
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="field-label">{t("mtg.date")}</label>
              <input
                type="date"
                className="input w-full"
                value={draft.meeting_date}
                onChange={(event) => set({ meeting_date: event.target.value })}
              />
            </div>
            <div>
              <label className="field-label">{t("mtg.start")}</label>
              <TimePicker value={draft.start_time} onChange={(value) => set({ start_time: value })} />
            </div>
            <div>
              <label className="field-label">{t("mtg.end")}</label>
              <TimePicker value={draft.end_time} onChange={(value) => set({ end_time: value })} />
            </div>
          </div>

          <div>
            <label className="field-label">{t("mtg.detail")}</label>
            <input
              className="input w-full"
              value={draft.title}
              onChange={(event) => set({ title: event.target.value })}
              placeholder={t("mtg.detailHint")}
            />
          </div>

          <div>
            <label className="field-label">{t("mtg.byDepartment")}</label>
            <div
              className="max-h-40 overflow-y-auto rounded-[var(--r-sm)] border p-1.5"
              style={{ borderColor: "var(--line)" }}
            >
              {departments.map((department) => {
                const picked = draft.department_codes.includes(department.code);
                return (
                  <label
                    key={department.code}
                    className="flex cursor-pointer items-center gap-2 rounded-[var(--r-xs)] px-1.5 py-1 text-[12px] hover:bg-[var(--surface-2)]"
                  >
                    <input
                      type="checkbox"
                      checked={picked}
                      onChange={() =>
                        set({
                          department_codes: picked
                            ? draft.department_codes.filter((code) => code !== department.code)
                            : [...draft.department_codes, department.code],
                        })
                      }
                    />
                    <span style={{ color: "var(--ink)" }}>{department.name}</span>
                    <span className="ml-auto text-[11px]" style={{ color: "var(--muted)" }}>
                      {department.people}
                    </span>
                  </label>
                );
              })}
              {!departments.length && (
                <p className="px-1.5 py-2 text-[11px]" style={{ color: "var(--muted)" }}>
                  {t("label.noData")}
                </p>
              )}
            </div>
          </div>

          <div>
            <label className="field-label">{t("mtg.byEmployee")}</label>
            {Boolean(pickedEmployees.length) && (
              <div className="mb-1.5 flex flex-wrap gap-1">
                {pickedEmployees.map((employee) => (
                  <button
                    key={employee.code}
                    className="pill"
                    title={`${employee.full_name || employee.name}${employee.department_name ? ` · ${employee.department_name}` : ""}`}
                    onClick={() =>
                      set({ employee_codes: draft.employee_codes.filter((code) => code !== employee.code) })
                    }
                  >
                    {employee.name} <X size={10} className="ml-0.5 inline" />
                  </button>
                ))}
              </div>
            )}
            <input
              className="input w-full"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("mtg.employeeSearch")}
            />
            {Boolean(search.trim()) && (
              <div
                className="mt-1 max-h-40 overflow-y-auto rounded-[var(--r-sm)] border p-1.5"
                style={{ borderColor: "var(--line)" }}
              >
                {matches.map((employee) => (
                  <button
                    key={employee.code}
                    className="flex w-full items-center gap-2 rounded-[var(--r-xs)] px-1.5 py-1 text-left text-[12px] hover:bg-[var(--surface-2)]"
                    onClick={() => {
                      if (!draft.employee_codes.includes(employee.code)) {
                        set({ employee_codes: [...draft.employee_codes, employee.code] });
                      }
                      setSearch("");
                    }}
                  >
                    <span style={{ color: "var(--ink)" }}>{employee.name}</span>
                    <span className="truncate text-[11px]" style={{ color: "var(--muted)" }}>
                      {employee.full_name}
                    </span>
                    <span className="ml-auto shrink-0 text-[11px]" style={{ color: "var(--muted)" }}>
                      {employee.department_name || "—"}
                    </span>
                  </button>
                ))}
                {!matches.length && (
                  <p className="px-1.5 py-2 text-[11px]" style={{ color: "var(--muted)" }}>
                    {t("label.noData")}
                  </p>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="field-label">{t("mtg.guests")}</label>
            <input
              className="input w-full"
              value={draft.attendees}
              onChange={(event) => set({ attendees: event.target.value })}
              placeholder={t("mtg.attendeesHint")}
            />
          </div>

          <div>
            <label className="field-label">{t("mtg.room")}</label>
            <input
              className="input w-full"
              list="meeting-rooms"
              value={draft.room}
              onChange={(event) => set({ room: event.target.value })}
            />
            <datalist id="meeting-rooms">
              {rooms.map((room) => (
                <option key={room} value={room} />
              ))}
            </datalist>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="field-label">{t("mtg.status")}</label>
              <select
                className="select w-full"
                value={draft.status}
                onChange={(event) => set({ status: event.target.value as Draft["status"] })}
              >
                {(Object.keys(STATUS_PILL) as Meeting["status"][]).map((status) => (
                  <option key={status} value={status}>
                    {t(STATUS_PILL[status].label)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label">{t("mtg.note")}</label>
              <input
                className="input w-full"
                value={draft.note}
                onChange={(event) => set({ note: event.target.value })}
              />
            </div>
          </div>
        </div>

        <div className="card-bd flex items-center justify-between gap-2 pt-0">
          {draft.id ? (
            confirmDelete ? (
              <div className="flex items-center gap-1.5">
                <span className="text-[11px]" style={{ color: "var(--neg)" }}>{t("mtg.confirmDelete")}</span>
                <button
                  className="btn"
                  style={{ borderColor: "var(--neg)", color: "var(--neg)" }}
                  onClick={() => onDelete(draft.id as number)}
                >
                  {t("mtg.delete")}
                </button>
                <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
                  {t("mtg.cancel")}
                </button>
              </div>
            ) : (
              <button className="btn btn-ghost" style={{ color: "var(--neg)" }} onClick={() => setConfirmDelete(true)}>
                <Trash2 size={13} /> {t("mtg.delete")}
              </button>
            )
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button className="btn" onClick={onClose}>
              {t("mtg.cancel")}
            </button>
            <button className="btn btn-primary" onClick={onSave} disabled={invalid}>
              {t("mtg.save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
