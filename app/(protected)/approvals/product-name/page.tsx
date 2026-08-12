"use client";

import { useState } from "react";
import { Boxes, ChevronDown, ChevronRight } from "lucide-react";
import {
  Card,
  Empty,
  ErrorNote,
  Loading,
  Page,
  Pill,
  Table,
  fmtDate,
} from "@/components/ui";
import { ApprovalHeader, ItemName, RowActions, StatusPill, useApprovalQueue } from "@/components/approvals";
import { useLanguage } from "@/context/LanguageContext";

type Doc = {
  doc_no: string;
  doc_date: string | null;
  status: number;
  item_count: number | null;
  creator_code: string | null;
  creator_name: string | null;
  approve_code: string | null;
  approver_name: string | null;
  approve_time: string | null;
};

type Line = {
  doc_no: string;
  code: string | null;
  name_1: string | null;
  new_name_1: string | null;
  new_name_2: string | null;
};

type Draft = {
  roworder: number;
  name_1: string | null;
  name_2: string | null;
  unit_code: string | null;
  wh_code: string | null;
  brand_code: string | null;
  user_created: string | null;
  approve_status: number;
  approver: string | null;
  requst_status: number;
  created_date_time_now: string | null;
};

export default function ApproveProductNamePage() {
  const { t } = useLanguage();
  const queue = useApprovalQueue<{ docs: Doc[]; lines: Line[]; drafts: Draft[] }>("/approvals/product-name");
  const [expanded, setExpanded] = useState<string | null>(null);

  const docs = queue.data?.docs || [];
  const drafts = queue.data?.drafts || [];
  const linesOf = (docNo: string) => (queue.data?.lines || []).filter((line) => line.doc_no === docNo);

  return (
    <Page>
      <ApprovalHeader
        icon={<Boxes size={22} />}
        title={t("sidebar.approveProductName")}
        subtitle={t("approve.productName.subtitle")}
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
        <div className="space-y-4">
          <Card className="approval-card" title={t("approve.pn.docs")} action={<span className="approval-card-hint">{t("approve.pn.docsHint")}</span>} flush>
            {docs.length === 0 ? (
              <Empty text={t("approve.empty")} />
            ) : (
              <Table
                minWidth={880}
                heads={[
                  "",
                  t("approve.pn.docNo"),
                  t("approve.date"),
                  t("approve.pn.items"),
                  t("approve.pn.creator"),
                  t("approve.status"),
                  t("approve.by"),
                  <span key="a" className="block text-right">{t("approve.actions")}</span>,
                ]}
              >
                {docs.map((doc) => {
                  const open = expanded === doc.doc_no;
                  const lines = linesOf(doc.doc_no);
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
                      <td className="num">{doc.item_count ?? lines.length}</td>
                      <td>{doc.creator_name || doc.creator_code || "-"}</td>
                      <td>
                        <StatusPill status={doc.status} />
                      </td>
                      <td>
                        {doc.approve_code ? (
                          <span className="text-[11.5px]">
                            {doc.approver_name || doc.approve_code}
                            <span className="muted"> · {fmtDate(doc.approve_time)}</span>
                          </span>
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                      <td className="text-right">
                        <RowActions
                          status={doc.status}
                          busy={queue.busy}
                          onApprove={() => queue.decide("approve", { source: "doc", key: doc.doc_no })}
                          onReject={() => queue.decide("reject", { source: "doc", key: doc.doc_no })}
                        />
                      </td>
                    </tr>,
                    open && (
                      <tr key={`${doc.doc_no}-detail`}>
                        <td colSpan={8} className="bg-[var(--surface-2)]">
                          <div className="space-y-2 px-2 py-2">
                            {lines.length === 0 && <p className="muted text-[11.5px]">{t("approve.empty")}</p>}
                            {lines.map((line, index) => (
                              <div key={`${line.code}-${index}`} className="text-[11.5px]">
                                <p className="num font-semibold">{line.code}</p>
                                <p className="muted">
                                  {t("approve.pn.oldName")}: <ItemName value={line.name_1} className="inline-block align-top" />
                                </p>
                                <p style={{ color: "var(--ink)" }}>
                                  {t("approve.pn.newName")}:{" "}
                                  <ItemName value={line.new_name_1 || line.new_name_2} className="inline-block align-top" />
                                </p>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </Table>
            )}
          </Card>

          <Card className="approval-card" title={t("approve.pn.drafts")} action={<span className="approval-card-hint">{t("approve.pn.draftsHint")}</span>} flush>
            {drafts.length === 0 ? (
              <Empty text={t("approve.empty")} />
            ) : (
              <Table
                minWidth={880}
                heads={[
                  t("approve.pn.name"),
                  t("approve.pn.unit"),
                  t("approve.pn.warehouse"),
                  t("approve.pn.creator"),
                  t("approve.date"),
                  t("approve.status"),
                  t("approve.by"),
                  <span key="a" className="block text-right">{t("approve.actions")}</span>,
                ]}
              >
                {drafts.map((draft) => (
                  <tr key={draft.roworder}>
                    <td>
                      <ItemName value={draft.name_1} className="font-medium" />
                      {draft.name_2 && <ItemName value={draft.name_2} className="muted text-[11px]" />}
                    </td>
                    <td>{draft.unit_code || "-"}</td>
                    <td className="num">{draft.wh_code || "-"}</td>
                    <td>{draft.user_created || "-"}</td>
                    <td>{fmtDate(draft.created_date_time_now)}</td>
                    <td className="whitespace-nowrap">
                      <StatusPill status={draft.approve_status} />{" "}
                      <Pill tone={draft.requst_status === 1 ? "brand" : "muted"}>
                        {draft.requst_status === 1 ? t("approve.pn.requested") : t("approve.pn.notRequested")}
                      </Pill>
                    </td>
                    <td>{draft.approver || <span className="muted">-</span>}</td>
                    <td className="text-right">
                      <RowActions
                        status={draft.approve_status}
                        busy={queue.busy}
                        onApprove={() => queue.decide("approve", { source: "draft", key: draft.roworder })}
                        onReject={() => queue.decide("reject", { source: "draft", key: draft.roworder })}
                      />
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      )}
    </Page>
  );
}
