const GPS_OFFSET = "+07:00";

function normalizeGpsTimestamp(value: string): string {
  return String(value ?? "").trim().replace(" ", "T");
}

export function formatGpsWallTime(value: string): string {
  const raw = String(value ?? "").trim();
  const match = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/
  );
  if (!match) return raw || "-";
  const [, y, m, d, hh, mi, ss = "00"] = match;
  return `${d}-${m}-${y} ${hh}:${mi}:${ss}`;
}

export function parseGpsTimestampMs(value: string): number {
  const raw = normalizeGpsTimestamp(value);
  if (!raw) return Number.NaN;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const ts = Date.parse(hasZone ? raw : `${raw}${GPS_OFFSET}`);
  return Number.isFinite(ts) ? ts : Number.NaN;
}

export function formatGpsTime(value: string): string {
  const raw = String(value ?? "").trim();
  const match = raw.match(/[ T](\d{2}:\d{2}(?::\d{2})?)/);
  return match?.[1] ?? raw;
}

export function formatGpsRelative(value: string, short = false): string {
  const ts = parseGpsTimestampMs(value);
  if (!Number.isFinite(ts)) return value || "";
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return short ? `${diffSec}s` : `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return short ? `${diffMin}m` : `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return short ? `${diffH}h` : `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return short ? `${diffD}d` : `${diffD}d ago`;
}
