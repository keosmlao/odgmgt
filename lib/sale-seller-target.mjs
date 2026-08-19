/**
 * How much of the plan one salesperson carries.
 *
 * Lifted out of app/api/sales-summary so the Sales vs Delivery comparison can
 * show the same ເປົ້າ per person. Two pages that each spelled this out would
 * drift the first time the claim rules change, and the board, the summary and
 * the comparison would then disagree about the same person's number.
 *
 * The rule, unchanged from where it came from: a plan row is claimed by the
 * assignment row that names it most precisely, ties broken by who actually
 * sold the most into it, and each plan row is only ever counted once.
 * Managers own no plan row — their board figure is the roll-up of the sellers
 * under them, so counting it here would count the plan twice.
 * See app/api/sales-assignments for the roll-up the board displays.
 */
import { claimableChannelSql, isManagerSql } from "./sales-board-roles.mjs";
import { SELLER_TABLE } from "./sale-monthly-sql.mjs";

/**
 * @param {object} options
 * @param {string} options.sellerTable  rollup the tie-break reads (defaults to SELLER_TABLE)
 * @param {string} options.channelClause extra `AND st.sale_channel = ANY(...)` style filter, or ""
 * @param {string} options.scope        `WHERE ...` applied to the outer assignment rows, or ""
 * @param {boolean} options.bySegment   also break the figure down by the BU and
 *   channel of the plan row it came from, adding target_bu / target_channel
 *   columns and one row per (person × BU × channel). Off by default, so the
 *   plain per-person shape /sales-summary reads is byte-identical to before.
 * @returns {string} SQL taking params: [year, year, ...channelParams, ...scopeParams]
 */
export function sellerTargetSql({
  sellerTable = SELLER_TABLE, channelClause = "", scope = "", bySegment = false,
} = {}) {
  // The plan row carries the BU and channel; the assignment that claims it only
  // carries the BU, so the segment has to be read off `st` and dragged through
  // owner/share rather than recovered at the end.
  const segCols = bySegment ? ", st.bu_code AS target_bu, st.sale_channel AS target_channel" : "";
  const segOwner = bySegment ? ", c.target_bu, c.target_channel" : "";
  const segShare = bySegment ? ", target_bu, target_channel" : "";
  const segOut = bySegment ? ", share.target_bu, share.target_channel" : "";
  const segGroup = bySegment ? ", share.target_bu, share.target_channel" : "";
  return `
      WITH act AS (
        SELECT b.id AS assignment_id, COALESCE(SUM(sm.sum_amount), 0) AS amount
        FROM public.odg_sales_assignment b
        LEFT JOIN ${sellerTable} sm
          ON sm.yeardoc=%s AND sm.sale_id=b.sale_id AND sm.monthdoc=b.month
         AND sm.bu_code=b.bu_code
         AND (b.province_code='ALL' OR sm.province=b.province_code)
         AND (b.district_code='ALL' OR sm.amper=b.district_code)
         AND (b.channel_codes IS NULL OR array_length(b.channel_codes,1) IS NULL
              OR sm.channel_code = ANY(b.channel_codes))
        GROUP BY b.id
      ),
      claim AS (
        SELECT b.id AS assignment_id, st.id AS target_id, st.target_amount${segCols},
               (CASE WHEN b.province_code <> 'ALL' THEN 2 ELSE 0 END
                + CASE WHEN b.district_code <> 'ALL' THEN 1 ELSE 0 END) AS specificity
        FROM public.odg_sales_assignment b
        JOIN public.odg_sales_target st
          ON st.target_year=%s AND st.target_month=b.month AND st.bu_code=b.bu_code
         -- 'ALL' is a wildcard on either side; see app/api/sales-assignments.
         AND (b.province_code='ALL' OR st.province_code='ALL' OR st.province_code=b.province_code)
         AND (b.district_code='ALL' OR st.district_code='ALL' OR st.district_code=b.district_code)
         AND ${claimableChannelSql("b", "st")}
         ${channelClause}
        -- Managers own no plan row: their number is the sum of what their
        -- sellers carry, so counting it here would count the plan twice.
        -- See app/api/sales-assignments for the roll-up the board displays.
        WHERE NOT ${isManagerSql("b")}
      ),
      owner AS (
        SELECT DISTINCT ON (c.target_id) c.target_id, c.assignment_id, c.target_amount${segOwner}
        FROM claim c
        LEFT JOIN act ON act.assignment_id = c.assignment_id
        ORDER BY c.target_id, c.specificity DESC, act.amount DESC NULLS LAST, c.assignment_id
      ),
      share AS (
        SELECT assignment_id${segShare}, SUM(target_amount) AS amount
        FROM owner GROUP BY assignment_id${segShare}
      )
      SELECT a.sale_id, COALESCE(NULLIF(a.sale_name,''),a.sale_id) AS sale_name${segOut},
             COALESCE(SUM(share.amount),0)::float AS target
      FROM public.odg_sales_assignment a
      LEFT JOIN share ON share.assignment_id = a.id
      ${scope}
      GROUP BY a.sale_id, sale_name${segGroup}`;
}
