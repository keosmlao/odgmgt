// ຈັບຄູ່ລາຍການສິນຄ້າກັບ "ຫີບທີ່ວັດແລ້ວ" ແລ້ວຄິດ m³ ຕໍ່ຫົວໜ່ວຍຂາຍ.
//
// ສາມຊັ້ນ ຈາກແນ່ນອນທີ່ສຸດລົງໄປ:
//   measured  — ວັດຫີບຂອງ (ຕະກຸນ, ຂະໜາດ) ນີ້ພໍດີ
//   estimated — ຕະກຸນນີ້ວັດຂະໜາດອື່ນໄວ້ ຈຶ່ງຄາດຄະເນຂ້າມຂະໜາດ (ຕິດປ້າຍໄວ້!)
//   ບໍ່ຮູ້     — ບໍ່ຢູ່ໃນຜົນເລີຍ
//
// ບໍ່ແຕະ DB — ຮັບແຖວທີ່ດຶງມາແລ້ວ ເພື່ອໃຫ້ test ໄດ້ໂດຍບໍ່ຕ້ອງມີ Postgres.

import { estimatePieceM3, parseItemPack } from "./item-pack";

/** ແຖວຈາກ odg_tms_pack_dim — numeric ຂອງ Postgres ມາເປັນ string */
export interface PackDimRow {
  family: string;
  size_key: string | null;
  pack_unit: string | null;
  /** ຈຳນວນຕົວຕໍ່ຫີບ ຕອນວັດ (ຈາກຊື່ ຫຼື ຄົນນັບ) */
  pack_qty: number | string | null;
  width_cm: number | string | null;
  length_cm: number | string | null;
  height_cm: number | string | null;
  weight_kg?: number | string | null;
}

export interface PackDim {
  family: string;
  sizeKey: string | null;
  packUnit: string | null;
  packQty: number | null;
  packM3: number;
  /** m³ ຕໍ່ 1 ຕົວ — packM3 / packQty */
  pieceM3: number | null;
  /** kg ຕໍ່ຫີບ */
  weightKg: number | null;
  /** kg ຕໍ່ 1 ຕົວ — weightKg / packQty */
  pieceKg: number | null;
}

export interface PackItemRow {
  item_code: string;
  item_name?: string | null;
  unit_code?: string | null;
  lines?: number | string;
}

export interface ResolvedPack {
  /** m³ ຕໍ່ 1 ຫົວໜ່ວຍທີ່ບິນໃຊ້ (unit_code) */
  m3: number;
  /** kg ຕໍ່ 1 ຫົວໜ່ວຍດຽວກັນ — null ເມື່ອຫີບບໍ່ໄດ້ບອກນ້ຳໜັກ */
  kg: number | null;
  family: string;
  sizeKey: string | null;
  label: string | null;
  /** ບິນນັບເປັນຫີບ ຫຼື ເປັນຕົວ */
  perPack: boolean;
  packQty: number | null;
  packUnit: string | null;
  source: "pack_measured" | "pack_estimated";
  /** ເລກກຳລັງທີ່ໃຊ້ຄາດຄະເນ — ມີສະເພາະ pack_estimated */
  exponent?: number;
  basedOn?: number;
}

const toNum = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function buildPackDimIndex(rows: PackDimRow[] | null | undefined): {
  byKey: Map<string, PackDim>;
  byFamily: Map<string, PackDim[]>;
} {
  const byKey = new Map<string, PackDim>();
  const byFamily = new Map<string, PackDim[]>();

  for (const row of rows ?? []) {
    const family = String(row?.family ?? "").trim();
    const w = toNum(row?.width_cm);
    const l = toNum(row?.length_cm);
    const h = toNum(row?.height_cm);
    if (!family || !w || !l || !h) continue;

    const packM3 = (w * l * h) / 1_000_000;
    const packQty = toNum(row.pack_qty);
    const dim: PackDim = {
      family,
      sizeKey: row.size_key ? String(row.size_key) : null,
      packUnit: row.pack_unit ? String(row.pack_unit) : null,
      packQty: packQty && packQty > 0 ? packQty : null,
      packM3,
      pieceM3: packQty && packQty > 0 ? packM3 / packQty : null,
      weightKg: toNum(row.weight_kg ?? null),
      pieceKg:
        packQty && packQty > 0 && toNum(row.weight_kg ?? null) !== null
          ? toNum(row.weight_kg ?? null)! / packQty
          : null,
    };

    byKey.set(`${family}|${dim.sizeKey ?? "*"}`, dim);
    const list = byFamily.get(family) ?? [];
    list.push(dim);
    byFamily.set(family, list);
  }
  return { byKey, byFamily };
}

/** ຂະໜາດເປັນນີ້ວ ຈາກ size_key ('in:1.25' → 1.25, 'mm:25' → 0.984) */
function sizeKeyToInches(sizeKey: string | null): number | null {
  if (!sizeKey) return null;
  const [system, value] = sizeKey.split(":");
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return system === "mm" ? n / 25.4 : n;
}

/**
 * ຄິດ m³ ຕໍ່ຫົວໜ່ວຍຂາຍ ໃຫ້ລາຍການທີ່ບໍ່ແມ່ນທໍ່.
 *
 * ຖ້າ unit_code ຂອງບິນຕົງກັບຫົວໜ່ວຍຫໍ່ (ຫີບ/ຖົງ/ກ່ອງ) ຈະຄືນ m³ ຕໍ່ຫີບ
 * ບໍ່ດັ່ງນັ້ນຄືນ m³ ຕໍ່ຕົວ.
 */
export function resolvePackVolumes(
  items: PackItemRow[] | null | undefined,
  index: { byKey: Map<string, PackDim>; byFamily: Map<string, PackDim[]> }
): Map<string, ResolvedPack> {
  const out = new Map<string, ResolvedPack>();

  for (const item of items ?? []) {
    const code = String(item?.item_code ?? "").trim();
    if (!code || out.has(code)) continue;

    const parsed = parseItemPack(item?.item_name);
    if (!parsed.family) continue;

    const unit = String(item?.unit_code ?? "").trim();
    const exact =
      index.byKey.get(`${parsed.family}|${parsed.size?.sizeKey ?? "*"}`) ??
      // ສິນຄ້າຂະໜາດດຽວ: ແຖວທີ່ວັດໄວ້ແບບ "ທຸກຂະໜາດ"
      index.byKey.get(`${parsed.family}|*`);

    if (exact) {
      const perPack = unit !== "" && unit === exact.packUnit;
      // ຈຳນວນຕໍ່ຫີບຂອງລາຍການນີ້ ອາດຕ່າງຈາກແຖວທີ່ວັດ — ໃຊ້ຂອງລາຍການນີ້ ແຕ່
      // m³ ຕໍ່ຕົວ ຍັງເອົາຈາກແຖວທີ່ວັດ (ຕົວດຽວກັນ ຂະໜາດດຽວກັນ)
      const qty = parsed.packQty ?? exact.packQty;
      const pieceM3 = exact.pieceM3;

      if (perPack) {
        out.set(code, {
          m3: pieceM3 !== null && qty ? pieceM3 * qty : exact.packM3,
          // ບິນນັບເປັນຫີບ → ນ້ຳໜັກຕໍ່ຫີບ
          kg: exact.pieceKg !== null && qty ? exact.pieceKg * qty : exact.weightKg,
          family: parsed.family,
          sizeKey: parsed.size?.sizeKey ?? null,
          label: parsed.size?.label ?? null,
          perPack: true,
          packQty: qty,
          packUnit: exact.packUnit,
          source: "pack_measured",
        });
        continue;
      }
      if (pieceM3 !== null) {
        out.set(code, {
          m3: pieceM3,
          kg: exact.pieceKg,
          family: parsed.family,
          sizeKey: parsed.size?.sizeKey ?? null,
          label: parsed.size?.label ?? null,
          perPack: false,
          packQty: qty,
          packUnit: exact.packUnit,
          source: "pack_measured",
        });
      }
      continue;
    }

    // ຊັ້ນຄາດຄະເນ: ຕະກຸນນີ້ວັດຂະໜາດອື່ນໄວ້ບໍ?
    const targetInches = parsed.size ? parsed.size.inches : null;
    const siblings = index.byFamily.get(parsed.family);
    if (!targetInches || !siblings) continue;

    const points = siblings
      .map((s) => ({ inches: sizeKeyToInches(s.sizeKey), pieceM3: s.pieceM3 }))
      .filter(
        (p): p is { inches: number; pieceM3: number } =>
          p.inches !== null && p.pieceM3 !== null
      );

    const estimate = estimatePieceM3(targetInches, points);
    if (!estimate) continue;

    const qty = parsed.packQty;
    const perPack = unit !== "" && siblings.some((s) => s.packUnit === unit);
    out.set(code, {
      m3: perPack && qty ? estimate.pieceM3 * qty : estimate.pieceM3,
      // ຄາດຄະເນປະລິມານໄດ້ ແຕ່ບໍ່ຄາດຄະເນນ້ຳໜັກ — ວັດຖຸຕ່າງກັນໜັກຄົນລະຢ່າງ
      kg: null,
      family: parsed.family,
      sizeKey: parsed.size?.sizeKey ?? null,
      label: parsed.size?.label ?? null,
      perPack,
      packQty: qty,
      packUnit: perPack ? unit : null,
      source: "pack_estimated",
      exponent: estimate.exponent,
      basedOn: estimate.basedOn,
    });
  }
  return out;
}

export interface PackCoverage {
  totalItems: number;
  totalLines: number;
  measuredItems: number;
  measuredLines: number;
  estimatedItems: number;
  estimatedLines: number;
  /** ວຽກທີ່ຄວນວັດຕໍ່ໄປ ຈັດຕາມຈຳນວນແຖວທີ່ຈະໄດ້ຄືນ */
  worklist: Array<{
    itemCode: string;
    itemName: string;
    unitCode: string;
    family: string;
    sizeKey: string | null;
    label: string | null;
    packQty: number | null;
    packUnit: string | null;
    lines: number;
    /** ຈຳນວນແຖວທັງຕະກຸນ — ວັດອັນນີ້ຈະຊ່ວຍຄາດຄະເນອັນອື່ນນຳ */
    familyLines: number;
    status: "estimated" | "unknown";
  }>;
}

/** ລາຍງານຄວາມຄຸມ + ບັນຊີວຽກ "ຄວນວັດອັນໃດກ່ອນ". */
export function computePackCoverage(
  items: PackItemRow[] | null | undefined,
  index: { byKey: Map<string, PackDim>; byFamily: Map<string, PackDim[]> },
  limit = 40
): PackCoverage {
  const resolved = resolvePackVolumes(items, index);
  const rows = items ?? [];

  const familyLines = new Map<string, number>();
  for (const item of rows) {
    const family = parseItemPack(item?.item_name).family;
    if (!family) continue;
    familyLines.set(family, (familyLines.get(family) ?? 0) + (toNum(item?.lines) ?? 0));
  }

  let totalLines = 0;
  let measuredItems = 0;
  let measuredLines = 0;
  let estimatedItems = 0;
  let estimatedLines = 0;
  const worklist: PackCoverage["worklist"] = [];

  for (const item of rows) {
    const lines = toNum(item?.lines) ?? 0;
    totalLines += lines;
    const code = String(item?.item_code ?? "");
    const hit = resolved.get(code);

    if (hit?.source === "pack_measured") {
      measuredItems += 1;
      measuredLines += lines;
      continue;
    }

    const parsed = parseItemPack(item?.item_name);
    if (hit?.source === "pack_estimated") {
      estimatedItems += 1;
      estimatedLines += lines;
    }
    worklist.push({
      itemCode: code,
      itemName: String(item?.item_name ?? ""),
      unitCode: String(item?.unit_code ?? ""),
      family: parsed.family,
      sizeKey: parsed.size?.sizeKey ?? null,
      label: parsed.size?.label ?? null,
      packQty: parsed.packQty,
      packUnit: parsed.packUnit,
      lines,
      familyLines: familyLines.get(parsed.family) ?? lines,
      status: hit ? "estimated" : "unknown",
    });
  }

  // ບໍ່ຮູ້ເລີຍມາກ່ອນ, ແລ້ວຈຶ່ງຈັດຕາມແຖວທັງຕະກຸນ (ວັດ 1 ຫີບ ໄດ້ຫຼາຍລາຍການ)
  worklist.sort((a, b) => {
    if (a.status !== b.status) return a.status === "unknown" ? -1 : 1;
    if (b.familyLines !== a.familyLines) return b.familyLines - a.familyLines;
    return b.lines - a.lines;
  });

  return {
    totalItems: rows.length,
    totalLines,
    measuredItems,
    measuredLines,
    estimatedItems,
    estimatedLines,
    worklist: worklist.slice(0, limit),
  };
}
