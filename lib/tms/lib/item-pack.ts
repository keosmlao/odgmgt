// ແກະ "ຕະກຸນ + ຂະໜາດ + ຈຳນວນຕໍ່ຫີບ" ອອກຈາກຊື່ຂໍ້ຕໍ່/ອຸປະກອນ.
//
// ຂໍ້ຕໍ່ (ຂໍ້ງໍ, ສາມຕາ, ຂໍ້ຕໍ່ລົດ ...) ວັດເປັນລາຍການໜຶ່ງໆຍາກ ເພາະຮູບຊົງບໍ່ເປັນ
// ກ່ອງ. ແຕ່ຂາຍເປັນ "ຫີບ" ເຊິ່ງເປັນກ່ອງ ແລະ ຊື່ບອກຈຳນວນຕໍ່ຫີບໄວ້ແລ້ວ:
//
//   ຂໍ້ງໍບາງ ຊ້າງ ຂະໜາດ 2 ນີ້ວ 1ຫີບ= 30 ຕົວ
//   ^--- ຕະກຸນ ---^      ^ຂະໜາດ^  ^ຈຳນວນ^
//
// ສະນັ້ນວັດ 1 ຫີບ ໄດ້ 2 ຄ່າພ້ອມກັນ: m³/ຫີບ ແລະ m³/ຕົວ (ຫານດ້ວຍຈຳນວນ).
// ບິນອາດຂຽນເປັນ ຕົວ ຫຼື ຫີບ ກໍໃຊ້ໄດ້ທັງສອງ.

import {
  parsePackClause,
  parseSizePair,
  stripClassTokens,
  type NominalSize,
} from "./nominal-size";

export interface ItemPackParse {
  /** ຕະກຸນ — ຂໍ້ຄວາມກ່ອນຄຳ "ຂະໜາດ" ຫຼັງລ້າງແລ້ວ ('ຂໍ້ງໍບາງ ຊ້າງ') */
  family: string;
  /** ຂະໜາດຫຼັກ (ຂ້າງໃຫຍ່ ຖ້າເປັນຂໍ້ຕໍ່ລົດ) */
  size: NominalSize | null;
  /** ຂ້າງນ້ອຍຂອງຂໍ້ຕໍ່ລົດ — null ຖ້າມີຂະໜາດດຽວ */
  secondarySize: NominalSize | null;
  /** ຈຳນວນຕໍ່ຫໍ່ ຈາກ "1ຫີບ= 30 ຕົວ" → 30 */
  packQty: number | null;
  /** ຫົວໜ່ວຍຫໍ່ — 'ຫີບ' / 'ຖົງ' / 'ກ່ອງ' / 'ແກັດ' */
  packUnit: string | null;
  /** ຫົວໜ່ວຍຍ່ອຍໃນຫໍ່ ຈາກ "= 30 ຕົວ" → 'ຕົວ' */
  pieceUnit: string | null;
  /** ກະແຈຈັບຄູ່ກັບຕາຕະລາງທີ່ວັດແລ້ວ — 'ຂໍ້ງໍບາງ ຊ້າງ|in:2' */
  matchKey: string | null;
}

/** ຄຳທ້າຍທີ່ບອກຍີ່ຫໍ້/ສີ ແຕ່ຢູ່ຫຼັງຂະໜາດ — ບໍ່ຄວນເປັນສ່ວນຂອງຕະກຸນ */
const TRAILING_NOISE = /\s*(ກາຊ້າງ|ຊ້າງ|OK)\s*$/u;

/** ຕັດ "1ຫີບ= 30 ຕົວ" ໃຫ້ໄດ້ຫົວໜ່ວຍຍ່ອຍນຳ */
const PIECE_UNIT_RE = /=\s*\d+\s*([຀-໿]{1,8})/u;

/**
 * ຕະກຸນ = ຂໍ້ຄວາມກ່ອນ "ຂະໜາດ". ຖ້າບໍ່ມີຄຳ "ຂະໜາດ" ໃຫ້ໃຊ້ຊື່ທັງໝົດ (ຫຼັງ
 * ຕັດປະໂຫຍກຫໍ່ອອກ) — ພວກນີ້ມັກເປັນສິນຄ້າຂະໜາດດຽວ ເຊັ່ນ "ກາວໃສກາຊ້າງ 500g".
 */
export function parseFamily(itemName: string | null | undefined): string {
  const { rest } = parsePackClause(String(itemName ?? ""));
  const head = rest.split("ຂະໜາດ")[0];
  return head.trim().replace(/\s+/gu, " ").replace(TRAILING_NOISE, "").trim();
}

export function makeMatchKey(family: string, sizeKey: string | null): string {
  return sizeKey ? `${family}|${sizeKey}` : `${family}|*`;
}

export function parseItemPack(itemName: string | null | undefined): ItemPackParse {
  const raw = String(itemName ?? "").trim();
  const { packQty, packUnit, rest } = parsePackClause(raw);
  const family = parseFamily(raw);
  const pair = parseSizePair(stripClassTokens(rest));
  const pieceMatch = PIECE_UNIT_RE.exec(raw);

  const size = pair?.primary ?? null;
  return {
    family,
    size,
    secondarySize: pair?.secondary ?? null,
    packQty,
    packUnit,
    pieceUnit: pieceMatch ? pieceMatch[1] : null,
    matchKey: family ? makeMatchKey(family, size?.sizeKey ?? null) : null,
  };
}

/**
 * ຄາດຄະເນປະລິມານຕໍ່ຕົວ ຂອງຂະໜາດທີ່ຍັງບໍ່ໄດ້ວັດ ຈາກຂະໜາດອື່ນໃນຕະກຸນດຽວກັນ.
 *
 * ຂໍ້ຕໍ່ຮູບຊົງຄືກັນທຸກຂະໜາດ (geometrically similar) ສະນັ້ນປະລິມານ ∝ ຂະໜາດ³.
 * ຖ້າມີຈຸດວັດ ≥2 ຈຸດ ຈະຫາເລກກຳລັງຈາກຂໍ້ມູນຈິງ (log-log) ແທນການສົມມຸດ 3
 * ເພາະຄວາມໜາຜະນັງບໍ່ໄດ້ໃຫຍ່ຂຶ້ນຕາມສ່ວນເປັນເສັ້ນຊື່.
 *
 * ຄືນ null ເມື່ອບໍ່ມີຈຸດວັດເລີຍ — ບໍ່ເດົາຈາກສູນ.
 */
export function estimatePieceM3(
  targetInches: number,
  measured: Array<{ inches: number; pieceM3: number }>
): { pieceM3: number; exponent: number; basedOn: number } | null {
  const points = measured.filter((p) => p.inches > 0 && p.pieceM3 > 0);
  if (points.length === 0) return null;

  // ຈຸດວັດຢູ່ຂະໜາດນັ້ນພໍດີ — ບໍ່ຕ້ອງຄາດຄະເນ
  const exact = points.find((p) => Math.abs(p.inches - targetInches) < 1e-9);
  if (exact) return { pieceM3: exact.pieceM3, exponent: 0, basedOn: points.length };

  if (points.length === 1) {
    const [only] = points;
    const ratio = targetInches / only.inches;
    return { pieceM3: only.pieceM3 * ratio ** 3, exponent: 3, basedOn: 1 };
  }

  // ຖອຍເສັ້ນຊື່ໃນ log-log: ln(v) = ln(k) + n·ln(d)
  const n = points.length;
  const xs = points.map((p) => Math.log(p.inches));
  const ys = points.map((p) => Math.log(p.pieceM3));
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  // ທຸກຈຸດຢູ່ຂະໜາດດຽວກັນ — ຖອຍບໍ່ໄດ້ ໃຊ້ກຳລັງ 3 ຕາມທິດສະດີ
  const exponent = den === 0 ? 3 : num / den;
  // ກັນຄ່າຜິດປົກກະຕິຈາກຂໍ້ມູນມົ້ວ — ຂໍ້ຕໍ່ຈິງຢູ່ລະຫວ່າງ 1.5 ຫາ 3.5
  const safeExponent = Math.min(Math.max(exponent, 1.5), 3.5);
  const lnK = meanY - safeExponent * meanX;
  return {
    pieceM3: Math.exp(lnK + safeExponent * Math.log(targetInches)),
    exponent: safeExponent,
    basedOn: n,
  };
}
