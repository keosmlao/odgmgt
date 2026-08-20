import { isOnlineBillSql, ONLINE_CHANNEL_NAME } from "./online-channel.mjs";

export function monthName(month) {
  const names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  if (month >= 1 && month <= 12) return names[month - 1];
  return "-";
}

export function parseIntSafe(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function safeDiv(numerator, denominator) {
  const left = Number(numerator || 0);
  const right = Number(denominator || 0);
  if (!right) return 0;
  return left / right;
}

export function pad2(value) {
  return String(value).padStart(2, "0");
}

export function formatDate(value, separator = "-") {
  return [pad2(value.getDate()), pad2(value.getMonth() + 1), value.getFullYear()].join(separator);
}

export function monthRange(year, month) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  return { start, end };
}

/**
 * SQL expression that normalizes channel name aliases into one canonical name.
 * Use this everywhere instead of raw COALESCE(channel_name, argroup, ...).
 *
 * Online is decided first and from a different source: the ERP tags no sale as
 * online, so it is recognised by the selling department. See
 * lib/online-channel.mjs.
 *
 * @param {string} docNo bill-number expression, qualified when more than one
 *   table in scope has a doc_no.
 */
export const channelExpr = (docNo = "doc_no") => `
  CASE
    WHEN ${isOnlineBillSql(docNo)} THEN '${ONLINE_CHANNEL_NAME}'
    ELSE CASE COALESCE(NULLIF(channel_name, ''), argroup, argroup_main, argroupsub, 'UNKNOWN')
      WHEN 'ໂຄງການ' THEN 'ຂາຍໂຄງການ'
      ELSE COALESCE(NULLIF(channel_name, ''), argroup, argroup_main, argroupsub, 'UNKNOWN')
    END
  END`;

/** Default form, for the many callers whose query has one unambiguous doc_no. */
export const CHANNEL_EXPR = channelExpr();

export function workingDaysBetween(start, end) {
  let cursor = new Date(start);
  let count = 0;
  while (cursor <= end) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) count += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}
