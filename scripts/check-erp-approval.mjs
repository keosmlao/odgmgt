/**
 * ທົດລອງສ້າງໃບອະນຸມັດ ແລ້ວ **ROLLBACK** — ບໍ່ມີຫຍັງຄາຢູ່ ERP.
 *
 * Builds the approval document exactly as /api/approvals/{pr,po} would, inside
 * a transaction that is always rolled back, and prints the header and lines it
 * produced next to a real ERP-written document of the same kind. It is the only
 * way to check the copy against the ERP's own work without writing to the
 * purchasing books first and asking questions afterwards.
 *
 * Run:  node --env-file=.env.local scripts/check-erp-approval.mjs pr PRHN26080016
 *       node --env-file=.env.local scripts/check-erp-approval.mjs po POH26080073
 */
import pg from "pg";
import { createApprovalDocument, APPROVAL_DOC } from "../lib/erp-approval.js";

const [kind, docNo] = process.argv.slice(2);
if (!APPROVAL_DOC[kind] || !docNo) {
  console.error("ໃຊ້: node --env-file=.env.local scripts/check-erp-approval.mjs <pr|po> <doc_no>");
  process.exit(1);
}

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 10_000,
});

const spec = APPROVAL_DOC[kind];
const client = await pool.connect();

try {
  await client.query("BEGIN");

  const result = await createApprovalDocument(client, {
    kind,
    sourceDocNo: docNo,
    approverCode: process.env.CHECK_APPROVER || "22034",
  });
  console.log("ຜົນ:", result);

  if (result.docNo && result.created) {
    const header = await client.query(
      `SELECT doc_no, doc_format_code, trans_flag, doc_ref, doc_date, doc_time,
              creator_code, user_approve, user_request, approve_status, cust_code,
              total_amount, currency_code, exchange_rate, branch_code, vat_rate
       FROM public.ic_trans WHERE doc_no = $1`,
      [result.docNo],
    );
    console.log("\n── ໃບອະນຸມັດທີ່ສ້າງ ──");
    console.table(header.rows);

    const lines = await client.query(
      `SELECT doc_no, trans_flag, line_number, ref_doc_no, doc_ref, item_code, qty, price, sum_amount
       FROM public.ic_trans_detail WHERE doc_no = $1 ORDER BY line_number LIMIT 5`,
      [result.docNo],
    );
    console.log(`── ແຖວລາຍການ (${lines.rowCount} ແຖວທຳອິດ) ──`);
    console.table(lines.rows);

    const real = await client.query(
      `SELECT doc_no, doc_format_code, trans_flag, doc_ref, doc_date, doc_time,
              creator_code, user_approve, user_request, approve_status, cust_code,
              total_amount, currency_code, exchange_rate, branch_code, vat_rate
       FROM public.ic_trans
       WHERE trans_flag = $1 AND doc_no LIKE $2 || '%' AND doc_no <> $3
       ORDER BY doc_no DESC LIMIT 1`,
      [spec.flag, spec.prefix, result.docNo],
    );
    console.log("── ໃບຈິງທີ່ ERP ຂຽນເອງ (ຫຼ້າສຸດ) ເພື່ອທຽບ ──");
    console.table(real.rows);

    const source = await client.query(
      `SELECT approve_status FROM public.ic_trans WHERE doc_no = $1 AND trans_flag = $2`,
      [docNo, spec.sourceFlag],
    );
    console.log("ໃບຕົ້ນທາງ approve_status ຫຼັງອະນຸມັດ (ໃນ transaction ນີ້):", source.rows[0]);
  }
} finally {
  await client.query("ROLLBACK");
  client.release();
  await pool.end();
  console.log("\n⤺ ROLLBACK ແລ້ວ — ບໍ່ມີເອກະສານໃດຖືກສ້າງຈິງ");
}
