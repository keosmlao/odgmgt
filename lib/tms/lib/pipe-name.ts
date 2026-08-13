// ແກະຂະໜາດທໍ່ອອກຈາກ "ຊື່ສິນຄ້າ" ຂອງ ERP ແລ້ວຄິດພື້ນທີ່ທີ່ທໍ່ກິນໃນລົດ.
//
// ເປັນຫຍັງຕ້ອງແກະຊື່: ໝວດ 1301/1302 (ທໍ່ + ຂໍ້ຕໍ່) ກວມ 62% ຂອງແຖວຖ້ຽວທັງໝົດ
// ແຕ່ບໍ່ມີລາຍການໃດມີຂະໜາດເກັບໄວ້ໃນ odg_item_size / odg_wms_product_dimension ເລີຍ.
// ໂຊກດີທີ່ຊື່ບອກຂະໜາດ ແລະ ຈຳນວນຕໍ່ມັດໄວ້ຢູ່ແລ້ວ ເຊັ່ນ:
//   "ທໍ່ PVC ຊ້າງ ຂະໜາດ 1/2 ຊັ້ນ 13.5  1ມັດ= 25 ເສັ້ນ"
//   "ທໍ່ນ້ຳຮ້ອນ PPR ຊ້າງ PN20 ຂະໜາດ 25MM  1ມັດ= 25 ເສັ້ນ"
//
// ຫຼັກການ: ຖ້າແກະບໍ່ໄດ້ ຫຼື ບໍ່ແນ່ໃຈ → ຄືນ null ພ້ອມເຫດຜົນ. ຢ່າເດົາ.
// ຕົວເລກທີ່ເດົາຜິດຮ້າຍກວ່າການບອກວ່າ "ບໍ່ຮູ້" ເພາະຄົນຈະເອົາໄປບັນທຸກຕາມ.
//
// ການແກະຂະໜາດ/ຫໍ່ ຢູ່ nominal-size.ts (ໃຊ້ຮ່ວມກັບ item-pack.ts).

import {
  parseNominalSize,
  parsePackClause,
  stripClassTokens,
} from "./nominal-size";

export { parsePackClause, parseNominalSize };

export type PipeParseKind =
  /** ທໍ່ເສັ້ນຍາວມາດຕະຖານ — ຄິດປະລິມານໄດ້ */
  | "pipe"
  /** ຊື່ບອກຄວາມຍາວມາໂດຍກົງ (ເຊັ່ນ "ຍາວ20cm") — ຄິດໄດ້ ແຕ່ໃຊ້ຄວາມຍາວນັ້ນ */
  | "pipe_explicit_length"
  /** ບໍ່ແມ່ນທໍ່ (ກິບຮັດທໍ່, ຂໍ້ຕໍ່ ...) */
  | "not_pipe"
  /** ແມ່ນທໍ່ ແຕ່ຄວາມຍາວບໍ່ແນ່ນອນ (ທໍ່ສັ້ນ) ຫຼື ແກະຂະໜາດບໍ່ໄດ້ */
  | "unknown";

export interface PipeParseResult {
  kind: PipeParseKind;
  /** ກະແຈຫາຂະໜາດໃນ odg_tms_pipe_dim — 'in:0.5' ຫຼື 'mm:25' */
  sizeKey: string | null;
  /** ປ້າຍສະແດງໃຫ້ຄົນອ່ານ — '1/2"' ຫຼື '25 mm' */
  label: string | null;
  /** ຈຳນວນຕໍ່ຫໍ່ ຈາກ "1ມັດ= 25 ເສັ້ນ" → 25 */
  packQty: number | null;
  /** ຫົວໜ່ວຍຫໍ່ — 'ມັດ' / 'ຫີບ' / 'ຖົງ' */
  packUnit: string | null;
  /** ຄວາມຍາວທີ່ຊື່ບອກມາເປັນແມັດ (ຖ້າມີ) */
  explicitLengthM: number | null;
  /** ເຫດຜົນຕອນແກະບໍ່ໄດ້ — ເອົາໄປສະແດງໃນໜ້າ "ຍັງບໍ່ວັດ" */
  reason?: string;
}

const NONE: Omit<PipeParseResult, "kind" | "reason"> = {
  sizeKey: null,
  label: null,
  packQty: null,
  packUnit: null,
  explicitLengthM: null,
};

/** "ຍາວ20cm", "ຍາວ 50 cm", "ຍາວ 3 ແມັດ" */
const EXPLICIT_LEN_RE = /ຍາວ\s*([\d.]+)\s*(cm|ຊມ|mm|ມມ|m\b|ແມັດ|ມ\b)/iu;

/** ແປງຄວາມຍາວທີ່ຊື່ບອກ ເປັນແມັດ */
function toMetres(value: number, unit: string): number | null {
  const u = unit.toLowerCase();
  if (u === "cm" || u === "ຊມ") return value / 100;
  if (u === "mm" || u === "ມມ") return value / 1000;
  if (u === "m" || u === "ແມັດ" || u === "ມ") return value;
  return null;
}

export function parsePipeName(itemName: string | null | undefined): PipeParseResult {
  const raw = String(itemName ?? "").trim();
  if (!raw) return { kind: "not_pipe", ...NONE, reason: "ຊື່ວ່າງ" };

  // ຕ້ອງເລີ່ມດ້ວຍ "ທໍ່" — ກັນ "ກິບຮັດທໍ່ເຫຼັກ", "ຂໍ້ຕໍ່ທໍ່" ທີ່ບໍ່ແມ່ນທໍ່ເສັ້ນ
  if (!raw.startsWith("ທໍ່")) {
    return { kind: "not_pipe", ...NONE, reason: "ຊື່ບໍ່ໄດ້ເລີ່ມດ້ວຍ ທໍ່" };
  }

  const { packQty, packUnit, rest } = parsePackClause(raw);
  let cleaned = stripClassTokens(rest);

  const explicitLen = EXPLICIT_LEN_RE.exec(cleaned);
  const explicitLengthM = explicitLen
    ? toMetres(Number(explicitLen[1]), explicitLen[2])
    : null;
  if (explicitLen) cleaned = cleaned.replace(EXPLICIT_LEN_RE, " ");

  // ຫຼັງຕັດຄວາມຍາວອອກແລ້ວຈຶ່ງເບິ່ງຂະໜາດ
  const size = parseNominalSize(cleaned);

  const base = {
    sizeKey: size?.sizeKey ?? null,
    label: size?.label ?? null,
    packQty,
    packUnit,
    explicitLengthM,
  };

  if (!size) {
    return { kind: "unknown", ...base, reason: "ແກະຂະໜາດຈາກຊື່ບໍ່ໄດ້" };
  }

  if (explicitLengthM !== null) {
    return { kind: "pipe_explicit_length", ...base };
  }

  // "ທໍ່ສັ້ນ" ບໍ່ແມ່ນເສັ້ນມາດຕະຖານ ແລະ ຊື່ບໍ່ບອກຄວາມຍາວ — ບໍ່ເດົາ
  if (cleaned.includes("ສັ້ນ")) {
    return { kind: "unknown", ...base, reason: "ທໍ່ສັ້ນ ແຕ່ຊື່ບໍ່ບອກຄວາມຍາວ" };
  }
  // ທໍ່ອ່ອນ/ມ້ວນ ຂາຍເປັນມ້ວນ ຄວາມຍາວຕໍ່ມ້ວນບໍ່ແນ່ນອນ
  if (cleaned.includes("ອ່ອນ") || cleaned.includes("ມ້ວນ")) {
    return { kind: "unknown", ...base, reason: "ທໍ່ອ່ອນ/ມ້ວນ ຄວາມຍາວບໍ່ແນ່ນອນ" };
  }

  return { kind: "pipe", ...base };
}

/**
 * ພື້ນທີ່ທີ່ທໍ່ 1 ເສັ້ນກິນໃນລົດ (m³).
 *
 * ໃຊ້ "ກ່ອງສີ່ຫຼ່ຽມຫຸ້ມ" (od × od × ຍາວ) ບໍ່ແມ່ນປະລິມາດຮູຊົງກະບອກ (πr²) ເພາະ
 * ຕອນວາງຊ້ອນກັນໃນລົດ ທໍ່ກິນທີ່ເທົ່າກ່ອງຫຸ້ມ ບໍ່ແມ່ນເທົ່າເນື້ອທໍ່. ແລ້ວຄູນ
 * packingFactor (ຄ່າເລີ່ມຕົ້ນ 0.9) ເພາະທໍ່ມົນວາງແຊກກັນໄດ້ແໜ້ນກວ່າກ່ອງແທ້ໆ.
 */
export function pipeM3(
  odMm: number | null | undefined,
  lengthM: number | null | undefined,
  packingFactor: number | null | undefined = 0.9
): number | null {
  const od = Number(odMm);
  const len = Number(lengthM);
  const factor =
    packingFactor === null || packingFactor === undefined ? 0.9 : Number(packingFactor);
  if (!Number.isFinite(od) || od <= 0) return null;
  if (!Number.isFinite(len) || len <= 0) return null;
  if (!Number.isFinite(factor) || factor <= 0 || factor > 1) return null;
  const odM = od / 1000;
  return odM * odM * len * factor;
}
