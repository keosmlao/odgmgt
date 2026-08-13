const fs = require("node:fs");
const path = require("node:path");
const admin = require("firebase-admin");
const { query, queryOne } = require("../lib/db");

const SERVICE_ACCOUNT_PATH = path.join(
  process.cwd(),
  "firebase-service-account.json"
);

let firebaseReady = false;
let firebaseInitError = null;

// Resolution order:
//   1. FIREBASE_SERVICE_ACCOUNT_JSON  — full JSON string (preferred for prod)
//   2. FIREBASE_SERVICE_ACCOUNT_BASE64 — base64-encoded JSON (Vercel/CI safer)
//   3. firebase-service-account.json on disk (legacy / local dev)
// Lets us deploy without ever writing the secret to the filesystem.
function loadServiceAccount() {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (inline) {
    return { source: "FIREBASE_SERVICE_ACCOUNT_JSON env", value: JSON.parse(inline) };
  }
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (b64) {
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    return { source: "FIREBASE_SERVICE_ACCOUNT_BASE64 env", value: JSON.parse(decoded) };
  }
  if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    return {
      source: SERVICE_ACCOUNT_PATH,
      value: JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8")),
    };
  }
  return null;
}

function initFirebaseIfNeeded() {
  if (firebaseReady) return true;
  // ກວດ registry ກ່ອນ error ທີ່ຄ້າງ: ຄວາມຜິດພາດຊົ່ວຄາວ (ເຊັ່ນ app ຊ້ຳ) ບໍ່ຄວນ
  // ປິດ push ຖາວອນຕະຫຼອດອາຍຸ process.
  if (admin.apps.length > 0) {
    firebaseReady = true;
    firebaseInitError = null;
    return true;
  }
  if (firebaseInitError) return false;

  try {
    // ໃນ dev ຂອງ Next, hot-reload ໂຫຼດ module ນີ້ຄືນ (ທຸງ firebaseReady ຫາຍ)
    // ແຕ່ registry ຂອງ firebase-admin ຢູ່ລະດັບ process ຈຶ່ງຍັງຄ້າງຢູ່ →
    // initializeApp ຮອບສອງ throw "app [DEFAULT] already exists" ແລ້ວໜ້າເວັບ
    // ຂຶ້ນວ່າ "Firebase ຍັງບໍ່ຕັ້ງຄ່າຢູ່ server" ທັງທີ່ຕັ້ງຄ່າຮຽບຮ້ອຍແລ້ວ.
    if (admin.apps.length > 0) {
      firebaseReady = true;
      firebaseInitError = null;
      return true;
    }

    const loaded = loadServiceAccount();
    if (!loaded) {
      firebaseInitError =
        "Firebase service account not configured (set FIREBASE_SERVICE_ACCOUNT_JSON or place firebase-service-account.json)";
      console.warn(`[push] ${firebaseInitError} — push notifications disabled`);
      return false;
    }

    admin.initializeApp({
      credential: admin.credential.cert(loaded.value),
    });
    firebaseReady = true;
    console.log(`[push] firebase-admin initialized (source: ${loaded.source})`);
    return true;
  } catch (err) {
    firebaseInitError = err;
    console.error("[push] firebase init failed:", err);
    return false;
  }
}

// Schema — one row per (user_code, token). Tokens can move between users if a
// device is shared; (token) PK enforces that.
let schemaReady = false;
async function ensureFcmSchema() {
  if (schemaReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS public.odg_tms_fcm_tokens (
      token text PRIMARY KEY,
      user_code character varying NOT NULL,
      platform character varying,
      updated_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0)
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_odg_tms_fcm_tokens_user_code
    ON public.odg_tms_fcm_tokens (user_code)
  `);
  schemaReady = true;
}

async function saveToken(userCode, token, platform) {
  await ensureFcmSchema();
  if (!userCode || !token) return;
  await queryOne(
    `INSERT INTO public.odg_tms_fcm_tokens(token, user_code, platform, updated_at)
     VALUES ($1, $2, $3, LOCALTIMESTAMP(0))
     ON CONFLICT (token) DO UPDATE
     SET user_code = EXCLUDED.user_code,
         platform = EXCLUDED.platform,
         updated_at = LOCALTIMESTAMP(0)`,
    [token, userCode, platform || null]
  );
}

async function deleteToken(token) {
  await ensureFcmSchema();
  if (!token) return;
  await queryOne("DELETE FROM public.odg_tms_fcm_tokens WHERE token = $1", [
    token,
  ]);
}

async function getTokensFor(userCode) {
  await ensureFcmSchema();
  if (!userCode) return [];
  const rows = await query(
    "SELECT token FROM public.odg_tms_fcm_tokens WHERE user_code = $1",
    [userCode]
  );
  return rows.map((r) => r.token).filter(Boolean);
}

/**
 * ເຄື່ອງທີ່ **login ລ່າສຸດ** ຂອງຜູ້ໃຊ້ຄົນນີ້ — ໃຊ້ກັບການທົດສອບເທົ່ານັ້ນ.
 *
 * ຄົນໜຶ່ງມັກມີຫຼາຍ token ຄ້າງ (ປ່ຽນເຄື່ອງ, ຕິດຕັ້ງໃໝ່). ຖ້າທົດສອບຍິງໝົດທຸກ
 * ອັນ ຈະບອກບໍ່ໄດ້ວ່າ "ບໍ່ເຫັນ" ຍ້ອນລະບົບພັງ ຫຼື ຍ້ອນມັນໄປລົງເຄື່ອງເກົ່າ.
 * ຍິງໃສ່ເຄື່ອງລ່າສຸດອັນດຽວຈຶ່ງອ່ານຜົນໄດ້ແນ່ນອນ.
 *
 * ⚠️ ແຈ້ງເຕືອນຈິງ (pushToDriver) ຍັງຍິງທຸກເຄື່ອງຢູ່ຄືເກົ່າ — ຄົນຂັບອາດຖືສອງ
 * ເຄື່ອງ ແລະ ບໍ່ຄວນພາດງານ.
 */
async function getLatestTokenFor(userCode) {
  await ensureFcmSchema();
  if (!userCode) return null;
  const rows = await query(
    `SELECT token, platform, to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS last_seen
       FROM public.odg_tms_fcm_tokens
      WHERE user_code = $1
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1`,
    [userCode]
  );
  return rows?.[0] ?? null;
}

// ── Per-user push history ────────────────────────────────────────────────
// Every push is journaled here before FCM delivery, so the app's ແຈ້ງເຕືອນ
// screen can show history that survives reinstalls and device changes — and
// even records sends that FCM failed to deliver.
let pushLogReady = false;
async function ensurePushLogSchema() {
  if (pushLogReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS public.odg_tms_push_log (
      id bigserial PRIMARY KEY,
      user_code character varying NOT NULL,
      title text NOT NULL DEFAULT '',
      body text NOT NULL DEFAULT '',
      type character varying NOT NULL DEFAULT '',
      doc_no character varying NOT NULL DEFAULT '',
      sent_at timestamp without time zone DEFAULT LOCALTIMESTAMP(0),
      read_at timestamp without time zone
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_odg_tms_push_log_user
    ON public.odg_tms_push_log (user_code, id DESC)
  `);
  pushLogReady = true;
}

// Journal one push. Repeats of the same (user, type, doc, title) within an
// hour are skipped — cron nudges re-push every 5 minutes and replace each
// other in the tray via `tag`, so the history must collapse them the same way.
async function logPush(userCode, title, body, data = {}) {
  try {
    await ensurePushLogSchema();
    await query(
      // ຕ້ອງ cast ທຸກຕົວ: $1 ຖືກໃຊ້ທັງໃນ SELECT ແລະ ໃນ WHERE ຂອງ subquery
      // → Postgres ຫາຊະນິດບໍ່ໄດ້ ("inconsistent types deduced for parameter $1")
      // ແລ້ວ log ຕົກງຽບໆ ປະຫວັດການແຈ້ງເຕືອນຈຶ່ງຫວ່າງເປົ່າ.
      `INSERT INTO public.odg_tms_push_log (user_code, title, body, type, doc_no)
       SELECT $1::varchar, $2::text, $3::text, $4::varchar, $5::varchar
       WHERE NOT EXISTS (
         SELECT 1 FROM public.odg_tms_push_log
         WHERE user_code = $1 AND title = $2 AND type = $4 AND doc_no = $5
           AND sent_at >= LOCALTIMESTAMP - interval '60 minutes'
       )`,
      [
        userCode,
        String(title ?? ""),
        String(body ?? ""),
        String(data.type ?? ""),
        String(data.doc_no ?? ""),
      ]
    );
  } catch (err) {
    // History being unavailable must never block the actual push.
    console.warn("[push] log failed:", err?.message ?? err);
  }
}

async function pushHistory(userCode, limit = 50) {
  await ensurePushLogSchema();
  if (!userCode) return [];
  const max = Math.min(Math.max(Number(limit) || 50, 1), 100);
  return query(
    `SELECT id::text AS id, title, body, type, doc_no,
       to_char(sent_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS sent_at,
       (read_at IS NOT NULL) AS read
     FROM public.odg_tms_push_log
     WHERE user_code = $1
     ORDER BY id DESC
     LIMIT $2`,
    [userCode, max]
  );
}

// Empty ids = mark everything read (the screen's "ອ່ານທັງໝົດ" button).
async function pushHistoryMarkRead(userCode, ids = []) {
  await ensurePushLogSchema();
  if (!userCode) return { success: false };
  if (Array.isArray(ids) && ids.length > 0) {
    await query(
      `UPDATE public.odg_tms_push_log SET read_at = LOCALTIMESTAMP(0)
       WHERE user_code = $1 AND read_at IS NULL AND id = ANY($2::bigint[])`,
      [userCode, ids.map((n) => Number(n))]
    );
  } else {
    await query(
      `UPDATE public.odg_tms_push_log SET read_at = LOCALTIMESTAMP(0)
       WHERE user_code = $1 AND read_at IS NULL`,
      [userCode]
    );
  }
  return { success: true };
}

// Core send — multi-device per user. Silently no-ops when Firebase is not
// configured so job actions never crash because of notifications.
/**
 * ຄົນນີ້ຢາກຮັບ push ປະເພດນີ້ບໍ — ຕາມໜ້າ "ໃຜຮັບແຈ້ງເຕືອນຫຍັງ".
 *
 * ວາງໄວ້ໃນ pushToDriver/pushToEmployees ຈຸດດຽວ ຈຶ່ງກວມທຸກຈຸດເອີ້ນ (ຈັດຖ້ຽວ,
 * ອະນຸມັດ, ແຊັດ, ເຕືອນ, …) ແລະ push ໃໝ່ໃນອະນາຄົດຖືກກວມເອງ.
 *
 * ຜິດພາດ = ປ່ອຍຜ່ານ. ແຈ້ງເຕືອນທີ່ຄວນໄປແຕ່ບໍ່ໄປ ຮ້າຍແຮງກວ່າແຈ້ງເຕືອນເກີນ.
 */
async function wantsPush(userCode, data) {
  try {
    const { topicForPushType } = require("../lib/notify-topics");
    const topic = topicForPushType(data?.type);
    if (!topic) return true;
    const { filterByPrefs } = require("./notify-prefs");
    const allowed = await filterByPrefs(topic, [userCode]);
    return allowed.length > 0;
  } catch (err) {
    console.warn("[push] pref check failed:", err?.message ?? err);
    return true;
  }
}

async function pushToDriver(driverCode, title, body, data = {}) {
  if (!driverCode) return;
  // ກັ່ນຕອງ **ກ່ອນ** ບັນທຶກ: ຖ້າບັນທຶກກ່ອນ ປະຫວັດໃນແອັບຈະຂຶ້ນລາຍການທີ່ຄົນນັ້ນ
  // ບໍ່ເຄີຍໄດ້ຮັບຈິງ.
  if (!(await wantsPush(driverCode, data))) return;
  // Journal before delivery — history exists even when FCM is down/unset.
  await logPush(driverCode, title, body, data);
  if (!initFirebaseIfNeeded()) return;

  try {
    const tokens = await getTokensFor(driverCode);
    if (tokens.length === 0) return;

    const tag = data.doc_no
      ? `job_${data.doc_no}_${data.type ?? "default"}`
      : undefined;

    const message = {
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries({ ...data, driver_code: driverCode })
          .filter(([, v]) => v != null)
          .map(([k, v]) => [k, String(v)])
      ),
      android: {
        priority: "high",
        notification: {
          channelId: "odgtms_jobs",
          color: "#0d9488",
          defaultSound: true,
          defaultVibrateTimings: true,
          tag,
          notificationCount: 1,
        },
      },
      apns: {
        payload: {
          aps: {
            alert: { title, body },
            sound: "default",
            "thread-id": data.doc_no ? `job_${data.doc_no}` : undefined,
          },
        },
      },
      tokens,
    };

    const res = await admin.messaging().sendEachForMulticast(message);

    // Clean up tokens that are no longer valid.
    const invalid = [];
    res.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code ?? "";
        if (
          code.includes("registration-token-not-registered") ||
          code.includes("invalid-argument")
        ) {
          invalid.push(tokens[i]);
        }
      }
    });
    for (const tok of invalid) await deleteToken(tok);

    // Best-effort audit log so admins can verify a push was attempted.
    try {
      const { recordAudit } = require("./audit-log");
      await recordAudit({
        action: "push.sent",
        entityType: "driver",
        entityId: driverCode,
        userCode: "system",
        changes: {
          title,
          body,
          data,
          token_count: tokens.length,
          sent: res.successCount,
          failed: res.failureCount,
        },
      });
    } catch (_) {
      // audit log being unavailable must not break push
    }

    return { sent: res.successCount, failed: res.failureCount };
  } catch (err) {
    console.error("[push] send failed:", err);
  }
}

/**
 * ສະຖານະການຕັ້ງຄ່າ push — ໃຊ້ໂດຍປຸ່ມ "ທົດສອບແຈ້ງເຕືອນ" ໃນເວັບ.
 *
 * ບອກໄດ້ວ່າບັນຫາຢູ່ໃສ: Firebase ຍັງບໍ່ຕັ້ງຄ່າ, ຫຼື ຕັ້ງແລ້ວແຕ່ຜູ້ໃຊ້ຄົນນັ້ນ
 * ຍັງບໍ່ເຄີຍເປີດແອັບ (ບໍ່ມີ token). ສອງອັນນີ້ແກ້ຄົນລະວິທີ.
 */
async function pushDiagnostics(userCode) {
  const configured = initFirebaseIfNeeded();
  const code = String(userCode ?? "").trim();
  let appTokens = 0;
  let salesTokens = 0;
  try {
    appTokens = (await getTokensFor(code)).length;
  } catch {
    // ຕາຕະລາງຍັງບໍ່ມີ = ຍັງບໍ່ເຄີຍມີໃຜລົງທະບຽນ
  }
  try {
    const rows = await query(
      `SELECT COUNT(*)::int AS n FROM public.app_fcm_token WHERE employee_code = $1`,
      [code]
    );
    salesTokens = Number(rows?.[0]?.n ?? 0);
  } catch {
    // ຕາຕະລາງຂອງແອັບຝ່າຍຂາຍອາດບໍ່ມີໃນລະບົບນີ້
  }
  return {
    configured,
    error: configured
      ? ""
      : String(firebaseInitError?.message ?? firebaseInitError ?? ""),
    app_tokens: appTokens,
    sales_tokens: salesTokens,
  };
}

/**
 * ເຄື່ອງທີ່ລົງທະບຽນຮັບແຈ້ງເຕືອນແລ້ວ — ໃໝ່ສຸດຂຶ້ນກ່ອນ.
 *
 * ຮວມຫຼາຍ token ຂອງຄົນດຽວກັນເປັນແຖວດຽວ ເພາະຄົນໜຶ່ງມັກມີຫຼາຍເຄື່ອງ/ຫຼາຍ
 * ຄັ້ງທີ່ຕິດຕັ້ງ ແລະ ຄົນເລືອກຢາກເລືອກ "ຄົນ" ບໍ່ແມ່ນ "token".
 */
async function listPushTargets(limit = 50) {
  const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
  try {
    const rows = await query(
      `SELECT t.user_code,
              COUNT(*)::int                                   AS devices,
              to_char(MAX(t.updated_at), 'YYYY-MM-DD HH24:MI') AS last_seen,
              COALESCE(MAX(e.fullname_lo), '')                 AS name
         FROM public.odg_tms_fcm_tokens t
         LEFT JOIN public.odg_employee e ON e.employee_code = t.user_code
        GROUP BY t.user_code
        ORDER BY MAX(t.updated_at) DESC NULLS LAST
        LIMIT ${max}`
    );
    return (rows ?? []).map((r) => ({
      user_code: String(r.user_code ?? ""),
      name: String(r.name ?? "").trim(),
      devices: Number(r.devices ?? 0),
      last_seen: String(r.last_seen ?? ""),
    }));
  } catch (err) {
    // ຄືນຫວ່າງ ດີກວ່າພັງທັງໜ້າ ແຕ່ **ຕ້ອງ log** — ຮອບກ່ອນ catch ງຽບໆ ປິດບັງ
    // ຊື່ column ຜິດ ແລ້ວເບິ່ງຄືວ່າ "ບໍ່ມີໃຜລົງທະບຽນ" ທັງທີ່ມີ 8 ເຄື່ອງ.
    console.warn("[push] listPushTargets failed:", err?.message ?? err);
    return [];
  }
}

/**
 * ຍິງແຈ້ງເຕືອນທົດສອບຫາຜູ້ໃຊ້ຄົນໜຶ່ງ ແລ້ວຄືນຜົນລະອຽດ.
 *
 * ໃຊ້ເສັ້ນທາງດຽວກັບແຈ້ງເຕືອນຈິງ (pushToDriver) ຈຶ່ງທົດສອບໄດ້ຄົບທັງ
 * credential, token, ແລະ ການສົ່ງຂອງ FCM — ບໍ່ແມ່ນພຽງກວດການຕັ້ງຄ່າ.
 */
async function sendTestPush(userCode, { title, body } = {}) {
  const code = String(userCode ?? "").trim();
  if (!code) return { ok: false, error: "ບໍ່ຮູ້ວ່າຈະສົ່ງຫາໃຜ" };

  const diagnostics = await pushDiagnostics(code);
  if (!diagnostics.configured) {
    return {
      ok: false,
      ...diagnostics,
      error:
        diagnostics.error ||
        "Firebase ຍັງບໍ່ໄດ້ຕັ້ງຄ່າຢູ່ server (ຂາດ service account)",
    };
  }
  // ນັບສະເພາະ app_tokens: sales_tokens ຢູ່ຄົນລະ Firebase project ຈຶ່ງຍິງບໍ່ໄດ້
  // ຈາກນີ້ — ຖືວ່າ "ມີອຸປະກອນ" ຍ້ອນມັນ ຈະໄດ້ຜົນ "ສົ່ງ 0" ທີ່ອະທິບາຍບໍ່ໄດ້.
  if (diagnostics.app_tokens === 0) {
    return {
      ok: false,
      ...diagnostics,
      error:
        "ບັນຊີນີ້ຍັງບໍ່ມີອຸປະກອນລົງທະບຽນ — ກະລຸນາເປີດແອັບ ODG TMS ດ້ວຍບັນຊີນີ້ 1 ຄັ້ງກ່ອນ",
    };
  }

  const data = { type: "push_test" };
  const useTitle = title || "🔔 ທົດສອບແຈ້ງເຕືອນ";
  const useBody = body || "ຖ້າເຫັນຂໍ້ຄວາມນີ້ ແປວ່າແຈ້ງເຕືອນໃຊ້ງານໄດ້ປົກກະຕິ";
  // ຍິງໃສ່ **ເຄື່ອງທີ່ login ລ່າສຸດ ອັນດຽວ**. ຍິງໝົດທຸກ token ເຮັດໃຫ້ອ່ານຜົນ
  // ບໍ່ອອກ: "ສົ່ງ 2 ເຄື່ອງສຳເລັດ" ແຕ່ຜູ້ທົດສອບບໍ່ເຫັນຫຍັງ ເພາະມັນລົງເຄື່ອງເກົ່າ.
  //
  // ນອກຈາກນັ້ນຍັງບໍ່ແຕະຕາຕະລາງ app_fcm_token (ແອັບຝ່າຍຂາຍ) ເພາະຢູ່ຄົນລະ
  // Firebase project → ໄດ້ `messaging/mismatched-credential` ທຸກເທື່ອ ແລ້ວ
  // ຜົນທົດສອບເບິ່ງຄືພັງທັງທີ່ແອັບ TMS ຮັບໄດ້ປົກກະຕິ.
  const device = await getLatestTokenFor(code);
  if (!device?.token) {
    return {
      ok: false,
      ...diagnostics,
      error: "ຫາເຄື່ອງລ່າສຸດຂອງບັນຊີນີ້ບໍ່ພົບ — ໃຫ້ເປີດແອັບ ແລ້ວ login ໃໝ່",
    };
  }

  await logPush(code, useTitle, useBody, data);
  let sent = 0;
  let failed = 0;
  try {
    const res = await admin.messaging().send({
      notification: { title: useTitle, body: useBody },
      data: { ...data, driver_code: code },
      android: {
        priority: "high",
        notification: {
          channelId: "odgtms_jobs",
          color: "#0d9488",
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        payload: { aps: { alert: { title: useTitle, body: useBody }, sound: "default" } },
      },
      token: device.token,
    });
    sent = res ? 1 : 0;
  } catch (err) {
    failed = 1;
    const errCode = String(err?.code ?? "");
    if (errCode.includes("registration-token-not-registered")) {
      await deleteToken(device.token);
    }
    return {
      ok: false,
      ...diagnostics,
      sent,
      failed,
      target_device: `${device.platform ?? "?"} · ${device.last_seen ?? ""}`,
      error: errCode.includes("registration-token-not-registered")
        ? "token ຂອງເຄື່ອງລ່າສຸດໝົດອາຍຸແລ້ວ (ລຶບອອກໃຫ້ແລ້ວ) — ໃຫ້ເປີດແອັບໃໝ່"
        : `ສົ່ງບໍ່ສຳເລັດ — ${err?.message ?? errCode}`,
    };
  }

  return {
    ok: sent > 0,
    ...diagnostics,
    sent,
    failed,
    target_device: `${device.platform ?? "?"} · ${device.last_seen ?? ""}`,
    error: "",
  };
}

// Scan trips that have been received + had at least one bill picked up but
// the driver hasn't yet tapped "ເລີ່ມຈັດສົ່ງ". Push a nudge to the driver
// every cron tick. Returns count of trips pushed for caller logging.
//
// Idempotency: each trip's tag is reused (`job_<doc_no>_dispatch_reminder`)
// so the OS replaces the old notification instead of stacking. Cron should
// fire every 5 min; the function itself does no rate-limiting beyond the
// recipt_job-age guard.
async function remindUnstartedDispatches({ minMinutesSincePickup = 5 } = {}) {
  const { query } = require("../lib/db");
  const { getFixedYearSqlFilter } = require("../lib/fixed-year");
  const rows = await query(
    `SELECT t.doc_no, t.driver,
            MIN(d.recipt_job) AS earliest_pickup
     FROM odg_tms t
     INNER JOIN public.odg_tms_detail d
       ON d.doc_no = t.doc_no AND ${getFixedYearSqlFilter("d.doc_date")}
     WHERE COALESCE(t.approve_status, 0) = 1
       AND COALESCE(t.job_status, 0) = 1
       AND t.dispatch_started_at IS NULL
       AND ${getFixedYearSqlFilter("t.doc_date")}
     GROUP BY t.doc_no, t.driver
     HAVING MIN(d.recipt_job) IS NOT NULL
        AND MIN(d.recipt_job) <= LOCALTIMESTAMP(0) - ($1 || ' minutes')::interval`,
    [String(minMinutesSincePickup)]
  );

  let pushed = 0;
  for (const r of rows) {
    if (!r.driver) continue;
    await pushToTopic({
      candidates: [r.driver],
      title: "ກະລຸນາກົດເລີ່ມຈັດສົ່ງ",
      body: `ທ່ານຍັງບໍ່ໄດ້ກົດເລີ່ມຈັດສົ່ງສຳລັບຖ້ຽວ ${r.doc_no} — ກະລຸນາກົດເລີ່ມຈັດສົ່ງກ່ອນຈຶ່ງດຳເນີນການຈັດສົ່ງ`,
      data: { doc_no: r.doc_no, type: "dispatch_reminder" },
      // ຫົວໜ້າທີ່ຕິກເປີດ ຢາກຮູ້ວ່າ "ຖ້ຽວໃດຍັງບໍ່ອອກ" ບໍ່ແມ່ນຖືກສັ່ງໃຫ້ກົດເອງ.
      observerTitle: "⏰ ຖ້ຽວຍັງບໍ່ໄດ້ອອກ",
      observerBody: `ຖ້ຽວ ${r.doc_no} ເບີກເຄື່ອງແລ້ວ ແຕ່ຍັງບໍ່ໄດ້ກົດເລີ່ມຈັດສົ່ງ`,
      sales: false,
    });
    pushed += 1;
  }
  return { scanned: rows.length, pushed };
}

// Send to sales-app employees (app_sale_order Flutter app). Tokens live in
// the shared `app_fcm_token` table owned by web_sale_order, keyed by
// employee_code. Reuses firebase-admin already initialised above — both apps
// share the same Firebase project, so the same service account can push to
// either token store.
async function pushToEmployees(employeeCodes, title, body, data = {}) {
  let codes = Array.from(
    new Set(
      (Array.isArray(employeeCodes) ? employeeCodes : [])
        .map((c) => (c == null ? "" : String(c).trim()))
        .filter(Boolean)
    )
  );
  if (codes.length === 0) return;
  // ຄືກັບ pushToDriver — ຕັດຄົນທີ່ປິດປະເພດນີ້ອອກກ່ອນຍິງ.
  try {
    const { topicForPushType } = require("../lib/notify-topics");
    const topic = topicForPushType(data?.type);
    if (topic) {
      const { filterByPrefs } = require("./notify-prefs");
      codes = await filterByPrefs(topic, codes);
    }
  } catch (err) {
    console.warn("[push] pref check failed:", err?.message ?? err);
  }
  if (codes.length === 0) return;
  if (!initFirebaseIfNeeded()) return;

  let tokenRows;
  try {
    tokenRows = await query(
      `SELECT id, token, employee_code
       FROM public.app_fcm_token
       WHERE employee_code = ANY($1::varchar[])`,
      [codes]
    );
  } catch (err) {
    console.warn("[push] pushToEmployees lookup failed:", err?.message ?? err);
    return;
  }
  if (tokenRows.length === 0) return;

  const tokens = tokenRows.map((r) => r.token);
  const tag = data.doc_no ? `sales_${data.doc_no}_${data.type ?? "default"}` : undefined;
  const message = {
    notification: { title, body },
    data: Object.fromEntries(
      Object.entries(data)
        .filter(([, v]) => v != null)
        .map(([k, v]) => [k, String(v)])
    ),
    android: {
      priority: "high",
      notification: {
        channelId: "default",
        defaultSound: true,
        defaultVibrateTimings: true,
        tag,
      },
    },
    apns: {
      payload: {
        aps: {
          alert: { title, body },
          sound: "default",
          "thread-id": data.doc_no ? `sales_${data.doc_no}` : undefined,
        },
      },
    },
    tokens,
  };

  try {
    const res = await admin.messaging().sendEachForMulticast(message);
    const staleIds = [];
    res.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error?.code ?? "";
      if (
        code.includes("registration-token-not-registered") ||
        code.includes("invalid-registration-token") ||
        code.includes("invalid-argument")
      ) {
        staleIds.push(tokenRows[i].id);
      }
    });
    if (staleIds.length > 0) {
      await query(
        `DELETE FROM public.app_fcm_token WHERE id = ANY($1::bigint[])`,
        [staleIds]
      );
    }
    try {
      const { recordAudit } = require("./audit-log");
      await recordAudit({
        action: "push.sent",
        entityType: "sales_employee",
        entityId: codes.join(","),
        userCode: "system",
        changes: {
          title,
          body,
          data,
          token_count: tokens.length,
          sent: res.successCount,
          failed: res.failureCount,
        },
      });
    } catch (_) {
      // audit log unavailable must not break push
    }
    return { sent: res.successCount, failed: res.failureCount };
  } catch (err) {
    console.error("[push] pushToEmployees send failed:", err);
  }
}

/**
 * ປະເພດທີ່ **ຫ້າມ** ກະຈາຍໃຫ້ຄົນທີ່ກົດເປີດເອງ.
 *
 * ແຊັດເປັນຂໍ້ຄວາມສ່ວນຕົວລະຫວ່າງສອງຄົນ (ຫຼື ໃນບິນໜຶ່ງ) — ຖ້າກະຈາຍຕາມການ
 * ຕັ້ງຄ່າ ຈະກາຍເປັນໃຫ້ຄົນນອກອ່ານຂໍ້ຄວາມຄົນອື່ນ. ການຕັ້ງຄ່າ "ຂໍ້ຄວາມແຊັດ"
 * ຈຶ່ງໃຊ້ໄດ້ພຽງແຕ່ **ປິດ** ຂອງຕົນເອງ ບໍ່ແມ່ນ **ເປີດ** ຮັບຂອງຄົນອື່ນ.
 */
const NEVER_FANOUT = new Set(["chat"]);

/**
 * ສົ່ງແຈ້ງເຕືອນຫາ **ຜູ້ກ່ຽວຂ້ອງກັບງານ + ຄົນທີ່ກົດເປີດປະເພດນີ້ເອງ**.
 *
 * ເປັນທາງດຽວທີ່ໜ້າ "ໃຜຮັບແຈ້ງເຕືອນຫຍັງ" ຈະມີຜົນຈິງທັງສອງທາງ. ກ່ອນໜ້ານີ້
 * ຈຸດເອີ້ນຄິດຜູ້ຮັບຈາກງານເອງ ແລ້ວການຕັ້ງຄ່າພຽງແຕ່**ຕັດອອກ**ໄດ້ — ຄົນທີ່
 * ຕິກເປີດແຕ່ບໍ່ກ່ຽວກັບຖ້ຽວນັ້ນຈຶ່ງບໍ່ເຄີຍໄດ້ຮັບຫຍັງ (ຢືນຢັນຈາກ push log:
 * ຜູ້ຕິກເປີດ "ແຈ້ງສົ່ງສຳເລັດ" 15 ຄົນ ໄດ້ 0 ລາຍການ).
 *
 * ຂໍ້ຄວາມມີສອງສະບັບໄດ້: ຜູ້ກ່ຽວຂ້ອງໄດ້ [title]/[body] (ຂຽນເຖິງລາວໂດຍກົງ)
 * ສ່ວນຜູ້ເຝົ້າເບິ່ງໄດ້ [observerTitle]/[observerBody]. ບໍ່ໃສ່ = ໃຊ້ອັນດຽວກັນ
 * ເໝາະກັບຂໍ້ຄວາມທີ່ຂຽນເປັນກາງຢູ່ແລ້ວ ("ຖ້ຽວຖືກອະນຸມັດແລ້ວ").
 *
 * @param {object} o
 * @param {Iterable<string>} o.candidates ຜູ້ຮັບທີ່ຄິດຈາກງານ
 * @param {string} [o.excludeCode] ຜູ້ກໍ່ເຫດເອງ — ຕັດອອກ ນອກຈາກລາວຕິກເປີດເອງ
 * @param {boolean} [o.tms=true]   ສົ່ງເຂົ້າແອັບຄົນຂັບ/TMS (ແລະ ບັນທຶກປະຫວັດ)
 * @param {boolean} [o.sales=true] ສົ່ງເຂົ້າແອັບຝ່າຍຂາຍນຳ
 */
async function pushToTopic({
  candidates = [],
  title,
  body,
  data = {},
  excludeCode = "",
  observerTitle = "",
  observerBody = "",
  tms = true,
  sales = true,
}) {
  const { mergeRecipients } = require("../lib/notify-recipients");
  const core = mergeRecipients({ candidates, optIns: [], excludeCode });

  let observers = [];
  try {
    const { topicForPushType } = require("../lib/notify-topics");
    const topic = topicForPushType(data?.type);
    if (topic && !NEVER_FANOUT.has(topic)) {
      const { explicitOptIns } = require("./notify-prefs");
      const optIns = await explicitOptIns(topic);
      const already = new Set(core);
      observers = mergeRecipients({ optIns, excludeCode }).filter(
        (c) => !already.has(c)
      );
    }
  } catch (err) {
    // ຫາຜູ້ຕິກເປີດບໍ່ໄດ້ ບໍ່ຄວນເຮັດໃຫ້ຜູ້ກ່ຽວຂ້ອງກັບງານບໍ່ໄດ້ຮັບ.
    console.warn("[push] opt-in fan-out failed:", err?.message ?? err);
  }

  const send = (codes, t, b) =>
    codes.length === 0
      ? Promise.resolve()
      : Promise.allSettled([
          ...(tms ? codes.map((c) => pushToDriver(c, t, b, data)) : []),
          ...(sales ? [pushToEmployees(codes, t, b, data)] : []),
        ]);

  await Promise.allSettled([
    send(core, title, body),
    send(observers, observerTitle || title, observerBody || body),
  ]);
  return { core: core.length, observers: observers.length };
}

module.exports = {
  saveToken,
  deleteToken,
  pushToDriver,
  pushToTopic,
  pushDiagnostics,
  listPushTargets,
  sendTestPush,
  pushToEmployees,
  pushHistory,
  pushHistoryMarkRead,
  remindUnstartedDispatches,
};
