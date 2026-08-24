import { NextResponse } from "next/server";
import { one, rows } from "@/lib/db";
import { parseIntSafe, safeDiv } from "@/lib/helpers";
import { getCurrentUser } from "@/lib/route-auth";
import { OWNER_CODES } from "@/lib/employee-auth";
import { OVERRIDE_JOIN, REPORT_DATE } from "@/lib/sale-month-override";
import { channelCodeSql, CHANNEL_NAMES } from "@/lib/sale-monthly-sql.mjs";
import {
  isRegionKey,
  provinceLabel,
  provincesOf,
  REGIONS,
  regionOf,
} from "@/lib/sales-regions.mjs";

/** ທຸກລະຫັດແຂວງທີ່ຮູ້ຈັກ — ໃຊ້ພິສູດ "ບໍ່ລະບຸພື້ນທີ່" ດ້ວຍການປະຕິເສດ. */
const KNOWN_PROVINCES = REGIONS.flatMap((region) => region.provinces);

/**
 * ພາບລວມການຂາຍ — the executives' sales page.
 *
 * One question per block, the first being the only one that matters on the 24th
 * of a month: where does this month land if nothing changes, and how far is that
 * from the plan. Everything else on the page cuts that same number by BU, by
 * channel, by region.
 *
 * ACT comes from odg_sale_detail on REPORT_DATE (a bill approved into an earlier
 * month counts where it was credited), the plan from odg_sales_target — the same
 * two sources as ສະຫຼຸບເດືອນ, so the two pages cannot drift apart.
 */

/** ໜ້ານີ້ຂອງຜູ້ບໍລິຫານ ແລະ ຄົນທີ່ຖືກອະນຸຍາດ — ພະນັກງານຂາຍທົ່ວໄປບໍ່ເຫັນ. */
const ALLOWED_ROLES = new Set(["ceo", "gm", "sale_bu_manager", "sale_supervisor"]);

const BU_NAMES = {
  11: "ໄຟຟ້າ",
  12: "ແອ",
  13: "ປະປາ",
  14: "ອາໄຫຼ່",
  15: "ໄຟຟ້ານ້ອຍ",
  16: "ສູນບໍລິການ",
  17: "ອອນລາຍ",
};

/** ຄ່າທີ່ແອັບບັນທຶກໄວ້ເປັນອັງກິດ — ແປໃຫ້ຜູ້ອ່ານລາຍງານ. */
const VISIT_OUTCOME = {
  followup: "ຕ້ອງຕິດຕາມຕໍ່",
  negotiation: "ກຳລັງເຈລະຈາ",
  not_interested: "ບໍ່ສົນໃຈ",
  order: "ໄດ້ອໍເດີ",
  won: "ປິດການຂາຍໄດ້",
  lost: "ເສຍລູກຄ້າ",
};

const VISIT_TYPE = {
  visit: "ເຂົ້າພົບ",
  call: "ໂທຫາ",
  other: "ອື່ນໆ",
};

/** ກຸ່ມລູກຄ້າ ຕາມທີ່ odg_customer_health ຈັດໄວ້. */
const SEGMENT_LABEL = {
  repeat: "ຊື້ຊ້ຳ",
  one_time: "ຊື້ເທື່ອດຽວ",
  new: "ລູກຄ້າໃໝ່",
  at_risk: "ສ່ຽງເສຍ",
  lapsed: "ຫາຍໄປ",
  dormant: "ນອນ (ບໍ່ຊື້ 1 ປີ)",
};

const PLAN_STATUS = {
  planned: "ວາງແຜນໄວ້",
  checked_in: "ເຊັກອິນແລ້ວ",
  completed: "ເຮັດແລ້ວ",
  skipped: "ຂ້າມ",
};

const OPPORTUNITY_STAGE = {
  new: "ໃໝ່",
  qualify: "ກວດຄຸນສົມບັດ",
  proposal: "ສະເໜີລາຄາ",
  negotiation: "ເຈລະຈາ",
  won: "ປິດໄດ້",
  lost: "ເສຍ",
};

const daysInMonth = (year, month) => new Date(year, month, 0).getDate();

/**
 * ວັນຂາຍ — ວັນອາທິດບໍ່ນັບ. ຮ້ານປິດວັນອາທິດ, ແລະ ຄາດການທີ່ຫານດ້ວຍວັນປະຕິທິນ
 * ຈະຕໍ່າກວ່າຄວາມຈິງທຸກເດືອນທີ່ມີ 5 ວັນອາທິດ.
 */
function sellingDays(year, month, throughDay) {
  const last = Math.min(throughDay ?? daysInMonth(year, month), daysInMonth(year, month));
  let count = 0;
  for (let day = 1; day <= last; day += 1) {
    if (new Date(year, month - 1, day).getDay() !== 0) count += 1;
  }
  return count;
}

/** ຍ້ອນຫຼັງ n ເດືອນ ຈາກ (year, month). */
function monthsBack(year, month, count) {
  const list = [];
  for (let step = 1; step <= count; step += 1) {
    const index = year * 12 + (month - 1) - step;
    list.push({ year: Math.floor(index / 12), month: (index % 12) + 1 });
  }
  return list;
}

/**
 * ຄືກັບ ສະຫຼຸບເດືອນ: ສະແຕມທີ່ຂະຫຍັບທຸກຄັ້ງທີ່ແຫຼ່ງຂໍ້ມູນຂະຫຍັບ ເພື່ອຄຳຕອບເກົ່າ
 * ຢູ່ໃນ cache ບໍ່ໄດ້ອາຍຸຍາວກວ່າຂໍ້ມູນຂອງມັນ.
 */
async function readSourceStamp(years) {
  const row = await one(
    `SELECT to_char(MAX(d.doc_date), 'YYYY-MM-DD') AS data_through,
            COUNT(*)::text AS source_rows,
            (SELECT COUNT(*)::text || '@' || COALESCE(MAX(created_at)::text, '-')
               FROM public.app_sale_month_override) AS override_stamp
     FROM public.odg_sale_detail d
     WHERE d.yeardoc = ANY(%s::int[])`,
    [years],
  );
  return {
    data_through: row?.data_through ?? null,
    stamp: `${row?.source_rows ?? "0"}|${row?.data_through ?? "-"}|${row?.override_stamp ?? "-"}`,
  };
}

const cache = new Map();
const CACHE_MAX = 32;
const inFlight = new Map();

function once(key, task) {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = task().finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

/**
 * ໜຶ່ງສະແກນ ຮັບໃຊ້ທຸກຕົວກັ່ນຕອງ: ດຶງມາເປັນກ້ອນຕາມ (ປີ · ເດືອນ · BU · ຊ່ອງທາງ ·
 * ແຂວງ · ກ່ອນວັນຕັດ) ແລ້ວກັ່ນຕອງໃນ JS. ຖ້າໃສ່ WHERE ຕາມຕົວເລືອກຜູ້ໃຊ້ແທນ ທຸກ
 * ການກົດ chip ໜຶ່ງເທື່ອ = ສະແກນຕາຕະລາງ 2.7 GB ໃໝ່ອີກເທື່ອໜຶ່ງ.
 */
const bucketCache = new Map();

function loadBuckets(years, cutDay, stamp) {
  const key = `${years.join("-")}|${cutDay}|${stamp}`;
  const held = bucketCache.get(key);
  if (held) return Promise.resolve(held);
  const sql = `
    SELECT EXTRACT(YEAR FROM ${REPORT_DATE})::int AS year,
           EXTRACT(MONTH FROM ${REPORT_DATE})::int AS month,
           COALESCE(NULLIF(d.bu_code, ''), '-') AS bu_code,
           ${channelCodeSql("d.doc_no")} AS channel_code,
           COALESCE(NULLIF(d.province, ''), '-') AS province,
           (EXTRACT(DAY FROM ${REPORT_DATE})::int <= %s) AS before_cut,
           COALESCE(SUM(d.sum_amount), 0)::float AS amount
    FROM public.odg_sale_detail d
    ${OVERRIDE_JOIN}
    WHERE EXTRACT(YEAR FROM ${REPORT_DATE})::int = ANY(%s::int[])
    GROUP BY 1, 2, 3, 4, 5, 6`;
  return once(key, async () => {
    const loaded = await rows(sql, [cutDay, years]);
    // ໜຶ່ງກ້ອນຕໍ່ໜຶ່ງສະແຕມ — ກົດ chip ປ່ຽນຕົວກັ່ນຕອງແລ້ວບໍ່ຕ້ອງສະແກນຄືນ.
    if (bucketCache.size >= 4) bucketCache.clear();
    bucketCache.set(key, loaded);
    return loaded;
  });
}

/**
 * ລາຍລະອຽດຂອງຂອບເຂດທີ່ເລືອກ — ຄຳຖາມດຽວຄືນທຸກຢ່າງທີ່ຕ້ອງແຍກເປັນລາຍແຖວ
 * (ລາຍວັນ · ທິມຂາຍ · ລູກຄ້າ · ສ່ວນຫຼຸດ & ກຳໄລ). ຖ້າແຍກເປັນຄຳຖາມລະອັນ
 * ໜ້າໜຶ່ງເທື່ອ = ສະແກນຕາຕະລາງການຂາຍສີ່ຮອບ.
 */
function scopeDetailSql(whereExtra) {
  return `
    WITH scope AS (
      SELECT ${REPORT_DATE} AS report_date,
             EXTRACT(MONTH FROM ${REPORT_DATE})::int AS month,
             EXTRACT(DAY FROM ${REPORT_DATE})::int AS day,
             d.doc_no,
             COALESCE(NULLIF(d.bu_code, ''), '-') AS bu_code,
             ${channelCodeSql("d.doc_no")} AS channel_code,
             COALESCE(NULLIF(d.province, ''), '-') AS province,
             COALESCE(NULLIF(d.salename, ''), 'ບໍ່ລະບຸ') AS sale_name,
             COALESCE(NULLIF(d.customer_code, ''), '-') AS customer_code,
             COALESCE(NULLIF(d.customername, ''), d.customer_code, '-') AS customer_name,
             COALESCE(NULLIF(d.branch_name, ''), 'ບໍ່ລະບຸ') AS branch_name,
             COALESCE(NULLIF(d.itemmaingroup, ''), 'ບໍ່ລະບຸ') AS item_group,
             d.sum_amount::float AS amount,
             -- ສ່ວນຫຼຸດເອົາ discount_amount_2: discount_amount ເກັບເປັນເງິນກີບ
             -- ຕົ້ນສະບັບ (ບວກເຂົ້າກັນແລ້ວໄດ້ 460 ລ້ານ ຈາກຍອດ 54 ລ້ານ), ສ່ວນ _2
             -- ແມ່ນຫົວໜ່ວຍດຽວກັບ sum_amount.
             COALESCE(d.discount_amount_2, 0)::float AS discount,
             COALESCE(d.profit, 0)::float AS profit
      FROM public.odg_sale_detail d
      ${OVERRIDE_JOIN}
      WHERE EXTRACT(YEAR FROM ${REPORT_DATE})::int = %s
        AND EXTRACT(MONTH FROM ${REPORT_DATE})::int BETWEEN %s AND %s
    ), kept AS (
      SELECT * FROM scope ${whereExtra ? `WHERE ${whereExtra}` : ""}
    )
    SELECT json_build_object(
      'daily', (
        SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.day), '[]'::json) FROM (
          SELECT day, SUM(amount)::float AS amount, COUNT(DISTINCT doc_no)::int AS bills
          FROM kept WHERE month = %s GROUP BY day
        ) x
      ),
      'sellers', (
        SELECT COALESCE(json_agg(row_to_json(x)), '[]'::json) FROM (
          SELECT sale_name, SUM(amount)::float AS amount, COUNT(DISTINCT doc_no)::int AS bills
          FROM kept GROUP BY sale_name ORDER BY 2 DESC LIMIT 12
        ) x
      ),
      'customers', (
        SELECT COALESCE(json_agg(row_to_json(x)), '[]'::json) FROM (
          SELECT customer_code, MAX(customer_name) AS customer_name,
                 SUM(amount)::float AS amount, COUNT(DISTINCT doc_no)::int AS bills
          FROM kept GROUP BY customer_code ORDER BY 3 DESC LIMIT 12
        ) x
      ),
      'provinces', (
        SELECT COALESCE(json_agg(row_to_json(x)), '[]'::json) FROM (
          SELECT province, SUM(amount)::float AS amount
          FROM kept GROUP BY province ORDER BY 2 DESC LIMIT 10
        ) x
      ),
      'branches', (
        SELECT COALESCE(json_agg(row_to_json(x)), '[]'::json) FROM (
          SELECT branch_name, SUM(amount)::float AS amount
          FROM kept GROUP BY branch_name ORDER BY 2 DESC LIMIT 8
        ) x
      ),
      'groups', (
        SELECT COALESCE(json_agg(row_to_json(x)), '[]'::json) FROM (
          SELECT item_group, SUM(amount)::float AS amount
          FROM kept GROUP BY item_group ORDER BY 2 DESC LIMIT 10
        ) x
      ),
      -- ຮົ່ວໄຫຼ: ເງິນທີ່ອອກຈາກຍອດໂດຍບໍ່ໄດ້ຕັ້ງໃຈ — ສິນຄ້າສົ່ງຄືນ, ແຖວທີ່ຂາຍຕໍ່າ
      -- ກວ່າຕົ້ນທຶນ, ແລະ ບິນທີ່ຫຼຸດເກີນ 10% ຂອງລາຄາເຕັມ.
      'leak', (
        SELECT row_to_json(x) FROM (
          SELECT
            COALESCE(SUM(amount) FILTER (WHERE amount < 0), 0)::float AS returns,
            COUNT(DISTINCT doc_no) FILTER (WHERE amount < 0)::int AS return_bills,
            COALESCE(SUM(profit) FILTER (WHERE profit < 0), 0)::float AS loss_lines_profit,
            COUNT(*) FILTER (WHERE profit < 0)::int AS loss_lines,
            COALESCE(SUM(discount) FILTER (WHERE discount > amount * 0.1), 0)::float AS deep_discount
          FROM kept
        ) x
      ),
      'totals', (
        SELECT row_to_json(x) FROM (
          SELECT SUM(amount)::float AS amount,
                 SUM(discount)::float AS discount,
                 SUM(profit)::float AS profit,
                 COUNT(DISTINCT customer_code)::int AS customers,
                 COUNT(DISTINCT doc_no)::int AS bills
          FROM kept
        ) x
      )
    ) AS payload`;
}

/**
 * Call card — ການເຂົ້າພົບລູກຄ້າ ທີ່ພະນັກງານຂາຍບັນທຶກຜ່ານແອັບ salewole
 * (public.app_customer_visit, ຖານດຽວກັນ). ເລີ່ມເກັບ 08/2026 ຈຶ່ງຍັງໜ້ອຍ —
 * ບລ໋ອກນີ້ຈຶ່ງບອກຈຳນວນທີ່ມີຈິງໄວ້ ບໍ່ໃຫ້ອ່ານຜິດວ່າທັງທິມອອກພົບເທົ່ານີ້.
 *
 * ຮັບເດືອນເລີ່ມ–ເດືອນຈົບ ຂອງປີທີ່ເລືອກ ຄືກັບບລ໋ອກອື່ນ; ບໍ່ມີ BU/ພາກ ໃນຕາຕະລາງ
 * ຈຶ່ງບໍ່ຖືກຫັ່ນດ້ວຍສອງຕົວນັ້ນ.
 *
 * ⚠️ ຄະແນນຄຸນນະພາບ (checklist · ສຳຫຼວດສະຕັອກ · ຮູບ) ຄັດລອກສູດມາຈາກ salewole
 * ບ່ອນ src/lib/visit-quality.ts ທຸກປະການ — ນັບສະເພາະການ "ໄປຮອດຮ້ານ" ທີ່ເຊັກເອົາ
 * ແລ້ວ. ນິຍາມເປັນຂອງ salewole ເຈົ້າຂອງແອັບ; ຢູ່ນີ້ພຽງອ່ານມາສະແດງ ຈຶ່ງບໍ່ຕ້ອງ
 * ແກ້ສອງລະບົບເມື່ອຢາກເບິ່ງຕົວເລກນີ້ ແລະ ສອງບ່ອນຈະບໍ່ໃຫ້ຄ່າຄົນລະຢ່າງ. ຖ້າ
 * salewole ປ່ຽນສູດ ຕ້ອງມາປ່ຽນບ່ອນນີ້ນຳ.
 */
const VISIT_SQL = `
  WITH scope AS (
    SELECT v.id, v.employee_code, v.customer_code, v.status, v.outcome, v.visit_type,
           v.visited_at::date AS day,
           COALESCE(v.order_amount, 0)::float AS order_amount,
           COALESCE(v.collection_amount, 0)::float AS collection_amount,
           (v.checked_out_at IS NOT NULL) AS checked_out
    FROM public.app_customer_visit v
    WHERE EXTRACT(YEAR FROM v.visited_at)::int = %s
      AND EXTRACT(MONTH FROM v.visited_at)::int BETWEEN %s AND %s
  )
  SELECT json_build_object(
    'totals', (
      SELECT row_to_json(x) FROM (
        SELECT COUNT(*)::int AS visits,
               COUNT(DISTINCT employee_code)::int AS people,
               COUNT(DISTINCT customer_code)::int AS customers,
               COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
               COUNT(*) FILTER (WHERE NOT checked_out)::int AS open_visits,
               COALESCE(SUM(order_amount), 0)::float AS order_amount,
               COALESCE(SUM(collection_amount), 0)::float AS collection_amount
        FROM scope
      ) x
    ),
    'people', (
      SELECT COALESCE(json_agg(row_to_json(x)), '[]'::json) FROM (
        SELECT s.employee_code,
               COALESCE(NULLIF(e.fullname_lo, ''), NULLIF(e.fullname_en, ''), s.employee_code) AS name,
               COUNT(*)::int AS visits,
               COUNT(DISTINCT s.customer_code)::int AS customers,
               COUNT(*) FILTER (WHERE s.status = 'completed')::int AS completed
        FROM scope s
        LEFT JOIN public.odg_employee e ON e.employee_code = s.employee_code
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 12
      ) x
    ),
    'outcomes', (
      SELECT COALESCE(json_agg(row_to_json(x)), '[]'::json) FROM (
        SELECT COALESCE(NULLIF(outcome, ''), 'ບໍ່ໄດ້ບັນທຶກ') AS outcome, COUNT(*)::int AS visits
        FROM scope GROUP BY 1 ORDER BY 2 DESC
      ) x
    ),
    'types', (
      SELECT COALESCE(json_agg(row_to_json(x)), '[]'::json) FROM (
        SELECT COALESCE(NULLIF(visit_type, ''), 'ບໍ່ລະບຸ') AS visit_type, COUNT(*)::int AS visits
        FROM scope GROUP BY 1 ORDER BY 2 DESC
      ) x
    ),
    'quality', (
      SELECT row_to_json(x) FROM (
        SELECT COUNT(*)::int AS visits,
               COALESCE(AVG(CASE WHEN total_items > 0
                                 THEN LEAST(1.0, answered::float / total_items) ELSE 0 END), 0)::float AS checklist,
               COALESCE(AVG(CASE WHEN has_stock THEN 1.0 ELSE 0.0 END), 0)::float AS stock,
               COALESCE(AVG(CASE WHEN has_photo THEN 1.0 ELSE 0.0 END), 0)::float AS photo
        FROM (
          SELECT v.id,
                 (SELECT COUNT(*)::int FROM public.odg_sale_visit_checklist c
                   WHERE c.visit_id = v.id
                     AND (c.done OR COALESCE(NULLIF(TRIM(c.value), ''), '') <> '')) AS answered,
                 (SELECT COUNT(*)::int FROM public.odg_sale_checklist_item i
                   WHERE i.is_active) AS total_items,
                 EXISTS (SELECT 1 FROM public.odg_sale_stock_check s WHERE s.visit_id = v.id) AS has_stock,
                 EXISTS (SELECT 1 FROM public.odg_sale_visit_photo p WHERE p.visit_id = v.id) AS has_photo
          FROM public.app_customer_visit v
          WHERE v.id IN (SELECT id FROM scope)
            AND v.checked_out_at IS NOT NULL
            AND COALESCE(v.visit_type, 'visit') = 'visit'
        ) q
      ) x
    ),
    'first_day', (SELECT MIN(day)::text FROM scope),
    'last_day', (SELECT MAX(day)::text FROM scope)
  ) AS payload`;

/**
 * ສຸຂະພາບລູກຄ້າ — public.odg_customer_health, ຕາຕະລາງທີ່ salewole ສ້າງໄວ້ ແລະ
 * ໜ້ານີ້ຍັງບໍ່ເຄີຍອ່ານ: ໜຶ່ງແຖວຕໍ່ໜຶ່ງລູກຄ້າ ພ້ອມຄະແນນສຸຂະພາບ, ກຸ່ມ (ຊື້ຊ້ຳ ·
 * ຊື້ເທື່ອດຽວ · ສ່ຽງ · ຫາຍ · ນອນ), ຍອດ 365 ວັນ ແລະ ມື້ທີ່ງຽບໄປ.
 *
 * ມີ province_code ແລະ channel ຢູ່ໃນຕາຕະລາງ ຈຶ່ງຫັ່ນຕາມພາກ ແລະ ຊ່ອງທາງໄດ້;
 * ບໍ່ມີ BU ຈຶ່ງບໍ່ຫັ່ນຕາມ BU.
 */
const healthSql = (whereExtra) => `
  SELECT json_build_object(
    'segments', (
      SELECT COALESCE(json_agg(row_to_json(x)), '[]'::json) FROM (
        SELECT segment, COUNT(*)::int AS customers,
               COALESCE(SUM(sales_365), 0)::float AS sales_365,
               ROUND(AVG(health))::int AS health
        FROM public.odg_customer_health h
        ${whereExtra ? `WHERE ${whereExtra}` : ""}
        GROUP BY segment ORDER BY 2 DESC
      ) x
    ),
    'at_risk', (
      SELECT COALESCE(json_agg(row_to_json(x)), '[]'::json) FROM (
        SELECT customer_code, name, COALESCE(sales_365, 0)::float AS sales_365,
               quiet_days, health
        FROM public.odg_customer_health h
        WHERE segment IN ('at_risk', 'lapsed') AND COALESCE(sales_365, 0) > 0
          ${whereExtra ? `AND ${whereExtra}` : ""}
        ORDER BY sales_365 DESC LIMIT 8
      ) x
    ),
    'totals', (
      SELECT row_to_json(x) FROM (
        SELECT COUNT(*)::int AS customers,
               ROUND(AVG(health))::int AS health,
               COUNT(*) FILTER (WHERE segment IN ('at_risk', 'lapsed'))::int AS slipping,
               COALESCE(SUM(sales_365) FILTER (WHERE segment IN ('at_risk', 'lapsed')), 0)::float AS slipping_value
        FROM public.odg_customer_health h
        ${whereExtra ? `WHERE ${whereExtra}` : ""}
      ) x
    )
  ) AS payload`;

/**
 * ແຜນເຂົ້າພົບ (app_route_plan) ແລະ ທໍ່ຂາຍ (app_opportunity · odg_quote).
 * ສາມຕາຕະລາງນີ້ຫາກໍເລີ່ມໃຊ້ ຈຶ່ງມີແຖວໜ້ອຍ — ໜ້າຈະບອກຈຳນວນຈິງໄວ້ນຳ.
 */
const PLAN_SQL = `
  SELECT json_build_object(
    'plans', (
      SELECT COALESCE(json_agg(row_to_json(x)), '[]'::json) FROM (
        SELECT status, COUNT(*)::int AS plans
        FROM public.app_route_plan
        WHERE EXTRACT(YEAR FROM planned_date)::int = %s
          AND EXTRACT(MONTH FROM planned_date)::int BETWEEN %s AND %s
        GROUP BY status ORDER BY 2 DESC
      ) x
    ),
    'opportunities', (
      SELECT COALESCE(json_agg(row_to_json(x)), '[]'::json) FROM (
        SELECT stage, COUNT(*)::int AS deals, COALESCE(SUM(value), 0)::float AS value
        FROM public.app_opportunity GROUP BY stage ORDER BY 3 DESC
      ) x
    ),
    'quotes', (SELECT COUNT(*)::int FROM public.odg_quote)
  ) AS payload`;

/** ໜີ້ຄ້າງ ແລະ ສະຕັອກ — ຕາຕະລາງນ້ອຍ, ບໍ່ຂຶ້ນກັບຕົວກັ່ນຕອງຂອງໜ້າ. */
const AR_SQL = `
  SELECT COALESCE(SUM(balance_amount), 0)::float AS balance,
         COALESCE(SUM(balance_amount) FILTER (WHERE COALESCE(date_diff, 0) > 0), 0)::float AS overdue,
         COALESCE(SUM(balance_amount) FILTER (WHERE COALESCE(date_diff, 0) BETWEEN 1 AND 30), 0)::float AS d1_30,
         COALESCE(SUM(balance_amount) FILTER (WHERE COALESCE(date_diff, 0) BETWEEN 31 AND 60), 0)::float AS d31_60,
         COALESCE(SUM(balance_amount) FILTER (WHERE COALESCE(date_diff, 0) BETWEEN 61 AND 90), 0)::float AS d61_90,
         COALESCE(SUM(balance_amount) FILTER (WHERE COALESCE(date_diff, 0) > 90), 0)::float AS d90p,
         COUNT(DISTINCT ar_code)::int AS customers
  FROM public.odg_ar_aging`;

/**
 * ໜີ້ຄ້າງແບບເຕັມ — ຫຼາຍກວ່າຍອດລວມ: ອາຍຸໜີ້, ໃຜເປັນເຈົ້າຂອງ (ພະນັກງານຂາຍ),
 * ສາຂາໃດອອກບິນ, ບິນເກົ່າສຸດ, ແລະ ລູກຄ້າທີ່ໃຊ້ວົງເງິນເກີນ. ໜີ້ 75 ລ້ານ ບອກໄດ້
 * ພຽງວ່າມີໜີ້; "ຂອງໃຜ ຄ້າງມາດົນປານໃດ" ຄືສິ່ງທີ່ຕາມເກັບໄດ້.
 */
const AR_BY_SALE_SQL = `
  SELECT COALESCE(NULLIF(TRIM(sale_name), ''), 'ບໍ່ລະບຸ') AS name,
         COALESCE(SUM(balance_amount), 0)::float AS balance,
         COALESCE(SUM(balance_amount) FILTER (WHERE COALESCE(date_diff, 0) > 0), 0)::float AS overdue,
         COUNT(DISTINCT ar_code)::int AS customers
  FROM public.odg_ar_aging
  GROUP BY 1 ORDER BY 2 DESC LIMIT 8`;

const AR_BY_BRANCH_SQL = `
  SELECT COALESCE(NULLIF(TRIM(branch), ''), 'ບໍ່ລະບຸ') AS name,
         COALESCE(SUM(balance_amount), 0)::float AS balance
  FROM public.odg_ar_aging
  GROUP BY 1 ORDER BY 2 DESC LIMIT 6`;

/** ບິນທີ່ຄ້າງດົນສຸດ — ອັນທີ່ຄວນຕັດສິນໃຈວ່າຈະຕາມ ຫຼື ຕັດໜີ້ສູນ. */
const AR_OLDEST_SQL = `
  SELECT a.doc_no,
         COALESCE(NULLIF(TRIM(c.name_1), ''), a.ar_code) AS name,
         COALESCE(a.balance_amount, 0)::float AS balance,
         COALESCE(a.date_diff, 0)::int AS days
  FROM public.odg_ar_aging a
  LEFT JOIN public.ar_customer c ON c.code = a.ar_code
  WHERE COALESCE(a.balance_amount, 0) > 0
  ORDER BY a.date_diff DESC NULLS LAST LIMIT 6`;

/** ວົງເງິນເຄຣດິດທີ່ໃຊ້ເກີນ — ຄວາມສ່ຽງທີ່ອະນຸມັດຂາຍຕໍ່ໄປບໍ່ໄດ້. */
const AR_CREDIT_SQL = `
  SELECT COUNT(*)::int AS customers,
         COALESCE(SUM(debt_balance), 0)::float AS balance
  FROM public.odg_customer_health
  WHERE credit_used_pct > 100`;

/**
 * ⚠️ odg_ar_aging ເກັບແຕ່ ar_code ບໍ່ມີຊື່ລູກຄ້າ — ຊື່ຢູ່ public.ar_customer.
 * ກ່ອນນີ້ຄຳຖາມນີ້ອ້າງ ar_name ທີ່ບໍ່ມີຈິງ ແລ້ວ .catch() ກືນ error ໄປ ບລ໋ອກຈຶ່ງ
 * ຫວ່າງເປົ່າໂດຍບໍ່ມີໃຜຮູ້.
 */
const AR_TOP_SQL = `
  SELECT COALESCE(NULLIF(TRIM(c.name_1), ''), a.ar_code) AS name,
         COALESCE(SUM(a.balance_amount), 0)::float AS balance,
         COALESCE(MAX(a.date_diff), 0)::int AS days
  FROM public.odg_ar_aging a
  LEFT JOIN public.ar_customer c ON c.code = a.ar_code
  GROUP BY 1 ORDER BY 2 DESC LIMIT 8`;

const STOCK_SQL = `
  SELECT COALESCE(SUM(stockamount) FILTER (WHERE stockqty > 0), 0)::float AS stock_value,
         COUNT(*) FILTER (WHERE stockqty > 0)::int AS items,
         COALESCE(SUM(stockamount) FILTER (WHERE stockqty > 0 AND COALESCE(sale_90, 0) = 0), 0)::float AS dead_value,
         COUNT(*) FILTER (WHERE stockqty > 0 AND COALESCE(sale_90, 0) = 0)::int AS dead_items,
         COALESCE(SUM(stockamount) FILTER (WHERE stockqty > 0 AND agingday > 360), 0)::float AS over_360
  FROM public.odg_stock_aging`;

const targetSql = `
  SELECT bu_code, target_month AS month, sale_channel,
         COALESCE(NULLIF(province_code, ''), 'ALL') AS province_code,
         COALESCE(SUM(target_amount), 0)::float AS amount
  FROM public.odg_sales_target
  WHERE target_year = %s
  GROUP BY 1, 2, 3, 4`;

/** ແຖວເປົ້າເກັບຊ່ອງທາງເປັນລະຫັດ ຫຼື ຊື່ — ດຶງລົງເປັນລະຫັດອັນດຽວ. */
function normalizeTargetChannel(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "ALL";
  if (/^\d+$/.test(raw)) return raw;
  const byName = {
    ຂາຍໜ້າຮ້ານ: "101",
    ຂາຍສົ່ງ: "102",
    ຂາຍໂຄງການ: "103",
    ໂຄງການ: "103",
    ພະນັກງານ: "104",
    ຂາຍຊ່າງ: "106",
    ອອນລາຍ: "107",
    ຂາຍອອນລາຍ: "107",
    ຕົວແທນຂາຍ: "108",
  };
  return byName[raw] || (raw.toUpperCase() === "ALL" ? "ALL" : raw);
}

/** ຈັດອັນດັບ ແລະ ຄິດສ່ວນແບ່ງ — ໃຊ້ທັງ ແຍກຕາມ BU ແລະ ແຍກຕາມຊ່ອງທາງ. */
function ranked(map, names) {
  const total = [...map.values()].reduce((sum, value) => sum + value, 0);
  return [...map.entries()]
    .map(([code, amount]) => ({
      code,
      label: names[code] || code,
      amount,
      share: safeDiv(amount, total) * 100,
    }))
    .filter((row) => row.amount !== 0)
    .sort((a, b) => b.amount - a.amount);
}

export async function GET(request) {
  const user = getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const role = String(user.role || "").toLowerCase();
  const isOwner = OWNER_CODES.has(String(user.username || ""));
  if (!isOwner && !ALLOWED_ROLES.has(role)) {
    return NextResponse.json({ success: false, error: "forbidden" }, { status: 403 });
  }

  try {
    const sp = request.nextUrl.searchParams;
    const now = new Date();
    const year = parseIntSafe(sp.get("year"), now.getFullYear());
    const month = Math.min(12, Math.max(1, parseIntSafe(sp.get("month"), now.getMonth() + 1)));
    const mode = sp.get("mode") === "ytd" ? "ytd" : "month";
    const regionParam = String(sp.get("region") || "ALL").toUpperCase();
    const region = isRegionKey(regionParam) || regionParam === "U" ? regionParam : "ALL";

    // ຫົວໜ້າ BU ເຫັນສະເພາະ BU ແລະ ຊ່ອງທາງຂອງຕົນ ບໍ່ວ່າຈະສົ່ງ ?bu= ມາແນວໃດ.
    let bu = String(sp.get("bu") || "ALL");
    let channel = String(sp.get("channel") || "ALL");
    if (role === "sale_bu_manager" && !isOwner) {
      if (user.bu_code) bu = String(user.bu_code);
      if (Array.isArray(user.channel_codes) && user.channel_codes.length && channel === "ALL") {
        channel = user.channel_codes.map(String).join(",");
      }
    }
    const buWanted = bu === "ALL" ? null : new Set(bu.split(",").map((code) => code.trim()));
    const channelWanted =
      channel === "ALL" ? null : new Set(channel.split(",").map((code) => code.trim()));
    const provinceWanted =
      region === "ALL" ? null : new Set(region === "U" ? [] : provincesOf(region));

    const lastYear = year - 1;
    /** ສາມປີ — ປີນີ້ ທຽບປີກ່ອນ ແລະ ປີກ່ອນນັ້ນ, ຢູ່ໃນສະແກນອັນດຽວກັນ. */
    const trendYears = [year, lastYear, year - 2];
    const source = await readSourceStamp([year, lastYear]);

    /**
     * ວັນຕັດ: ຖ້າເດືອນທີ່ເລືອກຄືເດືອນທີ່ຂໍ້ມູນຢຸດຢູ່ ໃຫ້ຕັດຢູ່ວັນນັ້ນ (ເດືອນຍັງບໍ່ຈົບ);
     * ເດືອນທີ່ຜ່ານໄປແລ້ວ ໃຊ້ວັນສຸດທ້າຍຂອງເດືອນ. ວັນຕັດອັນດຽວກັນນີ້ຖືກໃຊ້ຄືນກັບ 12
     * ເດືອນຫຼ້າສຸດ ເພື່ອວັດອະຄະຕິຂອງຄາດການ — ທຽບຢູ່ຈຸດດຽວກັນຂອງເດືອນຈຶ່ງຍຸດຕິທຳ.
     */
    const through = source.data_through ? new Date(`${source.data_through}T00:00:00`) : now;
    const isRunningMonth =
      through.getFullYear() === year && through.getMonth() + 1 === month;
    const cutDay = isRunningMonth ? through.getDate() : daysInMonth(year, month);

    const cacheKey = `${year}|${month}|${mode}|${region}|${bu}|${channel}|${cutDay}|${source.stamp}`;
    const cached = cache.get(cacheKey);
    const force = /^(1|true|force)$/i.test(String(sp.get("refresh") || ""));
    if (!force && cached) return NextResponse.json(cached);

    /**
     * ຈຳນວນບິນ ນັບຈາກ doc_no ບໍ່ຊ້ຳ ຈຶ່ງບວກຕໍ່ຈາກກ້ອນຂ້າງເທິງບໍ່ໄດ້ (ບິນໜຶ່ງມີໄດ້
     * ຫຼາຍ BU) — ຄຳຖາມແຍກ ຖືຕົວກັ່ນຕອງອັນດຽວກັນ.
     */
    const billWhere = [];
    const billParams = [year, month];
    if (buWanted) {
      billWhere.push("x.bu_code = ANY(%s::text[])");
      billParams.push([...buWanted]);
    }
    if (channelWanted) {
      billWhere.push("x.channel_code = ANY(%s::text[])");
      billParams.push([...channelWanted]);
    }
    if (provinceWanted) {
      billWhere.push(
        region === "U" ? "NOT (x.province = ANY(%s::text[]))" : "x.province = ANY(%s::text[])",
      );
      billParams.push(region === "U" ? KNOWN_PROVINCES : [...provinceWanted]);
    }
    const billSql = `
      SELECT COUNT(DISTINCT x.doc_no)::int AS bills
      FROM (
        SELECT d.doc_no,
               COALESCE(NULLIF(d.bu_code, ''), '-') AS bu_code,
               ${channelCodeSql("d.doc_no")} AS channel_code,
               COALESCE(NULLIF(d.province, ''), '-') AS province
        FROM public.odg_sale_detail d
        ${OVERRIDE_JOIN}
        WHERE EXTRACT(YEAR FROM ${REPORT_DATE})::int = %s
          AND EXTRACT(MONTH FROM ${REPORT_DATE})::int = %s
      ) x
      ${billWhere.length ? `WHERE ${billWhere.join(" AND ")}` : ""}`;

    /** ຕົວກັ່ນຕອງອັນດຽວກັນ ຂຽນເປັນ SQL ໃຫ້ຄຳຖາມລາຍລະອຽດ. */
    // ລຳດັບພາຣາມິເຕີຕ້ອງຕາມລຳດັບທີ່ %s ປາກົດໃນ SQL: ປີ · ເດືອນເລີ່ມ · ເດືອນຈົບ ·
    // ຕົວກັ່ນຕອງ · ແລ້ວຈຶ່ງເດືອນຂອງແຖວລາຍວັນ (ຢູ່ທ້າຍສຸດ).
    const detailWhere = [];
    const detailParams = [year, mode === "ytd" ? 1 : month, month];
    if (buWanted) {
      detailWhere.push("bu_code = ANY(%s::text[])");
      detailParams.push([...buWanted]);
    }
    if (channelWanted) {
      detailWhere.push("channel_code = ANY(%s::text[])");
      detailParams.push([...channelWanted]);
    }
    if (provinceWanted) {
      detailWhere.push(
        region === "U" ? "NOT (province = ANY(%s::text[]))" : "province = ANY(%s::text[])",
      );
      detailParams.push(region === "U" ? KNOWN_PROVINCES : [...provinceWanted]);
    }
    detailParams.push(month);

    /** ຕົວກັ່ນຕອງທີ່ຕາຕະລາງສຸຂະພາບລູກຄ້າຮັບໄດ້ — ພາກ ແລະ ຊ່ອງທາງ. */
    const healthWhere = [];
    if (provinceWanted) {
      healthWhere.push(
        region === "U"
          ? `NOT (COALESCE(h.province_code, '') = ANY(ARRAY[${KNOWN_PROVINCES.map((code) => `'${code}'`).join(",")}]))`
          : `h.province_code = ANY(ARRAY[${[...provinceWanted].map((code) => `'${code}'`).join(",")}])`,
      );
    }
    if (channelWanted) {
      healthWhere.push(
        `h.channel = ANY(ARRAY[${[...channelWanted].map((code) => `'${code}'`).join(",")}])`,
      );
    }

    const [
      buckets,
      targetRows,
      billRow,
      detailRow,
      arRow,
      arTop,
      stockRow,
      visitRow,
      healthRow,
      arBySale,
      arByBranch,
      arOldest,
      arCredit,
      planRow,
    ] = await Promise.all([
      loadBuckets(trendYears, cutDay, source.stamp),
      rows(targetSql, [year]),
      one(billSql, billParams),
      one(scopeDetailSql(detailWhere.join(" AND ")), detailParams),
      one(AR_SQL).catch(() => null),
      rows(AR_TOP_SQL).catch(() => []),
      one(STOCK_SQL).catch(() => null),
      one(VISIT_SQL, [year, mode === "ytd" ? 1 : month, month]).catch(() => null),
      one(healthSql(healthWhere.join(" AND "))).catch(() => null),
      rows(AR_BY_SALE_SQL).catch(() => []),
      rows(AR_BY_BRANCH_SQL).catch(() => []),
      rows(AR_OLDEST_SQL).catch(() => []),
      one(AR_CREDIT_SQL).catch(() => null),
      one(PLAN_SQL, [year, mode === "ytd" ? 1 : month, month]).catch(() => null),
    ]);
    const detail = detailRow?.payload || {};
    const visit = visitRow?.payload || null;
    const customerHealth = healthRow?.payload || null;
    const plan = planRow?.payload || null;

    const keep = (row) => {
      if (buWanted && !buWanted.has(String(row.bu_code))) return false;
      if (channelWanted && !channelWanted.has(String(row.channel_code))) return false;
      if (!provinceWanted) return true;
      if (region === "U") return regionOf(row.province) === "U";
      return provinceWanted.has(String(row.province));
    };

    /** ຍອດຂອງເດືອນໜຶ່ງ — ທັງເດືອນ ຫຼື ສະເພາະກ່ອນວັນຕັດ. */
    const sumMonth = (targetYear, targetMonth, onlyBeforeCut = false) => {
      let total = 0;
      for (const row of buckets) {
        if (Number(row.year) !== targetYear || Number(row.month) !== targetMonth) continue;
        if (onlyBeforeCut && !row.before_cut) continue;
        if (!keep(row)) continue;
        total += Number(row.amount || 0);
      }
      return total;
    };

    const monthActual = sumMonth(year, month);
    const lastYearMonthActual = sumMonth(lastYear, month);
    let ytdActual = 0;
    let lastYearYtdActual = 0;
    for (let m = 1; m <= month; m += 1) {
      ytdActual += sumMonth(year, m);
      lastYearYtdActual += sumMonth(lastYear, m);
    }

    // ── ເປົ້າ ─────────────────────────────────────────────────────
    // ⚠️ ເປົ້າຂາຍສົ່ງເທົ່ານັ້ນທີ່ຕັ້ງເປັນລາຍແຂວງ; ໜ້າຮ້ານ/ໂຄງການ/ຊ່າງ/ອອນລາຍ/ບໍລິການ
    //    ຕັ້ງເປັນກ້ອນດຽວທັງບໍລິສັດ (province_code = 'ALL'). ເມື່ອເລືອກພາກ ຈຶ່ງນັບ
    //    ສະເພາະແຖວທີ່ມີແຂວງຈິງ — ບໍ່ດັ່ງນັ້ນທຸກພາກຈະໄດ້ເປົ້າກ້ອນນັ້ນຄົນລະເທື່ອ.
    const targetFor = (wantedMonth) => {
      let total = 0;
      for (const row of targetRows) {
        if (Number(row.month) !== wantedMonth) continue;
        if (buWanted && !buWanted.has(String(row.bu_code))) continue;
        const targetChannel = normalizeTargetChannel(row.sale_channel);
        if (channelWanted && targetChannel !== "ALL" && !channelWanted.has(targetChannel)) continue;
        const province = String(row.province_code);
        if (provinceWanted) {
          if (province === "ALL") continue;
          if (region === "U" ? regionOf(province) !== "U" : !provinceWanted.has(province)) continue;
        }
        total += Number(row.amount || 0);
      }
      return total;
    };

    const monthTarget = targetFor(month);
    let ytdTarget = 0;
    for (let m = 1; m <= month; m += 1) ytdTarget += targetFor(m);

    // ── ຄາດການສິ້ນເດືອນ ───────────────────────────────────────────
    const totalSellingDays = sellingDays(year, month);
    const elapsedSellingDays = sellingDays(year, month, cutDay);
    const remainingSellingDays = Math.max(0, totalSellingDays - elapsedSellingDays);
    const perDayActual = safeDiv(monthActual, elapsedSellingDays);
    const perDayTarget = safeDiv(monthTarget, totalSellingDays);
    const gap = Math.max(0, monthTarget - monthActual);
    const perDayRequired = remainingSellingDays ? safeDiv(gap, remainingSellingDays) : 0;
    const projected = perDayActual * totalSellingDays;

    /**
     * ອະຄະຕິຂອງຄາດການ: ຄາດການແບບຫານວັນສະເໝີຕົ້ນສະເໝີປາຍຕໍ່າກວ່າຄວາມຈິງ ເພາະ
     * ຍອດຍ້າຍໄປທ້າຍເດືອນ. ວັດຈາກ 12 ເດືອນຫຼ້າສຸດທີ່ຈົບແລ້ວ — ຄາດການ ນະ ວັນຕັດ
     * ດຽວກັນ ທຽບກັບຍອດຈິງທີ່ອອກມາ — ແລ້ວປັບຄາດການເດືອນນີ້ດ້ວຍອັດຕາສະເລ່ຍນັ້ນ.
     */
    let ratioSum = 0;
    let ratioCount = 0;
    for (const past of monthsBack(year, month, 12)) {
      if (past.year !== year && past.year !== lastYear) continue;
      const pastCut = sumMonth(past.year, past.month, true);
      const pastFull = sumMonth(past.year, past.month);
      const pastElapsed = sellingDays(past.year, past.month, cutDay);
      const pastTotal = sellingDays(past.year, past.month);
      if (!pastCut || !pastElapsed || !pastFull) continue;
      const pastProjection = safeDiv(pastCut, pastElapsed) * pastTotal;
      if (pastProjection <= 0) continue;
      ratioSum += pastFull / pastProjection;
      ratioCount += 1;
    }
    const biasRatio = ratioCount ? ratioSum / ratioCount : 1;

    // ── ແຍກຕາມ BU ແລະ ຊ່ອງທາງ (ຕາມໂໝດທີ່ເລືອກ) ──────────────────
    const scopeMonths = mode === "ytd" ? Array.from({ length: month }, (_, i) => i + 1) : [month];
    const byBu = new Map();
    const byChannel = new Map();
    const byRegion = new Map();
    for (const row of buckets) {
      if (Number(row.year) !== year || !scopeMonths.includes(Number(row.month))) continue;
      if (!keep(row)) continue;
      const amount = Number(row.amount || 0);
      const buCode = String(row.bu_code);
      const channelCode = String(row.channel_code);
      const regionKey = regionOf(row.province);
      byBu.set(buCode, (byBu.get(buCode) || 0) + amount);
      byChannel.set(channelCode, (byChannel.get(channelCode) || 0) + amount);
      byRegion.set(regionKey, (byRegion.get(regionKey) || 0) + amount);
    }

    /**
     * ສາມປີ: ຍອດລາຍເດືອນຂອງແຕ່ລະປີ — ເສັ້ນທຽບກັນ ບອກລະດູການ ແລະ ບອກວ່າ
     * ເດືອນນີ້ຜິດປົກກະຕິ ຫຼື ເປັນຮູບແບບເກົ່າຂອງມັນເອງ.
     */
    const trend = trendYears.map((trendYear) => ({
      year: trendYear,
      months: Array.from({ length: 12 }, (_, index) => sumMonth(trendYear, index + 1)),
    }));

    /**
     * ຊ່ອງຫວ່າງ: ຄູ່ (BU × ຊ່ອງທາງ) ທີ່ຕົກເປົ້າຫຼາຍສຸດ — ບ່ອນທີ່ຄວນລົງແຮງກ່ອນ.
     * ເປົ້າຢູ່ລະດັບ BU+ຊ່ອງທາງ (ບໍ່ໄດ້ແຍກແຂວງ ນອກຈາກຂາຍສົ່ງ) ຈຶ່ງຄິດສະເພາະ
     * ຕອນເບິ່ງທັງປະເທດ; ເລືອກພາກແລ້ວ ບລ໋ອກນີ້ຈະບໍ່ມີເປົ້າໃຫ້ທຽບ.
     */
    const gapRows = [];
    if (region === "ALL") {
      const actualPair = new Map();
      for (const row of buckets) {
        if (Number(row.year) !== year || !scopeMonths.includes(Number(row.month))) continue;
        if (!keep(row)) continue;
        const key = `${row.bu_code}|${row.channel_code}`;
        actualPair.set(key, (actualPair.get(key) || 0) + Number(row.amount || 0));
      }
      const targetPair = new Map();
      for (const row of targetRows) {
        if (!scopeMonths.includes(Number(row.month))) continue;
        if (buWanted && !buWanted.has(String(row.bu_code))) continue;
        const targetChannel = normalizeTargetChannel(row.sale_channel);
        if (channelWanted && targetChannel !== "ALL" && !channelWanted.has(targetChannel)) continue;
        const key = `${row.bu_code}|${targetChannel}`;
        targetPair.set(key, (targetPair.get(key) || 0) + Number(row.amount || 0));
      }
      /** ຍອດຈິງທັງ BU — ໃຊ້ກັບເປົ້າທີ່ຕັ້ງລວມທຸກຊ່ອງທາງ (ສູນບໍລິການ). */
      const actualByBu = new Map();
      for (const [key, value] of actualPair) {
        const buCode = key.split("|")[0];
        actualByBu.set(buCode, (actualByBu.get(buCode) || 0) + value);
      }
      for (const [key, target] of targetPair) {
        const [buCode, channelCode] = key.split("|");
        const actualValue =
          channelCode === "ALL" ? actualByBu.get(buCode) || 0 : actualPair.get(key) || 0;
        gapRows.push({
          label: `${BU_NAMES[buCode] || buCode} · ${
            channelCode === "ALL" ? "ທຸກຊ່ອງທາງ" : CHANNEL_NAMES[channelCode] || channelCode
          }`,
          target,
          actual: actualValue,
          gap: target - actualValue,
          pct: safeDiv(actualValue, target) * 100,
        });
      }
      gapRows.sort((a, b) => b.gap - a.gap);
    }

    /**
     * ຄວາມແມ່ນ: ຄາດການທີ່ຈະໄດ້ ນະ ວັນຕັດດຽວກັນ ຂອງ 12 ເດືອນຫຼ້າສຸດ ທຽບກັບຍອດຈິງ
     * ທີ່ອອກມາ — ຕົວດຽວກັນທີ່ໃຊ້ຄິດອະຄະຕິຂ້າງເທິງ, ວາງໃຫ້ເຫັນເປັນແຖວ.
     */
    const accuracy = monthsBack(year, month, 12)
      .filter((past) => trendYears.includes(past.year))
      .map((past) => {
        const pastCut = sumMonth(past.year, past.month, true);
        const pastFull = sumMonth(past.year, past.month);
        const pastElapsed = sellingDays(past.year, past.month, cutDay);
        const projection = safeDiv(pastCut, pastElapsed) * sellingDays(past.year, past.month);
        return {
          year: past.year,
          month: past.month,
          projected: projection,
          actual: pastFull,
          error_pct: projection ? (pastFull / projection - 1) * 100 : 0,
        };
      })
      .filter((row) => row.actual > 0)
      .reverse();

    const totals = detail.totals || {};
    const scopeAmount = Number(totals.amount || 0);
    const discount = Number(totals.discount || 0);
    const profit = Number(totals.profit || 0);
    const dailyRows = Array.isArray(detail.daily) ? detail.daily : [];
    let running = 0;
    const daily = dailyRows.map((row) => {
      running += Number(row.amount || 0);
      return {
        day: Number(row.day),
        amount: Number(row.amount || 0),
        bills: Number(row.bills || 0),
        cumulative: running,
      };
    });
    const bestDay = daily.reduce((best, row) => (row.amount > (best?.amount ?? 0) ? row : best), null);

    const rankFrom = (list, pick) => {
      const total = list.reduce((sum, row) => sum + Number(row.amount || 0), 0);
      return list.map((row) => ({
        code: String(pick(row).code),
        label: String(pick(row).label),
        amount: Number(row.amount || 0),
        share: safeDiv(Number(row.amount || 0), total) * 100,
        bills: Number(row.bills || 0),
      }));
    };

    const scopeActual = mode === "ytd" ? ytdActual : monthActual;
    const scopeTarget = mode === "ytd" ? ytdTarget : monthTarget;
    const scopeLastYear = mode === "ytd" ? lastYearYtdActual : lastYearMonthActual;

    const result = {
      success: true,
      data: {
        meta: {
          year,
          month,
          mode,
          region,
          bu,
          channel,
          last_year: lastYear,
          data_through: source.data_through,
          generated_at: new Date().toISOString(),
          running_month: isRunningMonth,
        },
        days: {
          total: totalSellingDays,
          elapsed: elapsedSellingDays,
          remaining: remainingSellingDays,
          cut_day: cutDay,
        },
        forecast: {
          projected,
          adjusted: projected * biasRatio,
          bias_pct: (biasRatio - 1) * 100,
          bias_months: ratioCount,
          target: monthTarget,
          pct_of_target: safeDiv(projected, monthTarget) * 100,
          shortfall: Math.max(0, monthTarget - projected),
          booked: monthActual,
          from_pace: Math.max(0, projected - monthActual),
        },
        month: {
          actual: monthActual,
          target: monthTarget,
          pct: safeDiv(monthActual, monthTarget) * 100,
          gap,
          per_day_actual: perDayActual,
          per_day_target: perDayTarget,
          per_day_required: perDayRequired,
          speed_up_pct: perDayActual ? (perDayRequired / perDayActual - 1) * 100 : 0,
          last_year: lastYearMonthActual,
          growth: safeDiv(monthActual, lastYearMonthActual) * 100,
          bills: Number(billRow?.bills || 0),
          avg_bill: safeDiv(monthActual, Number(billRow?.bills || 0)),
        },
        ytd: {
          actual: ytdActual,
          target: ytdTarget,
          pct: safeDiv(ytdActual, ytdTarget) * 100,
          last_year: lastYearYtdActual,
          growth: safeDiv(ytdActual, lastYearYtdActual) * 100,
        },
        scope: {
          actual: scopeActual,
          target: scopeTarget,
          pct: safeDiv(scopeActual, scopeTarget) * 100,
          last_year: scopeLastYear,
          growth: safeDiv(scopeActual, scopeLastYear) * 100,
        },
        by_bu: ranked(byBu, BU_NAMES),
        by_channel: ranked(byChannel, CHANNEL_NAMES),
        by_region: [...byRegion.entries()]
          .map(([key, amount]) => ({ code: key, amount }))
          .sort((a, b) => b.amount - a.amount),
        daily: {
          rows: daily,
          best: bestDay,
          per_day_target: perDayTarget,
        },
        trend,
        sellers: rankFrom(Array.isArray(detail.sellers) ? detail.sellers : [], (row) => ({
          code: row.sale_name,
          label: row.sale_name,
        })),
        customers: {
          rows: rankFrom(Array.isArray(detail.customers) ? detail.customers : [], (row) => ({
            code: row.customer_code,
            label: row.customer_name,
          })),
          count: Number(totals.customers || 0),
          /** ນ້ຳໜັກຂອງ 12 ລູກຄ້າໃຫຍ່ — ຄວາມສ່ຽງທີ່ຍອດຝາກໄວ້ກັບຄົນໜ້ອຍຄົນ. */
          top_share:
            safeDiv(
              (Array.isArray(detail.customers) ? detail.customers : []).reduce(
                (sum, row) => sum + Number(row.amount || 0),
                0,
              ),
              scopeAmount,
            ) * 100,
        },
        margin: {
          amount: scopeAmount,
          discount,
          discount_pct: safeDiv(discount, scopeAmount + discount) * 100,
          profit,
          gp_pct: safeDiv(profit, scopeAmount) * 100,
          bills: Number(totals.bills || 0),
        },
        ar: arRow
          ? {
              balance: Number(arRow.balance || 0),
              overdue: Number(arRow.overdue || 0),
              customers: Number(arRow.customers || 0),
              buckets: [
                { label: "1–30 ວັນ", amount: Number(arRow.d1_30 || 0) },
                { label: "31–60 ວັນ", amount: Number(arRow.d31_60 || 0) },
                { label: "61–90 ວັນ", amount: Number(arRow.d61_90 || 0) },
                { label: "ເກີນ 90 ວັນ", amount: Number(arRow.d90p || 0) },
              ],
              top: arTop.map((row) => ({
                label: String(row.name),
                amount: Number(row.balance || 0),
                days: Number(row.days || 0),
              })),
              by_sale: arBySale.map((row) => ({
                label: String(row.name),
                amount: Number(row.balance || 0),
                overdue: Number(row.overdue || 0),
                customers: Number(row.customers || 0),
              })),
              by_branch: arByBranch.map((row) => ({
                label: String(row.name),
                amount: Number(row.balance || 0),
              })),
              oldest: arOldest.map((row) => ({
                label: `${row.doc_no} · ${row.name}`,
                amount: Number(row.balance || 0),
                days: Number(row.days || 0),
              })),
              over_credit: arCredit
                ? {
                    customers: Number(arCredit.customers || 0),
                    balance: Number(arCredit.balance || 0),
                  }
                : null,
              /**
               * ໜີ້ເທົ່າກັບຍອດຂາຍຈັກມື້ (DSO ຢ່າງງ່າຍ) — ໃຊ້ຄວາມໄວການຂາຍຂອງ
               * ເດືອນນີ້ເປັນຖານ, ບອກວ່າເງິນຈົມຢູ່ກັບລູກຄ້າດົນປານໃດ.
               */
              days_of_sales: perDayActual
                ? Number(arRow.balance || 0) / perDayActual
                : 0,
            }
          : null,
        health: customerHealth
          ? {
              totals: customerHealth.totals || {},
              segments: (customerHealth.segments || []).map((row) => ({
                code: row.segment,
                label: SEGMENT_LABEL[row.segment] || row.segment,
                customers: Number(row.customers || 0),
                sales_365: Number(row.sales_365 || 0),
                health: Number(row.health || 0),
              })),
              at_risk: (customerHealth.at_risk || []).map((row) => ({
                code: row.customer_code,
                label: row.name || row.customer_code,
                amount: Number(row.sales_365 || 0),
                quiet_days: Number(row.quiet_days || 0),
                health: Number(row.health || 0),
              })),
            }
          : null,
        plan: plan
          ? {
              plans: (plan.plans || []).map((row) => ({
                label: PLAN_STATUS[row.status] || row.status,
                plans: Number(row.plans || 0),
              })),
              opportunities: (plan.opportunities || []).map((row) => ({
                label: OPPORTUNITY_STAGE[row.stage] || row.stage,
                deals: Number(row.deals || 0),
                value: Number(row.value || 0),
              })),
              quotes: Number(plan.quotes || 0),
            }
          : null,
        visits: visit
          ? {
              totals: visit.totals || {},
              people: visit.people || [],
              outcomes: (visit.outcomes || []).map((row) => ({
                label: VISIT_OUTCOME[row.outcome] || row.outcome,
                visits: Number(row.visits || 0),
              })),
              types: (visit.types || []).map((row) => ({
                label: VISIT_TYPE[row.visit_type] || row.visit_type,
                visits: Number(row.visits || 0),
              })),
              quality: visit.quality
                ? {
                    visits: Number(visit.quality.visits || 0),
                    checklist: Number(visit.quality.checklist || 0) * 100,
                    stock: Number(visit.quality.stock || 0) * 100,
                    photo: Number(visit.quality.photo || 0) * 100,
                    score:
                      ((Number(visit.quality.checklist || 0) +
                        Number(visit.quality.stock || 0) +
                        Number(visit.quality.photo || 0)) /
                        3) *
                      100,
                  }
                : null,
              first_day: visit.first_day || null,
              last_day: visit.last_day || null,
            }
          : null,
        gaps: gapRows.slice(0, 10),
        accuracy,
        dimensions: {
          provinces: (Array.isArray(detail.provinces) ? detail.provinces : []).map((row) => ({
            code: String(row.province),
            label: provinceLabel(row.province),
            amount: Number(row.amount || 0),
          })),
          branches: (Array.isArray(detail.branches) ? detail.branches : []).map((row) => ({
            code: String(row.branch_name),
            label: String(row.branch_name),
            amount: Number(row.amount || 0),
          })),
          groups: (Array.isArray(detail.groups) ? detail.groups : []).map((row) => ({
            code: String(row.item_group),
            label: String(row.item_group),
            amount: Number(row.amount || 0),
          })),
        },
        leak: detail.leak
          ? {
              returns: Number(detail.leak.returns || 0),
              return_bills: Number(detail.leak.return_bills || 0),
              loss_lines: Number(detail.leak.loss_lines || 0),
              loss_lines_profit: Number(detail.leak.loss_lines_profit || 0),
              deep_discount: Number(detail.leak.deep_discount || 0),
            }
          : null,
        stock: stockRow
          ? {
              value: Number(stockRow.stock_value || 0),
              items: Number(stockRow.items || 0),
              dead_value: Number(stockRow.dead_value || 0),
              dead_items: Number(stockRow.dead_items || 0),
              over_360: Number(stockRow.over_360 || 0),
            }
          : null,
      },
    };

    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(cacheKey, result);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
