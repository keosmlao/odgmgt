import { NextResponse } from "next/server";
import { rows } from "@/lib/db";

/**
 * The people an area can be assigned to, from the HR roster.
 *
 * This used to read public.erp_user — the ERP's login accounts, which include
 * service, warehouse and system logins, and which carry ERP usernames rather
 * than employee codes. Every sale_id already stored in odg_sales_assignment is
 * an odg_employee.employee_code, so the picker was offering a different set of
 * identifiers than the table it writes to; the roster is the source of record
 * for who works here, and for the incentive reports that score the same codes.
 *
 * Resigned staff are left out: this list exists to hand out NEW areas. An
 * assignment already held by someone who has left keeps showing in the grid,
 * which reads the assignment rows themselves, not this list.
 */
export async function GET() {
  try {
    const result = await rows(
      `SELECT e.employee_code,
              COALESCE(NULLIF(btrim(e.fullname_lo), ''),
                       NULLIF(btrim(e.fullname_en), ''),
                       NULLIF(btrim(e.nickname), ''),
                       e.employee_code) AS name,
              COALESCE(NULLIF(btrim(e.nickname), ''), '') AS nickname,
              COALESCE(NULLIF(btrim(e.position_code), ''), '') AS position_code,
              COALESCE(NULLIF(btrim(p.position_name_lo), ''), '') AS position,
              COALESCE(p.is_manager, false) AS is_manager
         FROM public.odg_employee e
         LEFT JOIN public.odg_position p ON p.position_code = btrim(e.position_code)
        WHERE COALESCE(NULLIF(btrim(e.employee_code), ''), '') <> ''
          AND UPPER(COALESCE(btrim(e.employment_status), 'ACTIVE')) = 'ACTIVE'
        ORDER BY name, e.employee_code`,
    );

    const data = result.map((row) => ({
      id: row.employee_code,
      code: row.employee_code,
      name: row.name,
      nickname: row.nickname,
      position_code: row.position_code,
      position: row.position,
      is_manager: row.is_manager,
    }));

    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
