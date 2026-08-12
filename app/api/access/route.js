import { NextResponse } from "next/server";
import { rows, one, query } from "@/lib/db";
import { getCurrentUser } from "@/lib/route-auth";
import { OWNER_CODES, MGMT_USER_TABLE } from "@/lib/employee-auth";
import { ensureMgmtUserTable } from "@/lib/migrations";

/**
 * Who may sign in to this management app — public.odg_mgmt_user.
 * Deliberately separate from app_employee_access (that list belongs to the
 * sales/POS app). Only owners and ceo/gm accounts may read or change it.
 */
const ADMIN_ROLES = new Set(["ceo", "gm"]);
const ALLOWED_ROLES = ["ceo", "gm", "sale_bu_manager", "sale_supervisor", "sale"];

function requireAdmin(request) {
  const user = getCurrentUser(request);
  if (!user) return { ok: false, status: 401, message: "unauthorized" };
  const code = String(user.username || "");
  const role = String(user.role || "").toLowerCase();
  if (OWNER_CODES.has(code) || ADMIN_ROLES.has(role)) return { ok: true, user };
  return { ok: false, status: 403, message: "forbidden" };
}

export async function GET(request) {
  const auth = requireAdmin(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  try {
    await ensureMgmtUserTable();
    const search = (request.nextUrl.searchParams.get("q") || "").trim();

    const [approved, candidates, buList, channelList] = await Promise.all([
      rows(`
        SELECT u.employee_code, u.app_role, u.is_active, u.bu_code, u.channel_codes, u.note,
               u.updated_at, u.updated_by,
               e.fullname_lo, e.fullname_en, e.employment_status,
               (e.employee_code IS NULL) AS missing_employee,
               (e.password IS NULL OR e.password = '') AS no_password,
               (e.password ~* '^(scrypt|pbkdf2|argon2)[$:]') AS hashed_password
        FROM ${MGMT_USER_TABLE} u
        LEFT JOIN public.odg_employee e ON e.employee_code = u.employee_code
        ORDER BY u.is_active DESC, u.employee_code
      `),
      rows(
        `
        SELECT e.employee_code, e.fullname_lo, e.fullname_en, e.employment_status
        FROM public.odg_employee e
        WHERE NOT EXISTS (SELECT 1 FROM ${MGMT_USER_TABLE} u WHERE u.employee_code = e.employee_code)
          ${search ? "AND (e.employee_code ILIKE %s OR e.fullname_lo ILIKE %s OR e.fullname_en ILIKE %s)" : ""}
        ORDER BY e.employee_code
        LIMIT 2000
        `,
        search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [],
      ),
      rows(`SELECT code, name_1 FROM public.odg_bu ORDER BY code`).catch(() => []),
      rows(`SELECT code, name_1 FROM public.ar_group WHERE code NOT IN ('9','10','104','105') ORDER BY code`).catch(() => []),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        approved,
        candidates,
        owners: [...OWNER_CODES],
        roles: ALLOWED_ROLES,
        bu: buList,
        channels: channelList,
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/** Adds a user, or updates the role / BU scope / active flag of an existing one. */
export async function POST(request) {
  const auth = requireAdmin(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  try {
    await ensureMgmtUserTable();
    const body = await request.json();
    const code = String(body.employee_code || "").trim();
    const role = String(body.app_role || "sale").trim().toLowerCase();
    const isActive = body.is_active === undefined ? true : Boolean(body.is_active);
    const buCode = body.bu_code ? String(body.bu_code).trim() : null;
    const note = body.note ? String(body.note).trim() : null;
    const channelCodes = Array.isArray(body.channel_codes)
      ? body.channel_codes.map((value) => String(value).trim()).filter(Boolean)
      : null;

    if (!code) {
      return NextResponse.json({ success: false, message: "employee_code required" }, { status: 400 });
    }
    if (!ALLOWED_ROLES.includes(role)) {
      return NextResponse.json({ success: false, message: "invalid role" }, { status: 400 });
    }
    if (OWNER_CODES.has(code) && !isActive) {
      return NextResponse.json(
        { success: false, message: "owner account cannot be disabled" },
        { status: 400 },
      );
    }

    const employee = await one(
      `SELECT employee_code FROM public.odg_employee WHERE employee_code = %s`,
      [code],
    );
    if (!employee) {
      return NextResponse.json({ success: false, message: "employee not found" }, { status: 404 });
    }

    await query(
      `
      INSERT INTO ${MGMT_USER_TABLE}
        (employee_code, app_role, is_active, bu_code, channel_codes, note, created_by, updated_by, created_at, updated_at)
      VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now(), now())
      ON CONFLICT (employee_code) DO UPDATE
        SET app_role = EXCLUDED.app_role,
            is_active = EXCLUDED.is_active,
            bu_code = EXCLUDED.bu_code,
            channel_codes = EXCLUDED.channel_codes,
            note = COALESCE(EXCLUDED.note, ${MGMT_USER_TABLE}.note),
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
      `,
      [code, role, isActive, buCode, channelCodes, note, auth.user.username, auth.user.username],
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/** Removes a user from the access list. Owners cannot be removed. */
export async function DELETE(request) {
  const auth = requireAdmin(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  try {
    await ensureMgmtUserTable();
    const code = String(request.nextUrl.searchParams.get("employee_code") || "").trim();
    if (!code) {
      return NextResponse.json({ success: false, message: "employee_code required" }, { status: 400 });
    }
    if (OWNER_CODES.has(code)) {
      return NextResponse.json(
        { success: false, message: "owner account cannot be removed" },
        { status: 400 },
      );
    }

    await query(`DELETE FROM ${MGMT_USER_TABLE} WHERE employee_code = %s`, [code]);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
