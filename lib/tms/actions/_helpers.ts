import { getSession, type Session } from "@/lib/tms/lib/auth";
import { isSalesLogin } from "@/lib/tms/lib/sales-role";
import { resolveDispatchBranchCodes } from "@/lib/tms/queries/master-data.js";

// Refresh the multi-branch dispatch set from the DB on every request so an admin
// re-assignment takes effect WITHOUT the user re-logging in. Falls back to the
// JWT-baked value if the lookup yields nothing (or fails).
export async function withLiveBranchCodes(session: Session): Promise<Session> {
  const live = await resolveDispatchBranchCodes(session.usercode);
  return live ? { ...session, branch_codes: live } : session;
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");
  return withLiveBranchCodes(session);
}

// Dispatch management — creating / approving / editing / deleting / closing
// delivery trips — is for operations & logistics staff. Sales-department logins
// are confined to their own tracking view, so they must be rejected here too:
// the sidebar hides these screens from sales, but the server actions are
// directly callable, so the authorization has to live on the server, not just
// in the UI.
export async function requireDispatchAccess(): Promise<Session> {
  const session = await requireSession();
  if (isSalesLogin(session)) {
    throw new Error("ບໍ່ມີສິດໃນການຈັດການຖ້ຽວ");
  }
  return session;
}
