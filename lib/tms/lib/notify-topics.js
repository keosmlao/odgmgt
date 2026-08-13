/**
 * ປະເພດແຈ້ງເຕືອນ + ຄ່າເລີ່ມຕົ້ນຕາມບົດບາດ — ບໍ່ແຕະ DB ຈຶ່ງເທສໄດ້ໂດຍກົງ.
 *
 * `managerDefault` ໃຊ້ກັບຜູ້ບໍ່ແມ່ນຄົນຂັບ, `driverDefault` ໃຊ້ກັບຄົນຂັບ.
 * ແຍກສອງຄ່າເພາະສ່ວນຫຼາຍຫົວໜ້າຢາກເຫັນພາບລວມ ແຕ່ຄົນຂັບຢາກເຫັນແຕ່ງານຕົນເອງ.
 */
const TOPICS = [
  {
    key: "job_assigned",
    label: "ຈັດຖ້ຽວໃຫ້ / ປ່ຽນຖ້ຽວ",
    detail: "ເມື່ອມີການຈັດຖ້ຽວ ຫຼື ແກ້ໄຂຖ້ຽວ",
    managerDefault: true,
    driverDefault: true,
  },
  {
    key: "job_status",
    label: "ອະນຸມັດ / ຍົກເລີກ / ປິດຖ້ຽວ",
    detail: "ການປ່ຽນສະຖານະຂອງຖ້ຽວ",
    managerDefault: true,
    driverDefault: true,
  },
  {
    key: "bill_delivered",
    label: "ແຈ້ງສົ່ງສຳເລັດ",
    detail: "ພະນັກງານກົດວ່າສົ່ງບິນສຳເລັດ",
    managerDefault: true,
    driverDefault: false,
  },
  {
    key: "pickup_variance",
    label: "ເບີກເຄື່ອງບໍ່ຄົບ",
    detail: "ຈຳນວນທີ່ເບີກບໍ່ຕົງກັບຖ້ຽວ",
    managerDefault: true,
    driverDefault: true,
  },
  {
    key: "bill_forwarded",
    label: "ບິນຖືກຍ້າຍສາຂາ",
    detail: "ບິນຖືກສົ່ງຕໍ່ໄປສາຂາອື່ນ",
    managerDefault: true,
    driverDefault: false,
  },
  {
    key: "dispatch_reminder",
    label: "ເຕືອນຖ້ຽວທີ່ຍັງບໍ່ອອກ",
    detail: "ຮັບຖ້ຽວ + ເບີກແລ້ວ ແຕ່ຍັງບໍ່ເລີ່ມສົ່ງ",
    managerDefault: false,
    driverDefault: true,
  },
  {
    key: "chat",
    label: "ຂໍ້ຄວາມແຊັດ",
    detail: "ຂໍ້ຄວາມໃໝ່ໃນບິນ ຫຼື ຂໍ້ຄວາມສ່ວນຕົວ",
    managerDefault: true,
    driverDefault: true,
  },
  {
    key: "web_activity",
    label: "ການເຄື່ອນໄຫວໃນເວັບ",
    detail: "ທຸກການແກ້ໄຂທີ່ເຮັດຜ່ານໜ້າເວັບ (ດັງຫຼາຍ)",
    managerDefault: false,
    driverDefault: false,
  },
];


/** ບໍ່ຮູ້ຈັກປະເພດ → false ສະເໝີ: ພິມຜິດບໍ່ຄວນກາຍເປັນ "ສົ່ງຫາທຸກຄົນ". */
function defaultFor(topicKey, isDriver) {
  const topic = TOPICS.find((t) => t.key === topicKey);
  if (!topic) return false;
  return isDriver ? topic.driverDefault : topic.managerDefault;
}

/**
 * `data.type` ຂອງ push ຈິງ → ປະເພດໃນໜ້າຕັ້ງຄ່າ.
 *
 * ທຸກ push ແນບ `type` ມາຢູ່ແລ້ວ ຈຶ່ງແປງບ່ອນນີ້ບ່ອນດຽວ ແທນທີ່ຈະໄປໃສ່ຕົວ
 * ກັ່ນຕອງທີ່ຈຸດເອີ້ນ 10 ບ່ອນ (ແລ້ວລືມບ່ອນໃດບ່ອນໜຶ່ງ).
 */
const TYPE_TO_TOPIC = {
  job_created: "job_assigned",
  job_updated: "job_assigned",
  bills_added: "job_assigned",
  job_approved: "job_status",
  job_closed: "job_status",
  job_deleted: "job_status",
  bill_delivered: "bill_delivered",
  pickup_variance: "pickup_variance",
  bill_forwarded: "bill_forwarded",
  dispatch_reminder: "dispatch_reminder",
  dm: "chat",
  chatter: "chat",
  web_activity: "web_activity",
};

/**
 * ປະເພດທີ່ຄວນເອົາໄປກັ່ນຕອງ — `null` ແປວ່າ **ຢ່າກັ່ນຕອງ**.
 *
 * `push_test` ຕ້ອງຜ່ານສະເໝີ: ປຸ່ມທົດສອບມີໄວ້ວິນິດໄສ ຖ້າມັນຖືກການຕັ້ງຄ່າ
 * ບລັອກງຽບໆ ຈະຫຼົງທາງໜັກກວ່າເກົ່າ. ປະເພດທີ່ບໍ່ຮູ້ຈັກກໍ່ປ່ອຍຜ່ານ ເພື່ອບໍ່ໃຫ້
 * push ໃໝ່ຫາຍໄປຍ້ອນລືມມາເພີ່ມໃນຕາຕະລາງນີ້.
 */
function topicForPushType(type) {
  return TYPE_TO_TOPIC[String(type ?? "")] ?? null;
}

module.exports = { TOPICS, defaultFor, TYPE_TO_TOPIC, topicForPushType };
