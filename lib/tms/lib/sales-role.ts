// Client-safe helpers to decide whether a logged-in user is a sales-department
// person (salesperson / head / manager) who should be confined to the sales
// view (a single menu + the /tracking/sales page).
//
// The reliable signal is odg_employee.department_code (carried on the session
// as emp_department_code): sales departments are the 2xx group (201–208). Role
// (manager/head/salesperson) comes from app_role, else position_code
// (11=manager, 12=head, 13=salesperson) — mirrors src/queries/notifications.js.
// Company-wide roles (top management / superuser) are never confined.
//
// Note: we intentionally do NOT key off logistic_code — most salespeople have
// one assigned, so that would wrongly let them out of the sales view.

export type SalesRole = "manager" | "head" | "salesperson" | "";

interface RoleFields {
  app_role?: string | null;
  position_code?: string | null;
  emp_department_code?: string | null;
  title?: string | null;
  logistic_code?: string | null;
}

export function getSalesRole(session: RoleFields | null | undefined): SalesRole {
  const appRole = (session?.app_role ?? "").trim().toLowerCase();
  const pos = (session?.position_code ?? "").trim();
  if (appRole === "manager" || (!appRole && pos === "11")) return "manager";
  if (appRole === "head" || (!appRole && pos === "12")) return "head";
  if (appRole === "salesperson" || appRole === "pc" || (!appRole && pos === "13")) {
    return "salesperson";
  }
  return "";
}

export function isSalesLogin(session: RoleFields | null | undefined): boolean {
  const dept = (session?.emp_department_code ?? "").trim();
  const title = (session?.title ?? "").trim().toLowerCase();
  // Sales departments are the 2xx group in odg_employee (e.g. 201–208).
  return /^2\d{2}$/.test(dept) && !["top management", "superuser"].includes(title);
}
