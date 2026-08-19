/**
 * Shared definition of the monthly rollup so the refresh job and the API
 * routes can never drift apart.
 */
export const MONTHLY_TABLE = "public.odg_sale_monthly";

/**
 * The same rollup with the salesperson added.
 *
 * odg_sale_detail records who the customer was and where, but not who sold it —
 * that lives on the bill header, ic_trans.sale_code — so the seller has to be
 * joined back on doc_no. Kept as a second table rather than a column on
 * MONTHLY_TABLE because splitting that one by seller would change its grain,
 * and its pre-counted `orders` / `customers` would then double-count anyone who
 * bought from two sellers in a month.
 *
 * Read by the Sales Assignment grid, where each row is one person's area: the
 * seller-less rollup would give every seller sharing a district that district's
 * whole baht, and several sellers really do share one.
 */
export const SELLER_TABLE = "public.odg_sale_seller_month";

/**
 * Its DDL, exported so the refresh script and the rebuild the API triggers both
 * create the same thing — the table is newer than the deploys that read it, and
 * whichever runs first has to be able to make it.
 */
export const SELLER_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS ${SELLER_TABLE} (
     yeardoc      int  NOT NULL,
     monthdoc     int  NOT NULL,
     sale_id      text NOT NULL,
     bu_code      text NOT NULL,
     channel_code text NOT NULL,
     province     text NOT NULL,
     amper        text NOT NULL,
     sum_amount   numeric NOT NULL DEFAULT 0,
     orders       int     NOT NULL DEFAULT 0,
     refreshed_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (yeardoc, monthdoc, sale_id, bu_code, channel_code, province, amper)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ossm_year_sale
     ON ${SELLER_TABLE} (yeardoc, sale_id, monthdoc)`,
];

/**
 * Normalizes a sale row onto an ar_group channel code:
 *   101 ຂາຍໜ້າຮ້ານ · 102 ຂາຍສົ່ງ · 103 ໂຄງການ · 104 ພະນັກງານ
 *   106 ຂາຍຊ່າງ · 107 ອອນລາຍ · 108 ຕົວແທນຂາຍ
 * Staff purchases are tagged on the AR group, and the service BU records every
 * row as "ບໍລິການ", so both are resolved before the channel name is used.
 */
export const CHANNEL_CODE_SQL = `
  CASE
    WHEN COALESCE(NULLIF(argroup_main, ''), argroup, '') IN ('104', 'ພະນັກງານ') THEN '104'
    WHEN bu_code = '16' THEN
      CASE WHEN COALESCE(NULLIF(argroup_main, ''), argroup, '') IN ('103', 'ໂຄງການ', 'ຂາຍໂຄງການ')
        THEN '103' ELSE '101' END
    ELSE
      CASE COALESCE(NULLIF(channel_name, ''), argroup, argroup_main, argroupsub, '')
        WHEN 'ຂາຍໜ້າຮ້ານ' THEN '101'
        WHEN 'ຂາຍສົ່ງ' THEN '102'
        WHEN 'ຂາຍໂຄງການ' THEN '103'
        WHEN 'ໂຄງການ' THEN '103'
        WHEN 'ພະນັກງານ' THEN '104'
        WHEN 'ຂາຍຊ່າງ' THEN '106'
        WHEN 'ອອນລາຍ' THEN '107'
        WHEN 'ຂາຍອອນລາຍ' THEN '107'
        WHEN 'ຕົວແທນຂາຍ' THEN '108'
        ELSE 'OTHER'
      END
  END`;

/** Channel code → the display name used across the app. */
export const CHANNEL_NAMES = {
  101: "ຂາຍໜ້າຮ້ານ",
  102: "ຂາຍສົ່ງ",
  103: "ຂາຍໂຄງການ",
  104: "ພະນັກງານ",
  106: "ຂາຍຊ່າງ",
  107: "ຂາຍອອນລາຍ",
  108: "ຕົວແທນຂາຍ",
};
