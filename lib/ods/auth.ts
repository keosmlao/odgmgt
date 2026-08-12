// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
import { pbkdf2Sync, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { jwtVerify, SignJWT } from "jose";
import { authSecretBytes } from "@/lib/ods/auth-secret";

export const SESSION_COOKIE = "ods_session";
const secret = authSecretBytes();
export type Session = { username: string; role: string };

export async function createSession(session: Session) {
  const token = await new SignJWT(session).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("12h").sign(secret);
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 43200 });
}
/** ກວດ token — ແຍກອອກມາເພື່ອໃຫ້ proxy.ts (ດ່ານກຳນົດສິດ) ໃຊ້ຮ່ວມກັນໄດ້ */
export async function verifySessionToken(token: string | undefined | null): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    return typeof payload.username === "string" && typeof payload.role === "string" ? { username: payload.username, role: payload.role } : null;
  } catch { return null; }
}
export async function getSession(): Promise<Session | null> {
  return verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
}
export async function clearSession() { (await cookies()).delete(SESSION_COOKIE); }
export function verifyWerkzeugPassword(stored: string, password: string) {
  const [method, salt, expected] = stored.split("$");
  const [algorithm, option1, option2, option3] = (method ?? "").split(":");
  if (!salt || !expected) return false;
  let actual: string;
  if (algorithm === "pbkdf2") {
    const digest = option1 || "sha256"; const rounds = Number(option2 || "260000");
    if (!Number.isSafeInteger(rounds) || rounds < 1) return false;
    actual = pbkdf2Sync(password, salt, rounds, expected.length / 2, digest).toString("hex");
  } else if (algorithm === "scrypt") {
    const N = Number(option1 || "32768"); const r = Number(option2 || "8"); const p = Number(option3 || "1");
    if (![N, r, p].every((value) => Number.isSafeInteger(value) && value > 0)) return false;
    actual = scryptSync(password, salt, expected.length / 2, { N, r, p, maxmem: 128 * N * r + 1024 }).toString("hex");
  } else return false;
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
