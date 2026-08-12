// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
import type { Session } from "@/lib/ods/auth";

/**
 * ກຳນົດສິດ (RBAC) — ກົດເກນກາງອັນດຽວຂອງລະບົບ.
 *
 * ກູ້ມາຈາກ ods/templates/layout/layout.html (ແຖວ 69-346) ບ່ອນທີ່ເມນູແຕ່ລະກຸ່ມ
 * ຖືກຫຸ້ມດ້ວຍ {% if roles == '...' %}:
 *
 *   manager  → ບໍລິການ + ຊ່າງ + ສາງ + ກຳນົດລູກຄ້າ + ອະນຸມັດ + ການຈັດການ (ຄົບທຸກຢ່າງ)
 *   admin    → ບໍລິການ + ກຳນົດລູກຄ້າ (ບໍ່ມີ ຊ່າງ/ສາງ/ອະນຸມັດ)
 *   stock    → ສາງ ເທົ່ານັ້ນ
 *   ອື່ນໆ    → ຊ່າງ ເທົ່ານັ້ນ ({% else %} — technical, headtechnical, user)
 *
 * ໝາຍເຫດສຳຄັນ: ods ບໍ່ໄດ້ກວດສິດຢູ່ຝັ່ງ server ເລີຍ — ທຸກ route ກວດແຕ່
 * `if not session.get("name")` ຄື login ຢູ່ບໍ່ເທົ່ານັ້ນ. ພິມ URL ໂດຍກົງກໍ່ເຂົ້າໄດ້ໝົດ.
 * ບ່ອນນີ້ຈຶ່ງບັງຄັບທັງເມນູ ແລະ ຝັ່ງ server (src/app/(app)/layout.tsx).
 */

/* ── role ມາດຕະຖານ ─────────────────────────────────────────────── */

export const ROLES = ["manager", "headtechnical", "admin", "stock", "technical", "sales", "user"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  manager: "ຜູ້ຈັດການ",
  headtechnical: "ຫົວໜ້າຊ່າງ",
  admin: "ພະນັກງານບໍລິການ (CS)",
  stock: "ພະນັກງານສາງ",
  technical: "ຊ່າງ",
  sales: "ພະນັກງານຂາຍ",
  user: "ພະນັກງານທົ່ວໄປ",
};

/** ຄ່າໃນ session ອາດເປັນຫຍັງກໍ່ໄດ້ (ODS users.roles ຫຼື ພະແນກ ERP) → ດຶງລົງເປັນ Role */
export function normalizeRole(raw: string | null | undefined): Role {
  const value = (raw ?? "").trim().toLowerCase();
  return (ROLES as readonly string[]).includes(value) ? (value as Role) : "user";
}

export function roleOf(session: Session | null | undefined): Role {
  return normalizeRole(session?.role);
}

/** ໜ້າທຳອິດຫຼັງ login — ຊ່າງເຂົ້າຄິວຂອງຕົນ, ບໍ່ເຂົ້າ dashboard ລວມ. */
export function homeForRole(role: Role): string {
  /**
   * ຜູ້ຈັດການມີໜ້າແລກຂອງຕົນ (/overview) — "ມີຫຍັງຄ້າງທີ່ຕ້ອງຕັດສິນ" ເທິງ ແລະ KPI ລຸ່ມ.
   * /dashboard ເປັນໜ້າລວມຂອງ**ຄົນທີ່ລົງມືເຮັດຄິວ** ຈຶ່ງບໍ່ຕອບຄຳຖາມຂອງຜູ້ຈັດການ.
   */
  if (role === "manager") return "/overview";
  return role === "technical" ? "/installations/schedule" : "/dashboard";
}

/* ── ຕຳແໜ່ງ + ພະແນກ ຂອງ ERP → role ─────────────────────────────
 * ສູດຈິງຢູ່ທີ່ roleFromErp() / ERP_ROLE_CASE ໃນ src/lib/erp-auth.ts ບ່ອນດຽວ
 * (ຕຳແໜ່ງ 11 ຜູ້ຈັດການ · 12 ຫົວໜ້າໜວຍງານ · 13 ພະນັກງານ, ພະແນກບອກສາຍງານ)
 * ⇒ ບ່ອນນີ້ບໍ່ຄິດ role ຊ້ຳອີກ ກັນສອງບ່ອນຄິດບໍ່ຕົງກັນ.
 */

/* ── ຕາຕະລາງສິດຕາມເສັ້ນທາງ ──────────────────────────────────────── */

const M: Role = "manager";
const HT: Role = "headtechnical";
const A: Role = "admin";
const S: Role = "stock";
const T: Role = "technical";
const SL: Role = "sales";

/** ກຸ່ມ "ຊ່າງ" ຂອງ ods = ທຸກຄົນທີ່ບໍ່ແມ່ນ manager/admin/stock ({% else %}) */
export const TECH_SIDE: Role[] = [M, HT, T];
/** ກຸ່ມ "ບໍລິການ" ຂອງ ods */
export const SERVICE_SIDE: Role[] = [M, A];
/** ຜູ້ສ້າງໃບຂໍເບີກອາໄຫຼ່ສ້ອມ: ຊ່າງ + CS/ບໍລິການ. */
export const REPAIR_REQUEST_SIDE: Role[] = [
  ...new Set([...TECH_SIDE, ...SERVICE_SIDE]),
];
/** ກຸ່ມ "ສາງ" ຂອງ ods */
export const STOCK_SIDE: Role[] = [M, S];
/** ຜູ້ອະນຸມັດ — ຕົງກັບ ROLE_APPROVER ໃນ lib/chatter */
export const APPROVER_SIDE: Role[] = [M, HT];
/**
 * ຜູ້ **ຕິດຕາມ/ບໍລິຫານ** — ພາບລວມ · ຕິດຕາມງານ · ຜົນງານລູກນ້ອງ · ລາຍງານ (ອ່ານຢ່າງດຽວ).
 * ລວມ admin (CS) ນຳ ເພາະ CS ຕິດຕາມສະຖານະງານຄືກັບຢູ່ dashboard ເວັບ — ແຕ່ **ບໍ່ລວມ approvals**
 * (admin ບໍ່ມີສິດອະນຸມັດ ຕາມ role — ເບິ່ງ SERVICE_SIDE vs APPROVER_SIDE).
 */
export const MONITOR_SIDE: Role[] = [M, HT, A];
/** ກວດນັບສະຕ໋ອກເຄື່ອງສ້ອມ — ຫົວໜ້າ/ຜູ້ຈັດການ ໝາຍ "ຕ້ອງກວດ" + **ສາງ** ລົງມືນັບຈິງ */
export const STOCK_COUNT_SIDE: Role[] = [M, HT, S];
/** ເຄມ — ທຸກຝ່າຍພາຍໃນເຫັນ/ຈັດການໄດ້ (ສາງ · ຫົວໜ້າ · ບໍລິການ) */
export const CLAIM_SIDE: Role[] = [M, HT, A, S];
/** ສ້ອມບໍລຸງ (ລ້າງແອ/ລ້າງເຄື່ອງ) — CS ເປີດ/ຈັດຊ່າງ · ຊ່າງລົງມື · ຫົວໜ້າຄຸມ */
export const MAINTENANCE_SIDE: Role[] = [M, A, HT, T];
/** ພະນັກງານຂາຍ — ແຈ້ງສ້ອມ · ຕິດຕາມງານຕາມເຂດ (`/sales/*`) */
export const SALES_SIDE: Role[] = [M, SL];
/**
 * ຂະບວນການອາໄຫຼ່ — **ຊ່າງ ກັບ ສາງ ເທົ່ານັ້ນ, ບໍ່ຜ່ານ CS** (ນະໂຍບາຍຂອງຜູ້ຈັດການ):
 *
 *   ເບີກ : ຊ່າງອອກໃບຂໍເບີກ → ສາງເບີກອອກ (ຕັດສະຕັອກ ERP) → ຊ່າງກົດຮັບອາໄຫຼ່
 *   ຄືນ  : ຊ່າງຂໍຄືນອາໄຫຼ່  → ສາງຮັບເຂົ້າສາງ (ບວກສະຕັອກ ERP)
 *
 * CS ບໍ່ແຕະຂອງຈິງ ຈຶ່ງບໍ່ຄວນອອກ/ຮັບເອກະສານສາງ. ໃບເບີກຂອງງານທີ່ຍົກເລີກຂຶ້ນຢູ່
 * ແທັບ "ຍົກເລີກ — ຖ້າສົ່ງຄືນ" ຂອງ /stock/returns ຢູ່ແລ້ວ ແລະ cancelInstall/ຍົກເລີກ
 * ແຈ້ງເຕືອນສາງໃຫ້ ⇒ ຊ່າງ/ສາງ ເຮັດຄົບເສັ້ນທາງໄດ້ເອງ ໂດຍບໍ່ຕ້ອງມີ CS.
 * ປ້າຍຢູ່ໜ້າ /installations ຈຶ່ງເປັນພຽງ "ບອກໃຫ້ຮູ້" (ບໍ່ມີປຸ່ມລົງມື).
 *
 * ຖ້າຢາກໃຫ້ໃຜຄົນນຶ່ງເຮັດໄດ້ເປັນກໍລະນີ ⇒ ຜູ້ຈັດການກຳນົດສິດໃຫ້ທີ່ /manage/employees
 * (ສິດທີ່ກຳນົດເອງຊະນະສິດຕາມຕຳແໜ່ງ) — ບໍ່ແມ່ນເປີດໃຫ້ທັງ role.
 */
export const RETURN_SIDE: Role[] = [M, HT, T, S];
/** ທຸກຄົນທີ່ login ແລ້ວ */
export const EVERYONE: Role[] = [...ROLES];

type Rule = { path: string; exact?: boolean; roles: Role[] };

/**
 * ກົດເກນ — `*` ແທນ 1 ຊັ້ນຂອງເສັ້ນທາງ (ເຊັ່ນ code/docNo).
 * ບໍ່ໃສ່ exact = ກວມເອົາລູກທັງໝົດ. ຖ້າຫຼາຍກົດຕົງກັນ ເອົາອັນທີ່ລະອຽດກວ່າ.
 */
const RULES: Rule[] = [
  /* ໜ້າກາງ — ທຸກຄົນເຫັນໄດ້ */
  { path: "/forbidden", roles: EVERYONE },
  // ໜ້າແລກຂອງຜູ້ຈັດການ — ໜ້ານີ້ເອງກໍ່ redirect ຄົນອື່ນໄປ /dashboard ອີກຊັ້ນ
  { path: "/overview", roles: [M] },
  // ຊ່າງເຂົ້າຄິວຕາມສະຖານະໄດ້; ໜ້າປາຍທາງກອງ emp_code
  // ເຫຼືອແຕ່ໃບງານຂອງຜູ້ທີ່ login. Dashboard ເປີດໃຫ້ອ່ານພາບລວມໄດ້ນຳ.
  { path: "/work", roles: EVERYONE },
  // ເສັ້ນທາງເກົ່າ — ໜ້າ redirect ໄປ /work/<ສາຍງານ>/<ຂັ້ນ>
  { path: "/dashboard/status", roles: EVERYONE },
  { path: "/dashboard", roles: EVERYONE },
  { path: "/assistant", roles: EVERYONE },
  { path: "/activities", roles: EVERYONE },
  /** ສົນທະນາ — ທຸກຄົນທີ່ login ໄດ້ (ດ່ານຫ້ອງຢູ່ lib/chat.canJoin ບໍ່ແມ່ນທີ່ນີ້) */
  { path: "/chat", roles: EVERYONE },
  { path: "/notifications", roles: EVERYONE },
  { path: "/manual", roles: EVERYONE },
  // ດາວໂຫຼດແອັບຊ່າງ — ຕ້ອງເປັນ EVERYONE ໂດຍສະເພາະ **ຊ່າງ** (canAccess ເປັນ default-deny
  // ⇒ ບໍ່ມີກົດ = ຊ່າງເປີດໜ້າດາວໂຫຼດແອັບຂອງຕົນເອງບໍ່ໄດ້)
  { path: "/download", roles: EVERYONE },

  /* ບໍລິການ / ຮັບເຄື່ອງສ້ອມ — ods: ເມນູ "ບໍລິການ" (manager, admin) */
  { path: "/service", exact: true, roles: SERVICE_SIDE },
  { path: "/service/new", roles: SERVICE_SIDE },
  { path: "/service/cancel", roles: SERVICE_SIDE },
  { path: "/service/notices", roles: SERVICE_SIDE },
  { path: "/service/*/edit", roles: SERVICE_SIDE },
  // ກວດນັບສະຕ໋ອກເຄື່ອງສ້ອມ — ຫົວໜ້າ/ຜູ້ຈັດການ + ສາງ (ລົງມືນັບ). ຕ້ອງຢູ່ກ່ອນ /service/* (ຄະແນນ segment ຫຼາຍກວ່າ ⇒ ຊະນະ)
  { path: "/service/stock-count", roles: STOCK_COUNT_SIDE },
  // ໃບຮັບເຄື່ອງ (ອ່ານ/ພິມ/ຮູບ/ຜູ້ຕິດຕໍ່) — ຊ່າງຕ້ອງເປີດເບິ່ງໄດ້ ເພາະການແຈ້ງເຕືອນ
  // ຂອງ tb_product ຊີ້ມາທີ່ /service/{code} (lib/chatter recordHref)
  { path: "/service/*", roles: EVERYONE },

  /* ພະນັກງານຂາຍ — ແຈ້ງສ້ອມແທນລູກຄ້າ · ຕິດຕາມງານສ້ອມຕາມເຂດຮັບຜິດຊອບ (`/sales/*`) */
  { path: "/sales", roles: [M, SL] },

  { path: "/quotations", roles: SERVICE_SIDE },
  // ຄິວແຈ້ງລູກຄ້າ (ລໍຕັດສິນລາຄາ · ມາຮັບເຄື່ອງ · ຢືນຢັນນັດ) — ຝ່າຍບໍລິການເປັນຜູ້ຕິດຕໍ່ລູກຄ້າ
  { path: "/customer-contact", roles: SERVICE_SIDE },
  // ປິດງານ (ສ້ອມ + ຕິດຕັ້ງ) — ວຽກຫຼັງບ້ານຂອງ CS ຄືກັບ /returns ແລະ /installations/close
  { path: "/close-jobs", roles: SERVICE_SIDE },
  /**
   * ໜ້າວຽກຕາມສາຍງານ `/work/*` — ຄິວທຸກຂັ້ນ + ໜ້າອາໄຫຼ່.
   * ເປີດຄືກັບ `/dashboard/status` ເກົ່າ (EVERYONE): ໜ້າປາຍທາງກອງ emp_code ໃຫ້ຊ່າງເອງ.
   */
    /**
   * ⚠️ **ບໍ່ມີໜ້ານີ້ແລ້ວ** (ລົບ 17-07-2026 — ຊ້ຳກັບຄິວ "2. ລໍຖ້າກວດເຊັກ" ແລະ ບໍ່ມີລິ້ງໃດພາໄປ).
   * ເກັບກົດໄວ້ເພາະມັນຍັງເປັນ **ສິດ** ທີ່ຄຸມປຸ່ມ "ຈັດຊ່າງ / ຍົກເລີກການຈັດ" ຢູ່ຄິວນັ້ນ
   * (dashboard/status/… ໃຊ້ canAccess(role, "/repair/assign")) — ລຶບອອກ = ປຸ່ມຫາຍງຽບໆ.
   */
  { path: "/repair/assign", roles: SERVICE_SIDE },
  { path: "/returns", roles: SERVICE_SIDE },
  // ໃບຮັບເງິນ — ອ່ານຢ່າງດຽວ ຝ່າຍບໍລິການເຫັນໄດ້ (ຂໍ້ມູນມາຈາກ ERP)
  { path: "/receipts", roles: SERVICE_SIDE },
  { path: "/install-revenue", roles: SERVICE_SIDE },
  { path: "/revenue-summary", roles: SERVICE_SIDE },
  { path: "/tech-revenue", roles: SERVICE_SIDE },
  { path: "/customers", roles: SERVICE_SIDE },

  /* ຊ່າງ — ods: ເມນູ "ຊ່າງ" ({% else %} + manager) */
  /**
   * ວຽກຂອງຂ້ອຍ ຕາມຂັ້ນ — ຄິວທຸກຂັ້ນຂອງຊ່າງຄົນດຽວ ຢູ່ໜ້າດຽວ.
   * ຊ່າງເປີດໄດ້ (ເຫັນສະເພາະຂອງຕົນ ຜ່ານ lib/scope) ເພາະ /work/* ຊ່າງບໍ່ມີສິດ
   * ⇒ ຖ້າບໍ່ມີໜ້ານີ້ ຊ່າງບໍ່ມີບ່ອນເຫັນວຽກຕົນເອງຄົບທຸກຂັ້ນເລີຍ.
   */
  { path: "/my-jobs", roles: TECH_SIDE },
  { path: "/checking", roles: TECH_SIDE },
  { path: "/repair", roles: TECH_SIDE },
  /**
   * ສູນວຽກງານສ້ອມ — ທາງເຂົ້າຫຼັກຂອງສາຍສ້ອມ (03-08-2026): ວຽກຈັດກຸ່ມຕາມ "ຜູ້ເຮັດຕໍ່"
   * (CS · ຊ່າງ · ສາງ · ຈັດຊື້ · QC). ທຸກຝ່າຍໃນວົງຈອນສ້ອມເຫັນໜ້າດຽວກັນ — ແຕ່ລະຄົນ
   * ເຮັດວຽກກຸ່ມຂອງຕົນ (ຄິວຂັ້ນເກົ່າ /dashboard/status ຍັງເປັນມຸມມອງຜູ້ຈັດການຄືເກົ່າ).
   */
  // ໃບຂໍເບີກສ້ອມ: ຊ່າງ ແລະ CS ສ້າງໄດ້; ສາງເຂົ້າເບິ່ງເພື່ອດຳເນີນການ.
  { path: "/stock/requests", roles: [...REPAIR_REQUEST_SIDE, S] },
  // ໃບຂໍສົ່ງຄືນ: ຊ່າງ+ສາງ ຄືເກົ່າ ບວກ **CS** — saveInstallReturnRequest / cancelInstallReturnRequest
  // redirect ມາທີ່ນີ້ ແລະ CS ເປັນຄົນສ້າງໃບຂໍສົ່ງຄືນຂອງງານຕິດຕັ້ງທີ່ຍົກເລີກ (ເບິ່ງ RETURN_SIDE)
  { path: "/stock/returns", roles: RETURN_SIDE },

  /* ສາງ — ods: ເມນູ "ສາງ" (manager, stock) */
  { path: "/stock/dispatch", roles: STOCK_SIDE },
  { path: "/stock/receive-returns", roles: STOCK_SIDE },
  /**
   * ອາໄຫຼ່ຄ້າງນອກສາງ — ຍ້າຍມາຈາກແທັບຂອງ /approvals/cancellations (17-07-2026).
   * ເປີດໃຫ້ **ຫົວໜ້າຊ່າງ** ນຳ ເພາະລາວຄຸມຊ່າງທີ່ຖືອາໄຫຼ່ຢູ່ (ຢູ່ໜ້າເກົ່າລາວເຫັນຢູ່ແລ້ວ).
   */
  { path: "/stock/spare-recovery", roles: [...STOCK_SIDE, HT] },
  { path: "/stock/spare-parts", roles: STOCK_SIDE },
  { path: "/stock/products", roles: STOCK_SIDE },
  { path: "/stock/transfers", roles: STOCK_SIDE },
  { path: "/stock/transfer-to-repair", roles: STOCK_SIDE },
  { path: "/stock/balance", roles: [...STOCK_SIDE, HT] },
  // ສ້າງອາໄຫຼ່ / ຂໍສັ່ງຊື່: ods ໄວ້ໃນເມນູ "ບໍລິການ" ແຕ່ສາງເປັນຜູ້ລົງມືຕົວຈິງ
  // (ການແຈ້ງເຕືອນ ROLE_WAREHOUSE ຊີ້ມາໜ້ານີ້) ⇒ ເພີ່ມ stock ເຂົ້ານຳ
  { path: "/spare-parts/new", roles: [M, A, S] },
  { path: "/purchase-requests", roles: [M, A, S] },
  // ໃບສັ່ງຊື້ (PO) ຢູ່ ERP — ເບິ່ງໄດ້ຝ່າຍຈັດຊື້/ສາງ, ອະນຸມັດສະເພາະ APPROVER_SIDE (ກວດຢູ່ action)
  { path: "/purchase-orders", roles: [M, A, S, HT] },
  // ໃບຂໍສັ່ງຊື້ (ມີລາຄາ) — ເມື່ອກ່ອນເປີດສາທາລະນະ ⇒ ດຽວນີ້ຕ້ອງ login
  { path: "/pr-view", roles: [M, A, S, HT] },

  /* ຕິດຕັ້ງ — ods ແຍກເປັນ 2 ຝັ່ງ: ຝ່າຍບໍລິການເປີດ/ປິດງານ · ຊ່າງລົງມື */
  // ── ສ້ອມບໍລຸງ (ລ້າງແອ/ລ້າງເຄື່ອງ) — ລະບົບແຍກ. prefix ດຽວຄຸມ /maintenance/* ໝົດ ──
  { path: "/maintenance", roles: MAINTENANCE_SIDE },

  { path: "/installations", exact: true, roles: SERVICE_SIDE },
  { path: "/installations/new", roles: SERVICE_SIDE },
  { path: "/installations/assign", roles: SERVICE_SIDE },
  { path: "/installations/feedback", roles: SERVICE_SIDE },
  { path: "/installations/close", roles: SERVICE_SIDE },
  { path: "/installations/accept", roles: TECH_SIDE },
  // ຄິວງານປະຈຳວັນ — ຜູ້ຈັດງານ (CS) ແລະ ຊ່າງ (ເຫັນສະເພາະຂອງຕົນ) ເບິ່ງໄດ້ທັງສອງຝ່າຍ
  { path: "/installations/schedule", roles: [M, HT, A, T] },
  { path: "/installations/work", roles: TECH_SIDE },
  { path: "/installations/spare-requests", roles: TECH_SIDE },
  { path: "/installations/spare-pickup", roles: TECH_SIDE },
  { path: "/installations/spare-returns", roles: RETURN_SIDE },
  { path: "/installations/spare-returns/receive", roles: STOCK_SIDE },
  { path: "/installations/dispatch", roles: STOCK_SIDE },
  { path: "/installations/pending-bills", roles: SERVICE_SIDE },
  { path: "/reports/kpi", roles: [M, HT] },
  { path: "/reports/repeat-repairs", roles: [M, HT] },
  { path: "/installations/*/edit", roles: SERVICE_SIDE },
  { path: "/installations/*/print", roles: EVERYONE },
  /**
   * ໜ້າລາຍລະອຽດງານຕິດຕັ້ງ (ອ່ານຢ່າງດຽວ + chatter) — ທຸກຄົນທີ່ login ເປີດໄດ້,
   * ຄູ່ກັບ `/service/*` ຂອງຝັ່ງສ້ອມ ແລະ ດ້ວຍເຫດຜົນອັນດຽວກັນ: ການແຈ້ງເຕືອນຂອງ
   * ods_tb_install ຊີ້ມາທີ່ນີ້ (lib/chatter recordHref) ແລະ ຄົນທີ່ຖືກແຈ້ງແມ່ນ
   * **ຊ່າງ** (ຈັດງານໃຫ້) ກັບ **ສາງ** (ມີໃບຂໍເບີກ) — ສອງ role ທີ່ເຂົ້າ /installations
   * ບໍ່ໄດ້. ຢ່າຫຸບອັນນີ້ໃຫ້ແຄບລົງ ບໍ່ດັ່ງນັ້ນການແຈ້ງເຕືອນຈະຕົກໃສ່ /forbidden ອີກ.
   *
   * ວາງໄວ້ **ຫຼັງ** ກົດຊື່ຕົງຕົວທັງໝົດ (assign/accept/work/…) ຈຶ່ງບໍ່ແຍ່ງກັນ:
   * ຊື່ຕົງຕົວໄດ້ຄະແນນ 22, `*` ໄດ້ 21 ⇒ ຄຸມແຕ່ /installations/<ລະຫັດງານ> ເທົ່ານັ້ນ.
   */
  { path: "/installations/*", roles: EVERYONE },

  /* ອະນຸມັດ — ods: ເມນູ "ອະນຸມັດ" (manager ເທົ່ານັ້ນ) + headtechnical (ROLE_APPROVER) */
  { path: "/approvals", roles: APPROVER_SIDE },

  /**
   * ກວດຮັບຄຸນນະພາບ — **ໃຜກວດໄດ້ ຢູ່ໃນຖານຂໍ້ມູນ (ods_qc_role) ບໍ່ແມ່ນຢູ່ນີ້**.
   * ຜູ້ຈັດການປ່ຽນຜູ້ກວດໄດ້ທີ່ /manage/qc-checklist ⇒ ຖ້າຝັງ role ໄວ້ບ່ອນນີ້ດ້ວຍ
   * ຄົນທີ່ຖືກກຳນົດໃໝ່ຈະຖືກ proxy ກັ້ນຢູ່ໜ້າປະຕູ ທັງທີ່ຕັ້ງຄ່າຖືກແລ້ວ.
   * ດ່ານຈິງ: ໜ້າ /qc ເອີ້ນ qcWorkflows() ແລ້ວພາໄປ /forbidden ຖ້າບໍ່ຖືກກຳນົດ
   * ແລະ actions/qc.ts ກວດຊ້ຳທຸກຄັ້ງທີ່ບັນທຶກ (ບວກ "ຄົນເຮັດກວດເອງບໍ່ໄດ້").
   */
  { path: "/qc", roles: EVERYONE },
  // ຕັ້ງລາຍການກວດ + ກຳນົດຜູ້ກວດ — ຜູ້ຈັດການເທົ່ານັ້ນ
  { path: "/manage/qc-checklist", roles: [M] },

  /* ຜູ້ໃຊ້ / ກຳນົດສິດ — ຜູ້ຈັດການເທົ່ານັ້ນ (ໃຜເປັນຫຍັງໃນລະບົບ ຕັດສິນຢູ່ນີ້)
   * ໝາຍເຫດ: ເມນູ "ການຈັດການ" ເກົ່າ (/manage/*) ຖືກລົບຖິ້ມໂດຍເຈດຕະນາ — ຢ່າກູ້ຄືນ.
   * ເຫຼືອແຕ່ໜ້ານີ້ໜ້າດຽວໃນເສັ້ນທາງ /manage */
  { path: "/manage/employees", roles: [M] },
  // ຄ່າບໍລິການ/ຄ່າຄອມ = ເລື່ອງເງິນ ⇒ ຜູ້ຈັດການເທົ່ານັ້ນ (actions/service-rate ກວດຊ້ຳ)
  { path: "/manage/service-rates", roles: [M] },
  // ຈັບຄູ່ ປະເພດເຄື່ອງ → ຄ່າບໍລິການທີ່ບິນຕື່ມໃຫ້ເອງ — ເລື່ອງເງິນ ⇒ ຜູ້ຈັດການເທົ່ານັ້ນ
  { path: "/manage/service-charges", roles: [M] },
  // ເປົ້າລາຍຮັບ = ຄ່າຕັ້ງຂອງລາຍງານ (ບໍ່ແມ່ນເງິນຈ່າຍ) ⇒ ເປີດໃຫ້ admin ນຳ ຄືສິດເບິ່ງລາຍງານ
  { path: "/manage/revenue-targets", roles: [M, A] },
  // ເຊື່ອມຕົວຕົນຊ່າງ — ຕັດສິນວ່າຄ່າຄອມເຂົ້າບັນຊີໃຜ ⇒ ຜູ້ຈັດການເທົ່ານັ້ນ
  { path: "/manage/technicians", roles: [M] },
  // ສະວິດເປີດ/ປິດຄວາມສາມາດຂອງທັງລະບົບ (ບາງອັນຢຸດນາລິກາ KPI) ⇒ ຜູ້ຈັດການເທົ່ານັ້ນ
  { path: "/manage/settings", roles: [M] },
  { path: "/manage/install-serials", roles: [M] },
  { path: "/manage/login-log", roles: [M] },

  /* ລາຍງານ — ods ໃຫ້ manager ຄົບ, admin ໄດ້ 2 ໜ້າ; ສາງໄດ້ສະເພາະລາຍງານສາງ/ສັ່ງຊື້ */
  { path: "/reports", roles: SERVICE_SIDE },
  { path: "/reports", exact: true, roles: [M, A, S] },
  { path: "/reports/stock", roles: [M, A, S] },
  { path: "/reports/stock-count", roles: STOCK_COUNT_SIDE },
  { path: "/reports/stock-count/missing", roles: STOCK_COUNT_SIDE },
  { path: "/claims", roles: CLAIM_SIDE },
  { path: "/manage/report-recipients", roles: APPROVER_SIDE },
  { path: "/manage/push-recipients", roles: APPROVER_SIDE },
  { path: "/manage/claim-brands", roles: APPROVER_SIDE },
  { path: "/map", roles: CLAIM_SIDE },
  { path: "/reports/install-spares-monthly", roles: [M, HT, A, S] },
  { path: "/reports/purchase-requests", roles: [M, A, S] },
  { path: "/reports/purchase-orders", roles: [M, A, S] },
  /** ເງິນຄ່າສ້ອມ — ຜູ້ຈັດການ/ແອດມິນ (CS ຮັບເງິນໜ້າຮ້ານ ໃຫ້ຜູ້ຈັດການເປີດສິດເປັນລາຍຄົນ) */
  { path: "/reports/service-debts", roles: [M, A] },
  { path: "/reports/service-revenue", roles: [M, A] },
  { path: "/reports/monthly-revenue", roles: [M, A] },
  { path: "/reports/service-by-kind", roles: [M, A] },
  // ລາຍຮັບຊ່າງ — ຊ່າງເບິ່ງ **ຂອງຕົນເອງ** ໄດ້ (ໜ້ານັ້ນກອງດ້ວຍ ownJobsOnly)
  // ຜູ້ຈັດການ/ຫົວໜ້າຊ່າງເບິ່ງໝົດ. CS/ສາງ ບໍ່ກ່ຽວ.
  { path: "/reports/technician-income", roles: [...TECH_SIDE] },
];

/** ຄະແນນຄວາມລະອຽດ — ຊັ້ນຫຼາຍ ແລະ ຊື່ຕົງຕົວ (ບໍ່ແມ່ນ `*`) ຊະນະ */
function score(rule: Rule, segments: string[]): number {
  const parts = rule.path.split("/").filter(Boolean);
  if (rule.exact && parts.length !== segments.length) return -1;
  if (parts.length > segments.length) return -1;

  let literal = 0;
  for (const [index, part] of parts.entries()) {
    if (part === "*") continue;
    if (part !== segments[index]) return -1;
    literal += 1;
  }
  return parts.length * 10 + literal + (rule.exact ? 1 : 0);
}

/** ກົດທີ່ຄຸມເສັ້ນທາງນີ້ — null ຖ້າບໍ່ມີກົດໃດຕົງ (ປະຕິເສດໄວ້ກ່ອນ) */
function ruleFor(pathname: string): Rule | null {
  const segments = pathname.split("/").filter(Boolean);
  let best: Rule | null = null;
  let bestScore = -1;
  for (const rule of RULES) {
    const value = score(rule, segments);
    if (value > bestScore) {
      best = rule;
      bestScore = value;
    }
  }
  return bestScore < 0 ? null : best;
}

/**
 * ເຂົ້າໜ້ານີ້ໄດ້ບໍ?
 * ຜູ້ຈັດການເຫັນທຸກຢ່າງສະເໝີ. ເສັ້ນທາງທີ່ບໍ່ມີໃນຕາຕະລາງ = ປະຕິເສດ (ປອດໄພໄວ້ກ່ອນ).
 */
export function canAccess(role: Role, pathname: string): boolean {
  if (role === "manager") return true;

  /**
   * "user" = ພະນັກງານທີ່ບໍ່ຢູ່ຝ່າຍບໍລິການ/ສາງ (ຂາຍ, ບັນຊີ, IT, ຂົນສົ່ງ... 149 ຄົນ)
   * ⇒ ບໍ່ມີວຽກຢູ່ລະບົບນີ້ ຈຶ່ງປິດໄວ້ກ່ອນ (default deny).
   * ຖ້າຕ້ອງໃຫ້ໃຜເຂົ້າໄດ້ ຜູ້ຈັດການໄປກຳນົດສິດໃຫ້ທີ່ /manage/employees
   * (ສິດທີ່ກຳນົດເອງຊະນະສິດຕາມຕຳແໜ່ງ).
   */
  if (role === "user") return pathname === "/forbidden";

  const rule = ruleFor(pathname);
  return rule ? rule.roles.includes(role) : false;
}
