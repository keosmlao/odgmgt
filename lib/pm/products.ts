import { pool } from "@/lib/pm/db";

export type Product = {
  code: string;
  name_1: string;
  name_eng_1: string;
  item_brand: string;
  unit_standard_name: string;
  balance_qty: string;
  average_cost: string;
  status: number;
  category_name: string | null;
  group_main_name: string | null;
  responsible_name: string | null;
  // Latest active price/cost from ic_inventory_price (null = no price row).
  price_retail: string | null; // ຂາຍໜ້າຮ້ານ = ວອກອີນ
  price_retail_cur: string | null; // '₭' | '฿' — retail can be LAK or THB
  price_wholesale: string | null; // ຂາຍສົ່ງ = ຮ້ານຂາຍສົ່ງ (always ฿)
  cost_vte: string | null; // ຕົ້ນທຶນວຽງຈັນ (always ฿)
  cost_pks: string | null; // ຕົ້ນທຶນປາກເຊ (always ฿)
};

// Latest active price/cost per item, replicated from the odg_pm_price_info VIEW
// but pulled straight from ic_inventory_price (the view also computes an expensive
// SML stock-cost function we don't need, which makes it too slow to query live).
// Prices key off cust_group_2 / cust_group_1 codes; "latest" = newest active
// from_date within [from_date, to_date]. ic_code is indexed → fast per page.
//   ວອກອີນ (retail) = cust_group_2 10101, LAK(02) then THB(01)
//   ຮ້ານຂາຍສົ່ງ (wholesale) = cust_group_2 10201, THB, × (100−disc%)/100 if a discount row exists
//   ຕົ້ນທຶນວຽງຈັນ = cust_group_1 9 · ຕົ້ນທຶນປາກເຊ = cust_group_1 10 (both THB)
const PM_PRICE_LATERAL = `LEFT JOIN LATERAL (
    SELECT
      COALESCE(rl.lak, rl.thb)::text AS price_retail,
      CASE WHEN rl.lak IS NOT NULL THEN '₭' WHEN rl.thb IS NOT NULL THEN '฿' END AS price_retail_cur,
      COALESCE(
        (SELECT p.sale_price1 FROM ic_inventory_price p
          WHERE p.ic_code = i.code AND p.cust_group_2 = '10201'
            AND CURRENT_DATE BETWEEN p.from_date AND p.to_date AND p.currency_code = '01' AND p.unit_code = i.unit_standard
          ORDER BY p.from_date DESC LIMIT 1)
        * ((SELECT 100 - left(d.discount::text, length(d.discount::text) - 1)::numeric
             FROM ic_inventory_discount d
            WHERE d.ic_code = i.code AND d.cust_group_2 = '10201'
              AND CURRENT_DATE BETWEEN d.from_date AND d.to_date AND d.currency_code = '01' AND d.unit_code = i.unit_standard
            ORDER BY d.from_date DESC LIMIT 1) / 100),
        (SELECT p.sale_price1 FROM ic_inventory_price p
          WHERE p.ic_code = i.code AND p.cust_group_2 = '10201'
            AND CURRENT_DATE BETWEEN p.from_date AND p.to_date AND p.currency_code = '01' AND p.unit_code = i.unit_standard
          ORDER BY p.from_date DESC LIMIT 1)
      )::text AS price_wholesale,
      (SELECT p.sale_price1 FROM ic_inventory_price p
        WHERE p.ic_code = i.code AND p.cust_group_1 = '9'
          AND CURRENT_DATE BETWEEN p.from_date AND p.to_date AND p.currency_code = '01'
        ORDER BY p.from_date DESC LIMIT 1)::text AS cost_vte,
      (SELECT p.sale_price1 FROM ic_inventory_price p
        WHERE p.ic_code = i.code AND p.cust_group_1 = '10'
          AND CURRENT_DATE BETWEEN p.from_date AND p.to_date AND p.currency_code = '01'
        ORDER BY p.from_date DESC LIMIT 1)::text AS cost_pks
    FROM (SELECT
            (SELECT p.sale_price1 FROM ic_inventory_price p
              WHERE p.ic_code = i.code AND p.cust_group_2 = '10101'
                AND CURRENT_DATE BETWEEN p.from_date AND p.to_date AND p.currency_code = '02'
              ORDER BY p.from_date DESC LIMIT 1) AS lak,
            (SELECT p.sale_price1 FROM ic_inventory_price p
              WHERE p.ic_code = i.code AND p.cust_group_2 = '10101'
                AND CURRENT_DATE BETWEEN p.from_date AND p.to_date AND p.currency_code = '01'
              ORDER BY p.from_date DESC LIMIT 1) AS thb
         ) rl
  ) pmp ON true`;
// Wholesale + both costs are always THB (฿); only retail varies (₭/฿ via price_retail_cur).
const PM_PRICE_COLS = `pmp.price_retail, pmp.price_retail_cur, pmp.price_wholesale, pmp.cost_vte, pmp.cost_pks`;

export type ProductFilters = {
  q: string;
  groupMain: string;
  groupSub: string;
  groupSub2: string;
  category: string;
  brand: string;
  inStock: boolean;
  mineOf: string; // employee_code → only products in that employee's responsible groups
  groupBy?: string; // '' | 'brand' | 'category' | 'group_main' → sort so same-group rows are contiguous
};

// ORDER BY expression for the optional group-by (E-2 search view). Same-group rows
// become contiguous so the page can render group headers.
const GROUP_BY_ORDER: Record<string, string> = {
  brand: "COALESCE(i.item_brand,'')",
  category: "COALESCE(cat.name_1,'')",
  group_main: "COALESCE(gm.name_1,'')",
};

export type ProductPage = {
  rows: Product[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type Option = {
  code: string;
  name: string;
  mainGroup?: string;
  groupSubCode?: string;
};

function buildWhere(
  f: ProductFilters,
  col: string,
): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (value: string, column: string) => {
    const v = value.trim();
    if (!v) return;
    params.push(v);
    clauses.push(`${col}${column} = $${params.length}`);
  };

  const term = f.q.trim();
  if (term) {
    params.push(`%${term}%`);
    const p = `$${params.length}`;
    clauses.push(
      `(${col}code ILIKE ${p} OR ${col}name_1 ILIKE ${p} OR ${col}name_eng_1 ILIKE ${p} OR ${col}item_brand ILIKE ${p})`,
    );
  }
  add(f.groupMain, "group_main");
  add(f.groupSub, "group_sub");
  add(f.groupSub2, "group_sub2");
  add(f.category, "item_category");
  add(f.brand, "item_brand");
  if (f.inStock) clauses.push(`${col}balance_qty > 0`);
  if (f.mineOf.trim()) {
    params.push(f.mineOf.trim());
    const p = `$${params.length}`;
    clauses.push(
      `EXISTS (SELECT 1 FROM odg_group_responsible gr
                WHERE gr.employee_code = ${p}
                  AND gr.group_main = ${col}group_main
                  AND (gr.group_sub = '' OR gr.group_sub = ${col}group_sub))`,
    );
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export async function getProducts(
  filters: ProductFilters,
  page: number,
  pageSize = 20,
): Promise<ProductPage> {
  // Alias the table (i) so the EXISTS mineOf subquery can qualify i.group_main —
  // an unqualified name there would bind to odg_group_responsible and never filter.
  const count = buildWhere(filters, "i.");
  const { rows: countRows } = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM ic_inventory i ${count.sql}`,
    count.params,
  );
  const total = countRows[0]?.total ?? 0;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const offset = (safePage - 1) * pageSize;

  const list = buildWhere(filters, "i.");
  const { rows } = await pool.query<Product>(
    `SELECT i.code, i.name_1, i.name_eng_1, i.item_brand, i.unit_standard_name,
            i.balance_qty, i.average_cost, i.status,
            cat.name_1 AS category_name, gm.name_1 AS group_main_name,
            (SELECT string_agg(DISTINCT COALESCE(re.fullname_lo, gr.employee_code), ', ')
               FROM odg_group_responsible gr
               LEFT JOIN odg_employee re ON re.employee_code = gr.employee_code
              WHERE gr.group_main = i.group_main
                AND (gr.group_sub = '' OR gr.group_sub = i.group_sub)) AS responsible_name,
            ${PM_PRICE_COLS}
       FROM ic_inventory i
       LEFT JOIN ic_category cat ON cat.code = i.item_category
       LEFT JOIN ic_group gm ON gm.code = i.group_main
       ${PM_PRICE_LATERAL}
       ${list.sql}
      ORDER BY ${filters.groupBy && GROUP_BY_ORDER[filters.groupBy] ? `${GROUP_BY_ORDER[filters.groupBy]} ASC, ` : ""}i.code ASC
      LIMIT ${pageSize} OFFSET ${offset}`,
    list.params,
  );

  return { rows, total, page: safePage, pageSize, totalPages };
}

// Filtered products for CSV export (no pagination; capped for safety).
export async function getProductsForExport(
  filters: ProductFilters,
  limit = 20000,
): Promise<Product[]> {
  const w = buildWhere(filters, "i.");
  const { rows } = await pool.query<Product>(
    `SELECT i.code, i.name_1, i.name_eng_1, i.item_brand, i.unit_standard_name,
            i.balance_qty, i.average_cost, i.status,
            cat.name_1 AS category_name, gm.name_1 AS group_main_name,
            (SELECT string_agg(DISTINCT COALESCE(re.fullname_lo, gr.employee_code), ', ')
               FROM odg_group_responsible gr
               LEFT JOIN odg_employee re ON re.employee_code = gr.employee_code
              WHERE gr.group_main = i.group_main
                AND (gr.group_sub = '' OR gr.group_sub = i.group_sub)) AS responsible_name,
            ${PM_PRICE_COLS}
       FROM ic_inventory i
       LEFT JOIN ic_category cat ON cat.code = i.item_category
       LEFT JOIN ic_group gm ON gm.code = i.group_main
       ${PM_PRICE_LATERAL}
       ${w.sql}
      ORDER BY i.code ASC
      LIMIT ${limit}`,
    w.params,
  );
  return rows;
}

async function loadOptions(table: string): Promise<Option[]> {
  const { rows } = await pool.query<Option>(
    `SELECT code, name_1 AS name
       FROM ${table}
      WHERE COALESCE(NULLIF(code, ''), NULL) IS NOT NULL
      ORDER BY name_1`,
  );
  return rows;
}

export type FilterOptions = {
  groupMain: Option[];
  groupSub: Option[];
  groupSub2: Option[];
  category: Option[];
  brand: Option[];
};

export type DeptStaff = { employee_code: string; fullname: string; dept_name: string };

// Employees in the product departments (101-104) who can own a product.
export async function getProductDeptStaff(): Promise<DeptStaff[]> {
  const { rows } = await pool.query<DeptStaff>(
    `SELECT e.employee_code, e.fullname_lo AS fullname,
            COALESCE(d.department_name_lo, '') AS dept_name
       FROM odg_employee e
       LEFT JOIN odg_department d ON d.department_code = e.department_code
      WHERE e.department_code IN ('101','102','103','104')
        AND e.employment_status = 'ACTIVE'
      ORDER BY e.department_code, e.fullname_lo`,
  );
  return rows;
}

export type GroupAssignment = {
  id: number;
  group_main: string;
  group_main_name: string;
  group_sub: string;
  group_sub_name: string;
};

export type StaffWithGroups = {
  employee_code: string;
  fullname: string;
  dept_code: string;
  dept_name: string;
  groups: GroupAssignment[];
};

// All active product-department staff (101-104) with the product groups
// (ກຸ່ມຫຼັກ / ກຸ່ມຍ່ອຍ) each is responsible for.
export async function getStaffWithGroups(): Promise<StaffWithGroups[]> {
  const { rows } = await pool.query<StaffWithGroups>(
    `SELECT e.employee_code, e.fullname_lo AS fullname,
            e.department_code AS dept_code,
            COALESCE(d.department_name_lo, '') AS dept_name,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', r.id,
                  'group_main', r.group_main,
                  'group_main_name', COALESCE(gm.name_1, r.group_main),
                  'group_sub', r.group_sub,
                  'group_sub_name', COALESCE(gs.name_1, '')
                ) ORDER BY r.group_main, r.group_sub
              ) FILTER (WHERE r.id IS NOT NULL),
              '[]'
            ) AS groups
       FROM odg_employee e
       LEFT JOIN odg_department d ON d.department_code = e.department_code
       LEFT JOIN odg_group_responsible r ON r.employee_code = e.employee_code
       LEFT JOIN ic_group gm ON gm.code = r.group_main
       LEFT JOIN ic_group_sub gs ON gs.code = r.group_sub
      WHERE e.department_code IN ('101','102','103','104')
        AND e.employment_status = 'ACTIVE'
      GROUP BY e.employee_code, e.fullname_lo, e.department_code, d.department_name_lo
      ORDER BY e.department_code, e.fullname_lo`,
  );
  return rows;
}

// How many product groups a logged-in employee is responsible for (0 = none →
// they are not a product-dept owner, so the "my groups" default view is off).
export async function getUserGroupCount(employeeCode: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM odg_group_responsible WHERE employee_code = $1`,
    [employeeCode],
  );
  return rows[0]?.n ?? 0;
}

export type Lifecycle = { status: string; note: string } | null;
export async function getLifecycle(code: string): Promise<Lifecycle> {
  const { rows } = await pool.query<{ status: string; note: string }>(
    `SELECT status, COALESCE(note,'') AS note FROM odg_product_lifecycle WHERE item_code = $1`,
    [code],
  );
  return rows[0] ?? null;
}

export type ItemSupplier = { id: number; supplier_code: string; supplier_name: string };
export async function getItemSuppliers(code: string): Promise<ItemSupplier[]> {
  const { rows } = await pool.query<ItemSupplier>(
    `SELECT ps.id, ps.supplier_code, COALESCE(s.name_1, ps.supplier_code) AS supplier_name
       FROM odg_product_supplier ps
       LEFT JOIN ap_supplier s ON s.code = ps.supplier_code
      WHERE ps.item_code = $1
      ORDER BY ps.created_at`,
    [code],
  );
  return rows;
}

export async function searchSuppliers(q: string, limit = 20): Promise<{ code: string; name: string }[]> {
  const term = q.trim();
  if (!term) return [];
  const { rows } = await pool.query<{ code: string; name: string }>(
    `SELECT code, name_1 AS name FROM ap_supplier
      WHERE code ILIKE $1 OR name_1 ILIKE $1 OR name_eng_1 ILIKE $1
      ORDER BY name_1 LIMIT ${limit}`,
    [`%${term}%`],
  );
  return rows;
}

export type PmPrices = {
  price_retail: string | null;
  price_retail_cur: string | null;
  price_wholesale: string | null;
  cost_vte: string | null;
  cost_pks: string | null;
};

// The 4 headline price/cost figures for one item (same source as the products list).
export async function getPmPrices(code: string): Promise<PmPrices | null> {
  const { rows } = await pool.query<PmPrices>(
    `SELECT ${PM_PRICE_COLS} FROM ic_inventory i ${PM_PRICE_LATERAL} WHERE i.code = $1`,
    [code],
  );
  return rows[0] ?? null;
}

export type StockThresholds = { min: number | null; max: number | null };

export async function getStockThresholds(code: string): Promise<StockThresholds> {
  const { rows } = await pool.query<{ min_qty: string | null; max_qty: string | null }>(
    `SELECT min_qty::text, max_qty::text FROM odg_min_stock_setting WHERE item_code = $1`,
    [code],
  );
  const r = rows[0];
  return {
    min: r && r.min_qty != null ? Number(r.min_qty) : null,
    max: r && r.max_qty != null ? Number(r.max_qty) : null,
  };
}

// Admins can manage staff/spare/audit and see all products. Default: IT dept
// (801) or an explicit app_role = 'admin'. Adjust ADMIN_DEPTS as needed.
const ADMIN_DEPTS = ["801"];
export async function getIsAdmin(employeeCode: string): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>(
    `SELECT (COALESCE(app_role, '') = 'admin' OR department_code = ANY($2::varchar[])) AS ok
       FROM odg_employee WHERE employee_code = $1`,
    [employeeCode, ADMIN_DEPTS],
  );
  return rows[0]?.ok ?? false;
}

// The distinct groups a logged-in employee owns (for locking the list filter).
export async function getUserGroups(
  employeeCode: string,
): Promise<{ group_main: string; group_sub: string }[]> {
  const { rows } = await pool.query<{ group_main: string; group_sub: string }>(
    `SELECT DISTINCT group_main, group_sub
       FROM odg_group_responsible WHERE employee_code = $1
      ORDER BY group_main, group_sub`,
    [employeeCode],
  );
  return rows;
}

export type GroupOption = { code: string; name: string; mainGroup?: string };

// Group options for the assignment picker (main groups + subs with their main).
export async function getGroupOptions(): Promise<{ main: GroupOption[]; sub: GroupOption[] }> {
  const [mainRes, subRes] = await Promise.all([
    pool.query<GroupOption>(
      `SELECT code, name_1 AS name FROM ic_group WHERE code <> '' ORDER BY name_1`,
    ),
    pool.query<GroupOption>(
      `SELECT code, name_1 AS name, main_group AS "mainGroup"
         FROM ic_group_sub WHERE code <> '' ORDER BY name_1`,
    ),
  ]);
  return { main: mainRes.rows, sub: subRes.rows };
}

export type ProductResponsible = {
  employee_code: string;
  fullname: string;
  dept_name: string;
  assigned_at: string | null;
} | null;

export async function getProductResponsible(code: string): Promise<ProductResponsible> {
  const { rows } = await pool.query<NonNullable<ProductResponsible>>(
    `SELECT r.employee_code,
            COALESCE(e.fullname_lo, '') AS fullname,
            COALESCE(d.department_name_lo, '') AS dept_name,
            r.assigned_at::text AS assigned_at
       FROM odg_product_responsible r
       LEFT JOIN odg_employee e ON e.employee_code = r.employee_code
       LEFT JOIN odg_department d ON d.department_code = e.department_code
      WHERE r.product_code = $1`,
    [code],
  );
  return rows[0] ?? null;
}

// Autocomplete search for the spare/product relation picker. spareOnly = true
// searches spares (group_main 14); false searches products (everything else).
export async function searchInventory(
  q: string,
  spareOnly: boolean,
  limit = 20,
): Promise<{ code: string; name: string }[]> {
  const term = q.trim();
  if (!term) return [];
  const kind = spareOnly ? "i.group_main = '14'" : "i.group_main <> '14'";
  const { rows } = await pool.query<{ code: string; name: string }>(
    `SELECT i.code, i.name_1 AS name
       FROM ic_inventory i
      WHERE ${kind}
        AND (i.code ILIKE $1 OR i.name_1 ILIKE $1 OR i.name_eng_1 ILIKE $1)
      ORDER BY i.code
      LIMIT ${limit}`,
    [`%${term}%`],
  );
  return rows;
}

export type ProductDetail = {
  code: string;
  code_old: string;
  name_1: string;
  name_2: string;
  name_eng_1: string;
  short_name: string;
  item_model: string;
  item_size: string;
  item_color: string;
  unit_standard_name: string;
  balance_qty: string;
  item_in_stock: string;
  average_cost: string;
  last_movement_date: string | null;
  supplier_code: string;
  remark: string;
  description: string;
  group_main_name: string | null;
  group_sub_name: string | null;
  group_sub2_name: string | null;
  category_name: string | null;
  brand_name: string | null;
  is_spare: boolean;
  warranty_months: number | null;
  responsible_name: string | null;
};

export type SoldSerial = {
  serial_no: string;
  isn: string;
  wh_name: string;
  bill: string;
  sale_date: string | null;
  customer: string;
  sale_price: string;
};

export type Barcode = { barcode: string; unit_code: string; price: string };

export type ProductImage = { url_image: string; image_base64: string };

export type Movement = {
  doc_date: string | null;
  doc_no: string;
  doc_type: string; // Lao doc-type name (ຂາຍ, ໂອນ, ຮັບຄືນ, ...)
  inqty: string;
  outqty: string;
  wh_name: string;
  unit_code: string;
  amount: string;
  currency_code: string;
};

export type WarehouseStock = {
  warehouse: string;
  wh_name: string;
  location: string;
  location_name: string;
  qty: string;
};

export type PriceRow = {
  currency_code: string;
  currency_label: string;
  sale_price: string;
  unit_code: string;
};

export type PriceCell = {
  from_date: string | null;
  to_date: string | null;
  group_code: string;
  group_name: string;
  price_lak: string | null;
  price_thb: string | null;
  create_date: string | null;
};

export type Serial = {
  serial_no: string;
  isn: string;
  wh_code: string;
  wh_name: string;
  rack: string;
  rack_name: string;
  location: string;
  location_name: string;
  status: number; // 0 = in stock, 1 = out
  entry_date: string | null;
  age_days: number | null;
  defect: string; // defect note from odg_product_defect ('' = none)
  receipt_doc: string; // receive doc (ໃບຮັບເຂົ້າ) from sn_trans_detail
  po_no: string; // PO number
  purchase_doc: string; // PUIH purchase receipt / payable document
  purchase_price: string; // Per-unit price from the PUIH purchase receipt
  purchase_currency: string;
};

export type SerialSummary = { total: number; in_stock: number; out_stock: number };

export type SerialWarehouse = {
  wh_code: string;
  wh_name: string;
  total: number;
  in_stock: number;
};

export type RelatedItem = {
  code: string;
  name_1: string;
  item_model: string;
  brand_name: string;
  balance_qty: string;
  unit_standard_name: string;
  is_manual: boolean;
};

export type LatestPurchase = {
  price: string | null;
  doc_no: string;
  doc_date: string | null;
  po_no: string;
  supplier_code: string;
  supplier_name: string;
} | null;

export type ProductDetailResult = {
  product: ProductDetail;
  barcodes: Barcode[];
  images: ProductImage[];
  movements: Movement[];
  warehouseStock: WarehouseStock[];
  prices: PriceRow[];
  movementWarehouses: { warehouse: string; wh_name: string }[];
  serials: Serial[];
  soldSerials: SoldSerial[];
  serialSummary: SerialSummary;
  serialWarehouses: SerialWarehouse[];
  priceCells: PriceCell[];
  latestPurchase: LatestPurchase;
  relatedItems: RelatedItem[];
} | null;

const CURRENCY_LABELS: Record<string, string> = {
  "01": "ບາດ (THB)",
  "02": "ກີບ (LAK)",
};

// Stock-affecting trans_flags, matching the SML wh_stock_movement view.
const STOCK_IN_FLAGS = "ARRAY[12,48,54,58,68,70]";
const STOCK_OUT_FLAGS = "ARRAY[44,56,66,72]";
const STOCK_ALL_FLAGS = "ARRAY[12,48,54,58,68,70,44,56,66,72]";
const STOCK_SIGNED_QTY = `CASE WHEN d.trans_flag = ANY(${STOCK_IN_FLAGS}) THEN d.qty
       WHEN d.trans_flag = ANY(${STOCK_OUT_FLAGS}) THEN -d.qty ELSE 0 END`;
const STOCK_DOCTYPE_CASE = `CASE d.trans_flag
    WHEN 12 THEN 'ຊື້ສິນຄ້າເຂົ້າ'
    WHEN 48 THEN 'ໃບຮັບຄືນ'
    WHEN 54 THEN 'ສິນຄ້າຄົງເຫຼືອທີ່ຍົກມາ'
    WHEN 58 THEN 'ຮັບຄືນຈາກການເບີກ'
    WHEN 68 THEN 'ປັບປຸງເພີ່ມ'
    WHEN 70 THEN 'ໃບໂອນສິນຄ້າເຂົ້າ'
    WHEN 44 THEN 'ຂາຍ'
    WHEN 56 THEN 'ໃບເບີກສິນຄ້າ'
    WHEN 66 THEN 'ປັບປຸງຂາດ'
    WHEN 72 THEN 'ໃບໂອນສິນຄ້າອອກ'
    ELSE 'ອື່ນໆ' END`;

export async function getProductBrief(code: string): Promise<{ code: string; name: string } | null> {
  const { rows } = await pool.query<{ code: string; name: string }>(
    `SELECT code, COALESCE(NULLIF(name_1,''), NULLIF(name_eng_1,''), code) AS name FROM ic_inventory WHERE code = $1`,
    [code],
  );
  return rows[0] ?? null;
}

// Paginated movement history for one item (same query/rule as getProductDetail's
// preview, but with LIMIT/OFFSET) — powers the "ເບິ່ງທັງໝົດ" movements page.
export async function getItemMovements(code: string, wh = "", limit = 50, offset = 0): Promise<Movement[]> {
  const { rows } = await pool.query<Movement>(
    `SELECT d.doc_date::text AS doc_date, d.doc_no,
            ${STOCK_DOCTYPE_CASE} AS doc_type,
            CASE WHEN d.trans_flag = ANY(${STOCK_IN_FLAGS}) THEN d.qty ELSE 0 END::text AS inqty,
            CASE WHEN d.trans_flag = ANY(${STOCK_OUT_FLAGS}) THEN -d.qty ELSE 0 END::text AS outqty,
            COALESCE(w.name_1, '') AS wh_name,
            COALESCE(d.unit_code, '') AS unit_code,
            (CASE WHEN h.currency_code = '02' THEN COALESCE(d.sum_amount_2, 0) ELSE COALESCE(d.sum_amount, 0) END)::text AS amount,
            COALESCE(h.currency_code, '') AS currency_code
       FROM ic_trans_detail d
       LEFT JOIN ic_warehouse w ON w.code = d.wh_code
       LEFT JOIN ic_trans h ON h.doc_no = d.doc_no AND h.trans_flag = d.trans_flag
      WHERE d.item_code = $1 AND d.last_status = 0
        AND d.trans_flag = ANY(${STOCK_ALL_FLAGS})
        AND ($2 = '' OR d.wh_code = $2)
      ORDER BY d.doc_date DESC NULLS LAST, d.doc_no DESC,
               (CASE WHEN d.trans_flag = ANY(${STOCK_OUT_FLAGS}) THEN 1 ELSE 0 END)
      LIMIT ${Math.min(limit, 20000)} OFFSET ${Math.max(0, offset)}`,
    [code, wh],
  );
  return rows;
}

// All movements for export (higher cap than the paginated view).
export function getItemMovementsForExport(code: string, wh = "", limit = 20000): Promise<Movement[]> {
  return getItemMovements(code, wh, limit, 0);
}

export async function getItemMovementWarehouses(code: string): Promise<{ warehouse: string; wh_name: string }[]> {
  const { rows } = await pool.query<{ warehouse: string; wh_name: string }>(
    `SELECT DISTINCT d.wh_code AS warehouse, COALESCE(w.name_1, '') AS wh_name
       FROM ic_trans_detail d
       LEFT JOIN ic_warehouse w ON w.code = d.wh_code
      WHERE d.item_code = $1 AND d.last_status = 0
        AND d.trans_flag = ANY(${STOCK_ALL_FLAGS})
      ORDER BY d.wh_code`,
    [code],
  );
  return rows;
}

export async function getProductDetail(
  code: string,
  whFilter = "",
): Promise<ProductDetailResult> {
  const { rows } = await pool.query<ProductDetail>(
    `SELECT i.code, i.code_old, i.name_1, i.name_2, i.name_eng_1, i.short_name,
            i.item_model, i.item_size, i.item_color, i.unit_standard_name,
            i.balance_qty, i.item_in_stock, i.average_cost,
            i.last_movement_date::text AS last_movement_date,
            i.supplier_code, i.remark, i.description,
            gm.name_1 AS group_main_name, gs.name_1 AS group_sub_name,
            gs2.name_1 AS group_sub2_name, cat.name_1 AS category_name,
            br.name_1 AS brand_name,
            (i.group_main = '14') AS is_spare,
            NULLIF(TRIM(i.warranty_monthy::text), '')::numeric::int AS warranty_months,
            (SELECT string_agg(DISTINCT COALESCE(re.fullname_lo, gr.employee_code), ', ')
               FROM odg_group_responsible gr
               LEFT JOIN odg_employee re ON re.employee_code = gr.employee_code
              WHERE gr.group_main = i.group_main
                AND (gr.group_sub = '' OR gr.group_sub = i.group_sub)) AS responsible_name
       FROM ic_inventory i
       LEFT JOIN ic_group gm ON gm.code = i.group_main
       LEFT JOIN ic_group_sub gs ON gs.code = i.group_sub
       LEFT JOIN ic_group_sub2 gs2 ON gs2.code = i.group_sub2
       LEFT JOIN ic_category cat ON cat.code = i.item_category
       LEFT JOIN ic_brand br ON br.code = i.item_brand
      WHERE i.code = $1`,
    [code],
  );
  const product = rows[0];
  if (!product) return null;

  const [barcodesRes, imagesRes, movementsRes, stockRes, priceRes, whRes, serialsRes, serialSumRes, serialWhRes, provenanceRes, soldRes, saleRes, priceGroupRes, purchaseRes, relatedRes, manualRelatedRes] =
    await Promise.all([
      pool.query<Barcode>(
        `SELECT barcode, unit_code, COALESCE(price, 0)::text AS price
           FROM ic_inventory_barcode
          WHERE ic_code = $1 AND barcode <> ''
          ORDER BY line_number
          LIMIT 20`,
        [code],
      ),
      pool.query<ProductImage>(
        `SELECT COALESCE(url_image, '') AS url_image,
                COALESCE(image_base64, '') AS image_base64
           FROM product_image
          WHERE ic_code = $1 AND (url_image <> '' OR image_base64 <> '')
          ORDER BY line_number
          LIMIT 8`,
        [code],
      ),
      // Query ic_trans_detail directly (indexed on item_code, ~30ms) instead of
      // the wh_stock_movement / stock_balance views, which full-scan 1.3M rows
      // with per-row correlated subqueries (3.6s / 15s). We replicate the view's
      // stock rule: last_status=0 AND trans_flag in the in/out sets. This
      // reconciles to ic_inventory.balance_qty; ic_trans_detail.calc_flag does NOT,
      // and quotations (not in these flags) are excluded automatically.
      // Transfers share one doc_no: show the IN row above the OUT row.
      pool.query<Movement>(
        `SELECT d.doc_date::text AS doc_date, d.doc_no,
                ${STOCK_DOCTYPE_CASE} AS doc_type,
                CASE WHEN d.trans_flag = ANY(${STOCK_IN_FLAGS}) THEN d.qty ELSE 0 END::text AS inqty,
                CASE WHEN d.trans_flag = ANY(${STOCK_OUT_FLAGS}) THEN -d.qty ELSE 0 END::text AS outqty,
                COALESCE(w.name_1, '') AS wh_name,
                COALESCE(d.unit_code, '') AS unit_code,
                (CASE WHEN h.currency_code = '02'
                      THEN COALESCE(d.sum_amount_2, 0)
                      ELSE COALESCE(d.sum_amount, 0)
                 END)::text AS amount,
                COALESCE(h.currency_code, '') AS currency_code
           FROM ic_trans_detail d
           LEFT JOIN ic_warehouse w ON w.code = d.wh_code
           LEFT JOIN ic_trans h ON h.doc_no = d.doc_no AND h.trans_flag = d.trans_flag
          WHERE d.item_code = $1 AND d.last_status = 0
            AND d.trans_flag = ANY(${STOCK_ALL_FLAGS})
            AND ($2 = '' OR d.wh_code = $2)
          ORDER BY d.doc_date DESC NULLS LAST, d.doc_no DESC,
                   (CASE WHEN d.trans_flag = ANY(${STOCK_OUT_FLAGS}) THEN 1 ELSE 0 END)
          LIMIT 20`,
        [code, whFilter],
      ),
      // Balance per warehouse + location (= stock condition, e.g. ສະພາບດີ /
      // ສະພາບຕຳນິ). Location names from ic_shelf. One row per location.
      pool.query<WarehouseStock>(
        `SELECT l.warehouse,
                COALESCE(w.name_1, '') AS wh_name,
                l.location,
                COALESCE(s.name_1, '') AS location_name,
                l.balance_qty::text AS qty
           FROM odg_stock_warehouse_location l
           LEFT JOIN ic_warehouse w ON w.code = l.warehouse
           LEFT JOIN ic_shelf s ON s.code = l.location
          WHERE l.ic_code = $1 AND l.balance_qty <> 0
          ORDER BY l.warehouse, l.location`,
        [code],
      ),
      pool.query<{ currency_code: string; sale_price: string; unit_code: string }>(
        `SELECT DISTINCT ON (currency_code)
                COALESCE(currency_code, '') AS currency_code,
                sale_price1::text AS sale_price,
                COALESCE(unit_code, '') AS unit_code
           FROM ic_inventory_price
          WHERE ic_code = $1 AND COALESCE(sale_price1, 0) > 0
          ORDER BY currency_code, from_date DESC NULLS LAST, line_number DESC`,
        [code],
      ),
      // Warehouses this item has ever moved through (for the movement filter).
      pool.query<{ warehouse: string; wh_name: string }>(
        `SELECT DISTINCT d.wh_code AS warehouse, COALESCE(w.name_1, '') AS wh_name
           FROM ic_trans_detail d
           LEFT JOIN ic_warehouse w ON w.code = d.wh_code
          WHERE d.item_code = $1 AND d.last_status = 0
            AND d.trans_flag = ANY(${STOCK_ALL_FLAGS})
          ORDER BY d.wh_code`,
        [code],
      ),
      // Serial / ISN units from sn_inventory (per-unit; status 0 = in stock,
      // 1 = out). Age is per unit = days since it entered stock.
      pool.query<Serial>(
        `SELECT s.sn AS serial_no,
                COALESCE(s.isn, '') AS isn,
                COALESCE(s.wh_code, '') AS wh_code,
                COALESCE(w.name_1, '') AS wh_name,
                COALESCE(s.rack, '') AS rack,
                COALESCE(rack.name_1, '') AS rack_name,
                COALESCE(s.location, '') AS location,
                COALESCE(location.name_1, '') AS location_name,
                COALESCE(s.status, 0) AS status,
                s.create_date_time_now::date::text AS entry_date,
                (CURRENT_DATE - s.create_date_time_now::date)::int AS age_days,
                COALESCE((SELECT COALESCE(NULLIF(pd.product_defect, ''), NULLIF(pd.remark, ''))
                            FROM odg_product_defect pd
                           WHERE pd.ic_code = s.item_code
                             AND (
                               (s.sn <> '' AND (pd.sn = s.sn OR pd.isn = s.sn))
                               OR (COALESCE(s.isn, '') <> '' AND (pd.sn = s.isn OR pd.isn = s.isn))
                             )
                           ORDER BY pd.date_register DESC NULLS LAST LIMIT 1), '') AS defect,
                '' AS receipt_doc, '' AS po_no
           FROM sn_inventory s
           LEFT JOIN ic_warehouse w ON w.code = s.wh_code
           LEFT JOIN odg_wms_location rack
                  ON rack.code = s.rack AND rack.wh_code = s.wh_code
           LEFT JOIN odg_wms_location1 location
                  ON location.code = s.location AND location.wh_code = s.wh_code
          WHERE s.item_code = $1 AND COALESCE(s.status, 0) = 0
          ORDER BY s.wh_code, s.create_date_time_now
          LIMIT 500`,
        [code],
      ),
      pool.query<{ total: number; in_stock: number; out_stock: number }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE COALESCE(status, 0) = 0)::int AS in_stock,
                count(*) FILTER (WHERE status = 1)::int AS out_stock
           FROM sn_inventory
          WHERE item_code = $1`,
        [code],
      ),
      // Per-warehouse in-stock ISN counts (tree nodes).
      pool.query<SerialWarehouse>(
        `SELECT COALESCE(s.wh_code, '') AS wh_code,
                COALESCE(w.name_1, '') AS wh_name,
                count(*)::int AS total,
                count(*)::int AS in_stock
           FROM sn_inventory s
           LEFT JOIN ic_warehouse w ON w.code = s.wh_code
          WHERE s.item_code = $1 AND COALESCE(s.status, 0) = 0
          GROUP BY s.wh_code, w.name_1
          ORDER BY s.wh_code`,
        [code],
      ),
      // Per-unit provenance. Older records use trans_flag 81 with the physical
      // SN, while newer PIC records use trans_flag 66 with the ISN in st.sn.
      // WMS records retain the direct receive-document to PO relationship.
      pool.query<{ serial_key: string; receipt_doc: string; po_no: string; purchase_doc: string; purchase_price: string; purchase_currency: string }>(
        `SELECT DISTINCT ON (source.serial_key)
                source.serial_key, source.receipt_doc, source.po_no,
                COALESCE(purchase.purchase_doc, '') AS purchase_doc,
                COALESCE(purchase.purchase_price, '') AS purchase_price,
                COALESCE(purchase.currency_code, '') AS purchase_currency
           FROM (
             SELECT st.sn AS serial_key,
                    COALESCE(st.doc_no, '') AS receipt_doc,
                    COALESCE(st.doc_ref, '') AS po_no,
                    st.doc_date AS received_on,
                    2 AS source_priority
               FROM sn_trans_detail st
              WHERE st.item_code = $1
                AND st.trans_flag IN (66, 81)
                AND COALESCE(st.sn, '') <> ''

             UNION ALL

             SELECT sd.serial_number AS serial_key,
                    COALESCE(sd.ref_rec_doc, '') AS receipt_doc,
                    COALESCE(NULLIF(wr.ref_doc_no, ''), NULLIF(wrr.ref_doc_no, ''), '') AS po_no,
                    sd.ref_rec_date AS received_on,
                    1 AS source_priority
               FROM wms_product_receive_serial_detail sd
               LEFT JOIN wms_product_receive wr ON wr.doc_no = sd.ref_rec_doc
               LEFT JOIN LATERAL (
                 SELECT ref.ref_doc_no
                   FROM wms_product_receive_ref ref
                  WHERE ref.doc_no = sd.ref_rec_doc
                    AND COALESCE(ref.ref_doc_no, '') <> ''
                  ORDER BY ref.line_order
                  LIMIT 1
               ) wrr ON true
              WHERE sd.item_code = $1
                AND COALESCE(sd.serial_number, '') <> ''
           ) source
           LEFT JOIN LATERAL (
             SELECT purchase_line.doc_no AS purchase_doc,
                    (CASE
                       WHEN purchase_header.currency_code = '02' AND COALESCE(purchase_line.price_2, 0) > 0
                         THEN purchase_line.price_2
                       ELSE purchase_line.price
                     END)::text AS purchase_price,
                    COALESCE(purchase_header.currency_code, '') AS currency_code
               FROM ic_trans_detail purchase_line
               LEFT JOIN ic_trans purchase_header ON purchase_header.doc_no = purchase_line.doc_no
              WHERE purchase_line.item_code = $1
                AND purchase_line.trans_flag = 12
                AND purchase_line.last_status = 0
                AND COALESCE(source.po_no, '') <> ''
                AND (
                  purchase_line.ref_doc_no = source.po_no
                  OR purchase_line.doc_ref = source.po_no
                  OR purchase_header.doc_ref = source.po_no
                )
              ORDER BY purchase_line.doc_date DESC NULLS LAST, purchase_line.roworder
              LIMIT 1
           ) purchase ON true
          ORDER BY source.serial_key, source.source_priority, source.received_on ASC NULLS LAST`,
        [code],
      ),
      // Sold-out ISN units (status 1). Basic info; sale bill/customer merged
      // from the sale query below (kept separate to avoid a slow per-row join).
      pool.query<{ serial_no: string; isn: string; wh_name: string }>(
        `SELECT s.sn AS serial_no, COALESCE(s.isn, '') AS isn,
                COALESCE(w.name_1, '') AS wh_name
           FROM sn_inventory s
           LEFT JOIN ic_warehouse w ON w.code = s.wh_code
          WHERE s.item_code = $1 AND s.status = 1
          ORDER BY s.create_date_time_now DESC
          LIMIT 300`,
        [code],
      ),
      // Real sale bill per sn = sn_trans_detail.doc_ref (the DPC picking doc's
      // referenced invoice, e.g. INHCE/CAK), with its customer.
      pool.query<{ sn: string; bill: string; sale_date: string | null; customer: string; sale_price: string }>(
        `SELECT DISTINCT ON (st.sn) st.sn,
                COALESCE(NULLIF(st.doc_ref, ''), st.doc_no) AS bill,
                st.doc_date::text AS sale_date,
                COALESCE(curef.name_1, tref.cust_code, '') AS customer,
                COALESCE(sale_line.sale_price, '') AS sale_price
           FROM sn_trans_detail st
           LEFT JOIN ic_trans tref ON tref.doc_no = st.doc_ref
           LEFT JOIN ar_customer curef ON curef.code = tref.cust_code
           LEFT JOIN LATERAL (
             SELECT d.price::text AS sale_price
               FROM ic_trans_detail d
              WHERE d.doc_no = st.doc_ref
                AND d.item_code = st.item_code
                AND d.last_status = 0
              ORDER BY d.roworder
              LIMIT 1
           ) sale_line ON true
          WHERE st.item_code = $1 AND st.trans_flag = 44
          ORDER BY st.sn, st.doc_date DESC`,
        [code],
      ),
      // Selling price per period × customer group (101 ຂາຍໜ້າຮ້ານ, 102 ຂາຍສົ່ງ,
      // 103 ໂຄງການ, 9/10 ຕົ້ນທຶນ). Price prefers LAK ('02'), falls back to THB ('01').
      // Pivoted in the page: rows = period, columns = group.
      pool.query<PriceCell>(
        `SELECT ip.from_date::text AS from_date, ip.to_date::text AS to_date,
                ip.cust_group_1 AS group_code,
                COALESCE(g.name_1, ip.cust_group_1) AS group_name,
                MAX(ip.sale_price1) FILTER (WHERE ip.currency_code = '02')::text AS price_lak,
                MAX(ip.sale_price1) FILTER (WHERE ip.currency_code = '01')::text AS price_thb,
                MAX(ip.create_date_time_now)::date::text AS create_date
           FROM ic_inventory_price ip
           LEFT JOIN ar_group g ON g.code = ip.cust_group_1
          WHERE ip.ic_code = $1 AND COALESCE(ip.sale_price1, 0) > 0
            AND COALESCE(ip.cust_group_1, '') <> ''
          GROUP BY ip.from_date, ip.to_date, ip.cust_group_1, g.name_1
          ORDER BY ip.from_date DESC NULLS LAST, ip.cust_group_1`,
        [code],
      ),
      // Latest purchase (trans_flag 12 = ຊື້ເຂົ້າ): buy price, receipt doc,
      // PO (ic_trans.doc_ref) and supplier (cust_code → ar_customer name).
      pool.query<NonNullable<LatestPurchase>>(
        `SELECT d.price::text AS price, d.doc_no,
                d.doc_date::text AS doc_date,
                COALESCE(t.doc_ref, '') AS po_no,
                COALESCE(t.cust_code, '') AS supplier_code,
                COALESCE(cu.name_1, '') AS supplier_name
           FROM ic_trans_detail d
           LEFT JOIN ic_trans t ON t.doc_no = d.doc_no
           LEFT JOIN ar_customer cu ON cu.code = t.cust_code
          WHERE d.item_code = $1 AND d.trans_flag = 12 AND d.last_status = 0
          ORDER BY d.doc_date DESC NULLS LAST, d.doc_no DESC
          LIMIT 1`,
        [code],
      ),
      product.is_spare
        ? pool.query<RelatedItem>(
            `WITH target AS (
               SELECT regexp_replace(
                        upper(COALESCE(name_1, '') || COALESCE(name_eng_1, '') || COALESCE(item_model, '')),
                        '[^A-Z0-9]', '', 'g'
                      ) AS search_text,
                      item_brand
                 FROM ic_inventory
                WHERE code = $1
             )
             SELECT related.code, related.name_1, COALESCE(related.item_model, '') AS item_model,
                    COALESCE(brand.name_1, related.item_brand, '') AS brand_name,
                    related.balance_qty::text AS balance_qty,
                    COALESCE(related.unit_standard_name, '') AS unit_standard_name,
                    false AS is_manual
               FROM ic_inventory related
               CROSS JOIN target
               LEFT JOIN ic_brand brand ON brand.code = related.item_brand
              WHERE related.group_main <> '14'
                AND related.code <> $1
                AND length(regexp_replace(upper(COALESCE(related.item_model, '')), '[^A-Z0-9]', '', 'g')) >= 6
                AND (COALESCE(target.item_brand, '') = '' OR related.item_brand = target.item_brand)
                AND target.search_text LIKE '%' || left(
                      regexp_replace(upper(related.item_model), '[^A-Z0-9]', '', 'g'), 8
                    ) || '%'
              ORDER BY related.name_1, related.code
              LIMIT 100`,
            [code],
          )
        : pool.query<RelatedItem>(
            `WITH target AS (
               SELECT regexp_replace(upper(COALESCE(item_model, '')), '[^A-Z0-9]', '', 'g') AS model_key,
                      item_brand
                 FROM ic_inventory
                WHERE code = $1
             )
             SELECT related.code, related.name_1, COALESCE(related.item_model, '') AS item_model,
                    COALESCE(brand.name_1, related.item_brand, '') AS brand_name,
                    related.balance_qty::text AS balance_qty,
                    COALESCE(related.unit_standard_name, '') AS unit_standard_name,
                    false AS is_manual
               FROM ic_inventory related
               CROSS JOIN target
               LEFT JOIN ic_brand brand ON brand.code = related.item_brand
              WHERE related.group_main = '14'
                AND related.code <> $1
                AND length(target.model_key) >= 6
                AND (COALESCE(target.item_brand, '') = '' OR related.item_brand = target.item_brand)
                AND regexp_replace(
                      upper(COALESCE(related.name_1, '') || COALESCE(related.name_eng_1, '') || COALESCE(related.item_model, '')),
                      '[^A-Z0-9]', '', 'g'
                    ) LIKE '%' || left(target.model_key, 8) || '%'
              ORDER BY related.name_1, related.code
              LIMIT 100`,
            [code],
          ),
      pool.query<RelatedItem>(
        `SELECT related.code, related.name_1, COALESCE(related.item_model, '') AS item_model,
                COALESCE(brand.name_1, related.item_brand, '') AS brand_name,
                related.balance_qty::text AS balance_qty,
                COALESCE(related.unit_standard_name, '') AS unit_standard_name,
                true AS is_manual
           FROM odg_product_spare_mapping mapping
           JOIN ic_inventory related
             ON related.code = CASE WHEN $2::boolean THEN mapping.product_code ELSE mapping.spare_code END
           LEFT JOIN ic_brand brand ON brand.code = related.item_brand
          WHERE CASE WHEN $2::boolean THEN mapping.spare_code = $1 ELSE mapping.product_code = $1 END
          ORDER BY related.name_1, related.code`,
        [code, product.is_spare],
      ),
    ]);

  const prices: PriceRow[] = priceRes.rows
    .map((r) => ({
      currency_code: r.currency_code,
      currency_label: CURRENCY_LABELS[r.currency_code] ?? (r.currency_code || "-"),
      sale_price: r.sale_price,
      unit_code: r.unit_code,
    }))
    // Show LAK (kip, "02") first — it is the primary currency for this business.
    .sort((a, b) => (a.currency_code === "02" ? -1 : b.currency_code === "02" ? 1 : 0));

  return {
    product,
    barcodes: barcodesRes.rows,
    images: imagesRes.rows,
    movements: movementsRes.rows,
    warehouseStock: stockRes.rows,
    prices,
    movementWarehouses: whRes.rows,
    serials: (() => {
      const prov = new Map(provenanceRes.rows.map((r) => [r.serial_key, r]));
      return serialsRes.rows.map((s) => {
        const p = prov.get(s.serial_no) ?? prov.get(s.isn);
        return {
          ...s,
          receipt_doc: p?.receipt_doc ?? "",
          po_no: p?.po_no ?? "",
          purchase_doc: p?.purchase_doc ?? "",
          purchase_price: p?.purchase_price ?? "",
          purchase_currency: p?.purchase_currency ?? "",
        };
      });
    })(),
    soldSerials: (() => {
      const sale = new Map(saleRes.rows.map((r) => [r.sn, r]));
      return soldRes.rows.map((s) => {
        const info = sale.get(s.serial_no) ?? sale.get(s.isn);
        return {
          serial_no: s.serial_no,
          isn: s.isn,
          wh_name: s.wh_name,
          bill: info?.bill ?? "",
          sale_date: info?.sale_date ?? null,
          customer: info?.customer ?? "",
          sale_price: info?.sale_price ?? "",
        };
      });
    })(),
    serialSummary: serialSumRes.rows[0] ?? { total: 0, in_stock: 0, out_stock: 0 },
    serialWarehouses: serialWhRes.rows,
    priceCells: priceGroupRes.rows,
    latestPurchase: purchaseRes.rows[0] ?? null,
    relatedItems: (() => {
      const manualCodes = new Set(manualRelatedRes.rows.map((item) => item.code));
      return [
        ...manualRelatedRes.rows,
        ...relatedRes.rows.filter((item) => !manualCodes.has(item.code)),
      ];
    })(),
  };
}

export async function getFilterOptions(): Promise<FilterOptions> {
  const [groupMain, groupSub, groupSub2, category, brand] = await Promise.all([
    loadOptions("ic_group"),
    pool.query<Option>(
      `SELECT code, name_1 AS name, main_group AS "mainGroup"
         FROM ic_group_sub
        WHERE COALESCE(NULLIF(code, ''), NULL) IS NOT NULL
        ORDER BY name_1`,
    ).then((result) => result.rows),
    pool.query<Option>(
      `SELECT code, name_1 AS name, main_group AS "mainGroup",
              ic_group_sub_code AS "groupSubCode"
         FROM ic_group_sub2
        WHERE COALESCE(NULLIF(code, ''), NULL) IS NOT NULL
        ORDER BY name_1`,
    ).then((result) => result.rows),
    loadOptions("ic_category"),
    loadOptions("ic_brand"),
  ]);
  return { groupMain, groupSub, groupSub2, category, brand };
}
