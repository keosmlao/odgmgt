// POD (ຫຼັກຖານການສົ່ງ) — ກົດການອ່ານຜົນ ທີ່ໃຊ້ຮ່ວມກັນລະຫວ່າງໜ້າຈໍ ແລະ ການທົດສອບ.
//
// ⚠️ ກົດດຽວກັນນີ້ຖືກຂຽນເປັນ SQL ຢູ່ `src/queries/pod.js` (podRowFlagsSql) ເພື່ອ
// ນັບສະຫຼຸບຢູ່ຖານຂໍ້ມູນໂດຍບໍ່ຕ້ອງດຶງທຸກແຖວມາ. ຖ້າແກ້ບ່ອນໜຶ່ງ ຕ້ອງແກ້ອີກບ່ອນ.

/** ເງື່ອນໄຂການຈັດສົ່ງທີ່ເລືອກຕອນເພີ່ມບິນເຂົ້າຖ້ຽວ (ດຶງມາຈາກ jobs/add). */
export const POD_CONDITION_LABELS: Record<string, string> = {
  to_customer: "ສົ່ງລູກຄ້າ",
  to_branch: "ສົ່ງສາຂາ",
  to_carrier: "ສົ່ງຂົນສົ່ງ",
  to_bus: "ຝາກລົດເມ",
};

export type PodPart = "photo" | "signature" | "gps";

export const POD_PART_LABELS: Record<PodPart, string> = {
  photo: "ຮູບ",
  signature: "ລາຍເຊັນ",
  gps: "GPS",
};

export interface PodFlags {
  has_photo: boolean;
  has_signature: boolean;
  has_gps: boolean;
}

/** ຄົບ = ບໍ່ຂາດອັນທີ່ບັງຄັບ · ຂາດບາງສ່ວນ = ຂາດແຕ່ບໍ່ໝົດ · ບໍ່ມີ = ຂາດໝົດ. */
export type PodState = "complete" | "partial" | "none";

/**
 * ຫຼັກຖານທີ່ "ບັງຄັບ" ຕໍ່ບິນໜຶ່ງ.
 *
 * ຮູບ ແລະ GPS ບັງຄັບສະເໝີ — ວັດຈາກຂໍ້ມູນຈິງ (07/2026: ປິດ 2,726 ໃບ ມີຮູບ 2,715
 * ແລະ ມີ GPS 2,726) ຄື ແອັບເກັບໃຫ້ຢູ່ແລ້ວ ບິນທີ່ຂາດຈຶ່ງແມ່ນຂໍ້ຍົກເວັ້ນທີ່ຄວນຖາມ.
 *
 * ລາຍເຊັນ *ບໍ່* ບັງຄັບໂດຍຄ່າເລີ່ມຕົ້ນ: ເດືອນ 07/2026 ມີພຽງ 358/2,726 ໃບ ແລະ
 * ເກືອບທັງໝົດມາຈາກຄົນຂັບຄົນດຽວ — ຄືການເກັບລາຍເຊັນຍັງບໍ່ທັນໃຊ້ທົ່ວ. ຖ້າບັງຄັບ
 * ເລີຍ ໜ້າຈໍຈະແດງເກືອບໝົດຈົນໃຊ້ເປັນລາຍການທີ່ຕ້ອງໄລ່ຕາມບໍ່ໄດ້. ເມື່ອນະໂຍບາຍ
 * ປ່ຽນ ໃຫ້ເປີດ requireSignature ຢູ່ໜ້າຈໍ.
 */
export function podRequiredParts(
  condition: string,
  requireSignature = false
): PodPart[] {
  return requireSignature && condition === "to_customer"
    ? ["photo", "signature", "gps"]
    : ["photo", "gps"];
}

export function podMissingParts(
  flags: PodFlags,
  condition: string,
  requireSignature = false
): PodPart[] {
  const have: Record<PodPart, boolean> = {
    photo: flags.has_photo,
    signature: flags.has_signature,
    gps: flags.has_gps,
  };
  return podRequiredParts(condition, requireSignature).filter((part) => !have[part]);
}

export function podState(
  flags: PodFlags,
  condition: string,
  requireSignature = false
): PodState {
  const required = podRequiredParts(condition, requireSignature);
  const missing = podMissingParts(flags, condition, requireSignature);
  if (missing.length === 0) return "complete";
  if (missing.length >= required.length) return "none";
  return "partial";
}

export const POD_STATE_LABELS: Record<PodState, string> = {
  complete: "ຄົບ",
  partial: "ຂາດບາງສ່ວນ",
  none: "ບໍ່ມີຫຼັກຖານ",
};

/** ເປີເຊັນແບບປອດໄພ — ໂຕຫານ 0 ໃຫ້ 0 ບໍ່ແມ່ນ NaN. */
export function podPercent(done: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.round((done / total) * 100);
}

/** ຊື່ເງື່ອນໄຂການສົ່ງ ພ້ອມ fallback ສຳລັບບິນເກົ່າທີ່ຍັງບໍ່ມີຄ່າ. */
export function podConditionLabel(condition: string): string {
  return POD_CONDITION_LABELS[condition] ?? "ສົ່ງລູກຄ້າ";
}

/** "ຫາກໍປິດ" ແບບອ່ານງ່າຍ — ໃຊ້ວິນາທີທີ່ server ຄິດໃຫ້ ບໍ່ແມ່ນໂມງເຄື່ອງຜູ້ໃຊ້. */
export function podAgoLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return "ຫາກໍປິດ";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} ນາທີກ່ອນ`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ຊມ. ${m % 60} ນທ. ກ່ອນ`;
  return `${Math.floor(h / 24)} ມື້ກ່ອນ`;
}

// ── ຮູບຮ່າງຂໍ້ມູນທີ່ actions ສົ່ງກັບມາ ──────────────────────────────────────

export interface PodRow extends PodFlags {
  bill_no: string;
  doc_no: string;
  doc_date: string;
  delivery_date: string;
  started_at: string | null;
  closed_at: string | null;
  cust_code: string;
  cust_name: string;
  driver_code: string;
  driver_name: string;
  car_name: string;
  transport_code: string;
  transport_name: string;
  delivery_condition: string;
  lat_end: string;
  lng_end: string;
  remark: string;
  collected_amount: string | number;
  photo_count: number;
  has_pickup_photo: boolean;
  has_pickup_signature: boolean;
  missing_count: number;
  required_count: number;
}

/** ແຖວຟີດສົດ — ມີເວລາທີ່ຜ່ານມາແລ້ວທີ່ຄິດຢູ່ server. */
export interface PodLiveRow extends PodRow {
  closed_seconds_ago: number;
}

export interface PodTotals {
  bills: number;
  complete: number;
  no_proof: number;
  missing_photo: number;
  missing_signature: number;
  missing_gps: number;
  to_customer_bills: number;
  with_signature: number;
  photos: number;
}

export interface PodDriverRow {
  driver_code: string;
  driver_name: string;
  bills: number;
  incomplete: number;
  missing_photo: number;
  missing_signature: number;
  missing_gps: number;
}

/** ຫຼັກຖານເຕັມ (ມີ base64 ຂອງຮູບ) — ດຶງຕໍ່ບິນເມື່ອເປີດເບິ່ງ. */
export interface PodProof {
  bill_no: string;
  doc_no: string;
  doc_date: string;
  delivery_date: string;
  started_at: string | null;
  checkin_at: string | null;
  closed_at: string | null;
  cust_code: string;
  cust_name: string;
  telephone: string;
  driver_name: string;
  car_name: string;
  transport_name: string;
  delivery_condition: string;
  forward_transport_code: string;
  lat_end: string;
  lng_end: string;
  remark: string;
  collected_amount: string | number;
  url_img: string;
  sight_img: string;
  recipt_img: string;
  recipt_sign_img: string;
  delivery_images: string[];
  selected_qty: string | number;
  delivered_qty: string | number;
  returned_qty: string | number;
}

/** ຮູບທັງໝົດຂອງບິນ ຮຽງແບບທີ່ຄົນເບິ່ງຢາກເຫັນ — ຮູບສົ່ງກ່ອນ ແລ້ວຄ່ອຍລາຍເຊັນ. */
/**
 * The proof images for a bill, de-duplicated on the full data URI.
 *
 * Each entry gets a distinct label, and that label — not the src — is what
 * React should key on. Two JPEGs from the same camera share a long identical
 * prefix (the EXIF header), so keying on a slice of the data URI collided on
 * every image: React warned about duplicate keys on every render, and warned
 * with the base64 blob in the message, which flooded the server log.
 */
export function podProofImages(proof: PodProof): { src: string; label: string }[] {
  const out: { src: string; label: string }[] = [];
  const seen = new Set<string>();
  const push = (src: string | null | undefined, label: string) => {
    if (!src || seen.has(src)) return;
    seen.add(src);
    out.push({ src, label });
  };
  (proof.delivery_images ?? []).forEach((src, i) => push(src, `ຮູບສົ່ງ ${i + 1}`));
  push(proof.url_img, "ຮູບຫຼັກ");
  push(proof.sight_img, "ລາຍເຊັນ");
  push(proof.recipt_img, "ຮູບຮັບເຄື່ອງ");
  push(proof.recipt_sign_img, "ລາຍເຊັນຮັບເຄື່ອງ");
  return out;
}
