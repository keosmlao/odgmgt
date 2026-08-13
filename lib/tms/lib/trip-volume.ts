// ລວມທຸກແຫຼ່ງຂະໜາດເປັນຄຳຕອບດຽວ ແລ້ວຄິດພື້ນທີ່ຂອງຖ້ຽວ.
//
// ຊັ້ນຄວາມແນ່ນອນ ຈາກສູງລົງຕ່ຳ:
//   master        — ວັດມາຈິງໃນ odg_item_size / odg_wms_product_dimension
//   pipe_formula  — ທໍ່: OD ມາດຕະຖານ × ຄວາມຍາວທີ່ຕັ້ງໄວ້
//   pack_measured — ວັດຫີບຂອງ (ຕະກຸນ, ຂະໜາດ) ນີ້ພໍດີ
//   pack_estimated— ຕະກຸນນີ້ວັດຂະໜາດອື່ນ ຈຶ່ງຂະຫຍາຍຕາມຂະໜາດ (ຄາດຄະເນ)
//   ບໍ່ຮູ້         — ບໍ່ຢູ່ໃນຜົນເລີຍ
//
// ບໍ່ແຕະ DB — ຮັບແຖວທີ່ດຶງມາແລ້ວ ເພື່ອໃຫ້ test ໄດ້ໂດຍບໍ່ຕ້ອງມີ Postgres.

import {
  buildPipeDimMap,
  resolvePipeVolumes,
  type PipeDimRow,
} from "./pipe-resolve";
import {
  buildPackDimIndex,
  resolvePackVolumes,
  type PackDimRow,
} from "./pack-resolve";
import { parseItemPack } from "./item-pack";
import { findFittingShape, fittingPieceM3 } from "./fitting-shape";

export type VolumeSource =
  | "master"
  | "pipe_formula"
  | "pack_measured"
  | "pack_estimated"
  /** ຄາດຄະເນຈາກຮູບຊົງຂໍ້ຕໍ່ × OD ທໍ່ — ຊັ້ນສຸດທ້າຍກ່ອນ "ບໍ່ຮູ້" */
  | "fitting_derived";

/** ແຖວຈາກ getMasterItemDims() */
export interface MasterDimRow {
  item_code: string;
  unit_code: string | null;
  width_cm: number | string | null;
  length_cm: number | string | null;
  height_cm: number | string | null;
  weight_kg?: number | string | null;
  stackable?: number | string | null;
}

export interface TripItem {
  item_code: string;
  item_name?: string | null;
  unit_code?: string | null;
  /** ຈຳນວນທີ່ຂຶ້ນລົດຕອນອອກ */
  qty: number | string;
  /** ຈຳນວນທີ່ຍັງຢູ່ເທິງລົດດຽວນີ້ — ບໍ່ມີ = ຖືວ່າຍັງຢູ່ໝົດ (ຮ່າງຖ້ຽວ) */
  qty_remaining?: number | string | null;
  bill_no?: string | null;
}

export interface ItemVolume {
  m3: number;
  kg: number | null;
  source: VolumeSource;
  label?: string | null;
  /** 3 = ວັດ/ມາດຕະຖານ, 2 = ຄາດຄະເນ */
  confidence: 3 | 2;
}

export interface CarCapacity {
  capacity_m3?: number | string | null;
  usable_m3?: number | string | null;
  payload_kg?: number | string | null;
  length_cm?: number | string | null;
  capacity_source?: string | null;
}

const toNum = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * ຄິດ m³ ຕໍ່ຫົວໜ່ວຍ ໃຫ້ທຸກລາຍການ ຈາກທຸກແຫຼ່ງ. ແຫຼ່ງທີ່ແນ່ນອນກວ່າຊະນະ.
 */
export function resolveItemVolumes(
  items: TripItem[] | null | undefined,
  sources: {
    masterDims?: MasterDimRow[] | null;
    pipeDims?: PipeDimRow[] | null;
    packDims?: PackDimRow[] | null;
  }
): Map<string, ItemVolume> {
  const out = new Map<string, ItemVolume>();

  // 1. master data — ວັດມາຈິງ
  for (const row of sources.masterDims ?? []) {
    const code = String(row?.item_code ?? "").trim();
    const w = toNum(row?.width_cm);
    const l = toNum(row?.length_cm);
    const h = toNum(row?.height_cm);
    if (!code || !w || !l || !h || out.has(code)) continue;
    out.set(code, {
      m3: (w * l * h) / 1_000_000,
      kg: toNum(row?.weight_kg ?? null),
      source: "master",
      confidence: 3,
    });
  }

  // 2. ທໍ່ຕາມສູດ
  const pipeHits = resolvePipeVolumes(items ?? [], buildPipeDimMap(sources.pipeDims ?? []));
  for (const [code, hit] of pipeHits) {
    if (out.has(code)) continue;
    out.set(code, {
      m3: hit.m3,
      kg: hit.weightKg,
      source: "pipe_formula",
      label: hit.label,
      confidence: 3,
    });
  }

  // 3. ຫີບທີ່ວັດແລ້ວ / ຄາດຄະເນຂ້າມຂະໜາດໃນຕະກຸນ
  const packHits = resolvePackVolumes(items ?? [], buildPackDimIndex(sources.packDims ?? []));
  for (const [code, hit] of packHits) {
    if (out.has(code)) continue;
    out.set(code, {
      m3: hit.m3,
      kg: hit.kg,
      source: hit.source,
      label: hit.label,
      confidence: hit.source === "pack_measured" ? 3 : 2,
    });
  }

  // 4. ຊັ້ນສຸດທ້າຍ: ຄາດຄະເນຈາກຮູບຊົງຂໍ້ຕໍ່ × OD ທໍ່ (ມອກ.1131).
  //    ໃຫ້ຕົວເລກຕັ້ງຕົ້ນແກ່ຕະກຸນທີ່ຍັງບໍ່ໄດ້ວັດຫີບເລີຍ. ພໍວັດຫີບແລ້ວ
  //    ຊັ້ນ 3 ຈະທັບຊັ້ນນີ້ອັດຕະໂນມັດ ເພາະຈັດລຳດັບກ່ອນ.
  const odByKey = new Map<string, number>();
  for (const row of sources.pipeDims ?? []) {
    const od = toNum(row?.od_mm);
    if (row?.size_key && od && od > 0) odByKey.set(String(row.size_key), od);
  }

  for (const item of items ?? []) {
    const code = String(item?.item_code ?? "").trim();
    if (!code || out.has(code)) continue;

    const parsed = parseItemPack(item?.item_name);
    const shape = findFittingShape(parsed.family);
    if (!shape || !parsed.size) continue;

    const od = odByKey.get(parsed.size.sizeKey);
    const pieceM3 = fittingPieceM3(od, shape);
    if (pieceM3 === null) continue;

    // ບິນນັບເປັນຫີບ → ຄູນຈຳນວນຕໍ່ຫີບ; ນັບເປັນຕົວ → ຄ່າຕໍ່ຕົວ
    const unit = String(item?.unit_code ?? "").trim();
    const perPack = unit !== "" && unit === parsed.packUnit;
    out.set(code, {
      m3: perPack && parsed.packQty ? pieceM3 * parsed.packQty : pieceM3,
      kg: null,
      source: "fitting_derived",
      label: `${shape.label} ${parsed.size.label}`,
      confidence: 2,
    });
  }

  return out;
}

export interface TripVolume {
  /** ປະລິມານທີ່ຄິດໄດ້ (ບໍ່ນັບລາຍການທີ່ບໍ່ຮູ້) */
  m3: number;
  /** ສ່ວນທີ່ມາຈາກຄ່າຄາດຄະເນ — ນັບຢູ່ໃນ m3 ແລ້ວ */
  estimatedM3: number;
  /** ຍັງຢູ່ເທິງລົດດຽວນີ້ (ຫັກສ່ວນທີ່ສົ່ງ/ຍົກເລີກແລ້ວ) */
  m3Remaining: number;
  /** % ຂອງລົດ ທີ່ຍັງມີຂອງຢູ່ — null ເມື່ອບໍ່ຮູ້ຄວາມຈຸ ຫຼື ຂໍ້ມູນບໍ່ພໍ */
  remainingPct: number | null;
  /** % ຂອງທີ່ຂຶ້ນລົດ ທີ່ສົ່ງລົງແລ້ວ */
  deliveredPct: number | null;
  kg: number | null;
  lines: number;
  linesKnown: number;
  linesEstimated: number;
  linesUnknown: number;
  /** % ຂອງແຖວທີ່ຄິດໄດ້ (ວັດ + ຄາດຄະເນ) */
  coveragePct: number;

  capacityM3: number | null;
  usableM3: number | null;
  payloadKg: number | null;
  /** % ຂອງພື້ນທີ່ບັນທຸກໄດ້ຈິງ — null ເມື່ອບໍ່ຮູ້ຄວາມຈຸ ຫຼື ຂໍ້ມູນບໍ່ພໍ */
  utilizationPct: number | null;
  /** % ນ້ຳໜັກ — null ເມື່ອບໍ່ຮູ້ */
  weightPct: number | null;
  overloaded: boolean;
  /**
   * ຂໍ້ມູນພໍທີ່ຈະບອກ % ບໍ. ຖ້າແຖວທີ່ບໍ່ຮູ້ເກີນ 25% ຈະເປັນ false ແລະ
   * utilizationPct ເປັນ null — ບອກວ່າ "ຂໍ້ມູນບໍ່ພໍ" ດີກວ່າສະແດງເລກຫຼອກ
   * ເພາະຄົນຈະເຫັນລົດຫວ່າງແລ້ວບັນທຸກເພີ່ມ.
   */
  dataSufficient: boolean;
  /** ຂອບເຂດຕ່ຳ–ສູງ ຂອງ m³ ໂດຍຄິດຄ່າຄາດຄະເນ ±30% */
  m3Low: number;
  m3High: number;
  /** ລາຍການທີ່ຍັງບໍ່ຮູ້ຂະໜາດ ຈັດຕາມ qty */
  unknownItems: Array<{
    itemCode: string;
    itemName: string;
    unitCode: string;
    qty: number;
  }>;
}

/** ຂ້າງໃດຂອງແຖວທີ່ບໍ່ຮູ້ ເກີນເທົ່ານີ້ → ບໍ່ສະແດງ % */
export const UNKNOWN_LINE_LIMIT = 0.25;
/** ຄວາມຄາດເຄື່ອນທີ່ຖືວ່າຄ່າຄາດຄະເນອາດຜິດ */
const ESTIMATE_TOLERANCE = 0.3;

/**
 * ລວມພື້ນທີ່ຂອງທັງຖ້ຽວ ແລະ ປຽບກັບຄວາມຈຸລົດ.
 *
 * ອັດຕາການໃຊ້ = ຄ່າສູງສຸດລະຫວ່າງ ຄິວ ກັບ ນ້ຳໜັກ ເພາະລົດເຕັມກ່ອນອັນໃດກໍໄດ້.
 */
export function computeTripVolume(
  items: TripItem[] | null | undefined,
  volumes: Map<string, ItemVolume>,
  capacity?: CarCapacity | null
): TripVolume {
  let m3 = 0;
  let m3Remaining = 0;
  let estimatedM3 = 0;
  let kg = 0;
  let sawWeight = false;
  let linesKnown = 0;
  let linesEstimated = 0;
  const unknown = new Map<string, { itemName: string; unitCode: string; qty: number }>();

  const rows = items ?? [];
  for (const item of rows) {
    const code = String(item?.item_code ?? "").trim();
    const qty = toNum(item?.qty) ?? 0;
    const hit = code ? volumes.get(code) : undefined;

    if (!hit) {
      const prior = unknown.get(code);
      unknown.set(code, {
        itemName: String(item?.item_name ?? ""),
        unitCode: String(item?.unit_code ?? ""),
        qty: (prior?.qty ?? 0) + qty,
      });
      continue;
    }

    m3 += hit.m3 * qty;
    // ບໍ່ໄດ້ບອກ qty_remaining (ຮ່າງຖ້ຽວ) = ຍັງບໍ່ໄດ້ອອກ ຈຶ່ງຍັງຢູ່ເທິງລົດໝົດ
    const qtyLeft = toNum(item?.qty_remaining);
    m3Remaining += hit.m3 * (qtyLeft === null ? qty : qtyLeft);
    if (hit.confidence === 2) {
      estimatedM3 += hit.m3 * qty;
      linesEstimated += 1;
    } else {
      linesKnown += 1;
    }
    if (hit.kg !== null) {
      kg += hit.kg * qty;
      sawWeight = true;
    }
  }

  const lines = rows.length;
  const linesUnknown = lines - linesKnown - linesEstimated;
  // ຮ່າງທີ່ຍັງບໍ່ໄດ້ໃສ່ບິນ = ຫວ່າງ 100% ບໍ່ແມ່ນ "ຂໍ້ມູນບໍ່ພໍ" — ບໍ່ມີລາຍການ
  // ຈຶ່ງບໍ່ມີຫຍັງທີ່ບໍ່ຮູ້ຂະໜາດ. ນີ້ຄືກໍລະນີທີ່ຄົນຈັດຖ້ຽວຢາກເຫັນທີ່ສຸດ:
  // ລົດຄັນນີ້ຍັງໃສ່ໄດ້ອີກຈັກ m³.
  const coveragePct = lines > 0 ? ((linesKnown + linesEstimated) / lines) * 100 : 100;
  const dataSufficient = lines === 0 || linesUnknown / lines <= UNKNOWN_LINE_LIMIT;

  const capacityM3 = toNum(capacity?.capacity_m3 ?? null);
  const usableM3 = toNum(capacity?.usable_m3 ?? null);
  const payloadKg = toNum(capacity?.payload_kg ?? null);

  const volumePct =
    dataSufficient && usableM3 && usableM3 > 0 ? (m3 / usableM3) * 100 : null;
  const weightPct =
    dataSufficient && sawWeight && payloadKg && payloadKg > 0
      ? (kg / payloadKg) * 100
      : null;

  // ລົດເຕັມກ່ອນອັນໃດກໍໄດ້ — ເອົາອັນທີ່ແໜ້ນສຸດ
  const utilizationPct =
    volumePct === null && weightPct === null
      ? null
      : Math.max(volumePct ?? 0, weightPct ?? 0);

  const remainingPct =
    dataSufficient && usableM3 && usableM3 > 0 ? (m3Remaining / usableM3) * 100 : null;

  return {
    m3,
    estimatedM3,
    m3Remaining,
    remainingPct,
    deliveredPct: m3 > 0 ? ((m3 - m3Remaining) / m3) * 100 : null,
    kg: sawWeight ? kg : null,
    lines,
    linesKnown,
    linesEstimated,
    linesUnknown,
    coveragePct,
    capacityM3,
    usableM3,
    payloadKg,
    utilizationPct,
    weightPct,
    overloaded: utilizationPct !== null && utilizationPct > 100,
    dataSufficient,
    // ຄ່າວັດຖືວ່າແນ່ນອນ, ຄ່າຄາດຄະເນເຜື່ອ ±30%
    m3Low: m3 - estimatedM3 * ESTIMATE_TOLERANCE,
    m3High: m3 + estimatedM3 * ESTIMATE_TOLERANCE,
    unknownItems: [...unknown.entries()]
      .map(([itemCode, info]) => ({ itemCode, ...info }))
      .sort((a, b) => b.qty - a.qty),
  };
}

export interface VolumeSlice {
  key: string;
  label: string;
  m3: number;
  /** % ຂອງພື້ນທີ່ບັນທຸກໄດ້ຈິງຂອງລົດ — null ເມື່ອບໍ່ຮູ້ຄວາມຈຸ */
  pctOfTruck: number | null;
  /** % ຂອງພື້ນທີ່ຖ້ຽວນີ້ — ໃຊ້ໄດ້ເຖິງວ່າຈະບໍ່ຮູ້ຄວາມຈຸລົດ */
  pctOfTrip: number;
  lines: number;
  linesUnknown: number;
}

/** ໝວດສິນຄ້າຕໍ່ລາຍການ ຈາກ getItemCategories() */
export interface ItemCategoryRow {
  item_code: string;
  group_sub?: string | null;
  group_sub_name?: string | null;
  group_main?: string | null;
  group_main_name?: string | null;
}

function sliceTotals(
  groups: Map<string, { label: string; m3: number; lines: number; linesUnknown: number }>,
  tripM3: number,
  usableM3: number | null
): VolumeSlice[] {
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      label: g.label,
      m3: g.m3,
      pctOfTruck: usableM3 && usableM3 > 0 ? (g.m3 / usableM3) * 100 : null,
      pctOfTrip: tripM3 > 0 ? (g.m3 / tripM3) * 100 : 0,
      lines: g.lines,
      linesUnknown: g.linesUnknown,
    }))
    .sort((a, b) => b.m3 - a.m3);
}

/**
 * ແຈກແຈງພື້ນທີ່ຕາມບິນ — ບອກ dispatcher ວ່າບິນໃດກິນທີ່ຫຼາຍສຸດ ຕອນຕ້ອງຕັດຖ້ຽວ.
 * ຜົນລວມຂອງ pctOfTruck ຈະເທົ່າກັບ % ຂອງທັງຖ້ຽວ.
 */
export function sliceByBill(
  items: TripItem[] | null | undefined,
  volumes: Map<string, ItemVolume>,
  trip: TripVolume,
  billNames?: Map<string, string> | null
): VolumeSlice[] {
  const groups = new Map<string, { label: string; m3: number; lines: number; linesUnknown: number }>();
  for (const item of items ?? []) {
    const key = String(item?.bill_no ?? "").trim() || "(ບໍ່ລະບຸບິນ)";
    const g = groups.get(key) ?? {
      label: billNames?.get(key) ? `${key} · ${billNames.get(key)}` : key,
      m3: 0,
      lines: 0,
      linesUnknown: 0,
    };
    const hit = volumes.get(String(item?.item_code ?? "").trim());
    g.lines += 1;
    if (hit) g.m3 += hit.m3 * (toNum(item?.qty) ?? 0);
    else g.linesUnknown += 1;
    groups.set(key, g);
  }
  return sliceTotals(groups, trip.m3, trip.usableM3);
}

/**
 * ແຈກແຈງພື້ນທີ່ຕາມໝວດສິນຄ້າ. ໃຊ້ໝວດຍ່ອຍ (group_sub) ເປັນຄ່າເລີ່ມຕົ້ນ
 * ເພາະໝວດໃຫຍ່ກວ້າງເກີນໄປ (ໝວດ 13 ດຽວກວມ 1,633 ລາຍການ).
 */
export function sliceByCategory(
  items: TripItem[] | null | undefined,
  volumes: Map<string, ItemVolume>,
  trip: TripVolume,
  categories: ItemCategoryRow[] | null | undefined,
  level: "sub" | "main" = "sub"
): VolumeSlice[] {
  const catByItem = new Map<string, { key: string; label: string }>();
  for (const row of categories ?? []) {
    const code = String(row?.item_code ?? "").trim();
    if (!code) continue;
    const key = String((level === "sub" ? row.group_sub : row.group_main) ?? "").trim();
    const name = String(
      (level === "sub" ? row.group_sub_name : row.group_main_name) ?? ""
    ).trim();
    if (!key) continue;
    catByItem.set(code, { key, label: name || key });
  }

  const groups = new Map<string, { label: string; m3: number; lines: number; linesUnknown: number }>();
  for (const item of items ?? []) {
    const code = String(item?.item_code ?? "").trim();
    const cat = catByItem.get(code) ?? { key: "?", label: "(ບໍ່ມີໝວດ)" };
    const g = groups.get(cat.key) ?? { label: cat.label, m3: 0, lines: 0, linesUnknown: 0 };
    const hit = volumes.get(code);
    g.lines += 1;
    if (hit) g.m3 += hit.m3 * (toNum(item?.qty) ?? 0);
    else g.linesUnknown += 1;
    groups.set(cat.key, g);
  }
  return sliceTotals(groups, trip.m3, trip.usableM3);
}

/**
 * ທໍ່ຍາວ 4 ແມັດ ບໍ່ເຂົ້າລົດຕູ້ຍາວ 3 ແມັດ ເຖິງວ່າຄິວຈະພໍ. ປະລິມານບອກເລື່ອງ
 * ນີ້ບໍ່ໄດ້ ຈຶ່ງກວດແຍກ.
 */
export function checkLengthFits(
  longestItemM: number | null,
  capacity?: CarCapacity | null
): { fits: boolean; cargoLengthM: number | null } {
  const cargoCm = toNum(capacity?.length_cm ?? null);
  const cargoLengthM = cargoCm !== null ? cargoCm / 100 : null;
  if (longestItemM === null || cargoLengthM === null) {
    return { fits: true, cargoLengthM };
  }
  return { fits: longestItemM <= cargoLengthM, cargoLengthM };
}
