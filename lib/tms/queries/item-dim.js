// ຂະໜາດສິນຄ້າຈາກ master data ເກົ່າ (ODG TMS) — ສະເພາະການອ່ານ DB.
//
// ສອງຕາຕະລາງນີ້ມີຢູ່ກ່ອນລະບົບ TMS ແລ້ວ ແລະ ຄຸມສິນຄ້າໄດ້ບໍ່ຫຼາຍ (528 + 354
// ລາຍການ ສ່ວນຫຼາຍເປັນເຄື່ອງເຮືອນ/ເຄື່ອງໄຟຟ້າ) ແຕ່ເປັນຂໍ້ມູນທີ່ວັດມາຈິງ
// ຈຶ່ງໃຫ້ຄວາມສຳຄັນສູງສຸດ.
//
// ⚠️ odg_item_size.m3 ຄິດຜິດ 10 ເທົ່າ (ເອົາ height/10 ແທນ /100) — ຢ່າໃຊ້
// ຄໍລັມນັ້ນ ໃຫ້ຄິດຈາກ width × length × height ເອົາເອງ.
//
// ຂະໜາດຢູ່ສອງຕາຕະລາງນີ້ເປັນ numeric ທັງໝົດ (pg driver ຄືນມາເປັນ string ເຊິ່ງ
// ຊັ້ນ lib ແປງໃຫ້) — ຢ່າໃສ່ TRIM() ໃສ່ ຈະຜິດ: btrim(numeric) ບໍ່ມີໃນ Postgres.
const { query } = require("../lib/db");

/**
 * ຂະໜາດຕໍ່ຫົວໜ່ວຍ ຂອງລາຍການທີ່ຂໍມາ. odg_item_size ມາກ່ອນ ເພາະມີ stackable
 * ແລະ ຄຸມກວ້າງກວ່າ, ຕົກໄປໃຊ້ odg_wms_product_dimension ເມື່ອບໍ່ມີ.
 */
async function getMasterItemDims(itemCodes) {
  const codes = Array.from(
    new Set((itemCodes ?? []).map((code) => String(code ?? "").trim()).filter(Boolean))
  );
  if (codes.length === 0) return [];

  return query(
    `SELECT z.ic_code AS item_code,
            NULLIF(TRIM(z.unit_code), '') AS unit_code,
            z.width AS width_cm,
            z.length AS length_cm,
            z.height AS height_cm,
            z.gweight AS weight_kg,
            z.stackable,
            'odg_item_size' AS origin
       FROM public.odg_item_size z
      WHERE z.ic_code = ANY($1::varchar[])
        AND z.width > 0 AND z.length > 0 AND z.height > 0
     UNION ALL
     SELECT w.ic_code, NULLIF(TRIM(w.ic_unit_code), ''),
            w.width, w.length, w.height, w.weight, w.stack,
            'odg_wms_product_dimension'
       FROM public.odg_wms_product_dimension w
      WHERE w.ic_code = ANY($1::varchar[])
        AND w.width > 0 AND w.length > 0 AND w.height > 0
        AND NOT EXISTS (
          SELECT 1 FROM public.odg_item_size z2
           WHERE z2.ic_code = w.ic_code AND z2.width > 0
        )`,
    [codes]
  );
}

/**
 * ໝວດສິນຄ້າ (ໝວດໃຫຍ່ + ໝວດຍ່ອຍ) ຂອງລາຍການທີ່ຂໍມາ.
 * ic_inventory.group_main → ic_group (2 ຕົວ) · group_sub → ic_group_sub (4 ຕົວ)
 */
async function getItemCategories(itemCodes) {
  const codes = Array.from(
    new Set((itemCodes ?? []).map((code) => String(code ?? "").trim()).filter(Boolean))
  );
  if (codes.length === 0) return [];

  return query(
    `SELECT inv.code AS item_code,
            NULLIF(TRIM(inv.group_main), '') AS group_main,
            NULLIF(TRIM(inv.group_sub), '')  AS group_sub,
            COALESCE(NULLIF(TRIM(gm.name_1), ''), NULLIF(TRIM(inv.group_main), '')) AS group_main_name,
            COALESCE(NULLIF(TRIM(gs.name_1), ''), NULLIF(TRIM(inv.group_sub), ''))  AS group_sub_name
       FROM public.ic_inventory inv
       LEFT JOIN public.ic_group gm ON gm.code = NULLIF(TRIM(inv.group_main), '')
       LEFT JOIN public.ic_group_sub gs ON gs.code = NULLIF(TRIM(inv.group_sub), '')
      WHERE inv.code = ANY($1::varchar[])`,
    [codes]
  );
}

module.exports = { getMasterItemDims, getItemCategories };
