import { rows } from "./db";

const DATE_COLUMN_ORDER = ["doc_date", "invoice_date", "date_doc", "datedoc"];
const DATE_COLUMN_TYPES = [
  "date",
  "timestamp without time zone",
  "timestamp with time zone",
];
const CUSTOMER_NAME_COLUMNS = ["customername", "customer_name", "cust_name", "ar_name"];
const COST_COLUMNS = ["sum_of_cost", "cost"];
const SCHEMA_TTL = 600_000;

let schemaCache = null;
let schemaTs = 0;
let schemaPromise = null;

export async function getSaleDetailSchema() {
  if (schemaCache && Date.now() - schemaTs < SCHEMA_TTL) {
    return schemaCache;
  }

  if (schemaPromise) {
    return schemaPromise;
  }

  schemaPromise = rows(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'odg_sale_detail'
  `)
    .then((columnRows) => {
      const columnSet = new Set(columnRows.map((row) => row.column_name));
      const dateCol =
        DATE_COLUMN_ORDER.find((columnName) =>
          columnRows.some(
            (row) =>
              row.column_name === columnName &&
              DATE_COLUMN_TYPES.includes(row.data_type),
          ),
        ) || null;
      const custNameCol =
        CUSTOMER_NAME_COLUMNS.find((columnName) => columnSet.has(columnName)) || null;
      const costCol =
        COST_COLUMNS.find((columnName) => columnSet.has(columnName)) || null;

      const schema = {
        columnSet,
        dateCol,
        custNameCol,
        costCol,
      };

      schemaCache = schema;
      schemaTs = Date.now();
      return schema;
    })
    .finally(() => {
      schemaPromise = null;
    });

  return schemaPromise;
}
