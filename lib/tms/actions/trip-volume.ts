"use server";

import { requireSession } from "./_helpers";
import {
  getTripDraftLoad,
  getTripDraftLoadsBulk,
  getTripDraftBillNamesBulk,
  getTripDraftBills,
  listTripDrafts,
} from "@/lib/tms/queries/trip-draft.js";
import {
  getTripLoad,
  getTripLoadsBulk,
  getTripBillNames,
  getTripsInRange,
} from "@/lib/tms/queries/trip-load.js";
import { getCarCapacity } from "@/lib/tms/queries/master-data.js";
import { getRemainingBillProductsMap } from "@/lib/tms/queries/helpers.js";
import { getMasterItemDims } from "@/lib/tms/queries/item-dim.js";
import { listPipeDims } from "@/lib/tms/queries/pipe-dim.js";
import { listPackDims } from "@/lib/tms/queries/pack-dim.js";
// ຕ້ອງມີ .js ຄືກັບບ່ອນອື່ນ (auth.ts, api/health) — ບໍ່ດັ່ງນັ້ນ resolve ບໍ່ຕົງ
import { query } from "@/lib/tms/lib/db.js";
import {
  buildPipeDimMap,
  resolvePipeVolumes,
  type PipeDimRow,
} from "@/lib/tms/lib/pipe-resolve";
import type { PackDimRow } from "@/lib/tms/lib/pack-resolve";
import {
  checkLengthFits,
  computeTripVolume,
  resolveItemVolumes,
  sliceByBill,
  type CarCapacity,
  type MasterDimRow,
  type TripItem,
} from "@/lib/tms/lib/trip-volume";

/**
 * ຄິດພື້ນທີ່ຂອງ "ກອງສິນຄ້າ + ລົດ" ໜຶ່ງຊຸດ — ໃຊ້ຮ່ວມກັນລະຫວ່າງຮ່າງຖ້ຽວ ແລະ
 * ຖ້ຽວທີ່ສົ່ງແລ້ວ ເພື່ອໃຫ້ສອງບ່ອນໃຫ້ຄຳຕອບດຽວກັນສະເໝີ.
 */
async function computeLoad(
  car: string,
  items: TripItem[],
  billNames: Map<string, string>
) {
  const itemCodes = Array.from(
    new Set(items.map((i) => String(i.item_code ?? "").trim()).filter(Boolean))
  );

  const [masterDims, pipeDims, packDims, capacity] = await Promise.all([
    getMasterItemDims(itemCodes) as Promise<MasterDimRow[]>,
    listPipeDims() as Promise<PipeDimRow[]>,
    listPackDims() as Promise<PackDimRow[]>,
    car ? (getCarCapacity(car) as Promise<CarCapacity | null>) : Promise.resolve(null),
  ]);

  const volumes = resolveItemVolumes(items, { masterDims, pipeDims, packDims });
  const trip = computeTripVolume(items, volumes, capacity);

  // ທໍ່ຍາວກວ່າຕູ້ບໍ? ປະລິມານບອກເລື່ອງນີ້ບໍ່ໄດ້ ຈຶ່ງກວດແຍກ.
  const pipeHits = resolvePipeVolumes(items, buildPipeDimMap(pipeDims));
  let longestM: number | null = null;
  for (const item of items) {
    const hit = pipeHits.get(String(item.item_code ?? ""));
    if (hit && (longestM === null || hit.lengthM > longestM)) longestM = hit.lengthM;
  }
  const length = checkLengthFits(longestM, capacity);

  // ພື້ນທີ່ວ່າງ — ຕົວເລກທີ່ dispatcher ຕ້ອງການແທ້ຕອນຕັດສິນວ່າຈະໃສ່ຕື່ມບໍ
  const freeM3 =
    trip.usableM3 !== null && trip.dataSufficient
      ? Math.max(trip.usableM3 - trip.m3, 0)
      : null;

  return {
    car,
    capacitySource: capacity?.capacity_source ?? "none",
    ...trip,
    freeM3,
    byBill: sliceByBill(items, volumes, trip, billNames),
    longestItemM: longestM,
    cargoLengthM: length.cargoLengthM,
    lengthFits: length.fits,
  };
}

/** ພື້ນທີ່ບັນທຸກຂອງ "ຮ່າງຖ້ຽວ" ທຽບກັບຄວາມຈຸລົດ. */
export async function getTripDraftVolume(draftId: number) {
  await requireSession();
  const [load, billRows] = await Promise.all([
    getTripDraftLoad(draftId) as Promise<{ car: string; items: TripItem[] }>,
    getTripDraftBills(draftId) as Promise<Array<{ doc_no: string; cust_name?: string }>>,
  ]);
  const names = new Map(
    (billRows ?? []).map((b) => [String(b.doc_no), String(b.cust_name ?? "")])
  );
  return computeLoad(load.car, load.items ?? [], names);
}

/** ພື້ນທີ່ບັນທຸກຂອງ "ຖ້ຽວທີ່ສົ່ງອອກແລ້ວ". */
export async function getTripVolume(docNo: string) {
  await requireSession();
  return buildTripVolume(docNo);
}

/**
 * ແກ່ນຂອງການຄິດພື້ນທີ່ບັນທຸກ ໂດຍບໍ່ກວດ session — ແຍກອອກມາເພື່ອໃຫ້ route
 * handler (/api/reports/trip-volume ທີ່ ODGMGT ເອີ້ນ) ໃຊ້ໄດ້ ເພາະ route ນັ້ນ
 * ກວດສິດດ້ວຍ REPORT_API_SECRET ແທນ cookie. ສູດຢູ່ບ່ອນດຽວ ທັງສອງທາງຈຶ່ງ
 * ໄດ້ຕົວເລກດຽວກັນສະເໝີ.
 */
export async function buildTripVolume(docNo: string) {
  const [load, billRows] = await Promise.all([
    getTripLoad(docNo) as Promise<{ car: string; items: TripItem[] }>,
    getTripBillNames(docNo) as Promise<Array<{ bill_no: string; cust_name?: string }>>,
  ]);
  const names = new Map(
    (billRows ?? []).map((b) => [String(b.bill_no), String(b.cust_name ?? "")])
  );
  return computeLoad(load.car, load.items ?? [], names);
}

/**
 * ລາຍການຮ່າງຖ້ຽວ ພ້ອມພື້ນທີ່ບັນທຸກມາໃນຄຳຕອບດຽວ.
 *
 * ເປັນຫຍັງລວມ: ຖ້າແຍກເປັນ 2 action ໜ້າຈະ render ຮອບໜຶ່ງດ້ວຍ "…" ກ່ອນ
 * ແລ້ວຄ່ອຍເຕັມ — ຄົນຈັດຖ້ຽວເຫັນເປັນຄວາມຊັກຊ້າ. ດຶງພ້ອມກັນຈຶ່ງບໍ່ມີ
 * ສະຖານະກຳລັງໂຫຼດ.
 */
export async function listTripDraftsWithVolume(dateFrom?: string, dateTo?: string) {
  const session = await requireSession();
  const drafts = (await listTripDrafts(session, dateFrom, dateTo)) as Array<
    Record<string, unknown>
  >;
  if (drafts.length === 0) return { drafts, volumes: {} };

  const ids = drafts.map((d) => Number(d.draft_id));
  const [{ cars, itemsByDraft }, namesByDraft] = (await Promise.all([
    getTripDraftLoadsBulk(ids),
    getTripDraftBillNamesBulk(ids),
  ])) as [
    { cars: Map<number, string>; itemsByDraft: Map<number, TripItem[]> },
    Map<number, Map<string, string>>,
  ];

  // ຂະໜາດສິນຄ້າ ແລະ ຄວາມຈຸລົດ ດຶງເທື່ອດຽວໃຫ້ທຸກຮ່າງ ແລ້ວຄິດຢູ່ໜ່ວຍຄວາມຈຳ
  const allItems = [...itemsByDraft.values()].flat();
  const itemCodes = Array.from(
    new Set(allItems.map((i) => String(i.item_code ?? "").trim()).filter(Boolean))
  );
  const [masterDims, pipeDims, packDims, carRows] = await Promise.all([
    getMasterItemDims(itemCodes) as Promise<MasterDimRow[]>,
    listPipeDims() as Promise<PipeDimRow[]>,
    listPackDims() as Promise<PackDimRow[]>,
    query(
      `SELECT code, payload_kg, cargo_length_cm AS length_cm,
              ROUND((cargo_width_cm / 100) * (cargo_length_cm / 100) * (cargo_height_cm / 100)
                    * COALESCE(stowage_pct, 80) / 100, 3) AS usable_m3,
              CASE WHEN capacity_verified THEN 'measured' ELSE 'estimated' END AS capacity_source
         FROM public.odg_tms_car
        WHERE cargo_width_cm > 0 AND cargo_length_cm > 0 AND cargo_height_cm > 0`
    ) as Promise<Array<Record<string, unknown>>>,
  ]);

  const capByCar = new Map(carRows.map((c) => [String(c.code), c as CarCapacity]));
  const volumes = resolveItemVolumes(allItems, { masterDims, pipeDims, packDims });
  const pipeMap = buildPipeDimMap(pipeDims);

  // ⚠️ ຮູບຮ່າງຕ້ອງຄືກັບ computeLoad() ທຸກຊ່ອງ — TripLoadStrip ອ່ານ
  // unknownItems, byBill, capacitySource ນຳ. ຖ້າຂາດຊ່ອງໃດ ໜ້າຈະລົ້ມ
  // (ເຄີຍລົ້ມມາແລ້ວທີ່ v.unknownItems.length).
  const out: Record<number, ReturnType<typeof buildDraftVolume>> = {};
  function buildDraftVolume(draftId: number) {
    const items = itemsByDraft.get(draftId) ?? [];
    const car = cars.get(draftId) ?? "";
    const capacity = capByCar.get(car) ?? null;
    const trip = computeTripVolume(items, volumes, capacity);

    const pipeHits = resolvePipeVolumes(items, pipeMap);
    let longestM: number | null = null;
    for (const item of items) {
      const hit = pipeHits.get(String(item.item_code ?? ""));
      if (hit && (longestM === null || hit.lengthM > longestM)) longestM = hit.lengthM;
    }
    const length = checkLengthFits(longestM, capacity);

    return {
      car,
      capacitySource: String(capacity?.capacity_source ?? "none"),
      ...trip,
      freeM3:
        trip.usableM3 !== null && trip.dataSufficient
          ? Math.max(trip.usableM3 - trip.m3, 0)
          : null,
      byBill: sliceByBill(items, volumes, trip, namesByDraft.get(draftId) ?? new Map()),
      longestItemM: longestM,
      cargoLengthM: length.cargoLengthM,
      lengthFits: length.fits,
    };
  }

  for (const id of ids) out[id] = buildDraftVolume(id);
  return { drafts, volumes: out };
}

export interface TripVolumeSummary {
  m3: number;
  m3Remaining: number;
  remainingPct: number | null;
  deliveredPct: number | null;
  usableM3: number | null;
  utilizationPct: number | null;
  freeM3: number | null;
  coveragePct: number;
  linesUnknown: number;
  dataSufficient: boolean;
  car: string;
}

/**
 * % ພື້ນທີ່ ຂອງຫຼາຍຖ້ຽວພ້ອມກັນ — ໃຫ້ຕາຕະລາງລາຍການຖ້ຽວສະແດງໄດ້ທຸກແຖວ
 * ດ້ວຍການເອີ້ນເທື່ອດຽວ. ຄືນເປັນ object ຕາມ doc_no.
 */
export async function getTripVolumesBulk(docNos: string[]) {
  await requireSession();
  return buildTripVolumesBulk(docNos);
}

/**
 * ແກ່ນຂອງການຄິດພື້ນທີ່ບັນທຸກ ໂດຍບໍ່ກວດ session — ແຍກອອກມາເພື່ອໃຫ້ route
 * handler (/api/reports/trip-volume ທີ່ ODGMGT ເອີ້ນ) ໃຊ້ໄດ້ ເພາະ route ນັ້ນ
 * ກວດສິດດ້ວຍ REPORT_API_SECRET ແທນ cookie. ສູດຢູ່ບ່ອນດຽວ ທັງສອງທາງຈຶ່ງ
 * ໄດ້ຕົວເລກດຽວກັນສະເໝີ.
 */
export async function buildTripVolumesBulk(docNos: string[]) {
  const docs = Array.from(new Set((docNos ?? []).map((d) => String(d ?? "").trim()).filter(Boolean)));
  if (docs.length === 0) return {} as Record<string, TripVolumeSummary>;

  const { cars, items } = (await getTripLoadsBulk(docs)) as {
    cars: Array<{ doc_no: string; car: string }>;
    items: Array<TripItem & { doc_no: string }>;
  };

  const itemCodes = Array.from(
    new Set(items.map((i) => String(i.item_code ?? "").trim()).filter(Boolean))
  );
  const [masterDims, pipeDims, packDims, carRows] = await Promise.all([
    getMasterItemDims(itemCodes) as Promise<MasterDimRow[]>,
    listPipeDims() as Promise<PipeDimRow[]>,
    listPackDims() as Promise<PackDimRow[]>,
    query(
      `SELECT code, payload_kg,
              ROUND((cargo_width_cm / 100) * (cargo_length_cm / 100) * (cargo_height_cm / 100)
                    * COALESCE(stowage_pct, 80) / 100, 3) AS usable_m3
         FROM public.odg_tms_car
        WHERE cargo_width_cm > 0 AND cargo_length_cm > 0 AND cargo_height_cm > 0`
    ) as Promise<Array<Record<string, unknown>>>,
  ]);

  const capByCar = new Map(carRows.map((c) => [String(c.code), c as CarCapacity]));
  const carByDoc = new Map(cars.map((c) => [String(c.doc_no), String(c.car ?? "")]));
  const volumes = resolveItemVolumes(items, { masterDims, pipeDims, packDims });

  const itemsByTrip = new Map<string, TripItem[]>();
  for (const item of items) {
    const list = itemsByTrip.get(item.doc_no) ?? [];
    list.push(item);
    itemsByTrip.set(item.doc_no, list);
  }

  const out: Record<string, TripVolumeSummary> = {};
  for (const doc of docs) {
    const car = carByDoc.get(doc) ?? "";
    const trip = computeTripVolume(itemsByTrip.get(doc) ?? [], volumes, capByCar.get(car) ?? null);
    out[doc] = {
      car,
      m3: trip.m3,
      m3Remaining: trip.m3Remaining,
      remainingPct: trip.remainingPct,
      deliveredPct: trip.deliveredPct,
      usableM3: trip.usableM3,
      utilizationPct: trip.utilizationPct,
      freeM3:
        trip.usableM3 !== null && trip.dataSufficient
          ? Math.max(trip.usableM3 - trip.m3, 0)
          : null,
      coveragePct: trip.coveragePct,
      linesUnknown: trip.linesUnknown,
      dataSufficient: trip.dataSufficient,
    };
  }
  return out;
}

export interface BillVolume {
  m3: number;
  lines: number;
  linesUnknown: number;
  coveragePct: number;
}

/**
 * ບໍລິມາດຂອງ "ບິນທີ່ຍັງລໍຈັດຖ້ຽວ" — ໃຫ້ບັດບິນຢູ່ໜ້າຮ່າງຖ້ຽວບອກໄດ້ວ່າ
 * ໃບນີ້ກິນທີ່ເທົ່າໃດ ກ່ອນຈະລາກເຂົ້າຖ້ຽວ.
 *
 * ໃຊ້ "ຈຳນວນທີ່ຍັງເຫຼືອ" (getRemainingBillProductsMap) ອັນດຽວກັບທີ່ createJob
 * ໃຊ້ຕອນສົ່ງອອກ ບໍ່ດັ່ງນັ້ນຕົວເລກທີ່ເຫັນຈະບໍ່ຕົງກັບຂອງທີ່ຂຶ້ນລົດຈິງ.
 */
export async function getPendingBillVolumes(billNos: string[]) {
  await requireSession();
  const bills = Array.from(
    new Set((billNos ?? []).map((b) => String(b ?? "").trim()).filter(Boolean))
  );
  if (bills.length === 0) return {} as Record<string, BillVolume>;

  const remaining = (await getRemainingBillProductsMap(bills)) as Map<
    string,
    Array<{ item_code: string; item_name?: string; unit_code?: string; qty: number }>
  >;

  const allItems: TripItem[] = [];
  for (const [billNo, lines] of remaining) {
    for (const line of lines ?? []) {
      allItems.push({
        bill_no: billNo,
        item_code: String(line.item_code ?? ""),
        item_name: line.item_name ?? null,
        unit_code: line.unit_code ?? null,
        qty: Number(line.qty ?? 0),
      });
    }
  }

  const itemCodes = Array.from(
    new Set(allItems.map((i) => String(i.item_code ?? "").trim()).filter(Boolean))
  );
  const [masterDims, pipeDims, packDims] = await Promise.all([
    getMasterItemDims(itemCodes) as Promise<MasterDimRow[]>,
    listPipeDims() as Promise<PipeDimRow[]>,
    listPackDims() as Promise<PackDimRow[]>,
  ]);
  const volumes = resolveItemVolumes(allItems, { masterDims, pipeDims, packDims });

  const out: Record<string, BillVolume> = {};
  for (const billNo of bills) {
    const lines = (remaining.get(billNo) ?? []) as Array<{ item_code: string; qty: number }>;
    let m3 = 0;
    let unknown = 0;
    for (const line of lines) {
      const hit = volumes.get(String(line.item_code ?? "").trim());
      if (hit) m3 += hit.m3 * Number(line.qty ?? 0);
      else unknown += 1;
    }
    out[billNo] = {
      m3,
      lines: lines.length,
      linesUnknown: unknown,
      coveragePct: lines.length > 0 ? ((lines.length - unknown) / lines.length) * 100 : 0,
    };
  }
  return out;
}

export interface BillItemVolume {
  itemCode: string;
  itemName: string;
  unitCode: string;
  qty: number;
  /** m³ ຕໍ່ 1 ຫົວໜ່ວຍ — null = ຍັງບໍ່ຮູ້ຂະໜາດ */
  unitM3: number | null;
  totalM3: number | null;
  source: string | null;
  label: string | null;
}

/**
 * ລາຍລະອຽດສິນຄ້າຂອງບິນໜຶ່ງ ພ້ອມ m³ ຕໍ່ແຖວ — ໃຫ້ modal ເບິ່ງລາຍລະອຽດ
 * ບອກໄດ້ວ່າພື້ນທີ່ຂອງບິນມາຈາກລາຍການໃດ ແລະ ອັນໃດຍັງບໍ່ຮູ້ຂະໜາດ.
 */
export async function getBillItemVolumes(billNo: string) {
  await requireSession();
  const bill = String(billNo ?? "").trim();
  if (!bill) return { items: [] as BillItemVolume[], totalM3: 0, linesUnknown: 0 };

  const remaining = (await getRemainingBillProductsMap([bill])) as Map<
    string,
    Array<{ item_code: string; item_name?: string; unit_code?: string; qty: number }>
  >;
  const lines = remaining.get(bill) ?? [];

  const tripItems: TripItem[] = lines.map((l) => ({
    bill_no: bill,
    item_code: String(l.item_code ?? ""),
    item_name: l.item_name ?? null,
    unit_code: l.unit_code ?? null,
    qty: Number(l.qty ?? 0),
  }));

  const itemCodes = Array.from(
    new Set(tripItems.map((i) => String(i.item_code ?? "").trim()).filter(Boolean))
  );
  const [masterDims, pipeDims, packDims] = await Promise.all([
    getMasterItemDims(itemCodes) as Promise<MasterDimRow[]>,
    listPipeDims() as Promise<PipeDimRow[]>,
    listPackDims() as Promise<PackDimRow[]>,
  ]);
  const volumes = resolveItemVolumes(tripItems, { masterDims, pipeDims, packDims });

  let totalM3 = 0;
  let linesUnknown = 0;
  const items: BillItemVolume[] = tripItems.map((i) => {
    const hit = volumes.get(String(i.item_code));
    const qty = Number(i.qty ?? 0);
    if (!hit) linesUnknown += 1;
    else totalM3 += hit.m3 * qty;
    return {
      itemCode: String(i.item_code),
      itemName: String(i.item_name ?? ""),
      unitCode: String(i.unit_code ?? ""),
      qty,
      unitM3: hit?.m3 ?? null,
      totalM3: hit ? hit.m3 * qty : null,
      source: hit?.source ?? null,
      label: hit?.label ?? null,
    };
  });

  // ໃຫຍ່ສຸດຂຶ້ນກ່ອນ ເພື່ອຮູ້ໄວວ່າອັນໃດກິນທີ່
  items.sort((a, b) => (b.totalM3 ?? -1) - (a.totalM3 ?? -1));
  return { items, totalM3, linesUnknown };
}

export interface UtilizationRow {
  docNo: string;
  docDate: string;
  car: string;
  bills: number;
  m3: number;
  usableM3: number | null;
  utilizationPct: number | null;
  freeM3: number | null;
  coveragePct: number;
  linesUnknown: number;
  dataSufficient: boolean;
  /** ເກີນ 100% ມັກແປວ່າຂໍ້ມູນຖ້ຽວຜິດ ບໍ່ແມ່ນບັນທຸກເກີນຈິງ */
  suspect: boolean;
}

/**
 * ລາຍງານອັດຕາໃຊ້ລົດຍ້ອນຫຼັງ.
 *
 * ດຶງທຸກຢ່າງເປັນກ້ອນດຽວ (ຖ້ຽວ + ສິນຄ້າ + ຂະໜາດ) ແລ້ວຄິດໃນ memory —
 * ບໍ່ຍິງ query ຕໍ່ຖ້ຽວ ເພາະຊ່ວງ 6 ເດືອນມີເກືອບ 3,000 ຖ້ຽວ.
 */
export async function getUtilizationReport(dateFrom: string, dateTo: string) {
  await requireSession();
  return buildUtilizationReport(dateFrom, dateTo);
}

/**
 * ແກ່ນຂອງລາຍງານ ໂດຍບໍ່ກວດ session — ແຍກອອກມາເພື່ອໃຫ້ route handler
 * (/api/reports/truck-utilization ທີ່ ODGMGT ເອີ້ນ) ໃຊ້ໄດ້ ເພາະ route ນັ້ນ
 * ກວດສິດດ້ວຍ REPORT_API_SECRET ແທນ cookie ຂອງຜູ້ໃຊ້. ສູດຄິດໄລ່ຢູ່ບ່ອນດຽວ
 * ທັງສອງທາງຈຶ່ງໄດ້ຕົວເລກດຽວກັນສະເໝີ.
 */
export async function buildUtilizationReport(dateFrom: string, dateTo: string) {

  const { trips, items } = (await getTripsInRange({ dateFrom, dateTo })) as {
    trips: Array<Record<string, unknown>>;
    items: Array<TripItem & { doc_no: string }>;
  };
  if (trips.length === 0) {
    return { dateFrom, dateTo, trips: [] as UtilizationRow[], summary: null };
  }

  const itemCodes = Array.from(
    new Set(items.map((i) => String(i.item_code ?? "").trim()).filter(Boolean))
  );
  const [masterDims, pipeDims, packDims, carRows] = await Promise.all([
    getMasterItemDims(itemCodes) as Promise<MasterDimRow[]>,
    listPipeDims() as Promise<PipeDimRow[]>,
    listPackDims() as Promise<PackDimRow[]>,
    query(
      `SELECT code, payload_kg,
              ROUND((cargo_width_cm / 100) * (cargo_length_cm / 100) * (cargo_height_cm / 100)
                    * COALESCE(stowage_pct, 80) / 100, 3) AS usable_m3
         FROM public.odg_tms_car
        WHERE cargo_width_cm > 0 AND cargo_length_cm > 0 AND cargo_height_cm > 0`
    ) as Promise<Array<Record<string, unknown>>>,
  ]);

  const capByCar = new Map(carRows.map((c) => [String(c.code), c as CarCapacity]));
  const volumes = resolveItemVolumes(items, { masterDims, pipeDims, packDims });

  const itemsByTrip = new Map<string, TripItem[]>();
  for (const item of items) {
    const list = itemsByTrip.get(item.doc_no) ?? [];
    list.push(item);
    itemsByTrip.set(item.doc_no, list);
  }

  const rows: UtilizationRow[] = trips.map((t) => {
    const docNo = String(t.doc_no);
    const car = String(t.car ?? "");
    const trip = computeTripVolume(itemsByTrip.get(docNo) ?? [], volumes, capByCar.get(car) ?? null);
    return {
      docNo,
      docDate: String(t.doc_date ?? ""),
      car,
      bills: Number(t.bills ?? 0),
      m3: trip.m3,
      usableM3: trip.usableM3,
      utilizationPct: trip.utilizationPct,
      freeM3:
        trip.usableM3 !== null && trip.dataSufficient
          ? Math.max(trip.usableM3 - trip.m3, 0)
          : null,
      coveragePct: trip.coveragePct,
      linesUnknown: trip.linesUnknown,
      dataSufficient: trip.dataSufficient,
      suspect: trip.utilizationPct !== null && trip.utilizationPct > 100,
    };
  });

  const scored = rows.filter((r) => r.utilizationPct !== null && !r.suspect);
  const sorted = [...scored].sort((a, b) => a.utilizationPct! - b.utilizationPct!);
  const BANDS: Array<[number, number, string]> = [
    [0, 10, "0–10%"],
    [10, 25, "10–25%"],
    [25, 50, "25–50%"],
    [50, 75, "50–75%"],
    [75, 90, "75–90%"],
    [90, 100, "90–100%"],
  ];

  return {
    dateFrom,
    dateTo,
    trips: rows,
    summary: {
      total: rows.length,
      scored: scored.length,
      suspect: rows.filter((r) => r.suspect).length,
      noData: rows.filter((r) => !r.dataSufficient).length,
      noCapacity: rows.filter((r) => r.dataSufficient && r.usableM3 === null).length,
      medianPct: sorted.length ? sorted[Math.floor(sorted.length / 2)].utilizationPct : null,
      avgPct: scored.length
        ? scored.reduce((a, b) => a + b.utilizationPct!, 0) / scored.length
        : null,
      // ພື້ນທີ່ວ່າງລວມ — "ຖ້າຈັດຖ້ຽວດີຂຶ້ນ ຈະປະຢັດໄດ້ຫຼາຍປານໃດ"
      totalFreeM3: scored.reduce((a, b) => a + (b.freeM3 ?? 0), 0),
      bands: BANDS.map(([lo, hi, label]) => ({
        label,
        trips: scored.filter((r) => r.utilizationPct! >= lo && r.utilizationPct! < hi).length,
      })),
    },
  };
}
