import { NextResponse } from "next/server";
import { rows } from "@/lib/db";
import { getCurrentUser } from "@/lib/route-auth";

/**
 * The values a new rule may be keyed by, read from the ERP's own masters.
 *
 * Typing a brand or a design by hand is how a rule ends up matching nothing:
 * the scoring query compares them exactly, so "Toploader" or a trailing space
 * is a rule that silently never fires. `ic_brand` and `ic_design` are where
 * those names are defined, so the screen offers those and nothing else.
 *
 * A category is offered as the product category a person actually knows —
 * ເຄື່ອງຊັກຜ້າ, ຕູ້ເຢັນ — not as the point group it belongs to. The point group
 * is what a rule is stored against, so each category carries its own, and the
 * screen never asks anyone to know the difference.
 *
 * Designs come per category for the same reason: a design token is not one kind
 * of thing. A washer's is its loading type, a small appliance's is fixed by its
 * category, an air conditioner's is its compressor, and audio-visual has none.
 */
export async function GET(request) {
  try {
    if (!getCurrentUser(request)) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }

    const [brands, categories, designs, inUse] = await Promise.all([
      rows(`SELECT code, COALESCE(NULLIF(name_1, ''), code) AS label
            FROM public.ic_brand
            WHERE COALESCE(status, 0) = 0 AND btrim(COALESCE(code, '')) <> ''
            ORDER BY code`),
      rows(`SELECT c.category_code, c.pointmap_category, c.sda_subtype,
                   COALESCE(NULLIF(c.category_name, ''), NULLIF(ic.name_1, ''), c.category_code) AS label
            FROM public.app_incentive_category c
            LEFT JOIN public.ic_category ic ON ic.code = c.category_code
            WHERE c.pointmap_category IS NOT NULL AND COALESCE(c.is_active, true)
            ORDER BY c.pointmap_category, label`),
      // The tokens the scoring query can actually PRODUCE for each category.
      //
      // Not ic_design: the catalogue spells a fridge "2 Doors" while the token
      // the query derives is "2 Door", so a rule keyed from the catalogue would
      // never match a sale. app_incentive_design_token is the table that
      // performs that translation, so it is the only honest source — the Lao
      // wording beside it is what the ERP writes on the sale.
      rows(`SELECT DISTINCT d.item_category AS category_code,
                   dt.design_token AS token, dt.design_name AS label
            FROM public.odg_sale_detail d
            JOIN public.app_incentive_design_token dt ON btrim(dt.design_name) = btrim(d.design_name)
            WHERE btrim(COALESCE(dt.design_token, '')) <> ''
            ORDER BY 1, 2`),
      // Tokens existing rules are already written against, so a scheme that
      // predates the mapping table can still be seen and edited.
      rows(`SELECT DISTINCT category_code AS pointmap_category, design_token AS token
            FROM public.app_incentive_point_rule
            WHERE btrim(COALESCE(design_token, '')) <> ''`),
    ]);

    const byCategory = {};
    for (const row of designs) {
      byCategory[row.category_code] = byCategory[row.category_code] ?? [];
      if (!byCategory[row.category_code].some((item) => item.token === row.token)) {
        byCategory[row.category_code].push({ token: row.token, label: row.label || row.token });
      }
    }
    // Tokens already in use, offered on every category of their point group.
    for (const category of categories) {
      for (const row of inUse) {
        if (row.pointmap_category !== category.pointmap_category) continue;
        byCategory[category.category_code] = byCategory[category.category_code] ?? [];
        if (!byCategory[category.category_code].some((item) => item.token === row.token)) {
          byCategory[category.category_code].push({ token: row.token, label: row.token });
        }
      }
    }
    for (const category of categories) {
      // A small appliance's design token is its category's subtype, and an air
      // conditioner's is written into the scoring query rather than any table —
      // neither can be discovered from ic_design.
      if (category.sda_subtype) {
        byCategory[category.category_code] = [{ token: category.sda_subtype, label: category.sda_subtype }];
      } else if (category.pointmap_category === "Air") {
        byCategory[category.category_code] = [
          { token: "Inverter", label: "Inverter" },
          { token: "On-Off", label: "On-Off" },
        ];
      } else if (category.pointmap_category === "AV") {
        byCategory[category.category_code] = [];
      }
    }

    return NextResponse.json({ success: true, data: { brands, categories, designs: byCategory } });
  } catch (error) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}
