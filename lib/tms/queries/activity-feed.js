const { query } = require("../lib/db");

/**
 * ແຈ້ງເຕືອນ **ຜູ້ຈັດການ** ທຸກຄັ້ງທີ່ມີການເຄື່ອນໄຫວໃນເວັບ.
 *
 * ຮັບຈາກ `recordAudit()` ຈຸດດຽວ ຈຶ່ງກວມທຸກ action ທີ່ບັນທຶກ audit ຢູ່ແລ້ວ
 * ໂດຍບໍ່ຕ້ອງໄປແກ້ທຸກ server action ເທື່ອລະບ່ອນ (ແລະ action ໃໝ່ໃນອະນາຄົດ
 * ຈະຖືກກວມເອງ ຖ້າມັນບັນທຶກ audit).
 */

// ⚠️ ຫ້າມແຈ້ງເຕືອນ action ເຫຼົ່ານີ້ — `pushToDriver` ບັນທຶກ `push.sent` ເປັນ
// audit ຢູ່ແລ້ວ. ຖ້າແຈ້ງເຕືອນມັນນຳ ຈະເປັນ ແຈ້ງ → push → audit → ແຈ້ງ …
// ວົນບໍ່ຮູ້ຈົບ ແລະ ຍິງ FCM ບໍ່ຢຸດ.
const {
  NEVER_NOTIFY,
  ACTION_LABELS,
  describeActivity,
} = require("../lib/activity-labels");

/**
 * ຜູ້ຈັດການທີ່ **ເຄີຍ login ແອັບ** (ມີ FCM token).
 *
 * ໃຊ້ກົດດຽວກັບ `resolveIsDriver()` ຝັ່ງ login ແຕ່ກັບຫົວ: ຕຳແໜ່ງທີ່ເປັນ
 * ງານບໍລິຫານຊະນະສະເໝີ, ນອກນັ້ນຄົນໃນພະແນກຂົນສົ່ງຖືເປັນຄົນຂັບ. ສອງບ່ອນນີ້
 * ຕ້ອງຄືກັນ ບໍ່ດັ່ງນັ້ນຄົນທີ່ແອັບເປີດຈໍຫົວໜ້າໃຫ້ ຈະບໍ່ໄດ້ຮັບແຈ້ງເຕືອນ.
 */
async function managersWithApp() {
  const rows = await query(
    `WITH people AS (
       SELECT DISTINCT
         t.user_code,
         lower(COALESCE(
           NULLIF(TRIM(wb.position_code), ''),
           NULLIF(TRIM(e.app_role), ''),
           NULLIF(TRIM(u.title), ''),
           ''
         )) AS role_text,
         COALESCE(d.department_name_lo, '') AS dept,
         (e.employee_code IS NOT NULL) AS is_employee
       FROM public.odg_tms_fcm_tokens t
       LEFT JOIN public.erp_user u ON u.code = t.user_code
       LEFT JOIN public.odg_employee e ON e.employee_code = t.user_code
       LEFT JOIN public.odg_department d ON d.department_code = e.department_code
       LEFT JOIN public.odg_tms_worker_branch wb ON wb.worker_code = t.user_code
     )
     SELECT user_code FROM people
      WHERE role_text ~ '(supervisor|head|team_lead|manager|admin|director|executive|transport_head|ຫົວໜ້າ|ຜູ້ຈັດການ)'
         OR (is_employee AND dept NOT ILIKE '%ຂົນສົ່ງ%')
         OR (NOT is_employee AND role_text NOT LIKE '%driver%')`
  );
  return (rows ?? []).map((r) => String(r.user_code)).filter(Boolean);
}

/**
 * ຍິງແຈ້ງເຕືອນຫາຜູ້ຈັດການທຸກຄົນທີ່ມີແອັບ ຍົກເວັ້ນຜູ້ທີ່ເຮັດເອງ.
 *
 * ບໍ່ throw ເດັດຂາດ — ນີ້ເປັນຜົນພ່ວງຂອງ audit ຈຶ່ງບໍ່ຄວນເຮັດໃຫ້ງານຫຼັກລົ້ມ.
 */
async function notifyManagersOfActivity(input) {
  const { action, entityType, entityId, userCode } = input || {};
  if (!action || NEVER_NOTIFY.has(action)) return 0;

  try {
    // ຜູ້ຮັບມາຈາກຕາຕະລາງ "ໃຜຮັບແຈ້ງເຕືອນຫຍັງ" — ຄ່າເລີ່ມຕົ້ນຂອງປະເພດນີ້
    // ແມ່ນ **ປິດ** ທຸກຄົນ (ດັງຫຼາຍ) ຈຶ່ງບໍ່ມີໃຜຖືກລົບກວນຈົນກວ່າຈະໄປຕິກເປີດ.
    const { subscribersOf } = require("./notify-prefs");
    const managers = (await subscribersOf("web_activity")).filter(
      (c) => c !== userCode
    );
    if (managers.length === 0) return 0;

    const actorName = await resolveName(userCode);
    const { title, body } = describeActivity({
      action,
      entityType,
      entityId,
      actorName,
    });

    const { pushToDriver } = require("./push");
    const data = {
      type: "web_activity",
      action,
      doc_no: entityId ? String(entityId) : "",
    };
    await Promise.all(
      managers.map((code) =>
        pushToDriver(code, title, body, data).catch(() => undefined)
      )
    );
    return managers.length;
  } catch (err) {
    console.warn("[activity] notify failed:", err?.message ?? err);
    return 0;
  }
}

async function resolveName(userCode) {
  if (!userCode) return "";
  try {
    const rows = await query(
      `SELECT COALESCE(e.fullname_lo, u.name_1, '') AS name
         FROM (SELECT $1::varchar AS code) c
         LEFT JOIN public.odg_employee e ON e.employee_code = c.code
         LEFT JOIN public.erp_user u ON u.code = c.code
        LIMIT 1`,
      [userCode]
    );
    return String(rows?.[0]?.name ?? "").trim() || String(userCode);
  } catch {
    return String(userCode);
  }
}

module.exports = {
  managersWithApp,
  notifyManagersOfActivity,
};
