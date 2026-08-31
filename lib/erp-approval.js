/**
 * ສ້າງເອກະສານອະນຸມັດໃນ ERP — ໃບອະນຸມັດຂໍຊື້ (WPRA) ແລະ ໃບອະນຸມັດສັ່ງຊື້ (WPOA).
 *
 * Approving in the ERP is not a flag on the document; it is a DOCUMENT. Every
 * requisition approved in the last 120 days has one — 122 WPRA raised from the
 * web and 21 PRHA raised in the ERP itself, out of 143 — and 786 of the 788
 * approved purchase orders have a WPOA. A queue that only set approve_status
 * would leave the purchasing side with an approval nobody can produce on paper.
 *
 * The document is a COPY OF ITS SOURCE, which is how the ERP writes it. Read
 * off WPRA2026080038 against PRHO26080006 and WPOA2026080188 against
 * POT26080116, everything is carried over untouched except:
 *
 *   doc_no            ໃໝ່ — WPRA/WPOA + YYYYMM + ລຳດັບ 4 ໂຕ, ນັບໃໝ່ທຸກເດືອນ
 *   doc_format_code   WPRA / WPOA
 *   trans_flag        4 (ຂໍຊື້) / 8 (ສັ່ງຊື້)
 *   doc_ref           ເລກໃບຕົ້ນທາງ
 *   creator_code      ຜູ້ອະນຸມັດ (ບໍ່ແມ່ນຜູ້ຂໍ)
 *   user_approve      ຜູ້ອະນຸມັດ — ໃບຕົ້ນທາງບໍ່ເຄີຍມີຄ່ານີ້
 *   approve_status    0 — ໃບອະນຸມັດເອງບໍ່ໄດ້ຖືກອະນຸມັດ, ມັນຄືການອະນຸມັດ
 *   doc_date/time     ວັນເວລາທີ່ກົດອະນຸມັດ (send_date, expire_date ຕາມ doc_date)
 *
 * ແຖວລາຍການກໍ່ copy ຄືກັນ, ປ່ຽນ doc_no · trans_flag · ref_doc_no · doc_ref ແລະ
 * ວັນເວລາ. roworder ຖືກປະໄວ້ໃຫ້ sequence ຂອງຕາຕະລາງອອກເອງ.
 *
 * ── ດ່ານປ້ອງກັນ ─────────────────────────────────────────────────────────────
 *
 *  1. ທັງໝົດຢູ່ໃນ transaction ດຽວກັບການອັບເດດ approve_status ແລະ ຮ່ອງຮອຍ —
 *     ໃບອະນຸມັດທີ່ບໍ່ມີການອະນຸມັດ, ຫຼື ກັບກັນ, ບໍ່ມີທາງເກີດ.
 *  2. ລັອກເລກແລ່ນ (advisory lock ຕໍ່ prefix+ເດືອນ) ແລ້ວຍັງກວດຊ້ຳວ່າເລກນັ້ນຍັງ
 *     ວ່າງຢູ່ — ic_trans ບໍ່ມີ unique index ເທິງ doc_no ຈຶ່ງເຊື່ອ index ບໍ່ໄດ້.
 *  3. ໃບຕົ້ນທາງຖືກລັອກແຖວ (FOR UPDATE) ແລະ ຕ້ອງຍັງ "ລໍຖ້າ" ຢູ່ຈິງ — ອະນຸມັດ
 *     ແລ້ວ ຫຼື ຖືກຍົກເລີກ ຈະບໍ່ຖືກແຕະ.
 *  4. ໃບຕົ້ນທາງທີ່ມີໃບອະນຸມັດຢູ່ແລ້ວ ຈະບໍ່ຖືກສ້າງໃບທີສອງ — ຄືນເລກເກົ່າໃຫ້.
 *  5. ປິດໄດ້ໂດຍບໍ່ຕ້ອງ deploy: ODG_ERP_APPROVAL_DOC=off ⇒ ບັນທຶກສະເພາະຮ່ອງຮອຍ.
 */

/** ODG_ERP_APPROVAL_DOC=off ⇒ ບໍ່ຂຽນຫຍັງລົງ ERP ເລີຍ. */
export const erpApprovalEnabled = () =>
  !/^(0|off|false|no)$/i.test(String(process.env.ODG_ERP_APPROVAL_DOC || "on"));

/** ໃບອະນຸມັດຂອງແຕ່ລະປະເພດ. */
export const APPROVAL_DOC = {
  pr: { sourceFlag: 2, prefix: "WPRA", flag: 4 },
  po: { sourceFlag: 6, prefix: "WPOA", flag: 8 },
};

/** ຊື່ຖັນທັງໝົດຂອງຕາຕະລາງ ລົບອອກອັນທີ່ພວກເຮົາຂຽນເອງ ແລະ roworder. */
async function copyColumns(client, relation, overridden) {
  const { rows } = await client.query(
    `SELECT a.attname AS name
     FROM pg_attribute a
     WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [relation],
  );
  return rows
    .map((row) => row.name)
    .filter((name) => name !== "roworder" && !overridden.has(name))
    .map((name) => `"${name.replace(/"/g, '""')}"`);
}

/** ເລກໃບອະນຸມັດຕໍ່ໄປ — ຕໍ່ prefix ຕໍ່ເດືອນ, ພາຍໃຕ້ lock ຂອງ transaction ນີ້. */
async function nextDocNo(client, prefix) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`erp-approval-${prefix}`]);
  const { rows } = await client.query(
    `SELECT to_char(current_date, 'YYYYMM') AS ym,
            COALESCE(MAX(NULLIF(regexp_replace(substring(doc_no from 11), '\\D', '', 'g'), ''))::int, 0) AS last
     FROM public.ic_trans
     WHERE doc_no LIKE $1 || to_char(current_date, 'YYYYMM') || '%'`,
    [prefix],
  );
  const ym = rows[0].ym;
  let seq = Number(rows[0].last || 0);
  // The number is not indexed as unique, so the answer is checked rather than
  // trusted: a document written by the ERP between two runs still cannot be
  // overwritten.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    seq += 1;
    const docNo = `${prefix}${ym}${String(seq).padStart(4, "0")}`;
    const taken = await client.query(`SELECT 1 FROM public.ic_trans WHERE doc_no = $1 LIMIT 1`, [docNo]);
    if (!taken.rowCount) return docNo;
  }
  throw new Error(`no free ${prefix} number for ${ym}`);
}

/**
 * ສ້າງໃບອະນຸມັດ ແລະ ໝາຍໃບຕົ້ນທາງວ່າອະນຸມັດແລ້ວ. ຕ້ອງຖືກເອີ້ນພາຍໃນ transaction
 * ທີ່ຜູ້ເອີ້ນເປີດໄວ້ — ບໍ່ commit ເອງ.
 *
 * ຄືນ { docNo, created, alreadyApproved, missing } ໃຫ້ຜູ້ເອີ້ນຕັດສິນ.
 */
export async function createApprovalDocument(client, { kind, sourceDocNo, approverCode }) {
  const spec = APPROVAL_DOC[kind];
  if (!spec) throw new Error(`unknown approval kind ${kind}`);

  // ລັອກໃບຕົ້ນທາງກ່ອນ: ສອງຄົນກົດພ້ອມກັນ ຄົນທີສອງຈະລໍ ແລ້ວເຫັນວ່າອະນຸມັດແລ້ວ.
  const source = await client.query(
    `SELECT doc_no, approve_status, last_status
     FROM public.ic_trans
     WHERE doc_no = $1 AND trans_flag = $2
     FOR UPDATE`,
    [sourceDocNo, spec.sourceFlag],
  );
  if (!source.rowCount) return { missing: true };

  const row = source.rows[0];
  if (Number(row.last_status || 0) !== 0) return { cancelled: true };
  if (Number(row.approve_status || 0) === 1) return { alreadyApproved: true };

  const existing = await client.query(
    `SELECT doc_no FROM public.ic_trans
     WHERE trans_flag = $1 AND doc_ref = $2
     ORDER BY doc_no DESC LIMIT 1`,
    [spec.flag, sourceDocNo],
  );

  let docNo = existing.rows[0]?.doc_no ?? null;
  let created = false;

  if (!docNo) {
    docNo = await nextDocNo(client, spec.prefix);

    const headerOverrides = new Map([
      ["doc_no", "$1::varchar"],
      ["doc_format_code", "$2::varchar"],
      ["trans_flag", "$3::smallint"],
      ["doc_ref", "$4::varchar"],
      ["creator_code", "$5::varchar"],
      ["user_approve", "$5::varchar"],
      ["approve_status", "0"],
      ["doc_date", "current_date"],
      ["send_date", "current_date"],
      ["expire_date", "current_date"],
      ["doc_time", "to_char(localtimestamp, 'HH24:MI')"],
      ["create_date_time_now", "localtimestamp"],
      ["create_datetime", "NULL"],
    ]);
    const headerCols = await copyColumns(client, "public.ic_trans", new Set(headerOverrides.keys()));
    await client.query(
      `INSERT INTO public.ic_trans (${[...headerOverrides.keys()].map((k) => `"${k}"`).join(", ")}, ${headerCols.join(", ")})
       SELECT ${[...headerOverrides.values()].join(", ")}, ${headerCols.join(", ")}
       FROM public.ic_trans
       WHERE doc_no = $4::varchar AND trans_flag = $6::smallint`,
      [docNo, spec.prefix, spec.flag, sourceDocNo, approverCode, spec.sourceFlag],
    );

    const lineOverrides = new Map([
      ["doc_no", "$1::varchar"],
      ["trans_flag", "$2::smallint"],
      ["ref_doc_no", "$3::varchar"],
      ["doc_ref", "$3::varchar"],
      ["doc_date", "current_date"],
      ["doc_date_calc", "current_date"],
      ["doc_time", "to_char(localtimestamp, 'HH24:MI')"],
      ["doc_time_calc", "to_char(localtimestamp, 'HH24:MI')"],
      ["create_date_time_now", "localtimestamp"],
    ]);
    const lineCols = await copyColumns(client, "public.ic_trans_detail", new Set(lineOverrides.keys()));
    await client.query(
      `INSERT INTO public.ic_trans_detail (${[...lineOverrides.keys()].map((k) => `"${k}"`).join(", ")}, ${lineCols.join(", ")})
       SELECT ${[...lineOverrides.values()].join(", ")}, ${lineCols.join(", ")}
       FROM public.ic_trans_detail
       WHERE doc_no = $3::varchar AND trans_flag = $4::smallint`,
      [docNo, spec.flag, sourceDocNo, spec.sourceFlag],
    );
    created = true;
  }

  const approved = await client.query(
    `UPDATE public.ic_trans
        SET approve_status = 1
      WHERE doc_no = $1 AND trans_flag = $2 AND COALESCE(approve_status, 0) = 0`,
    [sourceDocNo, spec.sourceFlag],
  );

  return { docNo, created, approvedRows: approved.rowCount };
}
