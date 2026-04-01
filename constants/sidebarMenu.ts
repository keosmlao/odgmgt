export const SIDEBAR_MENU: Record<string, { label: string; path: string }[]> = {
  ADMIN: [
    { label: "Dashboard", path: "/" },
    { label: "Target Management", path: "/target" },
    { label: "User Management", path: "/users" },
  ],

  SALE: [
    { label: "My Dashboard", path: "/" },
  ],

  SALE_MANAGER: [
    { label: "Team Dashboard", path: "/" },
  ],

  SALE_BU: [
    { label: "BU Dashboard", path: "/" },
    { label: "Target View", path: "/target-view" },
  ],

  DIRECTOR: [
    { label: "Management Dashboard", path: "/" },
  ],

  CEO: [
    { label: "Executive Dashboard", path: "/" },
  ],
};
