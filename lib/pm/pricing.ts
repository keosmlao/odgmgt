import { pool } from "@/lib/pm/db";

// Editable SALE prices per customer group (C-1 price management). Reads/writes
// ic_inventory_price. Only sale groups (cust_group_2 <> '') are editable here —
// cost groups (cust_group_1 9/10) are computed by SML and left untouched.
// A price change UPDATEs sale_price1/2 of the *current active* row (the one whose
// [from_date, to_date] contains today), targeted precisely by roworder (PK).

export const PRICE_GROUP_LABEL: Record<string, string> = {
  "10101": "ຂາຍໜ້າຮ້ານ",
  "10102": "ອອນລາຍ",
  "10201": "ຂາຍສົ່ງ",
  "10202": "ຊ່າງ",
  "10203": "ໂມເດີນເທດ",
  "10204": "ຂາຍສົ່ງ ປາກເຊ",
  "10205": "ໂມເດີນເທດ ປາກເຊ",
};
export const PRICE_CURRENCY: Record<string, string> = { "01": "฿", "02": "₭" };

export type EditablePrice = {
  roworder: number;
  group_code: string;
  group_label: string;
  currency_code: string;
  currency_sign: string;
  unit: string;
  price: string;
  from_date: string | null;
  to_date: string | null;
};

// Current active sale-price row per (group, currency) for an item.
export async function getEditableSalePrices(code: string): Promise<EditablePrice[]> {
  const { rows } = await pool.query<{
    roworder: number;
    group_code: string;
    currency_code: string;
    unit: string;
    price: string;
    from_date: string | null;
    to_date: string | null;
  }>(
    `SELECT DISTINCT ON (cust_group_2, currency_code)
            roworder,
            cust_group_2 AS group_code,
            COALESCE(currency_code, '') AS currency_code,
            COALESCE(unit_code, '') AS unit,
            COALESCE(sale_price1, 0)::text AS price,
            from_date::text AS from_date,
            to_date::text AS to_date
       FROM ic_inventory_price
      WHERE ic_code = $1
        AND COALESCE(cust_group_2, '') <> ''
        AND CURRENT_DATE BETWEEN from_date AND to_date
      ORDER BY cust_group_2, currency_code, from_date DESC`,
    [code],
  );
  return rows
    .map((r) => ({
      ...r,
      group_label: PRICE_GROUP_LABEL[r.group_code] ?? r.group_code,
      currency_sign: PRICE_CURRENCY[r.currency_code] ?? r.currency_code,
    }))
    // stable, human order: retail → wholesale → the rest, LAK before THB within a group
    .sort((a, b) => a.group_code.localeCompare(b.group_code) || b.currency_code.localeCompare(a.currency_code));
}

// Update the price of one active row, targeted by roworder. Returns rows affected.
// Verifies the row belongs to the item and is a sale group (defensive).
export async function updateSalePrice(roworder: number, code: string, price: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE ic_inventory_price
        SET sale_price1 = $3, sale_price2 = $3
      WHERE roworder = $1 AND ic_code = $2 AND COALESCE(cust_group_2, '') <> ''`,
    [roworder, code, price],
  );
  return (rowCount ?? 0) > 0;
}
