/**
 * Who answers for what on the Sales Assignment board.
 *
 * Not read from odg_position.is_manager. That flag belongs to a POSITION, and
 * the three people titled ຫົວໜ້າໜວຍງານ are not interchangeable here — two of
 * them run a BU's wholesale number and the third does not — so a position-wide
 * flag cannot express it. It is also per BU: ຄຳປ້ອງ runs BU 12 but still sells
 * inside BU 14, and a person flagged manager everywhere would roll up a plan
 * they do not run.
 *
 * A manager OWNS NO PLAN ROW. Their board figure is a roll-up of what the
 * sellers under them carry, so counting it would count the plan twice; see the
 * ເປົ້າ comment in app/api/sales-assignments.
 *
 *   buCode "*" — every BU whose plan has the channel (a company-wide job).
 *   channels   — the plan channels this person answers for, so the roll-up is
 *                that channel's number and not the whole BU's.
 */
export const BOARD_MANAGERS = [
  { saleId: "24058", buCode: "13", channels: ["102"] }, // ธีรวุฒิ — ຂາຍສົ່ງ ປະປາ
  { saleId: "24044", buCode: "11", channels: ["102"] }, // ชุมพล — ຂາຍສົ່ງ ໄຟຟ້າ
  { saleId: "24044", buCode: "15", channels: ["102"] }, // ชุมพล — ຂາຍສົ່ງ BU 15
  { saleId: "25070", buCode: "12", channels: ["102"] }, // ຄຳປ້ອງ — ຂາຍສົ່ງ ແອ
  { saleId: "19001", buCode: "14", channels: ["102"] }, // ເຈມ — ຂາຍສົ່ງ ອາໄຫຼ່
  { saleId: "25016", buCode: "*", channels: ["103"] }, // ธนาธร — ຂາຍໂຄງການ, ທຸກ BU
];

/**
 * SQL predicate: is the assignment row aliased `alias` a manager row?
 *
 * Written as a VALUES list rather than a table because the roster is small and
 * changing it is a code review, not a data edit — who carries a BU's number is
 * a decision, and it should be visible in the diff.
 */
export const isManagerSql = (alias) => {
  const pairs = BOARD_MANAGERS.map(
    (m) => `('${m.saleId}','${m.buCode}')`,
  ).join(", ");
  return `EXISTS (
    SELECT 1 FROM (VALUES ${pairs}) AS bm(sale_id, bu_code)
    WHERE bm.sale_id = ${alias}.sale_id
      AND (bm.bu_code = '*' OR bm.bu_code = ${alias}.bu_code)
  )`;
};

/**
 * ຂາຍໜ້າຮ້ານ. Counter work: a shop plan is only ever claimed by a row that
 * names the channel outright.
 *
 * A row with no channels means "every channel", which used to sweep the shop
 * plan onto field sellers — 182,000,000 of it landed on seven people who work
 * provinces, while the ຂົວຫຼວງ counter staff who actually ring it up are kept
 * off the board. So it is excluded unless deliberately assigned.
 */
export const STOREFRONT_CHANNEL = "101";

/**
 * ERP sale department → the BU it sells for.
 *
 * erp_user.department is where a salesperson's department really lives, and its
 * code carries both halves: the first three digits are the product line, the
 * last one the channel. 2011 is ຂາຍສົ່ງເຄື່ອງໃຊ້ໄຟຟ້າ — wholesale, BU 11 — and
 * 2032 is ຂາຍໜ້າຮ້ານປະປາ. Only the product half is mapped here; the channel half
 * is not used to narrow an assignment, because a seller's department says which
 * goods they sell, not which of the channels they may be given.
 *
 * A department outside this table is not a sales department at all — ສາງ 5001,
 * ຈັດຊື້ 3001, ບັນຊີ 6001 — and someone posted to one of those has no business
 * carrying a BU's plan, however many bills carry their code.
 *
 * Kept as prefixes rather than matched on the Lao name: "ໄຟຟ້າຂະໜາດນ້ອຍ"
 * contains "ໄຟຟ້າ", so name matching silently files BU 15 under BU 11.
 */
export const DEPARTMENT_BU = {
  201: "11", // ເຄື່ອງໃຊ້ໄຟຟ້າ
  202: "12", // ແອ
  203: "13", // ປະປາ
  204: "14", // ອາໄຫຼ່
  206: "15", // ໄຟຟ້າຂະໜາດນ້ອຍ
  400: "16", // ບໍລິການ → ສູນບໍລິການ
};

/**
 * SQL for (sale_id, bu_code) pairs a person's department allows.
 *
 * erp_user.department holds a comma-separated list for anyone covering two
 * lines ("2021,2024"), so it is split rather than compared whole.
 */
export const SELLER_DEPARTMENT_BU_SQL = `
  SELECT DISTINCT btrim(u.code) AS sale_id, m.bu_code
  FROM public.erp_user u
  CROSS JOIN LATERAL unnest(string_to_array(COALESCE(u.department, ''), ',')) AS d(dept)
  JOIN (VALUES ${Object.entries(DEPARTMENT_BU)
    .map(([prefix, bu]) => `('${prefix}','${bu}')`)
    .join(", ")}) AS m(prefix, bu_code)
    ON m.prefix = left(btrim(d.dept), 3)`;

/**
 * SQL: may the assignment row aliased `alias` claim plan row `target`?
 * Everything is claimable except a storefront plan the row does not name.
 */
export const claimableChannelSql = (alias, target) => `(
  ${alias}.channel_codes IS NULL
  OR array_length(${alias}.channel_codes, 1) IS NULL
  OR ${target}.sale_channel = ANY(${alias}.channel_codes)
  OR ${target}.sale_channel = 'ALL'
) AND (
  ${target}.sale_channel <> '${STOREFRONT_CHANNEL}'
  OR '${STOREFRONT_CHANNEL}' = ANY(COALESCE(${alias}.channel_codes, '{}'))
)`;
