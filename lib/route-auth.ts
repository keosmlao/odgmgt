import type { NextRequest } from "next/server";
import { decodeToken, createToken } from "./auth";
import type { AuthUser, LoginResult } from "./types";

const secret = process.env.ODG_SECRET_KEY || "odg-secret-change";

export function getCurrentUser(request: NextRequest | Request): AuthUser | null {
  const authHeader = request.headers.get("authorization") || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return decodeToken(token, secret);
}

export function issueLoginResponse(user: AuthUser): LoginResult {
  const token = createToken(user, secret);
  return { success: true, user, token };
}
