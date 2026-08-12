/**
 * Shared definition of the monthly rollup so the refresh job and the API
 * routes can never drift apart.
 */
export const MONTHLY_TABLE = "public.odg_sale_monthly";

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
