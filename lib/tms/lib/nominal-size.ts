// ແກະ "ຂະໜາດທີ່ເອີ້ນ" (nominal size) ແລະ "ຈຳນວນຕໍ່ຫໍ່" ອອກຈາກຊື່ສິນຄ້າ ERP.
//
// ໃຊ້ຮ່ວມກັນລະຫວ່າງທໍ່ (pipe-name.ts) ແລະ ຂໍ້ຕໍ່/ອຸປະກອນ (item-pack.ts) ເພາະ
// ຮ້ານຂຽນຂະໜາດແບບດຽວກັນໝົດ:
//   "ຂະໜາດ 1/2"  "ຂະໜາດ 4 ນີ້ວ"  "ຂະໜາດ 1 1/4"  "ຂະໜາດ 25MM"  "ຂະໜາດ 4""
//   "ຂະໜາດ 21/2" (= 2 1/2, ຂຽນຕິດກັນ)   "ຂະໜາດ 1 x1/2" (ຂໍ້ຕໍ່ລົດ ມີ 2 ຂະໜາດ)

export interface NominalSize {
  /** ກະແຈຄົ້ນຫາ — 'in:1.25' ຫຼື 'mm:25' */
  sizeKey: string;
  /** ປ້າຍໃຫ້ຄົນອ່ານ — '1 1/4"' ຫຼື '25 mm' */
  label: string;
  /** ຂະໜາດເປັນນີ້ວ (ແປງຈາກ mm ໃຫ້ນຳ) — ໃຊ້ຄິດການຄາດຄະເນຂ້າມຂະໜາດ */
  inches: number;
}

/** ຂະໜາດນີ້ວທີ່ຜະລິດຂາຍຈິງ — ກັນການອ່ານເລກມົ້ວມາເປັນຂະໜາດ.
 *  ລວມຂະໜາດທໍ່ທອງແດງ (5/8, 7/8, 1 1/8, 1 3/8) ນຳ ເພື່ອໃຫ້ລາຍງານບອກໄດ້ວ່າ
 *  "ຍັງບໍ່ມີຂະໜາດນີ້ໃນຕາຕະລາງ" ແທນ "ແກະບໍ່ໄດ້". */
export const VALID_INCHES = new Set([
  0.375, 0.5, 0.625, 0.75, 0.875, 1, 1.125, 1.25, 1.375, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12,
]);

/** ຂະໜາດແມັດຕຣິກ (PPR / ທໍ່ຮ້ອຍສາຍໄຟ BS) ທີ່ຂາຍຈິງ. */
export const VALID_MM = new Set([16, 20, 25, 32, 40, 50, 63, 75, 90, 110, 125, 160]);

const MM_PER_INCH = 25.4;

const FRAC_LABELS: Record<string, string> = {
  "0.125": "1/8",
  "0.25": "1/4",
  "0.375": "3/8",
  "0.5": "1/2",
  "0.625": "5/8",
  "0.75": "3/4",
  "0.875": "7/8",
};

export function inchLabel(inches: number): string {
  const whole = Math.floor(inches);
  const frac = inches - whole;
  const fracLabel = FRAC_LABELS[String(Number(frac.toFixed(3)))] ?? "";
  if (!fracLabel) return `${whole}"`;
  return whole > 0 ? `${whole} ${fracLabel}"` : `${fracLabel}"`;
}

/** "1ມັດ= 25 ເສັ້ນ", "1ຫີບ=8 ຕົວ", "1ຖົງ= 100ຕົວ", "1ກ່ອງ=300 ຕົວ" */
const PACK_RE = /1\s*([຀-໿]{1,8}?)\s*=\s*(\d+)\s*([຀-໿]{0,8})/u;

/** ຊັ້ນ (pressure class) / PN / ມາດຕະຖານ — ຕ້ອງຕັດອອກກ່ອນແກະຂະໜາດ
 *  ບໍ່ດັ່ງນັ້ນ "ຊັ້ນ 13.5" ຈະຖືກອ່ານເປັນຂະໜາດ 13.5 ນີ້ວ. */
const CLASS_RES = [
  /ຊັ້ນ\s*[\d.]+/gu,
  /\bPN\s*\d+\b/giu,
  /\b(?:JIS|TIS|BS|DIN|มอก)\b/giu,
];

const MIXED_FRACTION_RE = /(?<![\d/])(\d+)\s+(\d+)\s*\/\s*(\d+)(?![\d/])/u;
const FRACTION_RE = /(?<![\d/])(\d+)\s*\/\s*(\d+)(?![\d/])/u;
const WHOLE_RE = /(?<![\d/.])(\d+(?:\.\d+)?)\s*(?:ນີ້ວ|นิ้ว|")?(?![\d/.])/u;
const METRIC_RE = /(\d+(?:\.\d+)?)\s*(?:MM|mm|ມມ)\b/u;

export function parsePackClause(itemName: string): {
  packQty: number | null;
  packUnit: string | null;
  rest: string;
} {
  const match = PACK_RE.exec(itemName);
  if (!match) return { packQty: null, packUnit: null, rest: itemName };
  const qty = Number(match[2]);
  return {
    packQty: Number.isFinite(qty) && qty > 0 ? qty : null,
    packUnit: match[1] || null,
    // ຕັດປະໂຫຍກຫໍ່ອອກ ບໍ່ດັ່ງນັ້ນເລກ "1" ຂອງ "1ຫີບ" ຈະໄປປົນກັບການແກະຂະໜາດ
    rest: itemName.replace(PACK_RE, " "),
  };
}

/** ຕັດ ຊັ້ນ/PN/JIS/BS ອອກ ເພື່ອບໍ່ໃຫ້ເລກຂອງມັນຖືກອ່ານເປັນຂະໜາດ */
export function stripClassTokens(text: string): string {
  let out = text;
  for (const re of CLASS_RES) out = out.replace(re, " ");
  return out;
}

function fromInches(inches: number): NominalSize | null {
  if (!VALID_INCHES.has(inches)) return null;
  return { sizeKey: `in:${inches}`, label: inchLabel(inches), inches };
}

function fromMm(mm: number): NominalSize | null {
  if (!VALID_MM.has(mm)) return null;
  return { sizeKey: `mm:${mm}`, label: `${mm} mm`, inches: mm / MM_PER_INCH };
}

/**
 * ແກະຂະໜາດອັນດຽວອອກຈາກຂໍ້ຄວາມ. ຄືນ null ເມື່ອບໍ່ແນ່ໃຈ — ຢ່າເດົາ.
 * ຜູ້ເອີ້ນຕ້ອງ stripClassTokens() ກ່ອນ.
 */
export function parseNominalSize(text: string): NominalSize | null {
  const metric = METRIC_RE.exec(text);
  if (metric) return fromMm(Number(metric[1]));

  // ຕັດຫົວຊື່ຮຸ່ນ/ຍີ່ຫໍ້ອອກ: ເອົາສ່ວນຫຼັງຄຳ "ຂະໜາດ" ຖ້າມີ
  const afterKeyword = /ຂະໜາດ\s*(.*)$/u.exec(text);
  const target = afterKeyword ? afterKeyword[1] : text;

  const mixed = MIXED_FRACTION_RE.exec(target);
  if (mixed) {
    return fromInches(Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]));
  }

  const frac = FRACTION_RE.exec(target);
  if (frac) {
    const numerator = Number(frac[1]);
    const denominator = Number(frac[2]);

    // ຮ້ານທໍ່ຂຽນເສດປະສົມຕິດກັນ: "21/2" ໝາຍ 2 1/2, "11/8" ໝາຍ 1 1/8.
    // ຂະໜາດບໍ່ເຄີຍເປັນເສດເກີນ ສະນັ້ນເມື່ອຕົວເສດໃຫຍ່ກວ່າຕົວຫານ ໃຫ້ອ່ານແບບ
    // ປະສົມ: ຕັດຕົວເລກສຸດທ້າຍອອກມາເປັນຕົວເສດ.
    if (numerator > denominator && frac[1].length >= 2) {
      const whole = Number(frac[1].slice(0, -1));
      const lastDigit = Number(frac[1].slice(-1));
      const mixedHit = fromInches(whole + lastDigit / denominator);
      if (mixedHit) return mixedHit;
    }
    return fromInches(numerator / denominator);
  }

  const whole = WHOLE_RE.exec(target);
  if (whole) {
    const value = Number(whole[1]);
    const asInches = fromInches(value);
    if (asInches) return asInches;
    // ທໍ່ຮ້ອຍສາຍໄຟມາດຕະຖານ BS ຂຽນຂະໜາດເປັນ mm ໂດຍບໍ່ຕິດຄຳ "MM"
    // (ເຊັ່ນ "NPI ຊ້າງ 20 BS"). ເລກທີ່ບໍ່ແມ່ນຂະໜາດນີ້ວ ແຕ່ເປັນຂະໜາດ mm
    // ທີ່ຂາຍຈິງ ຈຶ່ງອ່ານເປັນ mm ໄດ້ໂດຍບໍ່ຄຸມເຄືອ.
    return fromMm(value);
  }
  return null;
}

/**
 * ຂໍ້ຕໍ່ລົດ / ຂໍ້ຕໍ່ຫຼຸດ ມີສອງຂະໜາດ: "1 x1/2", "3/4x1/2", "11/4x1/2", "3 x2".
 * ຄືນທັງສອງ ໂດຍ primary = ຂະໜາດໃຫຍ່ (ເປັນຕົວກຳນົດຂະໜາດກ່ອງ).
 */
export function parseSizePair(text: string): {
  primary: NominalSize;
  secondary: NominalSize | null;
} | null {
  // ຫາຕົວ x/X/ຄູນ ທີ່ຂັ້ນກາງ ແລ້ວແກະສອງຂ້າງແຍກກັນ
  const afterKeyword = /ຂະໜາດ\s*(.*)$/u.exec(text);
  const target = (afterKeyword ? afterKeyword[1] : text).trim();
  const split = /^(.+?)\s*[xX×]\s*(.+)$/u.exec(target);

  if (split) {
    const left = parseNominalSize(split[1]);
    const right = parseNominalSize(split[2]);
    if (left && right) {
      const [primary, secondary] = left.inches >= right.inches ? [left, right] : [right, left];
      return { primary, secondary };
    }
    // ຂ້າງໜຶ່ງແກະບໍ່ໄດ້ — ໃຊ້ຂ້າງທີ່ໄດ້ ດີກວ່າຖິ້ມທັງອັນ
    const only = left ?? right;
    if (only) return { primary: only, secondary: null };
    return null;
  }

  const single = parseNominalSize(text);
  return single ? { primary: single, secondary: null } : null;
}
