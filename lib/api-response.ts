import { NextResponse } from "next/server";

/**
 * Standard success envelope: `{ success: true, data }`.
 * Matches the shape data endpoints already return, so the client is unaffected.
 */
export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ success: true, data }, init);
}

/** Standard error envelope: `{ success: false, error }`. */
export function fail(error: string, status = 500): NextResponse {
  return NextResponse.json({ success: false, error }, { status });
}

/** Extract a human-readable message from an unknown caught value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
