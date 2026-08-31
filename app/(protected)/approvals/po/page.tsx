"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, ShoppingCart } from "lucide-react";
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

type Po = {
  doc_no: string;
  status: string | null;
  po_id: number | null;
  supplier_code: string | null;
  supplier_name: string | null;
  order_date: string | null;
  expected_date: string | null;
  total: number | null;
  note: string | null;
  submitted_by: string | null;
  submitter_name: string | null;
  submitted_at: string | null;
  approved_by: string | null;
  approver_name: string | null;
  approved_at: string | null;
  reject_reason: string | null;
  created_at: string | null;
};

type Item = {
  doc_no: string;
  item_code: string | null;
  item_name: string | null;
  qty: number | null;
  unit_code: string | null;
  unit_price: number | null;
  total: number | null;
  wh_name: string | null;
};

export default function ApprovePoPage() {
  const { t } = useLanguage();
  const queue = useApprovalQueue<{ docs: Po[]; items: Item[] }>("/approvals/po");
  const [expanded, setExpanded] = useState<string | null>(null);

  const docs = queue.data?.docs || [];

  return (
    <Page>
      <ApprovalHeader
        icon={<ShoppingCart size={22} />}
        title={t("sidebar.approvePo")}
        subtitle={t("approve.po.subtitle")}
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
                t("approve.po.no"),
                t("approve.po.supplier"),
                t("approve.po.orderDate"),
                t("approve.po.expectedDate"),
                <span key="v" className="block text-right">{t("approve.po.total")}</span>,
                t("approve.po.submittedBy"),
                t("approve.status"),
                <span key="a" className="block text-right">{t("approve.actions")}</span>,
              ]}
            >
              {docs.map((doc) => {
                const open = expanded === doc.doc_no;
                const items = (queue.data?.items || []).filter((item) => item.doc_no === doc.doc_no);
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
                    <td>
                      <Link href={`/approvals/po/${encodeURIComponent(doc.doc_no)}`} className="approval-link num font-semibold">
                        {doc.doc_no}
                      </Link>
                    </td>
                    <td>{doc.supplier_name || doc.supplier_code || "-"}</td>
                    <td>{fmtDate(doc.order_date)}</td>
                    <td>{fmtDate(doc.expected_date)}</td>
                    <td className="num text-right">{fmtNum(doc.total)}</td>
                    <td>{doc.submitter_name || doc.submitted_by || "-"}</td>
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
                      <td colSpan={9} className="bg-[var(--surface-2)]">
                        <div className="space-y-1.5 px-2 py-2 text-[11.5px]">
                          <p className="muted">
                            {t("approve.status")}: <span className="num">{doc.status || "-"}</span>
                          </p>
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
                          {items.length === 0 ? (
                            <p className="muted">{t("approve.empty")}</p>
                          ) : (
                            items.map((item, index) => (
                              <p key={`${item.doc_no}-${item.item_code}-${index}`}>
                                <span className="num">{item.item_code}</span> {item.item_name} ·{" "}
                                {t("approve.po.qty")} <span className="num">{fmtNum(item.qty)}</span>{" "}
                                {item.unit_code || ""} · {t("approve.po.unitPrice")}{" "}
                                <span className="num">{fmtNum(item.unit_price)}</span>
                              </p>
                            ))
                          )}
                          <p className="pt-1">
                            <Link
                              href={`/approvals/po/${encodeURIComponent(doc.doc_no)}`}
                              className="approval-link font-semibold"
                            >
                              {t("approve.po.openDetail")} →
                            </Link>
                          </p>
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </Table>
          )}
        </Card>
      )}
    </Page>
  );
}
