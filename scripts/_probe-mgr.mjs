import { loadEnv } from "./_env.mjs";
import pg from "pg";
loadEnv();
const pool = new pg.Pool({
  host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD,
  max: 1, statement_timeout: 120000,
});
const show = async (label, sql) => {
  const r = await pool.query(sql);
  console.log(`\n=== ${label} ===`);
  for (const row of r.rows.slice(0, 30)) console.log(JSON.stringify(row));
};
await show("assigned people who are managers", `
  SELECT DISTINCT a.sale_id, MIN(a.sale_name) AS name,
         COALESCE(NULLIF(btrim(p.position_name_lo),''),'(none)') AS position,
         COALESCE(p.is_manager,false) AS is_manager,
         string_agg(DISTINCT a.bu_code, '+') AS bus,
         COUNT(*)::int AS rows,
         string_agg(DISTINCT COALESCE(array_to_string(a.channel_codes,'+'),'ALL'), ' | ') AS channels
  FROM public.odg_sales_assignment a
  LEFT JOIN public.odg_employee e ON btrim(e.employee_code) = a.sale_id
  LEFT JOIN public.odg_position p ON p.position_code = btrim(e.position_code)
  GROUP BY a.sale_id, position, is_manager
  ORDER BY is_manager DESC, a.sale_id`);
await show("plan by channel × BU", `
  SELECT bu_code, sale_channel, SUM(target_amount)::float AS plan
  FROM public.odg_sales_target WHERE target_year=2026
  GROUP BY 1,2 ORDER BY 1,3 DESC`);
await pool.end();
