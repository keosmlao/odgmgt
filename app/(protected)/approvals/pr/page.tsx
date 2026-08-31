"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, ClipboardList } from "lucide-react";
import {
  Card,
  Empty,
  ErrorNote,
  Loading,
  Page,
  Table,
  fmtDate,
  fmtNum,
} from "@/components/ui";
import { ApprovalHeader, RowActions, StatusPill, useApprovalQueue } from "@/components/approvals";
import { useLanguage } from "@/context/LanguageContext";

type Pr = {
  /** ເລກໃບຂໍຊື້ — ERP doc_no, which is what a verdict is keyed on. */
  doc_no: string;
  doc_date: string | null;
  department_code: string | null;
  department_name: string | null;
  requester_code: string | null;
  requester_name: string | null;
  need_date: string | null;
  note: string | null;
  status: string | null;
  reject_reason: string | null;
  approved_by: string | null;
  approver_name: string | null;
  approved_at: string | null;
  line_count: number;
  est_total: number;
};

type Line = {
  doc_no: string;
  line_no: number | null;
  item_code: string | null;
  item_name: string | null;
  unit: string | null;
  qty: number | null;
  est_price: number | null;
  note: string | null;
};

export default function ApprovePrPage() {
  const { t } = useLanguage();
  const queue = useApprovalQueue<{ docs: Pr[]; lines: Line[] }>("/approvals/pr");
  const [expanded, setExpanded] = useState<string | null>(null);

  const docs = queue.data?.docs || [];

  /**
   * ຈັດກຸ່ມຕາມພະແນກ — a requisition is approved on behalf of a department, and
   * a flat list of PR numbers makes the reader sort them in their head. Order
   * of first appearance keeps the newest department at the top, the way the
   * rows are already sorted; documents with no department land last, together.
   */
  const groups = (() => {
    const byDepartment = new Map<string, { label: string; rows: Pr[] }>();
    for (const doc of docs) {
      const key = doc.department_name || doc.department_code || "";
      const label = doc.department_name || doc.department_code || t("approve.pr.noDepartment");
      if (!byDepartment.has(key)) byDepartment.set(key, { label, rows: [] });
      byDepartment.get(key)!.rows.push(doc);
    }
    const list = [...byDepartment.entries()];
    list.sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : 0));
    return list.map(([, group]) => group);
  })();

  return (
    <Page>
      <ApprovalHeader
        icon={<ClipboardList size={22} />}
        title={t("sidebar.approvePr")}
        subtitle={t("approve.pr.subtitle")}
        filter={queue.filter}
        onFilterChange={queue.setFilter}
        scope={queue.scope}
        onScopeChange={queue.setScope}
        onRefresh={queue.reload}
        loading={queue.loading}
      />

      {queue.errorKey && <ErrorNote text={t(queue.errorKey)} />}

      {queue.loading ? (
        <Loading text={t("app.loading")} />
      ) : (
        <Card className="approval-card" title={t("approve.pending")} flush>
          {docs.length === 0 ? (
            /* ວ່າງເພາະ "ຂອງຂ້ອຍ" ກັ່ນອອກ ບໍ່ແມ່ນວ່າບໍ່ມີໃບລໍຖ້າ — ຜູ້ອະນຸມັດ
               ສ່ວນຫຼາຍບໍ່ແມ່ນຄົນຂຽນໃບ ຈຶ່ງບອກທາງອອກໄວ້ໃຫ້ເລີຍ. */
            <div className="py-2 text-center">
              <Empty text={t("approve.empty")} />
              {queue.scope === "mine" && (
                <button type="button" className="btn mt-2" onClick={() => queue.setScope("all")}>
                  {t("approve.seeAll")}
                </button>
              )}
            </div>
          ) : (
            <Table
              minWidth={1020}
              heads={[
                "",
                t("approve.pr.no"),
                t("approve.date"),
                t("approve.pr.department"),
                t("approve.pr.requester"),
                t("approve.pr.needDate"),
                <span key="l" className="block text-right">{t("approve.pr.lines")}</span>,
                <span key="v" className="block text-right">{t("approve.pr.estTotal")}</span>,
                t("approve.status"),
                <span key="a" className="block text-right">{t("approve.actions")}</span>,
              ]}
            >
              {groups.flatMap((group) => [
                /* ຫົວກຸ່ມພະແນກ — one band per department, with how many sit under it. */
                <tr key={`group-${group.label}`} className="approval-group">
                  <td colSpan={10}>
                    <span className="font-semibold">{group.label}</span>{" "}
                    <span className="muted">· {fmtNum(group.rows.length)}</span>
                  </td>
                </tr>,
                ...group.rows.map((doc) => {
                const open = expanded === doc.doc_no;
                const lines = (queue.data?.lines || []).filter((line) => line.doc_no === doc.doc_no);
                return [
                  <tr key={doc.doc_no}>
                    <td>
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : doc.doc_no)}
                        className="flex h-6 w-6 items-center justify-center rounded-[var(--r-xs)] text-[var(--muted)] hover:bg-[var(--surface-2)]"
                        aria-label={t("approve.details")}
                      >
                        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    </td>
                    <td className="num font-semibold">{doc.doc_no}</td>
                    <td>{fmtDate(doc.doc_date)}</td>
                    <td>{doc.department_name || doc.department_code || "-"}</td>
                    <td>{doc.requester_name || doc.requester_code || "-"}</td>
                    <td>{fmtDate(doc.need_date)}</td>
                    <td className="num text-right">{fmtNum(doc.line_count)}</td>
                    <td className="num text-right">{fmtNum(doc.est_total)}</td>
                    <td>
                      <StatusPill status={doc.status} />
                    </td>
                    <td className="text-right">
                      <RowActions
                        status={doc.status}
                        busy={queue.busy}
                        onApprove={() => queue.decide("approve", { key: doc.doc_no })}
                        onReject={() => queue.decide("reject", { key: doc.doc_no })}
                      />
                    </td>
                  </tr>,
                  open && (
                    <tr key={`${doc.doc_no}-detail`}>
                      <td colSpan={10} className="bg-[var(--surface-2)]">
                        <div className="space-y-1.5 px-2 py-2 text-[11.5px]">
                          {doc.note && (
                            <p className="muted">
                              {t("approve.note")}: {doc.note}
                            </p>
                          )}
                          {doc.reject_reason && (
                            <p style={{ color: "var(--neg)" }}>
                              {t("approve.reason")}: {doc.reject_reason}
                            </p>
                          )}
                          {doc.approved_by && (
                            <p className="muted">
                              {t("approve.by")}: {doc.approver_name || doc.approved_by} · {fmtDate(doc.approved_at)}
                            </p>
                          )}
                          {lines.length === 0 ? (
                            <p className="muted">{t("approve.empty")}</p>
                          ) : (
                            lines.map((line) => (
                              <p key={`${line.doc_no}-${line.line_no}-${line.item_code}`}>
                                <span className="num">{line.item_code}</span> {line.item_name} ·{" "}
                                {t("approve.pr.qty")} <span className="num">{fmtNum(line.qty)}</span> {line.unit || ""} ·{" "}
                                {t("approve.pr.price")} <span className="num">{fmtNum(line.est_price)}</span>
                              </p>
                            ))
                          )}
                        </div>
                      </td>
                    </tr>
                  ),
                ];
                }).flat(),
              ])}
            </Table>
          )}
        </Card>
      )}
    </Page>
  );
}
