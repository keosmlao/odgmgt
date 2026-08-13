/**
 * ກົດການລວມລາຍຊື່ຜູ້ຮັບແຈ້ງເຕືອນ — ບໍ່ແຕະ DB ຈຶ່ງເທສໄດ້ໂດຍກົງ.
 *
 * ຜູ້ຮັບມາຈາກສອງທາງ ແລະ ເມື່ອກ່ອນໃຊ້ພຽງທາງດຽວ:
 *  1. **ຄິດຈາກງານ** — ຜູ້ສ້າງຖ້ຽວ, ພະນັກງານສາຂາຕົ້ນທາງ. ຝັງຢູ່ໃນ code.
 *  2. **ຄົນກົດເປີດເອງ** ຢູ່ໜ້າ "ໃຜຮັບແຈ້ງເຕືອນຫຍັງ".
 *
 * ຮອບກ່ອນນັບແຕ່ (1) ແລ້ວເອົາການຕັ້ງຄ່າມາ**ຕັດອອກ**ຢ່າງດຽວ — ຄົນທີ່ກົດເປີດ
 * ແຕ່ບໍ່ແມ່ນຜູ້ສ້າງຖ້ຽວ ຫຼື ພະນັກງານສາຂານັ້ນ ຈຶ່ງບໍ່ເຄີຍໄດ້ຮັບຈັກເທື່ອ
 * (ຢືນຢັນຈາກ push log: ຜູ້ກົດເປີດ "ແຈ້ງສົ່ງສຳເລັດ" ທຸກຄົນໄດ້ 0 ລາຍການ).
 */

/**
 * @param {object} input
 * @param {Iterable<string>} input.candidates ຜູ້ຮັບທີ່ຄິດຈາກງານ
 * @param {Iterable<string>} input.optIns     ຄົນທີ່ກົດເປີດປະເພດນີ້ເອງ
 * @param {string} [input.excludeCode]        ຄົນທີ່ເປັນຜູ້ກໍ່ເຫດເອງ (ຄົນຂັບ)
 * @returns {string[]} ລາຍຊື່ບໍ່ຊ້ຳ
 */
function mergeRecipients({ candidates = [], optIns = [], excludeCode = "" }) {
  const clean = (v) => String(v ?? "").trim();
  const optInSet = new Set([...optIns].map(clean).filter(Boolean));
  const codes = new Set([...candidates].map(clean).filter(Boolean));
  for (const code of optInSet) codes.add(code);

  // ຜູ້ກໍ່ເຫດເອງບໍ່ຕ້ອງບອກ — ຍົກເວັ້ນລາວ**ກົດເປີດເອງ** (ຄົນຂັບບາງຄົນຢາກໄດ້
  // ໃບຢືນຢັນວ່າລະບົບຮັບການສົ່ງແລ້ວ ແລະ ໃຊ້ທົດສອບການແຈ້ງເຕືອນນຳ).
  const exclude = clean(excludeCode);
  if (exclude && !optInSet.has(exclude)) codes.delete(exclude);

  return Array.from(codes);
}

module.exports = { mergeRecipients };
