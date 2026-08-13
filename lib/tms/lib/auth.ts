import { cookies } from "next/headers";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { describeJwtSecretProblem } from "@/lib/tms/lib/jwt-secret";

export interface Session {
  usercode: string;
  username: string;
  logistic_code: string;
  department: string;
  title: string;
  emp_department_code: string;
  emp_department_name: string;
  position_title: string;
  app_role: string;
  position_code: string;
  // Comma-separated set of transport branch codes this user may see on the web
  // dispatch screens. Empty = fall back to logistic_code (legacy single branch).
  branch_codes: string;
}

const COOKIE_NAME = "token";
const MAX_AGE_SECONDS = 8 * 60 * 60;

/** ເຕືອນເລື່ອງກະແຈບໍ່ປອດໄພ — ຄັ້ງດຽວຕໍ່ process ບໍ່ໃຫ້ log ຖ້ວມ. */
let warnedAboutSecret = false;

function getJwtSecret(): Uint8Array {
  const value = process.env.JWT_SECRET;
  // Deliberately re-read + re-checked on every call: the env is the source of
  // truth (a test swaps it mid-run), and the check is a string scan — far
  // cheaper than the signing that follows.
  const problem = describeJwtSecretProblem(value);
  if (problem) {
    if (!warnedAboutSecret) {
      warnedAboutSecret = true;
      console.error(`[auth] ⚠️  ${problem}`);
    }
    // ບໍ່ມີກະແຈເລີຍ = ເຊັນບໍ່ໄດ້ຈິງໆ — ອັນນີ້ຕ້ອງລົ້ມ.
    if (!value || !value.trim()) {
      const error = new Error(
        "ລະບົບຍັງຕັ້ງຄ່າບໍ່ຄົບ — ກະລຸນາຕິດຕໍ່ IT"
      ) as Error & { status?: number };
      error.status = 503;
      throw error;
    }
    // ມີກະແຈແຕ່ອ່ອນ (ຄ່າຕົວຢ່າງ / ສັ້ນ): **ເຕືອນແລ້ວແລ່ນຕໍ່**.
    //
    // ເມື່ອກ່ອນອັນນີ້ໂຍນ 503 ແລ້ວລະບົບຈິງລົ່ມທັນທີທີ່ deploy — ຄົນຂັບ ແລະ
    // ຫ້ອງຈັດສົ່ງໃຊ້ບໍ່ໄດ້ທັງໝົດ ເພາະຄ່າ config ອັນດຽວ. ຄວາມສ່ຽງຂອງກະແຈອ່ອນ
    // ແມ່ນເລື່ອງທີ່ຕ້ອງແກ້ ແຕ່ບໍ່ຄຸ້ມທີ່ຈະຢຸດການຈັດສົ່ງທັງບໍລິສັດເພື່ອບັງຄັບ.
    // ຢາກໃຫ້ບລັອກແທ້ (staging/CI) ໃຫ້ຕັ້ງ JWT_SECRET_STRICT=1.
    if ((process.env.JWT_SECRET_STRICT ?? "").trim() === "1") {
      const error = new Error(
        "ລະບົບຍັງຕັ້ງຄ່າບໍ່ຄົບ — ກະລຸນາຕິດຕໍ່ IT"
      ) as Error & { status?: number };
      error.status = 503;
      throw error;
    }
  }
  return new TextEncoder().encode(value as string);
}

/**
 * ອາຍຸ token ຂອງແອັບມືຖື.
 *
 * ຄົນຂັບ/ຫົວໜ້າຢູ່ນອກສະຖານທີ່ທັງມື້ — ບັງຄັບ login ໃໝ່ທຸກ 8 ຊົ່ວໂມງເຮັດໃຫ້
 * ໜ້າຈໍຂຶ້ນ "Unauthorized" ກາງທາງ. ຕາມນະໂຍບາຍທີ່ຕົກລົງ: ບໍ່ໃຫ້ໝົດອາຍຸ.
 *
 * ⚠️ ຜົນຕາມມາ: token ທີ່ຫຼຸດອອກໄປໃຊ້ໄດ້ຕະຫຼອດ ແລະ ລະບົບຍັງບໍ່ມີບັນຊີດຳ. ຢາກ
 * ເອົາອາຍຸຄືນ ໃສ່ env `MOBILE_TOKEN_TTL` (ຮູບແບບຂອງ jose ເຊັ່ນ `30d`, `12h`)
 * ໂດຍບໍ່ຕ້ອງແກ້ code.
 */
export const MOBILE_TOKEN_TTL: string | null =
  (process.env.MOBILE_TOKEN_TTL ?? "").trim() || null;

/**
 * @param expiresIn ອາຍຸແບບ jose (`8h`, `30d`). ໃສ່ `null` = ບໍ່ມີ exp ໃນ token.
 *   ຄ່າເລີ່ມຕົ້ນ 8 ຊົ່ວໂມງ ໄວ້ໃຫ້ session ຂອງເວັບ (cookie ຢູ່ເຄື່ອງທີ່ອາດໃຊ້ຮ່ວມກັນ).
 */
export async function createToken(
  payload: JWTPayload,
  expiresIn: string | null = "8h"
): Promise<string> {
  const jwt = new SignJWT({ ...payload }).setProtectedHeader({ alg: "HS256" });
  if (expiresIn) jwt.setExpirationTime(expiresIn);
  return jwt.sign(getJwtSecret());
}

export async function verifyToken(token: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    return payload;
  } catch {
    return null;
  }
}

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  const payload = await verifyToken(token);
  if (!payload) return null;
  return {
    usercode: String(payload.usercode ?? ""),
    username: String(payload.username ?? ""),
    logistic_code: String(payload.logistic_code ?? ""),
    department: String(payload.department ?? ""),
    title: String(payload.title ?? ""),
    emp_department_code: String(payload.emp_department_code ?? ""),
    emp_department_name: String(payload.emp_department_name ?? ""),
    position_title: String(payload.position_title ?? ""),
    app_role: String(payload.app_role ?? ""),
    position_code: String(payload.position_code ?? ""),
    branch_codes: String(payload.branch_codes ?? ""),
  };
}

export async function setSessionCookie(session: Session): Promise<void> {
  const token = await createToken({ ...session });
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.SECURE_COOKIE === "true",
    sameSite: "lax",
    maxAge: MAX_AGE_SECONDS,
    path: "/",
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.SECURE_COOKIE === "true",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
}
