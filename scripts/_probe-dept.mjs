import { loadEnv } from "./_env.mjs";
import pg from "pg";
loadEnv();
const pool = new pg.Pool({
  host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD,
  max: 1, statement_timeout: 300000,
});
const show = async (label, sql) => {
  try {
    const r = await pool.query(sql);
    console.log(`\n=== ${label} ===`);
    for (const row of r.rows.slice(0, 45)) console.log(JSON.stringify(row));
  } catch (e) { console.log(`\n=== ${label} === ERR ${e.message}`); }
};
await show("BU list", `SELECT code, name_1 FROM public.erp_bu_list ORDER BY code`);
await show("BU list fallback (from sale detail)", `
  SELECT DISTINCT bu_code, bu_name FROM public.odg_sale_detail
  WHERE yeardoc=2026 AND COALESCE(bu_code,'')<>'' ORDER BY 1`);
await show("board sellers: department fields vs BUs they actually sell", `
  SELECT a.sale_id, MIN(a.sale_name) AS name,
         string_agg(DISTINCT a.bu_code, '+' ORDER BY a.bu_code) AS assigned_bus,
         COALESCE(NULLIF(btrim(e.department_code),''),'-') AS hr_dept,
         COALESCE(NULLIF(btrim(e.unit_code),''),'-') AS hr_unit,
         COALESCE(NULLIF(btrim(u.department),''),'-') AS erp_dept,
         COALESCE(NULLIF(btrim(u.bu_code),''),'-') AS erp_bu,
         COALESCE(NULLIF(btrim(dl.name_1),''),'-') AS erp_dept_name
  FROM public.odg_sales_assignment a
  LEFT JOIN public.odg_employee e ON btrim(e.employee_code)=a.sale_id
  LEFT JOIN public.erp_user u ON btrim(u.code)=a.sale_id
  LEFT JOIN public.erp_department_list dl ON btrim(dl.code)=btrim(u.department)
  GROUP BY a.sale_id, hr_dept, hr_unit, erp_dept, erp_bu, erp_dept_name
  ORDER BY a.sale_id`);
await pool.end();
