// ຈັບຄູ່ "ຊື່ສິນຄ້າທໍ່" ກັບ "ຕາຕະລາງຂະໜາດທໍ່" ແລ້ວຄິດ m³ ຕໍ່ຫົວໜ່ວຍ.
//
// ໂມດູນນີ້ບໍ່ແຕະ DB ເລີຍ — ຮັບແຖວທີ່ດຶງມາແລ້ວເປັນ argument ເພື່ອໃຫ້ test ໄດ້
// ໂດຍບໍ່ຕ້ອງມີ Postgres. ຜູ້ເອີ້ນ (actions/pipe-dim.ts) ດຶງຈາກ
// queries/pipe-dim.js ແລ້ວສົ່ງມາໃຫ້.

import { parsePipeName, pipeM3 } from "./pipe-name";

/** ແຖວຈາກ odg_tms_pipe_dim — numeric ຂອງ Postgres ມາເປັນ string */
export interface PipeDimRow {
  size_key: string;
  label: string;
  od_mm: number | string;
  length_m: number | string | null;
  packing_factor: number | string | null;
  /** ນ້ຳໜັກຕໍ່ເສັ້ນ — null = ຍັງບໍ່ມີສະເປັກ (ບໍ່ນັບເຂົ້ານ້ຳໜັກຖ້ຽວ) */
  weight_kg?: number | string | null;
}

export interface PipeDim {
  label: string;
  odMm: number;
  lengthM: number;
  packingFactor: number;
  weightKg: number | null;
}

export interface PipeItemRow {
  item_code: string;
  item_name?: string | null;
  unit_code?: string | null;
  lines?: number | string;
}

export interface ResolvedPipe {
  m3: number;
  sizeKey: string;
  label: string;
  odMm: number;
  lengthM: number;
  /** kg ຕໍ່ເສັ້ນ — null ເມື່ອຍັງບໍ່ມີສະເປັກ */
  weightKg: number | null;
  packQty: number | null;
  packUnit: string | null;
  source: "pipe_formula";
}

export interface PipeCoverage {
  totalItems: number;
  totalLines: number;
  resolvedItems: number;
  resolvedLines: number;
  unresolved: Array<{
    itemCode: string;
    itemName: string;
    unitCode: string;
    lines: number;
    reason: string;
  }>;
}

const toNum = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function buildPipeDimMap(rows: PipeDimRow[] | null | undefined): Map<string, PipeDim> {
  const map = new Map<string, PipeDim>();
  for (const row of rows ?? []) {
    const key = String(row?.size_key ?? "").trim();
    const odMm = toNum(row?.od_mm);
    if (!key || odMm === null || odMm <= 0) continue;
    map.set(key, {
      label: String(row.label ?? key),
      odMm,
      lengthM: toNum(row.length_m) ?? 4,
      packingFactor: toNum(row.packing_factor) ?? 0.9,
      weightKg: toNum(row.weight_kg ?? null),
    });
  }
  return map;
}

/**
 * ຄິດ m³ ຕໍ່ 1 ຫົວໜ່ວຍຂາຍ ໃຫ້ລາຍການທໍ່.
 *
 * ລາຍການທີ່ບໍ່ແມ່ນທໍ່ ຫຼື ແກະບໍ່ໄດ້ ຈະບໍ່ຢູ່ໃນຜົນເລີຍ (ບໍ່ໃສ່ຄ່າເດົາ) ເພື່ອ
 * ໃຫ້ຜູ້ເອີ້ນນັບເປັນ "ຍັງບໍ່ຮູ້" ໄດ້ຖືກຕ້ອງ.
 */
export function resolvePipeVolumes(
  items: PipeItemRow[] | null | undefined,
  dimMap: Map<string, PipeDim>
): Map<string, ResolvedPipe> {
  const out = new Map<string, ResolvedPipe>();
  for (const item of items ?? []) {
    const code = String(item?.item_code ?? "").trim();
    if (!code || out.has(code)) continue;

    const parsed = parsePipeName(item?.item_name);
    if (parsed.kind !== "pipe" && parsed.kind !== "pipe_explicit_length") continue;
    if (!parsed.sizeKey) continue;

    const dim = dimMap.get(parsed.sizeKey);
    if (!dim) continue;

    // ຄວາມຍາວທີ່ຊື່ບອກມາເອງ ຊະນະຄ່າມາດຕະຖານຂອງຕາຕະລາງ
    const lengthM = parsed.explicitLengthM ?? dim.lengthM;
    const m3 = pipeM3(dim.odMm, lengthM, dim.packingFactor);
    if (m3 === null) continue;

    out.set(code, {
      m3,
      sizeKey: parsed.sizeKey,
      label: dim.label,
      odMm: dim.odMm,
      lengthM,
      weightKg: dim.weightKg,
      packQty: parsed.packQty,
      packUnit: parsed.packUnit,
      source: "pipe_formula",
    });
  }
  return out;
}

/**
 * ລາຍງານວ່າສູດທໍ່ຄຸມແຖວຖ້ຽວໄດ້ຫຼາຍປານໃດ ແລະ ອັນໃດຍັງແກະບໍ່ໄດ້ (ພ້ອມເຫດຜົນ).
 * ໃຊ້ໃນໜ້າຕັ້ງຄ່າ ເພື່ອໃຫ້ເຫັນວ່າແກ້ຕາຕະລາງແລ້ວດີຂຶ້ນເທົ່າໃດ.
 */
export function computePipeCoverage(
  items: PipeItemRow[] | null | undefined,
  dimMap: Map<string, PipeDim>,
  limit = 40
): PipeCoverage {
  let resolvedItems = 0;
  let resolvedLines = 0;
  let totalLines = 0;
  const unresolved: PipeCoverage["unresolved"] = [];

  for (const item of items ?? []) {
    const lines = toNum(item?.lines) ?? 0;
    totalLines += lines;

    const parsed = parsePipeName(item?.item_name);
    const dim = parsed.sizeKey ? dimMap.get(parsed.sizeKey) : undefined;
    const usable =
      (parsed.kind === "pipe" || parsed.kind === "pipe_explicit_length") && dim !== undefined;

    if (usable) {
      resolvedItems += 1;
      resolvedLines += lines;
      continue;
    }
    unresolved.push({
      itemCode: String(item?.item_code ?? ""),
      itemName: String(item?.item_name ?? ""),
      unitCode: String(item?.unit_code ?? ""),
      lines,
      reason:
        parsed.reason ??
        (parsed.sizeKey && !dim
          ? `ຍັງບໍ່ມີຂະໜາດ ${parsed.sizeKey} ໃນຕາຕະລາງ`
          : "ແກະບໍ່ໄດ້"),
    });
  }

  unresolved.sort((a, b) => b.lines - a.lines);
  return {
    totalItems: (items ?? []).length,
    totalLines,
    resolvedItems,
    resolvedLines,
    unresolved: unresolved.slice(0, limit),
  };
}
