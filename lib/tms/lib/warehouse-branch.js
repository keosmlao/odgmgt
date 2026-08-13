// ⚠️ CommonJS (.js) ໂດຍເຈດຕະນາ — src/queries/*.js require ໄຟລ໌ນີ້ ແລະ
// require() ໂຫຼດ .ts ໄດ້ສະເພາະໃນ bundler ຂອງ Next. type ຢູ່ .d.ts ຄູ່ກັນ.
// Pure warehouse→branch mapping + grouping helpers for the "ຈັດຖ້ຽວທີ່ເຫຼືອຕາມ
// ສາຂາ" split tool. Kept free of any DB/IO so it is unit-testable and can be
// required from the CommonJS query layer (src/queries/helpers.js).

// Default suggestion from a warehouse's stock-branch group
// (ic_warehouse.branch_stock) to the delivery branch it belongs to
// (transport_type.code, the "02-xxxx" carrier used for pickup/forward). There is
// NO source-of-truth table for this in the ERP, so this is a best-effort DEFAULT
// only — the split UI shows it pre-selected in a dropdown the dispatcher can
// override. An unmapped branch_stock yields an empty suggestion.
//   01 ຂົວຫຼວງ    → 02-0001 ຂົນສົ່ງໂອດ່ຽນ
//   03 ດອນຕິ້ວ     → 02-0002 ຂົນສົ່ງດອນຕິ້ວ
//   02 ໂພນສະອາດ  → 02-0007 ຂົນສົ່ງໂພນສະອາດ
//   04 ປາກເຊ      → 02-0003 ຂົນສົ່ງປາກເຊ
"use strict";

/** @type {Record<string, string>} */
const BRANCH_STOCK_TO_TRANSPORT = {
  "01": "02-0001",
  "02": "02-0007",
  "03": "02-0002",
  "04": "02-0003",
};

/**
 * @param {unknown} branchStock
 * @returns {string}
 */
function suggestTransportForBranchStock(branchStock) {
  const key = String(branchStock ?? "").trim();
  return BRANCH_STOCK_TO_TRANSPORT[key] ?? "";
}

// Fold flat (warehouse, item) rows into one entry per warehouse, attaching the
// suggested delivery branch and a remaining-qty subtotal. Order of warehouses
// follows first appearance in the input.
/**
 * @param {import("./warehouse-branch").RemainingWarehouseRow[]} rows
 * @returns {import("./warehouse-branch").RemainingWarehouseGroup[]}
 */
function groupRemainingItemsByWarehouse(rows) {
  const byWarehouse = new Map();
  for (const row of rows) {
    const whCode = String(row.wh_code ?? "");
    if (!byWarehouse.has(whCode)) {
      const branchStock = String(row.branch_stock ?? "");
      byWarehouse.set(whCode, {
        wh_code: whCode,
        wh_name: row.wh_name,
        branch_stock: branchStock,
        suggested_transport_code: suggestTransportForBranchStock(branchStock),
        items: [],
        remaining_qty_total: 0,
      });
    }
    const group = byWarehouse.get(whCode);
    const remaining = Number(row.remaining_qty ?? 0);
    group.items.push({
      item_code: row.item_code,
      item_name: row.item_name,
      unit_code: row.unit_code,
      erp_qty: Number(row.erp_qty ?? 0),
      placed_qty: Number(row.placed_qty ?? 0),
      remaining_qty: remaining,
    });
    group.remaining_qty_total += remaining;
  }
  return Array.from(byWarehouse.values());
}

module.exports = {
  BRANCH_STOCK_TO_TRANSPORT,
  suggestTransportForBranchStock,
  groupRemainingItemsByWarehouse,
};
