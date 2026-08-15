/**
 * Where a suggested point rate comes from.
 *
 * Shared by the script that prints suggestions and the one that writes them,
 * so what gets reviewed is exactly what gets saved.
 *
 * Nothing here is invented. Within a category and design, brands price their
 * ladder in the same shape, so a missing rate is derived from the map itself:
 *
 *   hole   median( rate[missing] / rate[anchor] ) over brands holding BOTH,
 *          times this brand's own rate at the anchor; failing that, the
 *          straight line between the neighbours either side
 *   blank  median of the other brands' rate at that exact band
 *
 * Every suggestion carries `from` — how many brands it was drawn from. A rate
 * backed by ten brands is worth acting on; one backed by a single brand is a
 * guess wearing a number, and the caller is expected to treat it that way.
 */

/** Bands are a scale; sort them like one. `<=X` is an open lower bound. */
export const bandKey = (band) => {
  const first = Number(band.match(/[\d.]+/)?.[0] ?? Infinity);
  return band.trimStart().startsWith("<") ? [0, first] : [first, first];
};

export const sortBands = (list) => [...list].sort((a, b) => {
  const [a1, a2] = bandKey(a);
  const [b1, b2] = bandKey(b);
  return a1 - b1 || a2 - b2;
});

const median = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Rates in this scheme move in quarter points; keep suggestions on that grid. */
const toQuarter = (value) => Math.round(value * 4) / 4;

/**
 * Rate a brand actually earns at a band once the ceiling rule is applied: a
 * `<=` rule covers every lower `<=` band that has no rule of its own.
 */
function effectiveRate(byBand, bands, index) {
  const own = byBand.get(bands[index]);
  if (own !== undefined) return { points: own, own: true };
  if (!bands[index].trimStart().startsWith("<=")) return null;
  const cover = bands.slice(index + 1).find((band) => band.trimStart().startsWith("<=") && byBand.has(band));
  return cover ? { points: byBand.get(cover), own: false } : null;
}

/**
 * @param ruleRows  every rule in force for the month
 * @param soldRows  {pcat, brand, qty, amount} of what actually sold
 * @returns suggestions sorted by the sales value they unlock
 */
export function computeSuggestions(ruleRows, soldRows) {
  const soldIndex = new Map(soldRows.map((row) => [`${row.pcat}|${row.brand}|${row.design_token}|${row.size_token}`, row]));

  const map = new Map();       // category -> design -> brand -> band -> points
  const bandsByCat = new Map();
  for (const row of ruleRows) {
    const cat = row.category_code;
    if (!map.has(cat)) map.set(cat, new Map());
    const byDesign = map.get(cat);
    if (!byDesign.has(row.design_token)) byDesign.set(row.design_token, new Map());
    const byBrand = byDesign.get(row.design_token);
    if (!byBrand.has(row.brand_code)) byBrand.set(row.brand_code, new Map());
    byBrand.get(row.brand_code).set(row.size_token, Number(row.points));
    if (!bandsByCat.has(cat)) bandsByCat.set(cat, new Set());
    bandsByCat.get(cat).add(row.size_token);
  }

  const ratio = (byBrand, target, anchor) => {
    const seen = [];
    for (const bands of byBrand.values()) {
      const a = bands.get(anchor);
      const b = bands.get(target);
      if (a > 0 && b !== undefined) seen.push(b / a);
    }
    return seen.length ? { value: median(seen), from: seen.length } : null;
  };

  const out = [];

  for (const [cat, byDesign] of map) {
    const bands = sortBands(bandsByCat.get(cat));
    for (const [design, byBrand] of byDesign) {
      for (const [brand, byBand] of byBrand) {
        const rates = bands.map((_, index) => effectiveRate(byBand, bands, index));
        const first = rates.findIndex(Boolean);
        if (first < 0) continue;
        const last = rates.length - 1 - [...rates].reverse().findIndex(Boolean);
        for (let index = first; index <= last; index += 1) {
          if (rates[index]) continue;
          const band = bands[index];
          const below = rates.slice(0, index).map((rate, i) => (rate?.own ? bands[i] : null)).filter(Boolean).pop();
          const above = bands.slice(index + 1).find((later) => byBand.has(later));
          const anchor = below ?? above;
          const byRatio = anchor ? ratio(byBrand, band, anchor) : null;
          let points = null;
          let basis = "";
          let from = 0;
          if (byRatio && byBand.get(anchor) > 0) {
            points = toQuarter(byBand.get(anchor) * byRatio.value);
            basis = `${anchor}×${byRatio.value.toFixed(2)}`;
            from = byRatio.from;
          } else if (below && above) {
            const span = bands.indexOf(above) - bands.indexOf(below);
            const step = (byBand.get(above) - byBand.get(below)) / span;
            points = toQuarter(byBand.get(below) + step * (index - bands.indexOf(below)));
            basis = `ເສັ້ນຊື່ ${below}→${above}`;
            from = 2;
          }
          if (points === null || points <= 0) continue;
          out.push({
            kind: "hole",
            category_code: cat, brand_code: brand, design_token: design, size_token: band,
            points, basis, from,
            amount: Number(soldIndex.get(`${cat}|${brand}|${design}|${band}`)?.amount ?? 0),
            qty: Number(soldIndex.get(`${cat}|${brand}|${design}|${band}`)?.qty ?? 0),
          });
        }
      }
    }
  }

  // Only combinations that ACTUALLY SOLD and scored nothing. The first version
  // fanned out over every design in the category, so a brand selling one kettle
  // was handed rules for air purifiers and dispensers it has never stocked.
  for (const row of soldRows) {
    if (Number(row.points ?? 0) !== 0) continue;
    const cat = row.pcat;
    const byDesign = map.get(cat);
    if (!byDesign) continue;
    const byBrand = byDesign.get(row.design_token);
    if (!byBrand) continue;
    if (byBrand.get(row.brand)?.has(row.size_token)) continue;
    // Already covered by a ceiling? Then it is not a gap.
    const bands = sortBands(bandsByCat.get(cat));
    const own = byBrand.get(row.brand);
    if (own) {
      const index = bands.indexOf(row.size_token);
      if (index >= 0 && effectiveRate(own, bands, index)) continue;
    }
    const seen = [...byBrand.values()].map((byBand) => byBand.get(row.size_token)).filter((value) => value !== undefined);
    if (seen.length < 2) continue;
    const points = toQuarter(median(seen));
    if (points <= 0) continue;
    out.push({
      kind: "blank",
      category_code: cat, brand_code: row.brand,
      design_token: row.design_token, size_token: row.size_token,
      points, basis: "ຄ່າກາງ", from: seen.length,
      amount: Number(row.amount ?? 0), qty: Number(row.qty ?? 0),
    });
  }

  const seenKeys = new Set();
  const unique = out.filter((row) => {
    const key = `${row.category_code}|${row.brand_code}|${row.design_token}|${row.size_token}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  return unique.sort((a, b) => b.amount - a.amount || a.category_code.localeCompare(b.category_code));
}

/**
 * Rules in force on the 15th, and what sold that month at the exact grain a
 * rule is keyed by.
 *
 * The sold side is read through the REPORT'S OWN scoring query rather than a
 * copy of it, so the design and size tokens here are the ones the pay run
 * used. A separate derivation would drift, and a suggestion built on a token
 * the report never produces is worse than no suggestion.
 */
export async function loadInputs(rows, year, month, reportSql) {
  const on = `${year}-${String(month).padStart(2, "0")}-15`;
  const branch = process.env.ODG_RETAIL_BRANCH || "01";
  const [ruleRows, lines] = await Promise.all([
    rows(
      `SELECT category_code, brand_code, design_token, size_token, points::float AS points
       FROM public.app_incentive_point_rule
       WHERE %s::date BETWEEN effective_from AND effective_to`,
      [on],
    ),
    rows(reportSql, [year, month, year, month, branch, "101"]),
  ]);

  const byKey = new Map();
  for (const line of lines) {
    if (!line.pcat) continue;
    const key = `${line.pcat}|${line.brand}|${line.design_token ?? ""}|${line.size_token ?? ""}`;
    const entry = byKey.get(key) ?? {
      pcat: line.pcat,
      brand: String(line.brand ?? ""),
      design_token: line.design_token ?? "",
      size_token: line.size_token ?? "",
      qty: 0, amount: 0, points: 0,
    };
    entry.qty += Number(line.qty || 0);
    entry.amount += Number(line.amount || 0);
    entry.points += Number(line.points || 0);
    byKey.set(key, entry);
  }
  return { ruleRows, soldRows: [...byKey.values()] };
}
