import type { Session } from "@/lib/ods/auth";

/**
 * The ODSS pages copied here gate on an ODSS login (role, own-jobs-only). This
 * app has no ODSS session, and it is a management view, so it reads everything:
 * a stand-in "manager" session, and no technician filter.
 *
 * Using it also avoids ODSS's AUTH_SECRET requirement, which would otherwise
 * make every one of these pages fail to render.
 */
export const ALL_ACCESS_SESSION = {
  sub: "odgmgt",
  name: "ODGMGT",
  role: "manager",
} as unknown as Session;

/** Never scope to one technician — managers see the whole centre. */
export const NO_TECH_FILTER: string | null = null;
