/**
 * ຄຳແປ + ກົດການກັ່ນຕອງຂອງແຈ້ງເຕືອນ "ການເຄື່ອນໄຫວໃນເວັບ" — ບໍ່ແຕະ DB.
 */
const NEVER_NOTIFY = new Set([
  "push.sent",
  "auth.login",
  "auth.logout",
  "auth.login_failed",
]);

// ຄຳອະທິບາຍພາສາລາວຕໍ່ action. ບໍ່ມີອັນນີ້ ຜູ້ຈັດການຈະໄດ້ຮັບຂໍ້ຄວາມແບບ
// "bill_todo.set_done" ເຊິ່ງອ່ານບໍ່ຮູ້ເລື່ອງ.
const ACTION_LABELS = {
  "bill.update_transport": "ແກ້ໄຂຂໍ້ມູນຂົນສົ່ງຂອງບິນ",
  "bill.send_line": "ສົ່ງແຈ້ງເຕືອນ LINE ຫາລູກຄ້າ",
  "bill_todo.create": "ເພີ່ມລາຍການທີ່ຕ້ອງເຮັດ",
  "bill_todo.delete": "ລຶບລາຍການທີ່ຕ້ອງເຮັດ",
  "bill_todo.set_done": "ໝາຍລາຍການວ່າແລ້ວ",
  "pending_bill.add_custom": "ເພີ່ມບິນນອກລະບົບ",
  "pending_bill.add_manual": "ເພີ່ມບິນດ້ວຍມື",
  "pending_bill.bulk_update": "ແກ້ໄຂບິນຫຼາຍລາຍການ",
  "pending_bill.location_update": "ແກ້ໄຂຈຸດສົ່ງຂອງບິນ",
  "pending_bill.remove_manual": "ເອົາບິນອອກຈາກລາຍການ",
  "pending_bill.sales_schedule": "ຝ່າຍຂາຍນັດວັນຈັດສົ່ງ",
  "pending_bill.schedule_update": "ແກ້ໄຂວັນນັດຈັດສົ່ງ",
  "pending_bill.split_by_branch": "ແຍກບິນຕາມສາຂາ",
  reclassify_to_branch: "ຍ້າຍບິນໄປສາຂາອື່ນ",
  "setting.update": "ແກ້ໄຂການຕັ້ງຄ່າລະບົບ",
  "thunjai.setting.update": "ແກ້ໄຂການຕັ້ງຄ່າທັນໃຈ",
};


// ຊື່ຊະນິດຂໍ້ມູນເປັນພາສາລາວ — audit ເກັບເປັນຄຳອັງກິດ ("bill", "job") ເຊິ່ງ
// ໂຜລ່ອອກໄປຢູ່ແຈ້ງເຕືອນຂອງຫົວໜ້າແລ້ວອ່ານແປກຕາ.
const ENTITY_LABELS = {
  bill: "ບິນ",
  job: "ຖ້ຽວ",
  setting: "ການຕັ້ງຄ່າ",
  notify_prefs: "ການຕັ້ງຄ່າແຈ້ງເຕືອນ",
};

/** ຫົວຂໍ້ + ເນື້ອຫາທີ່ອ່ານຮູ້ເລື່ອງ ຈາກ audit ດິບ. */
function describeActivity({ action, entityType, entityId, actorName } = {}) {
  const label = ACTION_LABELS[action] ?? action;
  const who = actorName || "ພະນັກງານ";
  // ປະກອບຈາກສ່ວນທີ່ມີຈິງເທົ່ານັ້ນ — template ຕາຍຕົວເຮັດໃຫ້ເກີດຊ່ອງຫວ່າງຄູ່
  // ຕອນ entityType ຫວ່າງ ("ຊື່ຄົນ —  bill IV-001").
  const what = [ENTITY_LABELS[entityType] ?? entityType, entityId]
    .filter((part) => String(part ?? "").trim())
    .join(" ");
  return { title: `📋 ${label}`, body: `${who}${what ? ` — ${what}` : ""}` };
}

module.exports = { NEVER_NOTIFY, ACTION_LABELS, describeActivity };
