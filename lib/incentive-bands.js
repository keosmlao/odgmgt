/**
 * How a size / price band sorts, and how the scoring query reads it.
 *
 * The tokens are written by hand in the configuration screen and are not a
 * fixed vocabulary — a kilogram band ("6-11"), a price ceiling ("<=2000"), an
 * inch range ("40-44") and an open top ("&gt;5000") all live in the same column.
 * Sorting them as text puts "12-14" before "6-11", so they are ordered by the
 * first number they carry, with an open lower bound sorting first.
 */

/** `<=X` / `<X` is an open lower bound, so it sorts ahead of a range at X. */
export function bandKey(band) {
  const first = Number(String(band).match(/[\d.]+/)?.[0] ?? Infinity);
  return String(band).trimStart().startsWith("<") ? [0, first] : [first, first];
}

export function sortBands(list) {
  return [...list].sort((left, right) => {
    const [a1, a2] = bandKey(left);
    const [b1, b2] = bandKey(right);
    return a1 - b1 || a2 - b2 || String(left).localeCompare(String(right));
  });
}

/**
 * Whether a band is a ceiling the scoring query lets a lower band fall up to.
 *
 * Only `<=` behaves that way: a line in an empty `<=1000` band is priced by the
 * `<=2000` rule above it, while an empty "6-11" or "&gt;5000" simply scores
 * nothing. The screen has to say which of the two an empty cell is, because
 * they are the difference between an unnoticed payout and an unnoticed zero.
 */
export const isCeiling = (band) => String(band).trimStart().startsWith("<=");
