// Pure, DB-free helpers for the chatter system — message-type normalization,
// @mention serialization/matching, the sales-vs-admin rule, and notification
// recipient/visibility logic. Shared by the query layer (chatter.js,
// notifications.js) and unit-tested in chatter-helpers.test.ts so the tricky
// rules have one canonical, verified source.
//
// ⚠️ CommonJS (.js) ໂດຍເຈດຕະນາ — src/queries/*.js require ໄຟລ໌ນີ້ ແລະ
// require() ໂຫຼດ .ts ໄດ້ສະເພາະໃນ bundler ຂອງ Next. type ຢູ່ .d.ts ຄູ່ກັນ.
"use strict";

/**
 * @param {string | null} [type]
 * @returns {import("./chatter-helpers").ChatterMsgType}
 */
function normalizeMsgType(type) {
  if (type === "note") return "note";
  if (type === "system") return "system";
  return "comment";
}

/**
 * Array or CSV of mention codes -> trimmed CSV string (or null when empty).
 * @param {string[] | string | null} [mentions]
 * @returns {string | null}
 */
function serializeMentions(mentions) {
  const list = Array.isArray(mentions) ? mentions : String(mentions ?? "").split(",");
  const csv = list
    .map((m) => String(m).trim())
    .filter(Boolean)
    .join(",");
  return csv || null;
}

/**
 * Mirrors the SQL `(',' || mentions || ',') LIKE '%,code,%'` membership test.
 * @param {string | null | undefined} csv
 * @param {string} code
 * @returns {boolean}
 */
function mentionsInclude(csv, code) {
  const c = String(code ?? "").trim();
  if (!c || !csv) return false;
  return `,${csv},`.includes(`,${c},`);
}

const ADMIN_EXEMPT_TITLES = ["top management", "superuser"];

/**
 * A salesperson login: department 2xx and not a top-management/superuser title.
 * @param {{ emp_department_code?: string | null, title?: string | null } | null} [input]
 * @returns {boolean}
 */
function isSalesUser(input) {
  const dept = String(input?.emp_department_code ?? "").trim();
  const title = String(input?.title ?? "").trim().toLowerCase();
  return /^2\d{2}$/.test(dept) && !ADMIN_EXEMPT_TITLES.includes(title);
}

/**
 * Everyone who is not a sales login (dispatch / management) is treated as admin.
 * @param {{ emp_department_code?: string | null, title?: string | null } | null} [input]
 * @returns {boolean}
 */
function isChatterAdmin(input) {
  return !isSalesUser(input);
}

/**
 * Whether `userCode` should see a chatter message on a bill in their bell.
 * Mirrors the notifications.js SQL UNION so the rule is unit-testable.
 * @param {{ userCode: string, isAdmin: boolean, authorCode?: string | null, mentionsCsv?: string | null, isFollower?: boolean, billSaleCode?: string | null }} p
 * @returns {boolean}
 */
function shouldNotifyChatter(p) {
  const u = String(p.userCode ?? "").trim();
  if (!u) return false;
  if (String(p.authorCode ?? "").trim() === u) return false; // never notify yourself
  return (
    mentionsInclude(p.mentionsCsv, u) ||
    Boolean(p.isFollower) ||
    String(p.billSaleCode ?? "").trim() === u ||
    Boolean(p.isAdmin)
  );
}

/**
 * Parse a base64 data URL into its mime type + base64 payload (null if invalid).
 * @param {string} dataUrl
 * @returns {{ mime: string, base64: string } | null}
 */
function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(String(dataUrl ?? ""));
  if (!m || !m[2]) return null;
  return { mime: m[1], base64: m[2] };
}

/**
 * Distinct push recipients for a posted message (author always excluded).
 * @param {{ mentions?: string[] | string | null, followers?: string[], saleCode?: string | null, authorCode?: string | null }} p
 * @returns {string[]}
 */
function collectChatterRecipients(p) {
  const set = new Set();
  /** @param {string[]} arr */
  const addAll = (arr) =>
    arr
      .map((c) => String(c).trim())
      .filter(Boolean)
      .forEach((c) => set.add(c));
  addAll(Array.isArray(p.mentions) ? p.mentions : String(p.mentions ?? "").split(","));
  addAll(p.followers ?? []);
  const sale = String(p.saleCode ?? "").trim();
  if (sale) set.add(sale);
  const author = String(p.authorCode ?? "").trim();
  if (author) set.delete(author);
  return [...set];
}

module.exports = {
  normalizeMsgType,
  serializeMentions,
  mentionsInclude,
  isSalesUser,
  isChatterAdmin,
  shouldNotifyChatter,
  parseDataUrl,
  collectChatterRecipients,
};
