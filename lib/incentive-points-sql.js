import { OVERRIDE_JOIN, REPORT_DATE, REPORT_MONTH_FILTER } from "@/lib/sale-month-override";
import { isOnlineBillSql } from "./online-channel.mjs";

/**
 * The scoring query behind every incentive figure: one row per sold item per
 * bill, with the point rule that priced it and why.
 *
 * It lives here rather than inside the report because three screens need the
 * same answer — the reward report, the rule-gap manager, and the maintenance
 * scripts. A second copy would drift, and a drifting copy of this query means
 * two different answers to "what did this person earn".
 *
 * Placeholders, in order: year, month, year, month, branch, ar_group.
 */
export const POINTS_SQL = `
      WITH line AS (
        SELECT s.employee_code, s.category_name, s.item_code, s.item_name, s.doc_date, s.report_date, s.doc_no,
               s.brand, s.qty, s.sales_amount, s.price,
               -- The ERP's own wording, carried through beside the token it
               -- produced. When a line scores nothing because its size or
               -- design never became a token, this is the value that has to be
               -- mapped — and reading it off the token is impossible, because
               -- the token is exactly what is missing.
               s.size_name, s.design_name,
               -- The outdoor half scores nothing because its indoor half already
               -- scored the set. When it has no indoor half on the bill — an
               -- outdoor unit sold on its own, or a set split across two bills —
               -- nothing else is going to score it, so it scores itself.
               CASE
                 WHEN s.pcat = 'Air' AND s.item_name ~ '\\[H\\]\\s*$' AND s.has_mate THEN 0
                 ELSE s.qty
               END AS point_qty,
               CASE s.pcat
                 WHEN 'SDA' THEN s.sda_subtype
                 WHEN 'Air' THEN CASE WHEN s.item_name ~* 'invert' THEN 'Inverter' ELSE 'On-Off' END
                 WHEN 'AV' THEN ''
                 ELSE COALESCE(dt.design_token, '')
               END AS design_token,
               CASE
                 WHEN s.pcat = 'REF' THEN COALESCE(st.size_token, '')
                 -- ERP occasionally introduces a new spelling such as
                 -- "10.0ກິໂລ" before it is added to the token table. Washer
                 -- rules are numeric bands, so derive the band as a safe
                 -- fallback instead of silently dropping the sale.
                 WHEN s.pcat = 'Washer' THEN COALESCE(
                   st.size_token,
                   CASE
                     WHEN (substring(replace(s.size_name, ',', '.') from '([0-9]+([.][0-9]+)?)'))::numeric < 6 THEN '<5'
                     WHEN (substring(replace(s.size_name, ',', '.') from '([0-9]+([.][0-9]+)?)'))::numeric <= 11 THEN '6-11'
                     WHEN (substring(replace(s.size_name, ',', '.') from '([0-9]+([.][0-9]+)?)'))::numeric <= 14 THEN '12-14'
                     WHEN (substring(replace(s.size_name, ',', '.') from '([0-9]+([.][0-9]+)?)'))::numeric <= 19 THEN '15-19'
                     WHEN (substring(replace(s.size_name, ',', '.') from '([0-9]+([.][0-9]+)?)'))::numeric IS NOT NULL THEN '>20'
                     ELSE ''
                   END
                 )
                 WHEN s.pcat = 'AV' AND s.item_category = '008' THEN COALESCE(st.size_token, '')
                 -- Price brackets come from app_incentive_price_band (see the
                 -- lateral below), not from a CASE written here: a bracket is
                 -- the same kind of decision as an inch or a kilogram band, and
                 -- it should not cost a deployment to change one.
                 WHEN s.pcat IN ('AV', 'Air', 'SDA') THEN COALESCE(pb.size_token, '')
                 ELSE ''
               END AS size_token,
               -- The number a band is really a bound on. Bands used to be
               -- matched by name, which meant a size wording nobody had mapped
               -- matched nothing at all and scored zero, and a band belonged to
               -- the whole category because the name did. Carrying the number
               -- instead lets each brand and design keep its own ladder, and
               -- leaves no measurement without a band.
               --
               -- A size wording is often a range of its own ("10.0-14.9ຄິວ",
               -- "ນ້ອຍກວ່າ 5.0ຄິວ"), so it is its LOWER edge that identifies it.
               CASE
                 WHEN s.pcat = 'Air' THEN s.combo_price
                 WHEN s.pcat = 'AV' AND s.item_category <> '008' THEN s.combo_price
                 WHEN s.pcat = 'SDA' THEN s.price
                 WHEN s.size_name ~ 'ນ້ອຍກວ່າ' THEN 0
                 ELSE (substring(replace(s.size_name, ',', '.') from '([0-9]+([.][0-9]+)?)'))::numeric
               END AS measure,
               -- Which measurement it is, so an inch ceiling is never compared
               -- against a price.
               CASE
                 WHEN s.pcat = 'SDA' OR s.pcat = 'Air' OR (s.pcat = 'AV' AND s.item_category <> '008')
                   THEN 'price' ELSE 'size'
               END AS measure_kind,
               s.pcat
        FROM (
          SELECT COALESCE(a.employee_code, e.employee_code) AS employee_code,
                 d.doc_date, ${REPORT_DATE} AS report_date,
                 d.doc_no, d.item_code, d.item_name, d.item_category,
                 d.design_name, d.size_name, d.qty, d.price,
                 d.sum_amount AS sales_amount,
                 COALESCE(NULLIF(d.item_category_name, ''), '-') AS category_name,
                 UPPER(COALESCE(d.item_brand, '')) AS brand,
                 -- Deliberately NOT defaulted to 'SDA'. A category that is not
                 -- in app_incentive_category with a point group is outside the
                 -- scheme (TV brackets, freezers, spare parts …); falling back
                 -- to the SDA catch-all let those match an SDA rule by brand
                 -- and price band and quietly earn points they never should.
                 -- A NULL here matches no rule, which is the intended answer.
                 c.pointmap_category AS pcat,
                 COALESCE(c.sda_subtype, 'OTH') AS sda_subtype,
                 -- Band value of a split air conditioner:
                 --
                 --   (ຍອດຂາຍ [C] + ຍອດຂາຍ [H] − ຄ່າຕິດຕັ້ງ) ÷ ຈຳນວນຊຸດ
                 --
                 -- Read off what the customer actually PAID, not the list price.
                 -- A set sold at a discount is worth what it fetched, and the
                 -- band is a claim about the machine's value — banding a
                 -- discounted set on its ticket price pays the seller for money
                 -- the shop never took.
                 --
                 -- The ERP stores the set as an indoor [C] and an outdoor [H]
                 -- line. Summing every air line on the bill would merge two
                 -- different sets into one average, so the OPPOSITE component is
                 -- found instead: exactly one set per component line, however
                 -- many sets the bill carries. Dividing by qty brings a line
                 -- covering several sets back to one. Standalone/portable units
                 -- and unmatched components stand as their own set.
                 --
                 -- Both halves therefore resolve to the SAME number, which is
                 -- what lets a screen show one value for the set instead of two
                 -- that disagree.
                 --
                 -- ຄ່າຕິດຕັ້ງ then comes off: a bill that had the machine fitted
                 -- must not be pushed into a higher band than the same machine
                 -- carried away. install.ratio is the share of the bill's air
                 -- takings the fitting charge represents, so each set gives up
                 -- its own share — the charge is billed per unit at a price set
                 -- by BTU class, and a bigger unit is both worth more and costs
                 -- more to fit.
                 CASE
                   WHEN c.pointmap_category = 'Air'
                     THEN ((d.sum_amount + COALESCE(mate.amount, 0)) / NULLIF(d.qty, 0))
                          * (1 - COALESCE(install.ratio, 0))
                   ELSE d.price
                 END AS combo_price,
                 -- Whether this component found its other half at all.
                 (c.pointmap_category = 'Air' AND d.item_name ~ '\\[[CH]\\]\\s*$'
                  AND mate.amount IS NOT NULL) AS has_mate
          FROM public.odg_sale_detail d
          ${OVERRIDE_JOIN}
          -- The other half of the set, and what it sold for. The two halves are
          -- separate item codes with separate model numbers (FTKQ12XV2S beside
          -- RKQ12XV2S), so they are matched on the bill, the seller, the brand
          -- and the quantity — everything except the name, which differs by
          -- design. The nearest item code wins, because a set's two components
          -- are catalogued next to each other, which is what keeps two sets of
          -- the same brand on one bill from crossing over.
          LEFT JOIN LATERAL (
            SELECT mate.sum_amount AS amount
            FROM public.odg_sale_detail mate
            WHERE mate.doc_no = d.doc_no
              AND mate.branch_code IS NOT DISTINCT FROM d.branch_code
              AND mate.salename IS NOT DISTINCT FROM d.salename
              AND UPPER(COALESCE(mate.item_brand, '')) = UPPER(COALESCE(d.item_brand, ''))
              AND mate.qty IS NOT DISTINCT FROM d.qty
              AND (
                (d.item_name ~ '\\[C\\]\\s*$' AND mate.item_name ~ '\\[H\\]\\s*$')
                OR
                (d.item_name ~ '\\[H\\]\\s*$' AND mate.item_name ~ '\\[C\\]\\s*$')
              )
            ORDER BY abs(
              COALESCE(NULLIF(regexp_replace(mate.item_code, '\\D', '', 'g'), ''), '0')::bigint
              - COALESCE(NULLIF(regexp_replace(d.item_code, '\\D', '', 'g'), ''), '0')::bigint
            ) ASC
            LIMIT 1
          ) mate ON TRUE
          -- What fraction of this bill's air-conditioner takings is installation.
          --
          -- The denominator is every air line's ຍອດຂາຍ, both halves of every
          -- set: summed that way it is exactly the total of the set values the
          -- bands are read against, without having to resolve each set's other
          -- half a second time. Dividing by it and multiplying back per set
          -- spreads the charge in proportion to what each set fetched, and
          -- leaves the whole charge accounted for and no more.
          --
          -- 9701xx is ຕິດຕັ້ງ (both the air-conditioner and the appliance
          -- codes). 9702 ກວດເຊັກ, 9703 ຂົນສົ່ງ and 9704 ຮັບຝາກ are services
          -- bought alongside the machine, not part of getting it working, and
          -- stay out.
          --
          -- The charge taken off is the PRICE LIST cost of fitting, not the
          -- figure printed on the bill. A bill discounts the whole basket, the
          -- fitting line with it, so the billed figure understates what the
          -- work costs and leaves part of it sitting inside the machine's
          -- value. ic_inventory_price holds the branch's own THB price for each
          -- fitting code, by month; a code with no price falls back to what the
          -- bill charged, which is the best figure there is for it.
          LEFT JOIN LATERAL (
            SELECT COALESCE(
              (SELECT SUM(COALESCE(
                 (SELECT ip.sale_price1
                    FROM public.ic_inventory_price ip
                   WHERE ip.ic_code = fit.item_code
                     AND ip.currency_code = '01'
                     AND COALESCE(ip.status, 1) = 1
                     AND ip.from_date <= ${REPORT_DATE}
                     AND ip.to_date >= ${REPORT_DATE}
                   ORDER BY (ip.cust_group_1 = '101') DESC,
                            ip.from_date DESC, ip.roworder DESC
                   LIMIT 1) * fit.qty,
                 fit.sum_amount))
                 FROM public.odg_sale_detail fit
                WHERE fit.doc_no = d.doc_no
                  AND fit.branch_code IS NOT DISTINCT FROM d.branch_code
                  AND fit.item_code LIKE '9701%%')
              / NULLIF((SELECT SUM(air.sum_amount)
                          FROM public.odg_sale_detail air
                          JOIN public.app_incentive_category air_cat
                            ON air_cat.category_code = air.item_category
                         WHERE air.doc_no = d.doc_no
                           AND air.branch_code IS NOT DISTINCT FROM d.branch_code
                           AND air_cat.pointmap_category = 'Air'), 0),
              0) AS ratio
          ) install ON TRUE
          LEFT JOIN public.app_incentive_category c ON c.category_code = d.item_category
          LEFT JOIN public.app_incentive_sale_alias a ON btrim(a.salename) = btrim(d.salename)
          LEFT JOIN public.odg_employee e ON btrim(e.fullname_lo) = btrim(d.salename)
          WHERE ${REPORT_MONTH_FILTER}
            AND d.branch_code = %s AND d.argroup_main = %s
         -- ຂາຍອອນລາຍ is rung up at this branch under the retail AR group but is
         -- not storefront work; see lib/online-channel.mjs.
         AND NOT ${isOnlineBillSql("d.doc_no")}
            AND d.item_code NOT LIKE '97%%'
            AND COALESCE(c.is_active, true)
        ) s
        LEFT JOIN public.app_incentive_design_token dt ON dt.design_name = s.design_name
        LEFT JOIN public.app_incentive_size_token st ON st.size_name = s.size_name
        -- The smallest bracket whose ceiling the price is still under. The top
        -- bracket carries no ceiling (max_price IS NULL) and sorts last, so
        -- every price lands in exactly one — a sale can never fall past the end
        -- of the ladder and score nothing because a threshold was left short.
        --
        -- An air conditioner is bracketed on the price of the whole set, which
        -- is what combo_price carries; everything else on its own line price.
        LEFT JOIN LATERAL (
          SELECT b.size_token
          FROM public.app_incentive_price_band b
          WHERE b.category_code = s.pcat
            -- Price rows only: the same table also holds the size ladders the
            -- configuration screen draws its columns from.
            AND COALESCE(b.kind, 'price') = 'price'
            AND (
              b.max_price IS NULL
              OR (CASE WHEN s.pcat IN ('AV', 'Air') THEN s.combo_price ELSE s.price END) <= b.max_price
            )
          ORDER BY b.max_price ASC NULLS LAST
          LIMIT 1
        ) pb ON TRUE
      ),
      scored AS (
        SELECT l.employee_code, l.category_name, l.pcat, l.brand, l.item_code, l.item_name, l.doc_no, l.doc_date,
               l.qty, l.point_qty, l.sales_amount, l.price,
               l.design_token, l.size_token, l.size_name, l.design_name, l.measure,
               r.points AS rule_points,
               r.rule_max, r.rule_band, r.rule_kind,
               ps.status_code, ps.note AS status_note,
               -- The raw multiplier stays NULL when the item has no status
               -- rule, which is what tells "no rule" apart from "a rule that
               -- pays zero" when explaining a zero-point line.
               m.multiplier AS raw_multiplier,
               COALESCE(m.multiplier, 1) AS status_multiplier
        FROM line l
        -- A band is a ceiling, and a line takes the SMALLEST ceiling that still
        -- covers it WITHIN ITS OWN brand and design. That is what lets two rows
        -- of one category carry different ladders — the ladder is now a
        -- property of the row, not of the category — and, because the top of
        -- every ladder is open, no measurement is left without a band.
        --
        -- A band meant to pay nothing is written as a rule paying zero. There
        -- is no such thing here as an empty band that scores zero by omission:
        -- omitting one hands the sale to the band above it.
        LEFT JOIN LATERAL (
          -- The rule's own ceiling and name come back with its rate, so a
          -- screen can say WHICH band caught a product rather than only what it
          -- paid. Reading it off the measurement afterwards would be a second
          -- implementation of the match, free to disagree with this one.
          SELECT r.points, r.max_value AS rule_max, r.size_token AS rule_band, r.band_kind AS rule_kind
          FROM public.app_incentive_point_rule r
          WHERE r.category_code = l.pcat
            AND r.brand_code = l.brand
            AND r.design_token = l.design_token
            AND l.report_date BETWEEN r.effective_from AND r.effective_to
            AND r.band_kind = l.measure_kind
            AND l.measure IS NOT NULL
            AND (r.max_value IS NULL OR l.measure <= r.max_value)
          ORDER BY r.max_value ASC NULLS LAST,
                   r.is_special DESC,
                   (r.effective_to - r.effective_from) ASC,
                   r.updated_at DESC, r.id DESC
          LIMIT 1
        ) r ON TRUE
        LEFT JOIN LATERAL (
          SELECT ps.status_code, ps.note
          FROM public.app_incentive_product_status_rule ps
          WHERE ps.item_code = l.item_code
            AND l.report_date BETWEEN ps.effective_from AND ps.effective_to
          ORDER BY (ps.effective_to - ps.effective_from) ASC, ps.updated_at DESC
          LIMIT 1
        ) ps ON TRUE
        LEFT JOIN public.app_incentive_status_multiplier m ON m.status_code = ps.status_code
      )
      -- One row per sold item per bill, so the report can be drilled down
      -- category → brand → the bills that earned the points.
      SELECT employee_code, category_name, MAX(pcat) AS pcat, brand, item_code, item_name, doc_no, doc_date,
             COALESCE(SUM(qty), 0)::float AS qty,
             COALESCE(SUM(sales_amount), 0)::float AS amount,
             -- List price per unit: the figure the price band is chosen by,
             -- which the sale amount is not once a discount or a quantity
             -- above one is involved.
             MAX(price)::float AS price,
             COALESCE(SUM(rule_points * point_qty * status_multiplier), 0)::float AS points,
             COALESCE(MAX(rule_points * status_multiplier), 0)::float AS unit_points,
             COALESCE(SUM(point_qty) FILTER (WHERE rule_points IS NOT NULL), 0)::float AS matched_qty,
             COALESCE(SUM(point_qty) FILTER (WHERE rule_points IS NULL), 0)::float AS unmatched_qty,
             -- Everything the client needs to say WHY a line scored nothing.
             COALESCE(SUM(point_qty), 0)::float AS point_qty,
             MAX(design_token) AS design_token,
             MAX(size_token) AS size_token,
             -- The number the band was chosen by, so a zero can be explained
             -- without guessing which wording produced it.
             MAX(measure)::float AS measure,
             -- Beside each token, the wording it was derived from.
             MAX(size_name) AS size_name,
             MAX(design_name) AS design_name,
             MAX(status_code) AS status_code,
             MAX(status_note) AS status_note,
             MAX(raw_multiplier)::float AS raw_multiplier,
             MAX(rule_points)::float AS configured_points,
             -- Which band actually caught it: the ceiling, and the name that
             -- ceiling is filed under. NULL for a line no rule covers.
             MAX(rule_max)::float AS rule_max,
             MAX(rule_band) AS rule_band,
             MAX(rule_kind) AS rule_kind
      FROM scored
      GROUP BY employee_code, category_name, brand, item_code, item_name, doc_no, doc_date
`;
