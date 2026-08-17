/**
 * A split air conditioner, read as the one product it is.
 *
 * The ERP records a set as two lines — an indoor "… [C]" and an outdoor
 * "… [H]" — each carrying half the money, and the scoring query scores the set
 * on the indoor line so the outdoor one comes back with zero points. Every
 * screen that lists lines therefore showed each machine twice: once with its
 * points, once as a bare zero beside the same band, and one sale's takings read
 * as two half-sales.
 *
 * Folding is what makes a row a SET. The outdoor half's money goes to its
 * indoor partner and the half itself is dropped, so quantity stays a count of
 * machines and the amount is what the whole set brought in. Points are
 * untouched: the halves score zero, so nothing can be gained or lost here.
 *
 * Halves are paired inside their own bill and against the nearest indoor item
 * code — a set's two components are catalogued next to each other — which is
 * the same pairing the scoring query uses, so a screen can never disagree with
 * the points it is showing. An outdoor unit sold on its own has no partner to
 * fold into: it is a machine in its own right, scores in its own right, and
 * stays as its own row.
 */

/** Digits of an item code, for measuring how far apart two codes sit. */
const codeNumber = (code) => Number(String(code ?? "").replace(/\D/g, "")) || 0;

const isIndoor = (row) => /\[C\]\s*$/.test(String(row?.item_name ?? ""));

/**
 * Whether this row is an outdoor half whose points were taken by its partner.
 *
 * `point_qty` is the scoring query's own answer to "did something else score
 * this set" — reading the name alone would also catch the lone outdoor unit
 * that legitimately scores itself.
 */
const isFoldableHalf = (row) =>
  Number(row?.point_qty || 0) === 0 && /\[H\]\s*$/.test(String(row?.item_name ?? ""));

/**
 * One row per set: outdoor halves folded into their indoor partners.
 *
 * Mutates the surviving partner's `amount` so every existing consumer keeps
 * working unchanged, and returns the rows worth showing.
 *
 * @param rows scored lines carrying at least doc_no, item_code, item_name,
 *             point_qty and amount.
 */
export function foldAirSets(rows) {
  const byBill = new Map();
  for (const row of rows) {
    const doc = String(row.doc_no ?? "");
    if (!byBill.has(doc)) byBill.set(doc, []);
    byBill.get(doc).push(row);
  }

  const folded = new Set();
  for (const billRows of byBill.values()) {
    const indoors = billRows.filter(isIndoor);
    if (!indoors.length) continue;
    for (const half of billRows) {
      if (!isFoldableHalf(half)) continue;
      let partner = null;
      let nearest = Infinity;
      for (const indoor of indoors) {
        const gap = Math.abs(codeNumber(indoor.item_code) - codeNumber(half.item_code));
        if (gap < nearest) { nearest = gap; partner = indoor; }
      }
      if (!partner) continue;
      partner.amount = Number(partner.amount || 0) + Number(half.amount || 0);
      folded.add(half);
    }
  }

  return folded.size ? rows.filter((row) => !folded.has(row)) : rows;
}
