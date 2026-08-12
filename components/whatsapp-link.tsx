"use client";

import { FaWhatsapp } from "react-icons/fa";

// Normalises raw phone input into the international digits-only format wa.me
// expects (e.g. "020 12345" → "8562012345"). Defaults to Laos (856).
function normalizePhone(raw: string, defaultCc = "856"): string {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length >= 11 || (digits.length >= 10 && digits[0] !== "0")) {
    return digits;
  }
  const local = digits.startsWith("0") ? digits.slice(1) : digits;
  return defaultCc + local;
}

export function WhatsappLink({
  phone,
  message,
  size = 12,
  className = "",
  title = "ສົ່ງ WhatsApp ຫາລູກຄ້າ",
}: {
  phone: string | null | undefined;
  message?: string;
  size?: number;
  className?: string;
  title?: string;
}) {
  const normalized = normalizePhone(phone ?? "");
  if (!normalized) return null;
  const url = message
    ? `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`
    : `https://wa.me/${normalized}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex items-center justify-center rounded-md p-1 text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-400 transition-colors ${className}`}
    >
      <FaWhatsapp size={size} />
    </a>
  );
}

// Builds the standard delivery-notification message that goes into the wa.me
// URL — matches what notifyCustomerWhatsApp used to send before we replaced
// the API with click-to-open links.
export function buildBillWhatsappMessage(opts: {
  billNo: string;
  customerName?: string | null;
  carName?: string | null;
  driverName?: string | null;
  trackingUrl?: string | null;
}) {
  return [
    "🚚 ODG Group ຈັດສົ່ງສິນຄ້າ",
    "",
    `ບິນ: ${opts.billNo}`,
    opts.customerName ? `ລູກຄ້າ: ${opts.customerName}` : null,
    opts.carName ? `ລົດ: ${opts.carName}` : null,
    opts.driverName ? `ຄົນຂັບ: ${opts.driverName}` : null,
    "",
    opts.trackingUrl ? "ຕິດຕາມການສົ່ງສິນຄ້າຂອງທ່ານທີ່:" : null,
    opts.trackingUrl ?? null,
    opts.trackingUrl ? "" : null,
    "ຂອບໃຊ້ທີ່ໃຊ້ບໍລິການ 🙏",
  ]
    .filter((line) => line !== null)
    .join("\n");
}
