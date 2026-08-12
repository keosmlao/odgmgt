// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
import type { Locale } from "./config";

/**
 * ໂຄງ key = lo.json (ແມ່ແບບ / source of truth). th/en ຕ້ອງມີ key ຄືກັນ.
 * `typeof import(...)` ໃຫ້ຮູບຮ່າງ JSON ໂດຍກົງ (moduleResolution: bundler).
 */
export type Dictionary = typeof import("./dictionaries/lo.json");

/**
 * runtime ຂອງ Next ອາດຫໍ່ JSON ໄວ້ໃນ `.default` (ESM) ຫຼື ຄືນ object ກົງໆ —
 * `?? m` ຮັບໄດ້ທັງສອງແບບ ຈຶ່ງບໍ່ພັງບໍ່ວ່າ bundler ຈະ emit ແບບໃດ.
 */
const load = (mod: Promise<unknown>): Promise<Dictionary> =>
  mod.then((m) => ((m as { default?: Dictionary }).default ?? (m as Dictionary)));

const dictionaries: Record<Locale, () => Promise<Dictionary>> = {
  lo: () => load(import("./dictionaries/lo.json")),
  th: () => load(import("./dictionaries/th.json")),
  en: () => load(import("./dictionaries/en.json")),
};

/** ໂຫຼດ dictionary ຕາມພາສາ — ໃຊ້ໃນ Server Component/action ເທົ່ານັ້ນ. */
export const getDictionary = (locale: Locale): Promise<Dictionary> => dictionaries[locale]();
