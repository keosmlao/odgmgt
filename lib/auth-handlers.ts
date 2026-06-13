import { one, query } from "./db";
import {
  buildUserPayload,
  checkPasswordHash,
  generatePasswordHash,
} from "./auth";
import { issueLoginResponse } from "./route-auth";
import { errorMessage } from "./api-response";
import type { AuthUserRow, LoginResult } from "./types";

/**
 * Shared login logic for /api/auth/login.
 * Returns a plain object { success, user?, token?, message? } instead of
 * calling Express res.json directly.
 *
 * Note: schema migrations run at server boot (see instrumentation.ts), so this
 * no longer calls ensureAuthTable() per request.
 */
export async function authLogin(
  username: string,
  password: string,
): Promise<LoginResult> {
  try {
    if (!username || !password) {
      return { success: false, message: "username and password required" };
    }

    // Check odg_user_auth first
    const row = await one<AuthUserRow>(
      `
        SELECT id, username, password_hash, full_name, role, bu_code, channel_codes, is_active
        FROM public.odg_user_auth
        WHERE username = %s
      `,
      [username],
    );

    if (row && row.is_active) {
      if (!checkPasswordHash(row.password_hash, password)) {
        return { success: false, message: "invalid credentials" };
      }
      const user = buildUserPayload(row, "sale");
      if (!user) return { success: false, message: "invalid credentials" };
      return issueLoginResponse(user);
    }

    // Fall back to legacy odg_user table
    const legacy = await one<AuthUserRow>(
      `
        SELECT *
        FROM public.odg_user
        WHERE username = %s AND password = %s
      `,
      [username, password],
    );

    if (legacy) {
      const user = buildUserPayload(legacy, "sale");
      if (!user) return { success: false, message: "invalid credentials" };

      // Auto-migrate legacy user to odg_user_auth
      try {
        const exists = await one(
          "SELECT 1 FROM public.odg_user_auth WHERE username = %s",
          [username],
        );
        if (!exists) {
          await query(
            `
              INSERT INTO public.odg_user_auth
              (username, password_hash, full_name, role, bu_code, channel_codes, is_active)
              VALUES (%s, %s, %s, %s, %s, %s, %s)
            `,
            [
              user.username,
              generatePasswordHash(password),
              user.full_name,
              user.role,
              user.bu_code,
              user.channel_codes,
              true,
            ],
          );
        }
      } catch (error) {
        console.error("legacy auth sync error:", error);
      }

      return issueLoginResponse(user);
    }

    return { success: false, message: "invalid credentials" };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}
