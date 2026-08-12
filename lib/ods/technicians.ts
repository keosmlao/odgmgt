// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
import { query, queryOdg } from "@/lib/ods/db";
import { ERP_IDENTITY_SQL, ERP_ROLE_CASE } from "@/lib/ods/erp-auth";
import { unstable_cache } from "next/cache";

/**
 * **ລາຍຊື່ຊ່າງ — ບ່ອນດຽວຂອງທັງລະບົບ.**
 *
 * ── ບັນຫາເກົ່າ ──
 * ທຸກໜ້າທີ່ຕ້ອງເລືອກຊ່າງຂຽນ `select code,username from users where roles='technical'`
 * ⇒ ດຶງຈາກ **ຕາຕະລາງຜູ້ໃຊ້ເກົ່າຂອງ ODS** ເຊິ່ງ:
 *   · ບໍ່ມີພະນັກງານໃໝ່ທີ່ຍັງບໍ່ເຄີຍມີແຖວ users (ຄົນເຂົ້າໃໝ່ ຈັດງານໃຫ້ບໍ່ໄດ້)
 *   · ບໍ່ຮູ້ຈັກ **ສິດທີ່ຜູ້ຈັດການກຳນົດເອງ** ຢູ່ /manage/employees (ods_employee_role)
 *     ⇒ ຕັ້ງໃຫ້ຄົນນຶ່ງເປັນ "ຊ່າງ" ແລ້ວ ແຕ່ຊື່ບໍ່ຂຶ້ນມາໃນລາຍການເລືອກ
 *   · ບໍ່ຮູ້ຈັກຄົນທີ່ຖືກ **ປິດບັນຊີ** ⇒ ຍັງຈັດງານໃຫ້ຄົນທີ່ອອກໄປແລ້ວໄດ້
 *
 * ── ດຽວນີ້ ──
 * ຕັ້ງຕົ້ນຈາກ **odg_employee (ACTIVE)** ແລ້ວຄິດ role ສຸດທ້າຍຕາມລຳດັບດຽວກັບຕອນ login
 * (lib/employee-role):
 *   ① ods_employee_role.app_role  ← ຜູ້ຈັດການກຳນົດເອງ ຢູ່ໜ້າກຳນົດສິດ (ສູງສຸດ)
 *   ② users.roles                 ← ຜູ້ໃຊ້ເກົ່າ ODS
 *   ③ ຕຳແໜ່ງ+ພະແນກ ຂອງ ERP        ← ERP_ROLE_CASE
 * ໃຜກາຍເປັນ technical / headtechnical = ຊ່າງ. active = false ⇒ ຕັດອອກ.
 *
 * ⚠️ **ຄ່າ `code` ຕ້ອງຕົງກັບ session.username ຂອງຄົນນັ້ນ** ບໍ່ດັ່ງນັ້ນຈັດງານໃຫ້ແລ້ວ
 * ລາວເປີດແອັບບໍ່ເຫັນ. ຄົນທີ່ **ເຊື່ອມຕົວຕົນແລ້ວ** (ods_user_employee) ໃຊ້ລະຫັດ ERP ·
 * ຄົນທີ່ຍັງບໍ່ເຊື່ອມ ໃຊ້ຊື່ຫຼິ້ນຄືເກົ່າ — ກົດເກນດຽວກັບ lib/credentials ເປັນະ.
 */
export type Technician = {
  /** ຄ່າທີ່ຈະຖືກຂຽນລົງ tech_code / emp_code — ຕົງກັບ session.username */
  code: string;
  /** ຊື່ທີ່ສະແດງ */
  name: string;
  employee_code: string;
  head: boolean;
  /** ສູນບໍລິການຂອງຊ່າງ (ods_tech_center) — ຫວ່າງ = ຍັງບໍ່ໄດ້ຕັ້ງ ⇒ ບໍ່ໂອນອັດຕະໂນມັດ */
  center?: string | null;
};

type ErpRow = {
  employee_code: string;
  identity: string;
  fullname_lo: string;
  role: string;
};

/**
 * ພະແນກ **ຕິດຕັ້ງໂຄງການ (ຊ່າງໂຄງການ)** — ບໍ່ແມ່ນສູນບໍລິການ ⇒ ຕັດອອກຈາກ dropdown ຈັດຊ່າງ
 * (ຄືກັບໜ້າຈັດການພະນັກງານ). ຊ່າງໂຄງການບໍ່ຮັບງານສ້ອມ/ຕິດຕັ້ງ/ບຳລຸງຂອງສູນບໍລິການ.
 */
const PROJECT_DEPT = "403";

export async function listTechnicians(): Promise<Technician[]> {
  return cachedTechnicians();
}

/**
 * cache ລາຍຊື່ຊ່າງ 60 ວິນາທີ — ປ່ຽນບໍ່ຖີ່ (ເພີ່ມ/ປິດຊ່າງ ນານໆເທື່ອ) ແຕ່ຖືກອ່ານຈາກ
 * ~15 ໜ້າ ແລະ ທຸກໜ້າຈ່າຍ 5 query (1 ໃນນັ້ນຂ້າມໄປ ERP). ກົດເກນດຽວກັບ nav-counts:
 * ບໍ່ຂຶ້ນກັບຜູ້ໃຊ້ ⇒ cache ຮ່ວມທັງລະບົບໄດ້. ຊ່າງໃໝ່ອາດຊັກ 60 ວິ ກ່ອນຂຶ້ນ dropdown
 * — ຍອมຮັບໄດ້ ແລກກັບໜ້າລາຍການທຸກໜ້າໄວຂຶ້ນ.
 */
const cachedTechnicians = unstable_cache(
  loadTechnicians,
  ["technicians"],
  { revalidate: 60 },
);

async function loadTechnicians(): Promise<Technician[]> {
  const [erp, overrides, legacy, links] = await Promise.all([
    queryOdg<ErpRow>(
      `select e.employee_code, ${ERP_IDENTITY_SQL} as identity, e.fullname_lo, ${ERP_ROLE_CASE} as role
         from odg_employee e
        where e.employment_status = 'ACTIVE'
          and coalesce(e.department_code,'') <> '${PROJECT_DEPT}'
        order by e.fullname_lo`,
    ),
    query<{ employee_code: string; app_role: string; active: boolean }>(
      "select employee_code, coalesce(app_role,'') app_role, active from ods_employee_role",
    ),
    query<{ username: string; roles: string }>("select username, roles from users"),
    query<{ user_code: string; employee_code: string }>("select user_code, employee_code from ods_user_employee"),
  ]);

  const override = new Map(overrides.rows.map((row) => [row.employee_code, row]));
  const odsRole = new Map(legacy.rows.map((row) => [row.username.toLowerCase(), row.roles]));
  const linked = new Map(links.rows.map((row) => [row.employee_code, row.employee_code]));

  const rows: Technician[] = [];
  for (const employee of erp.rows) {
    const own = override.get(employee.employee_code);
    if (own && !own.active) continue; // ປິດບັນຊີແລ້ວ ⇒ ຈັດງານໃຫ້ບໍ່ໄດ້

    const role =
      own?.app_role ||
      odsRole.get(employee.employee_code.toLowerCase()) ||
      odsRole.get((employee.identity ?? "").toLowerCase()) ||
      employee.role;

    if (role !== "technical" && role !== "headtechnical") continue;

    const identity = employee.identity || employee.fullname_lo || employee.employee_code;
    rows.push({
      // ເຊື່ອມຕົວຕົນແລ້ວ ⇒ ລະຫັດ ERP · ຍັງບໍ່ເຊື່ອມ ⇒ ຊື່ຫຼິ້ນ (ຄືກັບຕອນ login)
      code: linked.has(employee.employee_code) ? employee.employee_code : identity,
      name: employee.fullname_lo || identity,
      employee_code: employee.employee_code,
      head: role === "headtechnical",
    });
  }

  /**
   * ສູນຂອງແຕ່ລະຊ່າງ (ods_tech_center) — ຄີຄື `code` ດຽວກັບທີ່ຢູ່ໃນງານ.
   * ອ່ານບໍ່ໄດ້ ⇒ ປະຫວ່າງ (ບໍ່ໂອນອັດຕະໂນມັດ) ບໍ່ໃຫ້ລາຍຊື່ຊ່າງພັງຕາມ.
   */
  try {
    const centers = new Map(
      (await query<{ tech_code: string; center: string }>("select tech_code, center from ods_tech_center")).rows.map(
        (row) => [row.tech_code, row.center],
      ),
    );
    for (const row of rows) row.center = centers.get(row.code) ?? null;
  } catch (error) {
    console.error("listTechnicians: ອ່ານສູນຂອງຊ່າງບໍ່ໄດ້", error);
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name, "lo"));
}

/**
 * ຕົວເລືອກຊ່າງ ສຳລັບຟອມ **ຮັບເຄື່ອງ/ແກ້ໄຂ** (ຮູບແບບ {code, name_1, department}).
 *
 * ⚠️ ແຕ່ກ່ອນຟອມນີ້ໃຊ້ erp-master.getErpTechnicians ເຊິ່ງ:
 *   · code = ຊື່ຫຼິ້ນ **ສະເໝີ** (ບໍ່ເບິ່ງການເຊື່ອມຕົວຕົນ) ⇒ ຄົນທີ່ເຊື່ອມແລ້ວ
 *     ຖືກຂຽນ emp_code=ຊື່ຫຼິ້ນ ແຕ່ login ເປັນ employee_code ⇒ **ເປີດແອັບບໍ່ເຫັນວຽກ**
 *   · ດຶງ division 400 ໝົດ (ລວມ CS 405 + ໂຄງການ 403) ແລະ ເນັ້ນຊື່ຫຼິ້ນໃນປ້າຍ
 *     ⇒ ຄົນຊື່ຫຼິ້ນຄ້າຍກັນ (ຫຼາຍ "ເລມ້ອນ") ຖືກຈັດຜິດຄົນ.
 * ດຽວນີ້ໃຊ້ listTechnicians ບ່ອນດຽວ ⇒ code ຕົງ login ແນ່ນອນ ແລະ ເຫັນແຕ່ຊ່າງສູນບໍລິການ.
 * ປ້າຍນຳໜ້າດ້ວຍ **ຊື່ເຕັມ + ລະຫັດ ພະນັກງານ** ⇒ ບໍ່ຫຼົງຄົນຊື່ຄ້າຍກັນ.
 */
export async function technicianOptions(): Promise<{ code: string; name_1: string; department: string }[]> {
  const techs = await listTechnicians();
  return techs.map((tech) => ({
    code: tech.code,
    name_1: `${tech.name} · ${tech.employee_code}${tech.head ? " · ຫົວໜ້າ" : ""}`,
    department: "",
  }));
}
