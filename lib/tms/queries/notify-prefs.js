const { query } = require("../lib/db");

/**
 * ກຳນົດວ່າ **ພະນັກງານຄົນໃດ ຮັບແຈ້ງເຕືອນປະເພດໃດແດ່**.
 *
 * ເມື່ອກ່ອນຜູ້ຮັບຖືກຝັງໄວ້ໃນ code (ຄົນຂັບຂອງຖ້ຽວ, ພະນັກງານສາຂາ, …) ຈຶ່ງ
 * ປ່ຽນບໍ່ໄດ້ຖ້າບໍ່ແກ້ code. ຕາຕະລາງນີ້ໃຫ້ຕັ້ງຄ່າຜ່ານໜ້າເວັບໄດ້ເລີຍ.
 *
 * ຫຼັກການ: ບໍ່ມີແຖວ = ໃຊ້ຄ່າເລີ່ມຕົ້ນຂອງປະເພດນັ້ນ. ມີແຖວ = ຄຳສັ່ງຂອງຄົນ
 * ຊະນະສະເໝີ. ຈຶ່ງເປີດໃຫ້ຄົນໃດຄົນໜຶ່ງເປັນພິເສດ ຫຼື ປິດສະເພາະຄົນກໍ່ໄດ້
 * ໂດຍບໍ່ຕ້ອງໄປແຕະຄ່າເລີ່ມຕົ້ນຂອງຄົນອື່ນ.
 */

const { TOPICS, defaultFor } = require("../lib/notify-topics");

const TOPIC_KEYS = new Set(TOPICS.map((t) => t.key));

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await query(
    `CREATE TABLE IF NOT EXISTS public.odg_tms_notify_prefs (
       user_code character varying NOT NULL,
       topic     character varying NOT NULL,
       enabled   boolean NOT NULL DEFAULT true,
       updated_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0),
       PRIMARY KEY (user_code, topic)
     )`
  );
  schemaReady = true;
}

/**
 * ພະນັກງານທຸກຄົນທີ່ **ເຄີຍ login ແອັບ** ພ້ອມບອກວ່າເປັນຄົນຂັບ ຫຼື ຫົວໜ້າ.
 *
 * ໃຊ້ກົດດຽວກັບ `resolveIsDriver()` ຝັ່ງ login: ຕຳແໜ່ງບໍລິຫານຊະນະສະເໝີ,
 * ນອກນັ້ນຄົນໃນພະແນກຂົນສົ່ງຖືເປັນຄົນຂັບ. ສອງບ່ອນຕ້ອງຄືກັນ ບໍ່ດັ່ງນັ້ນຄົນທີ່
 * ແອັບເປີດຈໍຫົວໜ້າໃຫ້ ຈະຖືກຈັດເປັນຄົນຂັບຢູ່ໜ້າຕັ້ງຄ່ານີ້.
 */
async function appPeople() {
  await ensureSchema();
  const rows = await query(
    `WITH people AS (
       SELECT DISTINCT
         t.user_code,
         COALESCE(e.fullname_lo, u.name_1, '')                       AS name,
         lower(COALESCE(
           NULLIF(TRIM(wb.position_code), ''),
           NULLIF(TRIM(e.app_role), ''),
           NULLIF(TRIM(u.title), ''),
           ''
         ))                                                          AS role_text,
         COALESCE(d.department_name_lo, '')                          AS dept,
         (e.employee_code IS NOT NULL)                               AS is_employee,
         MAX(t.updated_at) OVER (PARTITION BY t.user_code)           AS last_seen
       FROM public.odg_tms_fcm_tokens t
       LEFT JOIN public.erp_user u ON u.code = t.user_code
       LEFT JOIN public.odg_employee e ON e.employee_code = t.user_code
       LEFT JOIN public.odg_department d ON d.department_code = e.department_code
       LEFT JOIN public.odg_tms_worker_branch wb ON wb.worker_code = t.user_code
     )
     SELECT user_code, name, dept,
            to_char(last_seen, 'YYYY-MM-DD HH24:MI') AS last_seen,
            NOT (
              role_text ~ '(supervisor|head|team_lead|manager|admin|director|executive|transport_head|ຫົວໜ້າ|ຜູ້ຈັດການ)'
              OR (is_employee AND dept NOT ILIKE '%ຂົນສົ່ງ%')
              OR (NOT is_employee AND role_text NOT LIKE '%driver%')
            ) AS is_driver
       FROM people
      ORDER BY last_seen DESC NULLS LAST`
  );
  return (rows ?? []).map((r) => ({
    user_code: String(r.user_code),
    name: String(r.name ?? "").trim(),
    dept: String(r.dept ?? "").trim(),
    last_seen: String(r.last_seen ?? ""),
    is_driver: r.is_driver === true,
  }));
}

/** ທຸກແຖວທີ່ຕັ້ງໄວ້ເອງ → `{ [user_code]: { [topic]: boolean } }`. */
async function allPrefs() {
  await ensureSchema();
  const rows = await query(
    "SELECT user_code, topic, enabled FROM public.odg_tms_notify_prefs"
  );
  const out = {};
  for (const r of rows ?? []) {
    const code = String(r.user_code);
    (out[code] ??= {})[String(r.topic)] = r.enabled === true;
  }
  return out;
}


/**
 * ບັນທຶກການຕັ້ງຄ່າ. ຮັບເປັນ `[{ user_code, topic, enabled }]`.
 *
 * ຂຽນທຸກແຖວທີ່ສົ່ງມາເປັນຄຳສັ່ງຊັດເຈນ (ບໍ່ລຶບອອກເມື່ອຄ່າຄືກັບຄ່າເລີ່ມຕົ້ນ)
 * ເພື່ອວ່າຖ້າຕໍ່ໜ້າມີການປ່ຽນຄ່າເລີ່ມຕົ້ນ ຄົນທີ່ຕັ້ງໄວ້ເອງຈະບໍ່ຖືກປ່ຽນຕາມ.
 */
async function savePrefs(entries) {
  await ensureSchema();
  const rows = (entries ?? []).filter(
    (e) => e && e.user_code && TOPIC_KEYS.has(e.topic)
  );
  if (rows.length === 0) return 0;
  for (const r of rows) {
    await query(
      `INSERT INTO public.odg_tms_notify_prefs (user_code, topic, enabled, updated_at)
       VALUES ($1, $2, $3, LOCALTIMESTAMP(0))
       ON CONFLICT (user_code, topic) DO UPDATE
       SET enabled = EXCLUDED.enabled, updated_at = LOCALTIMESTAMP(0)`,
      [String(r.user_code), String(r.topic), r.enabled === true]
    );
  }
  return rows.length;
}

/**
 * ກັ່ນຕອງລາຍຊື່ຜູ້ຮັບຕາມການຕັ້ງຄ່າ.
 *
 * ຮັບ candidate ທີ່ code ຄິດໄວ້ຢູ່ແລ້ວ (ຄົນຂັບຂອງຖ້ຽວ, ພະນັກງານສາຂາ, …)
 * ແລ້ວຕັດຄົນທີ່ປິດປະເພດນີ້ອອກ. ບໍ່ໄດ້ **ເພີ່ມ** ຄົນ — ຄົນທີ່ບໍ່ກ່ຽວຂ້ອງກັບ
 * ງານນັ້ນບໍ່ຄວນຖືກດຶງເຂົ້າມາຍ້ອນຕັ້ງຄ່າຜິດ.
 */
async function filterByPrefs(topicKey, candidateCodes) {
  const codes = [...new Set((candidateCodes ?? []).map(String).filter(Boolean))];
  if (codes.length === 0) return [];
  if (!TOPIC_KEYS.has(topicKey)) return codes;
  try {
    await ensureSchema();
    const rows = await query(
      `SELECT user_code, enabled FROM public.odg_tms_notify_prefs
        WHERE topic = $1 AND user_code = ANY($2::varchar[])`,
      [topicKey, codes]
    );
    const explicit = new Map(
      (rows ?? []).map((r) => [String(r.user_code), r.enabled === true])
    );
    if (explicit.size === 0) return codes;
    // ບໍ່ມີແຖວ = ຍັງໃຊ້ຄ່າເລີ່ມຕົ້ນ = ຮັບຢູ່ (candidate ຖືກເລືອກມາແລ້ວ).
    return codes.filter((c) => explicit.get(c) !== false);
  } catch (err) {
    // ອ່ານການຕັ້ງຄ່າບໍ່ໄດ້ບໍ່ຄວນເຮັດໃຫ້ແຈ້ງເຕືອນຫາຍ — ສົ່ງຕາມເດີມ.
    console.warn("[notify-prefs] filter failed:", err?.message ?? err);
    return codes;
  }
}

/**
 * ຄົນທີ່ **ກົດເປີດເອງ** ປະເພດນີ້ຢູ່ໜ້າ "ໃຜຮັບແຈ້ງເຕືອນຫຍັງ".
 *
 * ຕ່າງຈາກ [subscribersOf]: ອັນນີ້ນັບສະເພາະແຖວທີ່ມີຈິງ (enabled = true)
 * ບໍ່ລວມຄົນທີ່ພຽງແຕ່ໄດ້ຄ່າເລີ່ມຕົ້ນເປັນ true — ຈຶ່ງເອົາໄປ **ເພີ່ມ** ໃສ່ຜູ້ຮັບ
 * ໄດ້ໂດຍບໍ່ກາຍເປັນສົ່ງຫາຫົວໜ້າທຸກຄົນທຸກບິນ.
 *
 * ມີໄວ້ເພາະຈຸດເອີ້ນສ່ວນຫຼາຍຄິດຜູ້ຮັບຈາກງານ (ຜູ້ສ້າງຖ້ຽວ, ພະນັກງານສາຂາ) ແລ້ວ
 * ໃຊ້ [filterByPrefs] ຕັດອອກເທົ່ານັ້ນ — ຄົນທີ່ກົດເປີດແຕ່ບໍ່ຢູ່ໃນສອງກຸ່ມນັ້ນ
 * ຈຶ່ງບໍ່ເຄີຍໄດ້ຮັບຫຍັງເລີຍ ທັງທີ່ໜ້າຈໍບອກວ່າເປີດແລ້ວ.
 */
async function explicitOptIns(topicKey) {
  if (!TOPIC_KEYS.has(topicKey)) return [];
  try {
    await ensureSchema();
    const rows = await query(
      `SELECT user_code FROM public.odg_tms_notify_prefs
        WHERE topic = $1 AND enabled = true`,
      [topicKey]
    );
    return (rows ?? []).map((r) => String(r.user_code)).filter(Boolean);
  } catch (err) {
    console.warn("[notify-prefs] opt-ins failed:", err?.message ?? err);
    return [];
  }
}

/**
 * ຜູ້ຮັບຂອງແຈ້ງເຕືອນແບບ **ກະຈາຍ** (ບໍ່ມີເຈົ້າຂອງງານຕາຍຕົວ) ເຊັ່ນ
 * "ການເຄື່ອນໄຫວໃນເວັບ" — ດຶງຈາກຄົນທີ່ເປີດປະເພດນີ້ໄວ້ເທົ່ານັ້ນ.
 */
async function subscribersOf(topicKey) {
  if (!TOPIC_KEYS.has(topicKey)) return [];
  const [people, prefs] = await Promise.all([appPeople(), allPrefs()]);
  return people
    .filter((p) => {
      const explicit = prefs[p.user_code]?.[topicKey];
      return explicit ?? defaultFor(topicKey, p.is_driver);
    })
    .map((p) => p.user_code);
}

module.exports = {
  TOPICS,
  appPeople,
  allPrefs,
  savePrefs,
  defaultFor,
  filterByPrefs,
  explicitOptIns,
  subscribersOf,
};
