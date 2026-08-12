/**
 * The reporting year the TMS screens are pinned to. Copied from
 * tms/src/lib/fixed-year.js so the ported pages bound their month pickers
 * exactly the way they do in TMS.
 */
export const FIXED_YEAR = 2026;
export const FIXED_MONTH_MIN = `${FIXED_YEAR}-01`;
export const FIXED_MONTH_MAX = `${FIXED_YEAR}-12`;

/** Current month, clamped into the fixed year. */
export function getFixedTodayMonth(): string {
  const now = new Date();
  if (now.getFullYear() !== FIXED_YEAR) return FIXED_MONTH_MAX;
  return `${FIXED_YEAR}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export const FIXED_YEAR_START = `${FIXED_YEAR}-01-01`;
export const FIXED_YEAR_END = `${FIXED_YEAR}-12-31`;

/** Today, clamped into the fixed year — the date pickers never leave it. */
export function getFixedTodayDate(): string {
  const now = new Date();
  if (now.getFullYear() !== FIXED_YEAR) return FIXED_YEAR_END;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${FIXED_YEAR}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
