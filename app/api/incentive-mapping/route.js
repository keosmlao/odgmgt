import { NextResponse } from "next/server";
import { rows, query } from "@/lib/db";
import { parseIntSafe } from "@/lib/helpers";
import { getCurrentUser } from "@/lib/route-auth";
import { clearCache } from "@/lib/cache";

/**
 * The four translations a sale must survive before any rule can price it.
 *
 * A point rule is keyed by (point group · brand · design · band), and a sale
 * line carries none of those: it carries an ERP category code, a size written
 * in Lao, a design written in Lao, and a seller's name. Each has to be turned
 * into the vocabulary the scheme is written in, and where the translation is
 * missing the sale does not score badly — it does not score at all, silently,
 * and the point map looks perfectly healthy while it happens.
 *
 * These four tables are those translations. None of them had a screen: they
 * were maintained by scripts, which is why the gaps below have been costing
 * points with nobody able to see them. Each tab therefore serves two lists —
 * what IS mapped, and what SOLD without a mapping, worth most first.
 */
const RETAIL_BRANCH = process.env.ODG_RETAIL_BRANCH || "01";
const RETAIL_AR_GROUP = "101";

const firstOf = (year, month) => `${year}-${String(month).padStart(2, "0")}-01`;
const lastOf = (year, month) => new Date(Date.UTC(Number(year), Number(month), 0)).toISOString().slice(0, 10);

/** The four kinds, and how each is addressed. Nothing else may be written. */
const KINDS = {
  category: { table: "app_incentive_category", key: "category_code" },
  size: { table: "app_incentive_size_token", key: "size_name" },
  design: { table: "app_incentive_design_token", key: "design_name" },
  seller: { table: "app_incentive_sale_alias", key: "salename" },
};

export async function GET(request) {
  try {
    if (!getCurrentUser(request)) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }
    const sp = request.nextUrl.searchParams;
    const now = new Date();
    const year = parseIntSafe(sp.get("year"), now.getFullYear());
    const month = Math.min(12, Math.max(1, parseIntSafe(sp.get("month"), now.getMonth() + 1)));
    const from = firstOf(year, month);
    const to = lastOf(year, month);
    const sale = [RETAIL_BRANCH, RETAIL_AR_GROUP, from, to];

    const [
      groups, categories, sizes, designs, sellers, employees,
      categoryGaps, sizeGaps, designGaps, sellerGaps,
    ] = await Promise.all([
      rows(`SELECT code, label FROM public.app_incentive_pointmap_category
            WHERE COALESCE(is_active, true) ORDER BY sort_order, code`),

      rows(`SELECT c.category_code, c.category_name, c.pointmap_category, c.sda_subtype,
                   COALESCE(c.is_active, true) AS is_active,
                   COALESCE(NULLIF(ic.name_1, ''), c.category_name, c.category_code) AS erp_name
              FROM public.app_incentive_category c
              LEFT JOIN public.ic_category ic ON ic.code = c.category_code
             ORDER BY c.pointmap_category NULLS FIRST, c.category_code`),

      rows(`SELECT size_name, size_token FROM public.app_incentive_size_token ORDER BY size_name`),
      rows(`SELECT design_name, design_token FROM public.app_incentive_design_token ORDER BY design_name`),

      rows(`SELECT a.salename, a.employee_code,
                   COALESCE(NULLIF(e.fullname_lo, ''), a.employee_code) AS employee_name
              FROM public.app_incentive_sale_alias a
              LEFT JOIN public.odg_employee e ON e.employee_code = a.employee_code
             ORDER BY a.salename`),

      rows(`SELECT employee_code, COALESCE(NULLIF(fullname_lo, ''), employee_code) AS name
              FROM public.odg_employee
             WHERE btrim(COALESCE(employee_code, '')) <> ''
             ORDER BY name`),

      // Sold under a category with no point group — or with no row at all. Both
      // score nothing, and the second is invisible everywhere else.
      rows(
        `SELECT d.item_category AS code,
                COALESCE(NULLIF(MAX(d.item_category_name), ''), MAX(ic.name_1), d.item_category) AS name,
                (c.category_code IS NULL) AS unlisted,
                COALESCE(SUM(d.qty), 0)::float AS qty,
                COALESCE(SUM(d.sum_amount), 0)::float AS amount
           FROM public.odg_sale_detail d
           LEFT JOIN public.app_incentive_category c ON c.category_code = d.item_category
           LEFT JOIN public.ic_category ic ON ic.code = d.item_category
          WHERE d.branch_code = %s AND d.argroup_main = %s
            AND d.doc_date >= %s::date AND d.doc_date <= %s::date
            AND d.item_code NOT LIKE '97%%'
            AND (c.category_code IS NULL OR c.pointmap_category IS NULL)
          GROUP BY d.item_category, c.category_code
          ORDER BY 5 DESC LIMIT 60`,
        sale,
      ),

      // A size wording that never became a token. Only for the categories that
      // are IN the scheme — everything else is noise.
      rows(
        `SELECT d.size_name AS name, MAX(c.pointmap_category) AS pcat,
                COALESCE(SUM(d.qty), 0)::float AS qty,
                COALESCE(SUM(d.sum_amount), 0)::float AS amount
           FROM public.odg_sale_detail d
           JOIN public.app_incentive_category c ON c.category_code = d.item_category
                AND c.pointmap_category IS NOT NULL
           LEFT JOIN public.app_incentive_size_token st ON btrim(st.size_name) = btrim(d.size_name)
          WHERE d.branch_code = %s AND d.argroup_main = %s
            AND d.doc_date >= %s::date AND d.doc_date <= %s::date
            AND st.size_name IS NULL
          GROUP BY d.size_name
          ORDER BY 4 DESC LIMIT 60`,
        sale,
      ),

      rows(
        `SELECT d.design_name AS name, MAX(c.pointmap_category) AS pcat,
                COALESCE(SUM(d.qty), 0)::float AS qty,
                COALESCE(SUM(d.sum_amount), 0)::float AS amount
           FROM public.odg_sale_detail d
           JOIN public.app_incentive_category c ON c.category_code = d.item_category
                AND c.pointmap_category IS NOT NULL
           LEFT JOIN public.app_incentive_design_token dt ON btrim(dt.design_name) = btrim(d.design_name)
          WHERE d.branch_code = %s AND d.argroup_main = %s
            AND d.doc_date >= %s::date AND d.doc_date <= %s::date
            AND dt.design_name IS NULL
          GROUP BY d.design_name
          ORDER BY 4 DESC LIMIT 60`,
        sale,
      ),

      // A seller whose name matches neither an alias nor the staff register: the
      // sale is scored and then belongs to nobody, so it is paid to nobody.
      rows(
        `SELECT d.salename AS name,
                COALESCE(SUM(d.qty), 0)::float AS qty,
                COALESCE(SUM(d.sum_amount), 0)::float AS amount
           FROM public.odg_sale_detail d
           LEFT JOIN public.app_incentive_sale_alias a ON btrim(a.salename) = btrim(d.salename)
           LEFT JOIN public.odg_employee e ON btrim(e.fullname_lo) = btrim(d.salename)
          WHERE d.branch_code = %s AND d.argroup_main = %s
            AND d.doc_date >= %s::date AND d.doc_date <= %s::date
            AND a.salename IS NULL AND e.employee_code IS NULL
          GROUP BY d.salename
          ORDER BY 3 DESC LIMIT 60`,
        sale,
      ),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        year, month, groups, employees,
        category: { rows: categories, gaps: categoryGaps },
        size: { rows: sizes, gaps: sizeGaps },
        design: { rows: designs, gaps: designGaps },
        seller: { rows: sellers, gaps: sellerGaps },
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}

/**
 * Write one translation.
 *
 * The table is chosen from a fixed map rather than from the request, so a kind
 * this route does not know about cannot reach the database at all.
 */
export async function POST(request) {
  try {
    if (!getCurrentUser(request)) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }
    const body = await request.json().catch(() => null);
    const kind = KINDS[String(body?.kind ?? "")];
    if (!kind) return NextResponse.json({ success: false, message: "unknown kind" }, { status: 400 });
    const key = String(body?.key ?? "").trim();
    if (!key) return NextResponse.json({ success: false, message: "key is required" }, { status: 400 });

    if (body.kind === "category") {
      const group = String(body?.pointmap_category ?? "").trim();
      const subtype = String(body?.sda_subtype ?? "").trim();
      await query(
        `INSERT INTO public.app_incentive_category
                (category_code, category_name, pointmap_category, sda_subtype, is_active)
         VALUES (%s, %s, %s, %s, true)
         ON CONFLICT (category_code) DO UPDATE
            SET category_name = COALESCE(NULLIF(EXCLUDED.category_name, ''), public.app_incentive_category.category_name),
                pointmap_category = EXCLUDED.pointmap_category,
                sda_subtype = EXCLUDED.sda_subtype,
                is_active = true`,
        [key, String(body?.category_name ?? "").trim(), group || null, subtype || null],
      );
    } else {
      const value = String(body?.value ?? "").trim();
      if (!value) return NextResponse.json({ success: false, message: "value is required" }, { status: 400 });
      const column = { size: "size_token", design: "design_token", seller: "employee_code" }[body.kind];
      await query(
        `INSERT INTO public.${kind.table} (${kind.key}, ${column}) VALUES (%s, %s)
         ON CONFLICT (${kind.key}) DO UPDATE SET ${column} = EXCLUDED.${column}`,
        [key, value],
      );
    }

    await clearCache("incentive-sold:");
    return NextResponse.json({ success: true, data: { kind: body.kind, key } });
  } catch (error) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    if (!getCurrentUser(request)) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }
    const body = await request.json().catch(() => null);
    const kind = KINDS[String(body?.kind ?? "")];
    if (!kind) return NextResponse.json({ success: false, message: "unknown kind" }, { status: 400 });
    const key = String(body?.key ?? "").trim();
    if (!key) return NextResponse.json({ success: false, message: "key is required" }, { status: 400 });

    // A category is switched off rather than removed: point rules elsewhere are
    // written against its group, and the sales it already scored stay explained.
    const removed = body.kind === "category"
      ? await query(`UPDATE public.app_incentive_category SET is_active = false WHERE category_code = %s`, [key])
      : await query(`DELETE FROM public.${kind.table} WHERE ${kind.key} = %s`, [key]);

    await clearCache("incentive-sold:");
    return NextResponse.json({ success: true, data: { removed: removed.rowCount } });
  } catch (error) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}
