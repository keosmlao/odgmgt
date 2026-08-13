import { NextResponse } from "next/server";
import { rows, one } from "@/lib/db";
import { getCurrentUser } from "@/lib/route-auth";
import { ensureMeetingScheduleTable } from "@/lib/migrations";
import { OWNER_CODES } from "@/lib/employee-auth";
import { auditLog, requestIp } from "@/lib/audit";
import { getLaoToday, addDays } from "@/lib/lao-date";

/**
 * Weekly meeting board (public.odg_meeting_board).
 *
 * Everyone who may sign in can read the board; only management keeps it up to
 * date, so writes are limited to owners and the roles below.
 */
const EDITOR_ROLES = new Set(["ceo", "gm", "sale_bu_manager", "sale_supervisor"]);
const STATUSES = new Set(["confirmed", "postponed", "cancelled"]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function canEdit(user) {
  if (!user) return false;
  return OWNER_CODES.has(String(user.username || "")) || EDITOR_ROLES.has(String(user.role || "").toLowerCase());
}

function requireUser(request) {
  const user = getCurrentUser(request);
  if (!user) return { ok: false, status: 401, message: "unauthorized" };
  return { ok: true, user };
}

function requireEditor(request) {
  const auth = requireUser(request);
  if (!auth.ok) return auth;
  if (!canEdit(auth.user)) return { ok: false, status: 403, message: "forbidden" };
  return auth;
}

/** Monday of the week the given day falls in. */
function weekStart(ymd) {
  const [year, month, day] = ymd.split("-").map(Number);
  const weekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  return addDays(ymd, -weekday);
}

/** Trimmed text, or null when the field was left empty. */
function text(value, max) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  return max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Shared validation for POST and PUT. Returns either the columns to write or
 * the message explaining why the meeting was rejected.
 */
function readMeeting(body) {
  const date = text(body.meeting_date);
  if (!date || !DATE_RE.test(date)) return { error: "meeting_date must be YYYY-MM-DD" };

  const start = text(body.start_time);
  const end = text(body.end_time);
  if (start && !TIME_RE.test(start)) return { error: "start_time must be HH:MM" };
  if (end && !TIME_RE.test(end)) return { error: "end_time must be HH:MM" };
  if (start && end && end < start) return { error: "end_time must not be before start_time" };
  if (end && !start) return { error: "start_time required when end_time is set" };

  const title = text(body.title, 300);
  if (!title) return { error: "title required" };

  const status = text(body.status) || "confirmed";
  if (!STATUSES.has(status)) return { error: "invalid status" };

  return {
    values: {
      meeting_date: date,
      start_time: start,
      end_time: end,
      title,
      attendees: text(body.attendees, 500),
      room: text(body.room, 120),
      status,
      note: text(body.note, 500),
      department_codes: codeList(body.department_codes),
      employee_codes: codeList(body.employee_codes),
    },
  };
}

/** De-duplicated list of codes, capped so one meeting cannot carry the org chart. */
function codeList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((code) => String(code ?? "").trim()).filter(Boolean))].slice(0, 200);
}

/**
 * Keeps only codes that exist today. A department deleted from the org chart
 * silently drops off the meeting instead of leaving an unresolvable code.
 */
async function keepKnownCodes({ department_codes, employee_codes }) {
  const [departments, employees] = await Promise.all([
    department_codes.length
      ? rows(`SELECT department_code FROM public.odg_department WHERE department_code = ANY(%s)`, [department_codes])
      : [],
    employee_codes.length
      ? rows(`SELECT employee_code FROM public.odg_employee WHERE employee_code = ANY(%s)`, [employee_codes])
      : [],
  ]);
  return {
    department_codes: departments.map((entry) => entry.department_code),
    employee_codes: employees.map((entry) => entry.employee_code),
  };
}

/**
 * Nobody and no room may be in two places at once.
 *
 * Meetings collide when they share a day and their time ranges overlap; a
 * meeting with no end time is treated as one hour long, and a meeting with no
 * start time is not checked at all because its slot is unknown. Cancelled
 * meetings release both their room and their people.
 *
 * Returns null when the meeting is free to save, otherwise a payload the page
 * turns into a message: which room, or which people, and where they are.
 */
async function findClash(values, excludeId = 0) {
  if (!values.start_time) return null;

  // Spacing varies between rooms in the master list ("ຫ້ອງ ປະຊຸມ 2" next to
  // "ຫ້ອງປະຊຸມ 1"), so spaces are ignored when matching one booking to another.
  const roomKey = (room) => String(room ?? "").toLowerCase().replace(/\s+/g, "");
  const attendees = await expandAttendees(values);

  const overlapping = await rows(
    `SELECT id, title, room,
            to_char(start_time, 'HH24:MI') AS start_time,
            to_char(end_time, 'HH24:MI')   AS end_time,
            COALESCE(employee_codes, '{}') || COALESCE((
              SELECT array_agg(e.employee_code::text)
              FROM public.odg_employee e
              WHERE e.department_code = ANY(odg_meeting_board.department_codes)
                AND e.employment_status = 'ACTIVE'
            ), '{}') AS people
     FROM public.odg_meeting_board
     WHERE meeting_date = %s::date
       AND status <> 'cancelled'
       AND id <> %s
       AND start_time IS NOT NULL
       AND (start_time, COALESCE(end_time, start_time + interval '1 hour'))
           OVERLAPS (%s::time, COALESCE(%s::time, %s::time + interval '1 hour'))`,
    [values.meeting_date, excludeId, values.start_time, values.end_time, values.start_time],
  );
  if (!overlapping.length) return null;

  const when = (meeting) => `${meeting.start_time}${meeting.end_time ? `-${meeting.end_time}` : ""}`;

  if (values.room) {
    const clash = overlapping.find((meeting) => roomKey(meeting.room) === roomKey(values.room));
    if (clash) {
      return {
        code: "room_conflict",
        message: `room ${values.room} is already booked ${when(clash)}`,
        room: clash.room,
        title: clash.title,
        time: when(clash),
      };
    }
  }

  if (attendees.length) {
    const wanted = new Set(attendees);
    for (const meeting of overlapping) {
      const busy = (meeting.people || []).filter((code) => wanted.has(code));
      if (!busy.length) continue;
      const names = await rows(
        `SELECT COALESCE(NULLIF(nickname, ''), fullname_lo) AS name
         FROM public.odg_employee WHERE employee_code = ANY(%s) ORDER BY employee_code LIMIT 5`,
        [busy],
      );
      return {
        code: "people_conflict",
        message: `${busy.length} attendee(s) are already booked ${when(meeting)}`,
        people: names.map((entry) => entry.name),
        extra: Math.max(0, busy.length - names.length),
        title: meeting.title,
        time: when(meeting),
      };
    }
  }

  return null;
}

/** Every person a meeting pulls in: the named ones plus whole departments. */
async function expandAttendees({ department_codes, employee_codes }) {
  const fromDepartments = department_codes.length
    ? await rows(
        `SELECT employee_code FROM public.odg_employee
         WHERE department_code = ANY(%s) AND employment_status = 'ACTIVE'`,
        [department_codes],
      )
    : [];
  return [...new Set([...employee_codes, ...fromDepartments.map((entry) => entry.employee_code)])];
}

/**
 * Attendee names are resolved on every read rather than stored: a department
 * renamed or a person's nickname changed shows through on the board at once.
 */
const SELECT_COLUMNS = `
  id,
  to_char(meeting_date, 'YYYY-MM-DD') AS meeting_date,
  to_char(start_time, 'HH24:MI')      AS start_time,
  to_char(end_time, 'HH24:MI')        AS end_time,
  title, attendees, room, status, note,
  COALESCE(department_codes, '{}') AS department_codes,
  COALESCE(employee_codes, '{}')   AS employee_codes,
  COALESCE((
    SELECT array_agg(d.department_name_lo ORDER BY d.department_code)
    FROM public.odg_department d
    WHERE d.department_code = ANY(odg_meeting_board.department_codes)
  ), '{}') AS department_names,
  COALESCE((
    SELECT array_agg(COALESCE(NULLIF(e.nickname, ''), e.fullname_lo) ORDER BY e.employee_code)
    FROM public.odg_employee e
    WHERE e.employee_code = ANY(odg_meeting_board.employee_codes)
  ), '{}') AS employee_names,
  created_by, created_at, updated_by, updated_at,
  (updated_at > created_at + interval '1 minute') AS is_updated
`;

/**
 * Room suggestions for the form: the shared room master first, then anything
 * else already typed on the board. The board keeps rooms as free text, so a
 * meeting held somewhere that is not a listed room still records where it was.
 */
async function loadRooms() {
  const [master, used] = await Promise.all([
    rows(
      `SELECT room_name FROM public.odg_meeting_room
       WHERE is_active AND room_name IS NOT NULL AND room_name <> ''
       ORDER BY sort_order, room_name`,
    ).catch(() => []),
    rows(
      `SELECT DISTINCT room FROM public.odg_meeting_board
       WHERE room IS NOT NULL AND room <> '' ORDER BY room LIMIT 50`,
    ),
  ]);
  return [...new Set([...master.map((entry) => entry.room_name), ...used.map((entry) => entry.room)])];
}

/** One week of meetings, plus the rooms to offer in the form. */
export async function GET(request) {
  const auth = requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  try {
    await ensureMeetingScheduleTable();

    const sp = request.nextUrl.searchParams;
    const requested = text(sp.get("from"));
    const from = weekStart(requested && DATE_RE.test(requested) ? requested : getLaoToday());
    const to = addDays(from, 6);

    const [meetings, rooms, departments, employees] = await Promise.all([
      rows(
        `SELECT ${SELECT_COLUMNS}
         FROM public.odg_meeting_board
         WHERE meeting_date BETWEEN %s::date AND %s::date
         ORDER BY meeting_date, start_time NULLS LAST, id`,
        [from, to],
      ),
      loadRooms(),
      rows(`
        SELECT d.department_code AS code, d.department_name_lo AS name,
               count(e.employee_code)::int AS people
        FROM public.odg_department d
        LEFT JOIN public.odg_employee e
          ON e.department_code = d.department_code AND e.employment_status = 'ACTIVE'
        WHERE d.is_active
        GROUP BY 1, 2
        ORDER BY d.department_code
      `).catch(() => []),
      rows(`
        SELECT e.employee_code AS code,
               COALESCE(NULLIF(e.nickname, ''), e.fullname_lo) AS name,
               e.fullname_lo AS full_name,
               e.department_code,
               d.department_name_lo AS department_name
        FROM public.odg_employee e
        LEFT JOIN public.odg_department d ON d.department_code = e.department_code
        WHERE e.employment_status = 'ACTIVE'
        ORDER BY d.department_code NULLS LAST, e.employee_code
      `).catch(() => []),
    ]);

    return NextResponse.json({
      success: true,
      data: { from, to, meetings, rooms, departments, employees, can_edit: canEdit(auth.user) },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  const auth = requireEditor(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  try {
    await ensureMeetingScheduleTable();
    const { values, error } = readMeeting(await request.json());
    if (error) return NextResponse.json({ success: false, message: error }, { status: 400 });

    const codes = await keepKnownCodes(values);
    const clash = await findClash({ ...values, ...codes });
    if (clash) return NextResponse.json({ success: false, ...clash }, { status: 409 });

    const created = await one(
      `INSERT INTO public.odg_meeting_board
         (meeting_date, start_time, end_time, title, attendees, room, status, note,
          department_codes, employee_codes, created_by, updated_by, created_at, updated_at)
       VALUES (%s::date, %s::time, %s::time, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now())
       RETURNING ${SELECT_COLUMNS}`,
      [
        values.meeting_date,
        values.start_time,
        values.end_time,
        values.title,
        values.attendees,
        values.room,
        values.status,
        values.note,
        codes.department_codes,
        codes.employee_codes,
        auth.user.username,
        auth.user.username,
      ],
    );

    auditLog(
      auth.user.username,
      "meeting_create",
      `${values.meeting_date} ${values.start_time || ""} ${values.title}`,
      requestIp(request),
    );
    return NextResponse.json({ success: true, data: created });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function PUT(request) {
  const auth = requireEditor(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  try {
    await ensureMeetingScheduleTable();
    const body = await request.json();
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ success: false, message: "id required" }, { status: 400 });
    }

    const { values, error } = readMeeting(body);
    if (error) return NextResponse.json({ success: false, message: error }, { status: 400 });

    const codes = await keepKnownCodes(values);
    const clash = await findClash({ ...values, ...codes }, id);
    if (clash) return NextResponse.json({ success: false, ...clash }, { status: 409 });

    const updated = await one(
      `UPDATE public.odg_meeting_board
       SET meeting_date     = %s::date,
           start_time       = %s::time,
           end_time         = %s::time,
           title            = %s,
           attendees        = %s,
           room             = %s,
           status           = %s,
           note             = %s,
           department_codes = %s,
           employee_codes   = %s,
           updated_by       = %s,
           updated_at       = now()
       WHERE id = %s
       RETURNING ${SELECT_COLUMNS}`,
      [
        values.meeting_date,
        values.start_time,
        values.end_time,
        values.title,
        values.attendees,
        values.room,
        values.status,
        values.note,
        codes.department_codes,
        codes.employee_codes,
        auth.user.username,
        id,
      ],
    );
    if (!updated) {
      return NextResponse.json({ success: false, message: "meeting not found" }, { status: 404 });
    }

    auditLog(
      auth.user.username,
      "meeting_update",
      `#${id} ${values.meeting_date} ${values.title}`,
      requestIp(request),
    );
    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  const auth = requireEditor(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  try {
    await ensureMeetingScheduleTable();
    const id = Number(request.nextUrl.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ success: false, message: "id required" }, { status: 400 });
    }

    const removed = await one(
      `DELETE FROM public.odg_meeting_board WHERE id = %s
       RETURNING id, to_char(meeting_date, 'YYYY-MM-DD') AS meeting_date, title`,
      [id],
    );
    if (!removed) {
      return NextResponse.json({ success: false, message: "meeting not found" }, { status: 404 });
    }

    auditLog(
      auth.user.username,
      "meeting_delete",
      `#${id} ${removed.meeting_date} ${removed.title}`,
      requestIp(request),
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
