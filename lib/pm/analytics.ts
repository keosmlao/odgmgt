import { pool } from "@/lib/pm/db";

// Restrict a report to the logged-in owner's responsible groups. Returns a SQL
// fragment + params; `alias` is the ic_inventory alias used in the query.
function ownerClause(
  mineOf: string,
  alias: string,
  startIndex: number,
): { sql: string; params: unknown[] } {
  if (!mineOf.trim()) return { sql: "", params: [] };
  return {
    sql: `AND EXISTS (SELECT 1 FROM odg_group_responsible gr
                       WHERE gr.employee_code = $${startIndex}
                         AND gr.group_main = ${alias}.group_main
                         AND (gr.group_sub = '' OR gr.group_sub = ${alias}.group_sub))`,
    params: [mineOf.trim()],
  };
}

// ===== Stock health (from odg_stock_aging, joined to ic_inventory) =====
export type StockHealth = {
  in_stock_items: number;
  stock_value: string;
  dead_items: number;
  dead_value: string;
  b0_30: number;
  b31_90: number;
  b91_180: number;
  b181_360: number;
  b360p: number;
};

export type AgingItem = {
  code: string;
  name: string;
  brand: string;
  stockqty: string;
  stock_value: string;
  aging_days: string;
  last_sale_date: string | null;
};

export async function getStockHealth(mineOf = ""): Promise<StockHealth> {
  const oc = ownerClause(mineOf, "i", 1);
  const { rows } = await pool.query<StockHealth>(
    `SELECT count(*) FILTER (WHERE a.stockqty > 0)::int AS in_stock_items,
            COALESCE(sum(a.stockamount) FILTER (WHERE a.stockqty > 0), 0)::text AS stock_value,
            count(*) FILTER (WHERE a.stockqty > 0 AND COALESCE(a.sale_90,0) = 0)::int AS dead_items,
            COALESCE(sum(a.stockamount) FILTER (WHERE a.stockqty > 0 AND COALESCE(a.sale_90,0) = 0), 0)::text AS dead_value,
            count(*) FILTER (WHERE a.stockqty > 0 AND a.agingday <= 30)::int AS b0_30,
            count(*) FILTER (WHERE a.stockqty > 0 AND a.agingday > 30 AND a.agingday <= 90)::int AS b31_90,
            count(*) FILTER (WHERE a.stockqty > 0 AND a.agingday > 90 AND a.agingday <= 180)::int AS b91_180,
            count(*) FILTER (WHERE a.stockqty > 0 AND a.agingday > 180 AND a.agingday <= 360)::int AS b181_360,
            count(*) FILTER (WHERE a.stockqty > 0 AND a.agingday > 360)::int AS b360p
       FROM odg_stock_aging a
       JOIN ic_inventory i ON i.code = a.ic_code
      WHERE true ${oc.sql}`,
    oc.params,
  );
  return rows[0];
}

// Dead / slow stock: has stock but no sale in 90 days, worst (highest value) first.
export async function getDeadStock(mineOf = "", limit = 100, offset = 0): Promise<AgingItem[]> {
  const oc = ownerClause(mineOf, "i", 1);
  const { rows } = await pool.query<AgingItem>(
    `SELECT a.ic_code AS code, COALESCE(a.ic_name,'') AS name,
            COALESCE(a.brand,'') AS brand,
            a.stockqty::text AS stockqty,
            COALESCE(a.stockamount,0)::text AS stock_value,
            COALESCE(a.agingday,0)::text AS aging_days,
            a.last_sale_date::text AS last_sale_date
       FROM odg_stock_aging a
       JOIN ic_inventory i ON i.code = a.ic_code
      WHERE a.stockqty > 0 AND COALESCE(a.sale_90,0) = 0 ${oc.sql}
      ORDER BY a.stockamount DESC NULLS LAST
      LIMIT ${limit} OFFSET ${Math.max(0, offset)}`,
    oc.params,
  );
  return rows;
}

// ===== Sales performance (from odg_stock_aging sale_90 / avgsale) =====
export type SalesItem = {
  code: string;
  name: string;
  brand: string;
  sale_90: string;
  avg_sale: string;
  stockqty: string;
  months_cover: string | null;
};

export async function getTopSellers(mineOf = "", limit = 50): Promise<SalesItem[]> {
  const oc = ownerClause(mineOf, "i", 1);
  const { rows } = await pool.query<SalesItem>(
    `SELECT a.ic_code AS code, COALESCE(a.ic_name,'') AS name, COALESCE(a.brand,'') AS brand,
            COALESCE(a.sale_90,0)::text AS sale_90,
            COALESCE(a.avgsale,0)::text AS avg_sale,
            COALESCE(a.stockqty,0)::text AS stockqty,
            CASE WHEN COALESCE(a.avgsale,0) > 0
                 THEN round(a.stockqty / a.avgsale, 1)::text ELSE NULL END AS months_cover
       FROM odg_stock_aging a
       JOIN ic_inventory i ON i.code = a.ic_code
      WHERE COALESCE(a.sale_90,0) > 0 ${oc.sql}
      ORDER BY a.sale_90 DESC
      LIMIT ${limit}`,
    oc.params,
  );
  return rows;
}

// ===== Defects (from odg_product_defect) =====
export type DefectByBrand = { brand: string; total: number; open: number };
export type DefectItem = { code: string; name: string; brand: string; sn: string; remark: string; date: string | null; open: boolean };

export async function getDefectsByBrand(mineOf = "", limit = 20): Promise<DefectByBrand[]> {
  const oc = ownerClause(mineOf, "i", 1);
  const { rows } = await pool.query<DefectByBrand>(
    `SELECT COALESCE(NULLIF(d.item_brand,''),'ບໍ່ລະບຸ') AS brand,
            count(*)::int AS total,
            count(*) FILTER (WHERE COALESCE(d.status,0) = 0)::int AS open
       FROM odg_product_defect d
       JOIN ic_inventory i ON i.code = d.ic_code
      WHERE true ${oc.sql}
      GROUP BY COALESCE(NULLIF(d.item_brand,''),'ບໍ່ລະບຸ')
      ORDER BY count(*) DESC
      LIMIT ${limit}`,
    oc.params,
  );
  return rows;
}

export async function getRecentDefects(mineOf = "", limit = 100, offset = 0): Promise<DefectItem[]> {
  const oc = ownerClause(mineOf, "i", 1);
  const { rows } = await pool.query<DefectItem>(
    `SELECT d.ic_code AS code, COALESCE(d.ic_name,'') AS name, COALESCE(d.item_brand,'') AS brand,
            COALESCE(NULLIF(d.sn,''),'') AS sn, COALESCE(NULLIF(d.remark,''),d.product_defect,'') AS remark,
            d.date_register::text AS date, (COALESCE(d.status,0) = 0) AS open
       FROM odg_product_defect d
       JOIN ic_inventory i ON i.code = d.ic_code
      WHERE true ${oc.sql}
      ORDER BY d.date_register DESC NULLS LAST
      LIMIT ${limit} OFFSET ${Math.max(0, offset)}`,
    oc.params,
  );
  return rows;
}

// ===== Procurement (ຈັດຊື້) =====
export type ReorderItem = {
  code: string;
  name: string;
  brand: string;
  stockqty: string;
  avg_sale: string;
  sale_90: string;
  months_cover: string;
  last_buy_date: string | null;
  last_buy_price: string | null;
};

// Items selling but running low on stock (< ~1.5 months cover) → suggest buying.
export async function getReorderSuggestions(mineOf = "", limit = 100, offset = 0, groupBy = ""): Promise<ReorderItem[]> {
  const oc = ownerClause(mineOf, "i", 1);
  const { rows } = await pool.query<ReorderItem>(
    `SELECT a.ic_code AS code, COALESCE(a.ic_name,'') AS name, COALESCE(a.brand,'') AS brand,
            COALESCE(a.stockqty,0)::text AS stockqty,
            COALESCE(a.avgsale,0)::text AS avg_sale,
            COALESCE(a.sale_90,0)::text AS sale_90,
            round(COALESCE(a.stockqty,0) / a.avgsale, 1)::text AS months_cover,
            a.last_buy_date::text AS last_buy_date,
            a.last_buy_price::text AS last_buy_price
       FROM odg_stock_aging a
       JOIN ic_inventory i ON i.code = a.ic_code
      WHERE COALESCE(a.avgsale,0) > 0
        AND (COALESCE(a.stockqty,0) / a.avgsale) < 1.5 ${oc.sql}
      ORDER BY ${groupBy === "brand" ? "COALESCE(a.brand,'') ASC, " : ""}(COALESCE(a.stockqty,0) / a.avgsale) ASC
      LIMIT ${limit} OFFSET ${Math.max(0, offset)}`,
    oc.params,
  );
  return rows;
}

export type BelowMinItem = {
  code: string;
  name: string;
  brand: string;
  balance: string;
  min_qty: string;
  shortfall: string;
};

// Items whose current stock is below the admin-set min stock.
export async function getBelowMinStock(mineOf = "", limit = 100): Promise<BelowMinItem[]> {
  const oc = ownerClause(mineOf, "i", 1);
  const { rows } = await pool.query<BelowMinItem>(
    `SELECT i.code, COALESCE(i.name_1,'') AS name,
            COALESCE(br.name_1, i.item_brand, '') AS brand,
            COALESCE(i.balance_qty,0)::text AS balance,
            m.min_qty::text AS min_qty,
            (m.min_qty - COALESCE(i.balance_qty,0))::text AS shortfall
       FROM odg_min_stock_setting m
       JOIN ic_inventory i ON i.code = m.item_code
       LEFT JOIN ic_brand br ON br.code = i.item_brand
      WHERE COALESCE(i.balance_qty,0) < m.min_qty ${oc.sql}
      ORDER BY (m.min_qty - COALESCE(i.balance_qty,0)) DESC
      LIMIT ${limit}`,
    oc.params,
  );
  return rows;
}

export type AboveMaxItem = {
  code: string;
  name: string;
  brand: string;
  balance: string;
  max_qty: string;
  excess: string;
};

// Items whose current stock is above the admin-set max stock → do NOT buy more.
export async function getAboveMaxStock(mineOf = "", limit = 100): Promise<AboveMaxItem[]> {
  const oc = ownerClause(mineOf, "i", 1);
  const { rows } = await pool.query<AboveMaxItem>(
    `SELECT i.code, COALESCE(i.name_1,'') AS name,
            COALESCE(br.name_1, i.item_brand, '') AS brand,
            COALESCE(i.balance_qty,0)::text AS balance,
            m.max_qty::text AS max_qty,
            (COALESCE(i.balance_qty,0) - m.max_qty)::text AS excess
       FROM odg_min_stock_setting m
       JOIN ic_inventory i ON i.code = m.item_code
       LEFT JOIN ic_brand br ON br.code = i.item_brand
      WHERE m.max_qty IS NOT NULL AND COALESCE(i.balance_qty,0) > m.max_qty ${oc.sql}
      ORDER BY (COALESCE(i.balance_qty,0) - m.max_qty) DESC
      LIMIT ${limit}`,
    oc.params,
  );
  return rows;
}

export type SupplierSpend = { code: string; supplier: string; docs: number; spend: string };

// Top suppliers by purchase value (ic_trans_detail trans_flag 12 = buy-in).
export async function getSupplierSpend(days = 180, limit = 20): Promise<SupplierSpend[]> {
  const { rows } = await pool.query<SupplierSpend>(
    `SELECT COALESCE(t.cust_code,'') AS code,
            COALESCE(s.name_1, t.cust_code, 'ບໍ່ລະບຸ') AS supplier,
            count(DISTINCT d.doc_no)::int AS docs,
            COALESCE(sum(d.sum_amount),0)::text AS spend
       FROM ic_trans_detail d
       JOIN ic_trans t ON t.doc_no = d.doc_no
       LEFT JOIN ap_supplier s ON s.code = t.cust_code
      WHERE d.trans_flag = 12 AND d.last_status = 0
        AND d.doc_date >= CURRENT_DATE - $1::int
      GROUP BY t.cust_code, s.name_1
      ORDER BY sum(d.sum_amount) DESC NULLS LAST
      LIMIT ${limit}`,
    [days],
  );
  return rows;
}

// ===== ABC analysis: rank products by 90-day consumption value =====
// usage_value = sale_90 (units sold, 90d) × unit cost. Pareto: A ≤80%, B ≤95%, C rest.
const ABC_BASE = `
  WITH base AS (
    SELECT a.ic_code AS code, COALESCE(a.ic_name,'') AS name, COALESCE(a.brand,'') AS brand,
           COALESCE(a.stockqty,0) AS stockqty, COALESCE(a.avgsale,0) AS avgsale,
           COALESCE(a.sale_90,0) AS sale_90,
           COALESCE(a.sale_90,0) * COALESCE(NULLIF(a.stockcost,0), a.last_buy_price, 0) AS usage_value
      FROM odg_stock_aging a
      JOIN ic_inventory i ON i.code = a.ic_code
     WHERE 1=1 __OWNER__
  ),
  ranked AS (
    SELECT *,
           SUM(usage_value) OVER () AS total_value,
           SUM(usage_value) OVER (ORDER BY usage_value DESC, code) AS cum_value
      FROM base
  ),
  classed AS (
    SELECT *,
           CASE WHEN total_value = 0 THEN 'C'
                WHEN cum_value / total_value <= 0.80 THEN 'A'
                WHEN cum_value / total_value <= 0.95 THEN 'B'
                ELSE 'C' END AS abc
      FROM ranked
  )`;

export type AbcSummaryRow = { abc: string; items: number; value: string; value_pct: string };

export async function getAbcSummary(mineOf = ""): Promise<AbcSummaryRow[]> {
  const oc = ownerClause(mineOf, "i", 1);
  const { rows } = await pool.query<AbcSummaryRow>(
    `${ABC_BASE.replace("__OWNER__", oc.sql)}
     SELECT abc,
            count(*)::int AS items,
            round(sum(usage_value))::text AS value,
            round(100.0 * sum(usage_value) / NULLIF(max(total_value), 0), 1)::text AS value_pct
       FROM classed GROUP BY abc ORDER BY abc`,
    oc.params,
  );
  return rows;
}

export type AbcItem = {
  code: string; name: string; brand: string; abc: string;
  stockqty: string; avgsale: string; sale_90: string; usage_value: string;
  cum_pct: string; months_cover: string;
};

export async function getAbcItems(mineOf = "", klass = "A", limit = 300, offset = 0): Promise<AbcItem[]> {
  const oc = ownerClause(mineOf, "i", 1);
  const kIdx = oc.params.length + 1;
  const { rows } = await pool.query<AbcItem>(
    `${ABC_BASE.replace("__OWNER__", oc.sql)}
     SELECT code, name, brand, abc,
            stockqty::text AS stockqty, avgsale::text AS avgsale, sale_90::text AS sale_90,
            round(usage_value)::text AS usage_value,
            round(100.0 * cum_value / NULLIF(total_value, 0), 2)::text AS cum_pct,
            CASE WHEN avgsale > 0 THEN round(stockqty / avgsale, 1)::text ELSE '' END AS months_cover
       FROM classed
      WHERE abc = $${kIdx}
      ORDER BY usage_value DESC, code
      LIMIT ${limit} OFFSET ${Math.max(0, offset)}`,
    [...oc.params, klass],
  );
  return rows;
}

// ===== Team KPI: performance per responsible employee =====
export type StaffPerformance = {
  employee_code: string;
  fullname: string;
  dept_name: string;
  groups: number;
  in_stock_items: number;
  sales_90: string;
  stock_value: string;
  dead_items: number;
};

export async function getStaffPerformance(): Promise<StaffPerformance[]> {
  const { rows } = await pool.query<StaffPerformance>(
    `SELECT gr.employee_code,
            COALESCE(e.fullname_lo, gr.employee_code) AS fullname,
            COALESCE(d.department_name_lo, '') AS dept_name,
            count(DISTINCT gr.group_main || ':' || gr.group_sub)::int AS groups,
            count(DISTINCT a.ic_code) FILTER (WHERE a.stockqty > 0)::int AS in_stock_items,
            COALESCE(sum(a.sale_90), 0)::text AS sales_90,
            COALESCE(sum(a.stockamount) FILTER (WHERE a.stockqty > 0), 0)::text AS stock_value,
            count(DISTINCT a.ic_code) FILTER (WHERE a.stockqty > 0 AND COALESCE(a.sale_90,0) = 0)::int AS dead_items
       FROM odg_group_responsible gr
       JOIN odg_employee e ON e.employee_code = gr.employee_code
       LEFT JOIN odg_department d ON d.department_code = e.department_code
       JOIN ic_inventory i ON i.group_main = gr.group_main
            AND (gr.group_sub = '' OR gr.group_sub = i.group_sub)
       JOIN odg_stock_aging a ON a.ic_code = i.code
      GROUP BY gr.employee_code, e.fullname_lo, d.department_name_lo
      ORDER BY sum(a.sale_90) DESC NULLS LAST`,
  );
  return rows;
}

export type QualityGaps = {
  total: number;
  no_image: number;
  no_price: number;
  no_category: number;
  no_brand: number;
};

export type GapProduct = {
  code: string;
  name_1: string;
  category_name: string;
  brand: string;
  missing: string[];
};

export async function getQualityGaps(mineOf = ""): Promise<QualityGaps> {
  const oc = ownerClause(mineOf, "i", 1);
  const { rows } = await pool.query<QualityGaps>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM product_image pi WHERE pi.ic_code = i.code AND (pi.url_image <> '' OR pi.image_base64 <> '')))::int AS no_image,
            count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM ic_inventory_price p WHERE p.ic_code = i.code AND COALESCE(p.sale_price1,0) > 0))::int AS no_price,
            count(*) FILTER (WHERE COALESCE(i.item_category,'') = '')::int AS no_category,
            count(*) FILTER (WHERE COALESCE(i.item_brand,'') = '')::int AS no_brand
       FROM ic_inventory i
      WHERE true ${oc.sql}`,
    oc.params,
  );
  return rows[0] ?? { total: 0, no_image: 0, no_price: 0, no_category: 0, no_brand: 0 };
}

// Products with at least one data gap, in-stock first (worth fixing).
export async function getGapProducts(mineOf = "", limit = 100, offset = 0): Promise<GapProduct[]> {
  const oc = ownerClause(mineOf, "i", 1);
  const { rows } = await pool.query<{
    code: string;
    name_1: string;
    category_name: string;
    brand: string;
    has_image: boolean;
    has_price: boolean;
    has_category: boolean;
    has_brand: boolean;
  }>(
    `SELECT i.code, i.name_1,
            COALESCE(cat.name_1,'') AS category_name,
            COALESCE(br.name_1, i.item_brand, '') AS brand,
            EXISTS (SELECT 1 FROM product_image pi WHERE pi.ic_code = i.code AND (pi.url_image <> '' OR pi.image_base64 <> '')) AS has_image,
            EXISTS (SELECT 1 FROM ic_inventory_price p WHERE p.ic_code = i.code AND COALESCE(p.sale_price1,0) > 0) AS has_price,
            (COALESCE(i.item_category,'') <> '') AS has_category,
            (COALESCE(i.item_brand,'') <> '') AS has_brand
       FROM ic_inventory i
       LEFT JOIN ic_category cat ON cat.code = i.item_category
       LEFT JOIN ic_brand br ON br.code = i.item_brand
      WHERE i.balance_qty > 0 ${oc.sql}
        AND (NOT EXISTS (SELECT 1 FROM product_image pi WHERE pi.ic_code = i.code AND (pi.url_image <> '' OR pi.image_base64 <> ''))
             OR NOT EXISTS (SELECT 1 FROM ic_inventory_price p WHERE p.ic_code = i.code AND COALESCE(p.sale_price1,0) > 0)
             OR COALESCE(i.item_category,'') = ''
             OR COALESCE(i.item_brand,'') = '')
      ORDER BY i.balance_qty DESC
      LIMIT ${limit} OFFSET ${Math.max(0, offset)}`,
    oc.params,
  );
  return rows.map((r) => ({
    code: r.code,
    name_1: r.name_1,
    category_name: r.category_name,
    brand: r.brand,
    missing: [
      !r.has_image ? "ຮູບ" : "",
      !r.has_price ? "ລາຄາ" : "",
      !r.has_category ? "ໝວດ" : "",
      !r.has_brand ? "ຍີ່ຫໍ້" : "",
    ].filter(Boolean),
  }));
}
