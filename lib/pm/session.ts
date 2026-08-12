export type SessionUser = {
  employeeId: number;
  employeeCode: string;
  fullname: string;
  role: string | null;
};

/**
 * Stands in for PRODUCTMANAGERENT's cookie session.
 *
 * This app authenticates with a bearer token held in localStorage, which a
 * Server Component cannot read, so there is no employee identity to hand the
 * copied pages. It returns a user with an empty employeeCode, which is the
 * read-only case throughout the ported code:
 *
 *   getUserGroupCount("") → 0      → no owner ("ສະເພາະກຸ່ມຂອງຂ້ອຍ") filter, all
 *                                    products are listed
 *   getIsAdmin("")        → false  → the price, min-stock and PM-settings
 *                                    editors do not render
 *
 * Every ported server action re-checks getIsAdmin() itself, so they refuse
 * regardless of what the UI shows. Access to the pages is already gated by
 * this app's own (protected) layout.
 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  return { employeeId: 0, employeeCode: "", fullname: "", role: null };
}
