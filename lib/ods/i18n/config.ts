/**
 * ຄ່າ i18n ທີ່ **ໃຊ້ຮ່ວມກັນ client + server** — ຫ້າມ import next/headers ຫຼື fs ຢູ່ນີ້
 * ບໍ່ດັ່ງນັ້ນ client component (language-switcher) ຈະ build ບໍ່ຜ່ານ.
 *
 * ວິທີເກັບພາສາ = cookie (ບໍ່ປ່ຽນ URL) ⇒ proxy.ts/RBAC ຕາມ pathname ຍັງເຮັດວຽກຄືເກົ່າ.
 */
export const LOCALES = ["lo", "th", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** ຄ່າຕັ້ງຕົ້ນ = ລາວ (ຜູ້ໃຊ້ສ່ວນໃຫຍ່) — ກົງກັບ <html lang="lo"> ເດີມ */
export const DEFAULT_LOCALE: Locale = "lo";

/** ຊື່ cookie — ອ່ານໃນ layout/action. maxAge 1 ປີ */
export const LOCALE_COOKIE = "ods_locale";

/** ປ້າຍພາສາເປັນພາສາຂອງມັນເອງ (endonym) — ຄົນຫາພາສາຕົນເອງເຫັນງ່າຍ */
export const LOCALE_LABEL: Record<Locale, string> = {
  lo: "ລາວ",
  th: "ไทย",
  en: "EN",
};

export function isLocale(value: string | undefined | null): value is Locale {
  return value != null && (LOCALES as readonly string[]).includes(value);
}
