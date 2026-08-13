/**
 * Guard for the signing key behind every web session cookie and every mobile
 * bearer token.
 *
 * The old check rejected exactly one string (`default-secret-change-me`), so
 * the shipped `.env` placeholder ("your-secret-key-change-this-in-production")
 * sailed through — and a signing key anyone can guess means anyone can mint a
 * supervisor token and read the whole fleet's data without a password. This
 * module fails the server closed instead: it refuses to sign or verify
 * anything until a real secret is configured.
 *
 * Pure + dependency-free so it can be unit-tested; used from `auth.ts`.
 */

/** HS256 keys shorter than the 256-bit digest add nothing. 32 chars ≈ that. */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Fragments that only ever appear in placeholder values. Kept specific on
 * purpose — a blanket ban on "secret" or "test" would reject perfectly good
 * random keys that happen to contain those letters.
 */
const PLACEHOLDER_MARKERS = [
  "change-this",
  "change_this",
  "changethis",
  "change-me",
  "change_me",
  "changeme",
  "your-secret",
  "your_secret",
  "yoursecret",
  "default-secret",
  "secret-key-here",
  "replace-me",
  "replace_me",
  "replace-this",
  "insert-secret",
  "todo",
  "xxxxx",
];

const HOWTO = "ສ້າງຄ່າໃໝ່ດ້ວຍ: openssl rand -base64 48";

/**
 * What's wrong with this secret, or null when it's usable.
 *
 * Returns a message rather than a boolean so the thrown error can tell the
 * operator exactly which rule failed and how to fix it — this surfaces in the
 * server log at the moment logins stop working.
 */
export function describeJwtSecretProblem(
  value: string | undefined | null
): string | null {
  const secret = (value ?? "").trim();
  if (!secret) {
    return `JWT_SECRET is required — ຍັງບໍ່ໄດ້ຕັ້ງໃນ .env. ${HOWTO}`;
  }
  const lower = secret.toLowerCase();
  const marker = PLACEHOLDER_MARKERS.find((needle) => lower.includes(needle));
  if (marker) {
    return (
      `JWT_SECRET ຍັງເປັນຄ່າຕົວຢ່າງ (ພົບຄຳວ່າ "${marker}") — ` +
      `ໃຜເດົາຄ່ານີ້ຖືກ ສາມາດປອມ token ຫົວໜ້າໄດ້. ${HOWTO}`
    );
  }
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    return (
      `JWT_SECRET ສັ້ນເກີນໄປ (${secret.length} ຕົວ, ຕ້ອງການຢ່າງໜ້ອຍ ` +
      `${MIN_JWT_SECRET_LENGTH}). ${HOWTO}`
    );
  }
  // A key made of one repeated character has almost no entropy no matter how
  // long it is ("aaaaaaaa…").
  if (new Set(secret).size < 8) {
    return `JWT_SECRET ຊ້ຳກັນເກີນໄປ ບໍ່ສຸ່ມພຽງພໍ. ${HOWTO}`;
  }
  return null;
}

/** Convenience for callers that only need a yes/no. */
export function isUsableJwtSecret(value: string | undefined | null): boolean {
  return describeJwtSecretProblem(value) === null;
}
