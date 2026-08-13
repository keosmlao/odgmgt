import crypto from "crypto";
import { one, rows } from "./db";
import { ALLOWED_ROLES, normalizeRole } from "./auth";
import { ensureMgmtUserTable } from "./migrations";

/**
 * Login source of truth: public.odg_employee.
 *
 * The employee table is owned by another system, so its column names are not
 * fixed here. The schema is read from information_schema once per process and
 * the relevant columns are matched from the candidate lists below.
 */
export const EMPLOYEE_SCHEMA = process.env.ODG_EMPLOYEE_SCHEMA || "public";
export const EMPLOYEE_TABLE = process.env.ODG_EMPLOYEE_TABLE || "odg_employee";

/**
 * Only code-like identifiers, never surrogate keys such as employee_id — an id
 * matching another employee's code would let the wrong row answer a login.
 */
const USERNAME_COLUMNS = [
  "username",
  "user_name",
  "login",
  "login_name",
  "user_code",
  "emp_code",
  "employee_code",
  "code",
  "email",
];
const PASSWORD_COLUMNS = [
  "password_hash",
  "password",
  "passwd",
  "pwd",
  "user_password",
];
const ID_COLUMNS = ["id", "emp_id", "employee_id", "emp_code", "employee_code", "code"];
const FULL_NAME_COLUMNS = [
  "full_name",
  "fullname",
  "fullname_lo",
  "fullname_en",
  "emp_name",
  "employee_name",
  "display_name",
  "name",
  "name_lo",
  "name_en",
  "name_1",
  "name_2",
  "nickname",
];
const ROLE_COLUMNS = [
  "app_role",
  "role",
  "user_role",
  "position",
  "job_title",
  "job_position",
  "level",
];
const BU_COLUMNS = ["bu_code", "bu", "business_unit_code", "business_unit"];
const CHANNEL_COLUMNS = [
  "channel_codes",
  "channel_code",
  "sale_channels",
  "sale_channel",
];
const ACTIVE_COLUMNS = [
  "is_active",
  "active",
  "enabled",
  "employment_status",
  "emp_status",
  "status",
];

/** Values that mark an employee as unable to sign in. */
const INACTIVE_VALUES = new Set([
  "0",
  "false",
  "f",
  "n",
  "no",
  "inactive",
  "disabled",
  "deleted",
  "resign",
  "resigned",
  "terminated",
  "quit",
  "out",
]);

/** Free-text positions mapped onto the app's own role set. */
const ROLE_ALIASES = new Map([
  ["ceo", "ceo"],
  ["chief executive officer", "ceo"],
  ["gm", "gm"],
  ["general manager", "gm"],
  ["dgm", "gm"],
  ["head", "gm"],
  ["head office", "gm"],
  ["bu manager", "sale_bu_manager"],
  ["sale bu manager", "sale_bu_manager"],
  ["sales bu manager", "sale_bu_manager"],
  ["manager", "sale_bu_manager"],
  ["sale manager", "sale_bu_manager"],
  ["sales manager", "sale_bu_manager"],
  ["supervisor", "sale_supervisor"],
  ["sale supervisor", "sale_supervisor"],
  ["sales supervisor", "sale_supervisor"],
  ["sale", "sale"],
  ["sales", "sale"],
  ["salesman", "sale"],
  ["salesperson", "sale"],
  ["pc", "sale"],
  ["sale staff", "sale"],
  ["staff", "sale"],
  ["user", "sale"],
]);

let schemaPromise = null;

function pickColumn(available, candidates) {
  for (const candidate of candidates) {
    if (available.has(candidate)) return candidate;
  }
  return null;
}

function pickColumns(available, candidates) {
  return candidates.filter((candidate) => available.has(candidate));
}

async function loadSchema() {
  const columns = await rows(
    `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = %s AND table_name = %s
    `,
    [EMPLOYEE_SCHEMA, EMPLOYEE_TABLE],
  );

  if (!columns.length) {
    throw new Error(
      `table ${EMPLOYEE_SCHEMA}.${EMPLOYEE_TABLE} not found or has no readable columns`,
    );
  }

  const available = new Map(
    columns.map((column) => [column.column_name.toLowerCase(), column.data_type]),
  );
  const names = new Set(available.keys());

  const usernameColumns = pickColumns(names, USERNAME_COLUMNS);
  const passwordColumn = pickColumn(names, PASSWORD_COLUMNS);

  if (!usernameColumns.length) {
    throw new Error(
      `no username-like column found on ${EMPLOYEE_SCHEMA}.${EMPLOYEE_TABLE}`,
    );
  }
  if (!passwordColumn) {
    throw new Error(
      `no password column found on ${EMPLOYEE_SCHEMA}.${EMPLOYEE_TABLE}`,
    );
  }

  return {
    usernameColumns,
    passwordColumn,
    idColumn: pickColumn(names, ID_COLUMNS),
    codeColumn: pickColumn(names, ["employee_code", "emp_code", "user_code", "code"]),
    fullNameColumns: pickColumns(names, FULL_NAME_COLUMNS),
    roleColumns: pickColumns(names, ROLE_COLUMNS),
    buColumn: pickColumn(names, BU_COLUMNS),
    channelColumns: pickColumns(names, CHANNEL_COLUMNS),
    activeColumn: pickColumn(names, ACTIVE_COLUMNS),
    types: available,
  };
}

/**
 * This app keeps its own access list (public.odg_mgmt_user) — an employee row
 * in odg_employee is not enough to sign in. Owner codes are always allowed so a
 * bad row can never lock everyone out.
 */
export const OWNER_CODES = new Set(
  (process.env.ODG_OWNER_CODES || "22020")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean),
);

export const MGMT_USER_TABLE = "public.odg_mgmt_user";

/** The access row for an employee, or null when not approved / disabled. */
export async function getMgmtUser(code) {
  const value = String(code ?? "").trim();
  if (!value) return null;
  await ensureMgmtUserTable();
  return one(
    `SELECT employee_code, app_role, is_active, bu_code, channel_codes
     FROM ${MGMT_USER_TABLE} WHERE employee_code = %s AND is_active`,
    [value],
  );
}

export async function isAccessApproved(code) {
  const value = String(code ?? "").trim();
  if (!value) return false;
  if (OWNER_CODES.has(value)) return true;
  return Boolean(await getMgmtUser(value));
}

/** Cached per process; a failed probe is not cached so it can be retried. */
export function getEmployeeSchema() {
  if (!schemaPromise) {
    schemaPromise = loadSchema().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

export function isActiveValue(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (!text) return true;
  return !INACTIVE_VALUES.has(text);
}

export function mapRole(value) {
  if (!value) return "sale";
  const raw = String(value).trim().toLowerCase();
  const underscored = raw.replace(/[\s-]+/g, "_");
  if (ALLOWED_ROLES.has(underscored)) return underscored;
  const alias = ROLE_ALIASES.get(raw) || ROLE_ALIASES.get(underscored.replace(/_/g, " "));
  return alias || "sale";
}

export function toChannelCodes(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  return String(value)
    .split(/[,;|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function firstValue(row, columns) {
  for (const column of columns) {
    const value = row[column];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return null;
}

function safeCompareText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function safeCompareBuffer(left, right) {
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// Werkzeug's "scrypt$<b64 salt>$<b64 hash>" form does not encode its cost
// parameters, so the combination those rows were written with is assumed.
const SCRYPT_DOLLAR = { N: 16384, r: 8, p: 1 };

/**
 * Checks a password against what odg_employee stores.
 *
 * That column is shared with the other ODIEN apps and holds several shapes at
 * once — 21 of the 255 rows are hashed and the rest are still plain text:
 *
 *   scrypt:N:r:p$salt$hex      Werkzeug scrypt (what generatePasswordHash writes)
 *   pbkdf2:sha256:iter$salt$hex
 *   scrypt$<b64 salt>$<b64 hash>
 *   <the password itself>      plain text
 *
 * All of them must verify. This previously rejected every hash as an
 * unsupported format, which locked those 21 employees out of this app
 * entirely; the same logic already lives in PRODUCTMANAGERENT's
 * src/lib/password.ts, and this is ported from it so the two apps agree on
 * what the shared column means.
 *
 * Plain text still verifies, so no one is locked out — but nothing here writes
 * plain text any more, and a stored hash is always preferred.
 */
export function verifyEmployeePassword(stored, password) {
  if (stored === undefined || stored === null || String(stored) === "") {
    return { ok: false, unsupported: false };
  }
  const value = String(stored);
  const parts = value.split("$");

  if (parts.length === 3) {
    const [method, salt, expected] = parts;
    try {
      if (method === "scrypt") {
        const expectedBuf = Buffer.from(expected, "base64");
        const { N, r, p } = SCRYPT_DOLLAR;
        const derived = crypto.scryptSync(String(password), Buffer.from(salt, "base64"), expectedBuf.length, {
          N, r, p, maxmem: 132 * N * r,
        });
        return { ok: safeCompareBuffer(derived, expectedBuf), unsupported: false };
      }

      const args = method.split(":");

      if (args[0] === "scrypt" && args.length === 4) {
        const [, N, r, p] = args.map(Number);
        const derived = crypto.scryptSync(String(password), salt, expected.length / 2, {
          N, r, p, maxmem: 132 * N * r,
        });
        return { ok: safeCompareText(derived.toString("hex"), expected), unsupported: false };
      }

      if (args[0] === "pbkdf2" && args.length === 3) {
        const derived = crypto.pbkdf2Sync(String(password), salt, Number(args[2]), expected.length / 2, args[1]);
        return { ok: safeCompareText(derived.toString("hex"), expected), unsupported: false };
      }
    } catch {
      // A malformed hash is a failed login, not a crash.
      return { ok: false, unsupported: false };
    }

    // A $-shaped value this app cannot derive (bcrypt, argon2) must never fall
    // through to the plain-text compare — that would treat the hash itself as
    // the password.
    return { ok: false, unsupported: true };
  }

  if (/^\$(2[aby]?|6|5|1)\$/.test(value) || /^argon2[$:]/i.test(value)) {
    return { ok: false, unsupported: true };
  }

  return { ok: safeCompareText(value, password), unsupported: false };
}

/** Looks an employee up by any of the detected username-like columns. */
export async function findEmployeeByUsername(username) {
  const schema = await getEmployeeSchema();
  const where = schema.usernameColumns
    .map((column) => `lower("${column}"::text) = lower(%s)`)
    .join(" OR ");

  const row = await one(
    `
      SELECT *
      FROM "${EMPLOYEE_SCHEMA}"."${EMPLOYEE_TABLE}"
      WHERE ${where}
      LIMIT 1
    `,
    schema.usernameColumns.map(() => String(username).trim()),
  );

  return { row, schema };
}

/**
 * Builds the JWT payload from the employee row. Role, BU and channel scope are
 * applied afterwards from this app's own access list (odg_mgmt_user).
 */
export function buildEmployeeUser(row, schema, fallbackUsername) {
  const username =
    firstValue(row, schema.usernameColumns) ?? String(fallbackUsername ?? "");
  const rowBu = schema.buColumn ? (row[schema.buColumn] ?? null) : null;

  return {
    id: schema.idColumn ? (row[schema.idColumn] ?? null) : null,
    username: String(username),
    full_name: firstValue(row, schema.fullNameColumns),
    role: normalizeRole(mapRole(firstValue(row, schema.roleColumns)), "sale"),
    bu_code: rowBu,
    bu_codes: rowBu ? [String(rowBu)] : [],
    channel_codes: toChannelCodes(firstValue(row, schema.channelColumns)),
  };
}

export async function countEmployees() {
  await getEmployeeSchema();
  const row = await one(
    `SELECT COUNT(*)::int AS count FROM "${EMPLOYEE_SCHEMA}"."${EMPLOYEE_TABLE}"`,
  );
  return Number(row?.count || 0);
}
