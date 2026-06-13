import crypto from "crypto";
import jwt from "jsonwebtoken";
import type { AuthUser, AuthUserRow } from "./types";

export const ALLOWED_ROLES = new Set<string>([
  "ceo",
  "gm",
  "sale_bu_manager",
  "sale_supervisor",
  "sale",
]);

const SALT_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function normalizeRole(role: unknown, fallback = "sale"): string {
  if (!role) return fallback;
  return String(role).toLowerCase();
}

export function buildUserPayload(
  row: AuthUserRow | null,
  fallbackRole = "sale",
): AuthUser | null {
  if (!row) return null;
  return {
    id: (row.id as number | undefined) ?? null,
    username: row.username ?? null,
    full_name: row.full_name ?? row.name ?? row.fullname ?? null,
    role: normalizeRole(row.role ?? row.role_code, fallbackRole),
    bu_code: row.bu_code ?? null,
    channel_codes: row.channel_codes || [],
  };
}

export function pickFirst(
  row: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
      return row[key];
    }
  }
  return null;
}

function generateSalt(length = 16): string {
  const bytes = crypto.randomBytes(length);
  let salt = "";
  for (let i = 0; i < length; i += 1) {
    salt += SALT_CHARS[bytes[i] % SALT_CHARS.length];
  }
  return salt;
}

export function generatePasswordHash(password: string): string {
  const salt = generateSalt(16);
  const n = 32768;
  const r = 8;
  const p = 1;
  const digest = crypto
    .scryptSync(String(password), salt, 64, {
      N: n, r, p,
      maxmem: 128 * 1024 * 1024,
    })
    .toString("hex");
  return `scrypt:${n}:${r}:${p}$${salt}$${digest}`;
}

function safeCompareHex(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function checkPasswordHash(
  storedHash: string | null | undefined,
  password: string,
): boolean {
  if (!storedHash || !password) return false;
  const [methodPart, salt, digest] = String(storedHash).split("$");
  if (!methodPart || !salt || !digest) return false;

  if (methodPart.startsWith("scrypt:")) {
    const [, nRaw, rRaw, pRaw] = methodPart.split(":");
    const n = Number(nRaw || 32768);
    const r = Number(rRaw || 8);
    const p = Number(pRaw || 1);
    const derived = crypto
      .scryptSync(String(password), salt, digest.length / 2, {
        N: n, r, p,
        maxmem: 128 * 1024 * 1024,
      })
      .toString("hex");
    return safeCompareHex(digest, derived);
  }

  if (methodPart.startsWith("pbkdf2:")) {
    const [, algorithm = "sha256", iterationsRaw = "600000"] = methodPart.split(":");
    const iterations = Number(iterationsRaw);
    const derived = crypto
      .pbkdf2Sync(String(password), salt, iterations, digest.length / 2, algorithm)
      .toString("hex");
    return safeCompareHex(digest, derived);
  }

  return false;
}

export function createToken(user: AuthUser, secret: string): string {
  return jwt.sign({ user }, secret, { expiresIn: "7d" });
}

export function decodeToken(
  token: string | null | undefined,
  secret: string,
): AuthUser | null {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, secret) as { user?: AuthUser };
    return decoded?.user || null;
  } catch {
    return null;
  }
}
