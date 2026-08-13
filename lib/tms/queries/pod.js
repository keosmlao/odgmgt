// ຕິດຕາມ POD (Proof of Delivery) — ອ່ານຢ່າງດຽວ.
//
// ຫຼັກຖານການສົ່ງຂອງບິນໜຶ່ງມາຈາກ 3 ບ່ອນ:
//   · ຮູບ      — odg_tms_delivery_images (ຫຼາຍໃບ) + odg_tms_detail.url_img (ຮູບຫຼັກ)
//   · ລາຍເຊັນ  — odg_tms_detail.sight_img
//   · GPS      — odg_tms_detail.lat_end / lng_end (ຈຸດທີ່ຄົນຂັບກົດສຳເລັດ)
// ບິນທີ່ຮັບເຄື່ອງຢູ່ລານລູກຄ້າ ('__CUSTOMER__') ຍັງມີ recipt_img / recipt_sign_img
// ອີກຄູ່ໜຶ່ງ — ນັ້ນຄືຫຼັກຖານ "ຕອນຮັບ" ບໍ່ແມ່ນ "ຕອນສົ່ງ" ຈຶ່ງບໍ່ນັບເຂົ້າ POD
// ແຕ່ສະແດງໃຫ້ເຫັນຢູ່ໜ້າລາຍລະອຽດ.
//
// ⚠️ ກົດ "ຄົບ/ບໍ່ຄົບ" ຢູ່ podRowFlagsSql ຕ້ອງກົງກັບ src/lib/pod.ts (podState).
const { query, queryOne } = require("../lib/db");
const { getFixedYearSqlFilter } = require("../lib/fixed-year");
const { getBranchScope, branchFilterJob } = require("./helpers");

// ຮູບ/ລາຍເຊັນເກັບເປັນ base64 ຢູ່ຄໍລຳ text (ຫຼາຍຮ້ອຍ KB ຕໍ່ໃບ). ການຖາມພຽງວ່າ
// "ມີ ຫຼື ບໍ່" ດ້ວຍ length()/TRIM() ຈະບັງຄັບໃຫ້ Postgres detoast ຄ່າທັງໝົດ —
// ໜ້າລາຍການໜຶ່ງເດືອນຈະດຶງເປັນ GB. substr(col,1,1) ອ່ານແຕ່ chunk ທຳອິດຂອງ TOAST
// ຈຶ່ງໃຫ້ຄຳຕອບດຽວກັນໃນລາຄາຄົງທີ່.
const hasImageSql = (col) => `COALESCE(substr(${col}, 1, 1), '') <> ''`;

// ເງື່ອນໄຂການສົ່ງ: ບິນເກົ່າສ້າງກ່ອນມີຄໍລຳ — ເດົາຈາກສາຂາປາຍທາງ ຄືກັບທີ່ໜ້າ
// ກຳລັງຈັດສົ່ງເຮັດ (resolveDeliveryCondition).
const CONDITION_SQL = `COALESCE(
  NULLIF(TRIM(d.delivery_condition), ''),
  CASE WHEN NULLIF(TRIM(d.forward_transport_code), '') IS NOT NULL
       THEN 'to_branch' ELSE 'to_customer' END
)`;

const HAS_GPS_SQL = `(
  NULLIF(TRIM(COALESCE(d.lat_end, '')), '') IS NOT NULL
  AND NULLIF(TRIM(COALESCE(d.lng_end, '')), '') IS NOT NULL
)`;

/**
 * ຊັ້ນຖານທີ່ທັງລາຍການ ແລະ ສະຫຼຸບໃຊ້ຮ່ວມກັນ — ບິນທີ່ "ປິດສຳເລັດແລ້ວ" ເທົ່ານັ້ນ
 * (status = 1). ບິນຍົກເລີກບໍ່ມີ POD ໃຫ້ຕິດຕາມ ແລະ ບິນທີ່ຍັງບໍ່ປິດຍັງບໍ່ຮອດເວລາ.
 *
 * @returns {{ sql: string, params: any[] }}
 */
function podBaseCte({ session, fromDate, toDate, branch, driver, search }) {
  const scope = getBranchScope(session);
  const params = [fromDate, toDate];
  let where = "";

  if (branch && branch !== "all") {
    params.push(branch);
    where += ` AND COALESCE(t.origin_transport_code, '') = $${params.length}`;
  }
  if (driver && driver !== "all") {
    params.push(driver);
    where += ` AND COALESCE(t.driver, '') = $${params.length}`;
  }
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (d.bill_no ILIKE $${params.length}
                    OR COALESCE(c.name_1, '') ILIKE $${params.length}
                    OR COALESCE(d.cust_code, '') ILIKE $${params.length})`;
  }

  const sql = `
    SELECT
      d.bill_no,
      d.doc_no,
      to_char(d.doc_date, 'DD-MM-YYYY') AS doc_date,
      to_char(t.date_logistic, 'DD-MM-YYYY') AS delivery_date,
      to_char(d.sent_start, 'DD-MM-YYYY HH24:MI') AS started_at,
      to_char(d.sent_end, 'DD-MM-YYYY HH24:MI') AS closed_at,
      -- ຄ່າດິບໄວ້ຮຽງ: closed_at ເປັນ text ຮູບແບບ DD-MM-YYYY ຮຽງແລ້ວຈະສັບສົນປີ/ວັນ
      d.sent_end AS closed_ts,
      COALESCE(d.cust_code, '') AS cust_code,
      COALESCE(NULLIF(TRIM(c.name_1), ''), d.cust_code, '-') AS cust_name,
      COALESCE(t.driver, '') AS driver_code,
      COALESCE(NULLIF(TRIM(dr.name_1), ''), t.driver, '-') AS driver_name,
      COALESCE(NULLIF(TRIM(car.name_1), ''), t.car, '-') AS car_name,
      COALESCE(t.origin_transport_code, '') AS transport_code,
      COALESCE(NULLIF(TRIM(tt.name_1), ''), '') AS transport_name,
      ${CONDITION_SQL} AS delivery_condition,
      COALESCE(d.lat_end, '') AS lat_end,
      COALESCE(d.lng_end, '') AS lng_end,
      COALESCE(d.remark, '') AS remark,
      COALESCE(d.collected_amount, 0)::numeric AS collected_amount,
      COALESCE(img.photo_count, 0)::int AS photo_count,
      (COALESCE(img.photo_count, 0) > 0 OR ${hasImageSql("d.url_img")}) AS has_photo,
      ${hasImageSql("d.sight_img")} AS has_signature,
      ${hasImageSql("d.recipt_img")} AS has_pickup_photo,
      ${hasImageSql("d.recipt_sign_img")} AS has_pickup_signature,
      ${HAS_GPS_SQL} AS has_gps
    FROM public.odg_tms_detail d
    INNER JOIN public.odg_tms t ON t.doc_no = d.doc_no
    LEFT JOIN ar_customer c ON c.code = d.cust_code
    LEFT JOIN public.odg_tms_driver dr ON dr.code = t.driver
    LEFT JOIN public.odg_tms_car car ON car.code = t.car
    LEFT JOIN public.transport_type tt ON tt.code = t.origin_transport_code
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS photo_count
      FROM public.odg_tms_delivery_images di
      WHERE di.bill_no = d.bill_no
    ) img ON true
    WHERE COALESCE(d.status, 0) = 1
      AND t.date_logistic::date BETWEEN $1::date AND $2::date
      AND ${getFixedYearSqlFilter("d.doc_date")}
      AND ${getFixedYearSqlFilter("t.doc_date")}
      ${branchFilterJob(scope, "t")}
      ${where}`;

  return { sql, params };
}

// ຂາດຫຍັງແດ່ — ຄິດຢູ່ SQL ເພື່ອໃຫ້ຄັດ ແລະ ນັບໄດ້ໂດຍບໍ່ຕ້ອງດຶງທຸກແຖວອອກມາ.
//
// requireSignature: ລາຍເຊັນຍັງບໍ່ບັງຄັບໂດຍຄ່າເລີ່ມຕົ້ນ (07/2026 ເກັບໄດ້ພຽງ
// 358/2,726 ໃບ ແລະ ເກືອບໝົດມາຈາກຄົນຂັບຄົນດຽວ) — ເບິ່ງເຫດຜົນເຕັມຢູ່ src/lib/pod.ts.
// missing_signature ຍັງຄິດໃຫ້ຢູ່ສະເໝີ ເພື່ອໃຫ້ນັບ "ຄວາມຄືບໜ້າການເກັບລາຍເຊັນ" ໄດ້
// ໂດຍບໍ່ຕ້ອງນັບເປັນ POD ບໍ່ຄົບ.
const podFlagsSql = (requireSignature) => {
  const sigCounts = requireSignature
    ? `(b.delivery_condition = 'to_customer' AND NOT b.has_signature)`
    : `false`;
  return `
  SELECT b.*,
    (NOT b.has_photo) AS missing_photo,
    (b.delivery_condition = 'to_customer' AND NOT b.has_signature) AS missing_signature,
    (NOT b.has_gps) AS missing_gps,
    (CASE WHEN b.has_photo THEN 0 ELSE 1 END
     + CASE WHEN ${sigCounts} THEN 1 ELSE 0 END
     + CASE WHEN b.has_gps THEN 0 ELSE 1 END)::int AS missing_count,
    (CASE WHEN ${requireSignature ? `b.delivery_condition = 'to_customer'` : "false"}
          THEN 3 ELSE 2 END)::int AS required_count
  FROM base b`;
};

const STATE_FILTERS = {
  all: "",
  complete: "AND p.missing_count = 0",
  incomplete: "AND p.missing_count > 0",
  no_photo: "AND p.missing_photo",
  no_signature: "AND p.missing_signature",
  no_gps: "AND p.missing_gps",
  // ບໍ່ມີຫຼັກຖານເລີຍ — ບິນທີ່ຄວນຖາມກ່ອນໝູ່
  none: "AND p.missing_count >= p.required_count",
};

/** ລາຍການບິນ ພ້ອມທຸງວ່າມີຮູບ/ລາຍເຊັນ/GPS ບໍ (ບໍ່ດຶງຮູບອອກມາ). */
async function getPodTracking(opts = {}) {
  // hasOwn ບໍ່ແມ່ນ STATE_FILTERS[x]: ຄ່າແປກໆຢ່າງ 'constructor' ຈະດຶງໄດ້ຈາກ
  // prototype ແລ້ວຖືກຕໍ່ເຂົ້າ SQL.
  const stateFilter = Object.prototype.hasOwnProperty.call(STATE_FILTERS, opts.state)
    ? STATE_FILTERS[opts.state]
    : STATE_FILTERS.all;
  const limit = Math.min(Math.max(Number(opts.limit ?? 300), 1), 1000);
  const flags = podFlagsSql(Boolean(opts.requireSignature));
  const { sql, params } = podBaseCte(opts);
  params.push(limit);

  return query(
    `WITH base AS (${sql}), pod AS (${flags})
     SELECT * FROM pod p
     WHERE true ${stateFilter}
     ORDER BY p.missing_count DESC, p.closed_ts DESC NULLS LAST, p.bill_no
     LIMIT $${params.length}`,
    params
  );
}

/**
 * ສະຫຼຸບທັງຊ່ວງ (ບໍ່ຖືກ limit ຂອງລາຍການ) + ຄົນຂັບທີ່ຂາດຫຼາຍສຸດ + ລາຍຊື່ຄົນຂັບ
 * ໄວ້ເຮັດ dropdown ໃຫ້ກົງກັບຂໍ້ມູນທີ່ມີແທ້ໃນຊ່ວງນັ້ນ.
 */
async function getPodSummary(opts = {}) {
  const flags = podFlagsSql(Boolean(opts.requireSignature));
  const { sql, params } = podBaseCte(opts);

  const [totals, byDriver, drivers] = await Promise.all([
    queryOne(
      `WITH base AS (${sql}), pod AS (${flags})
       SELECT COUNT(*)::int AS bills,
              COUNT(*) FILTER (WHERE p.missing_count = 0)::int AS complete,
              COUNT(*) FILTER (WHERE p.missing_count >= p.required_count)::int AS no_proof,
              COUNT(*) FILTER (WHERE p.missing_photo)::int AS missing_photo,
              COUNT(*) FILTER (WHERE p.missing_signature)::int AS missing_signature,
              COUNT(*) FILTER (WHERE p.missing_gps)::int AS missing_gps,
              COUNT(*) FILTER (WHERE p.delivery_condition = 'to_customer')::int AS to_customer_bills,
              -- ຄວາມຄືບໜ້າການເກັບລາຍເຊັນ (ນັບເຖິງແມ່ນຕອນຍັງບໍ່ບັງຄັບ)
              COUNT(*) FILTER (WHERE p.has_signature)::int AS with_signature,
              COALESCE(SUM(p.photo_count), 0)::int AS photos
       FROM pod p`,
      params
    ),
    query(
      `WITH base AS (${sql}), pod AS (${flags})
       SELECT p.driver_code, p.driver_name,
              COUNT(*)::int AS bills,
              COUNT(*) FILTER (WHERE p.missing_count > 0)::int AS incomplete,
              COUNT(*) FILTER (WHERE p.missing_photo)::int AS missing_photo,
              COUNT(*) FILTER (WHERE p.missing_signature)::int AS missing_signature,
              COUNT(*) FILTER (WHERE p.missing_gps)::int AS missing_gps
       FROM pod p
       GROUP BY p.driver_code, p.driver_name
       HAVING COUNT(*) FILTER (WHERE p.missing_count > 0) > 0
       ORDER BY incomplete DESC, bills DESC
       LIMIT 20`,
      params
    ),
    query(
      `WITH base AS (${sql}), pod AS (${flags})
       SELECT DISTINCT p.driver_code AS code, p.driver_name AS name
       FROM pod p
       WHERE p.driver_code <> ''
       ORDER BY name`,
      params
    ),
  ]);

  return { totals: totals ?? {}, by_driver: byDriver, drivers };
}

/**
 * ຟີດສົດ — ບິນທີ່ຫາກໍປິດ ຮຽງໃໝ່ສຸດກ່ອນ ສຳລັບເບິ່ງແບບ realtime ວ່າຄົນຂັບປິດ
 * ການຈັດສົ່ງດ້ວຍຫຼັກຖານແນວໃດ.
 *
 * ອີງ sent_end (ເວລາລາວ, ຂຽນດ້ວຍ LOCALTIMESTAMP) ບໍ່ແມ່ນ create_date_time_now
 * ຂອງ ERP ທີ່ເປັນ UTC. ບໍ່ດຶງ base64 ຂອງຮູບ — ໜ້າຈໍໂຫຼດຮູບເປັນລາຍບິນເມື່ອຕ້ອງການ
 * ບໍ່ດັ່ງນັ້ນທຸກໆຮອບ poll ຈະດຶງເປັນສິບ MB.
 *
 * @param {{ session: any, fromDate: string, toDate: string, minutes?: number, limit?: number, branch?: string, driver?: string, requireSignature?: boolean }} opts
 */
async function getPodLiveFeed(opts = {}) {
  const minutes = Math.min(Math.max(Number(opts.minutes ?? 720), 5), 4320);
  const limit = Math.min(Math.max(Number(opts.limit ?? 60), 1), 200);
  const flags = podFlagsSql(Boolean(opts.requireSignature));

  // fromDate/toDate ມາຈາກ action (ຍ້ອນຫຼັງ 2-3 ມື້) — ກວ້າງກວ່າ minutes ໄວ້ກັນ
  // ຖ້ຽວທີ່ date_logistic ເປັນມື້ວານ ແຕ່ຄົນຂັບຫາກໍປິດຕອນຂ້າມມື້. ຕົວກັ່ນຕອງແທ້
  // ຂອງຟີດຄື sent_end ຂ້າງລຸ່ມ.
  const { sql, params } = podBaseCte(opts);
  params.push(minutes, limit);
  const minutesParam = `$${params.length - 1}`;
  const limitParam = `$${params.length}`;

  return query(
    `WITH base AS (${sql}), pod AS (${flags})
     SELECT p.*,
            EXTRACT(EPOCH FROM (LOCALTIMESTAMP - p.closed_ts))::int AS closed_seconds_ago
     FROM pod p
     WHERE p.closed_ts IS NOT NULL
       AND p.closed_ts >= LOCALTIMESTAMP - (${minutesParam} || ' minutes')::interval
     ORDER BY p.closed_ts DESC
     LIMIT ${limitParam}`,
    params
  );
}

/**
 * ຫຼັກຖານເຕັມຂອງບິນດຽວ — ບ່ອນດຽວທີ່ດຶງ base64 ຂອງຮູບອອກມາ.
 * ບິນໜຶ່ງອາດຢູ່ຫຼາຍຖ້ຽວ (ສົ່ງທະຍອຍ) ຈຶ່ງຮັບ doc_no ມານຳ.
 */
async function getPodBillProof(billNo, docNo) {
  const bill = String(billNo ?? "").trim();
  if (!bill) return null;
  const doc = String(docNo ?? "").trim();

  const params = [bill];
  let docFilter = "";
  if (doc) {
    params.push(doc);
    docFilter = `AND d.doc_no = $${params.length}`;
  }

  const row = await queryOne(
    `SELECT d.bill_no, d.doc_no,
            to_char(d.doc_date, 'DD-MM-YYYY') AS doc_date,
            to_char(t.date_logistic, 'DD-MM-YYYY') AS delivery_date,
            to_char(d.sent_start, 'DD-MM-YYYY HH24:MI') AS started_at,
            to_char(d.checkin_at, 'DD-MM-YYYY HH24:MI') AS checkin_at,
            to_char(d.sent_end, 'DD-MM-YYYY HH24:MI') AS closed_at,
            COALESCE(d.cust_code, '') AS cust_code,
            COALESCE(NULLIF(TRIM(c.name_1), ''), d.cust_code, '-') AS cust_name,
            COALESCE(NULLIF(TRIM(d.telephone), ''), NULLIF(TRIM(c.telephone), ''), '') AS telephone,
            COALESCE(NULLIF(TRIM(dr.name_1), ''), t.driver, '-') AS driver_name,
            COALESCE(NULLIF(TRIM(car.name_1), ''), t.car, '-') AS car_name,
            COALESCE(NULLIF(TRIM(tt.name_1), ''), '') AS transport_name,
            ${CONDITION_SQL} AS delivery_condition,
            COALESCE(d.forward_transport_code, '') AS forward_transport_code,
            COALESCE(d.lat_end, '') AS lat_end,
            COALESCE(d.lng_end, '') AS lng_end,
            COALESCE(d.remark, '') AS remark,
            COALESCE(d.collected_amount, 0)::numeric AS collected_amount,
            COALESCE(d.url_img, '') AS url_img,
            COALESCE(d.sight_img, '') AS sight_img,
            COALESCE(d.recipt_img, '') AS recipt_img,
            COALESCE(d.recipt_sign_img, '') AS recipt_sign_img,
            COALESCE(img.delivery_images, ARRAY[]::text[]) AS delivery_images,
            COALESCE(it.selected_qty, 0)::numeric AS selected_qty,
            COALESCE(it.delivered_qty, 0)::numeric AS delivered_qty,
            COALESCE(it.returned_qty, 0)::numeric AS returned_qty
       FROM public.odg_tms_detail d
       INNER JOIN public.odg_tms t ON t.doc_no = d.doc_no
       LEFT JOIN ar_customer c ON c.code = d.cust_code
       LEFT JOIN public.odg_tms_driver dr ON dr.code = t.driver
       LEFT JOIN public.odg_tms_car car ON car.code = t.car
       LEFT JOIN public.transport_type tt ON tt.code = t.origin_transport_code
       LEFT JOIN LATERAL (
         SELECT array_agg(di.image_data ORDER BY di.created_at ASC, di.roworder ASC) AS delivery_images
         FROM public.odg_tms_delivery_images di
         WHERE di.bill_no = d.bill_no
       ) img ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(i.selected_qty), 0) AS selected_qty,
                COALESCE(SUM(i.delivered_qty), 0) AS delivered_qty,
                COALESCE(SUM(i.returned_qty), 0) AS returned_qty
         FROM public.odg_tms_detail_item i
         WHERE i.doc_no = d.doc_no AND i.bill_no = d.bill_no
       ) it ON true
      WHERE d.bill_no = $1
        ${docFilter}
        AND ${getFixedYearSqlFilter("d.doc_date")}
      ORDER BY d.sent_end DESC NULLS LAST
      LIMIT 1`,
    params
  );

  return row ?? null;
}

module.exports = {
  getPodTracking,
  getPodSummary,
  getPodLiveFeed,
  getPodBillProof,
};
