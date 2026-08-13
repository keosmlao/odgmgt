"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Check, RefreshCw, ShoppingBag, X } from "lucide-react";
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
import { StatusPill, normalizeStatus } from "@/components/approvals";
import { useLanguage } from "@/context/LanguageContext";
import api from "@/service/api";

type Doc = {
  doc_no: string;
  status: string | null;
  poa_no: string | null;
  wpoa_no: string | null;
  supplier_code: string | null;
  supplier_name: string | null;
  order_date: string | null;
  expected_date: string | null;
  credit_date: string | null;
  expire_date: string | null;
  doc_time: string | null;
  branch_code: string | null;
  currency_code: string | null;
  exchange_rate: number | null;
  vat_rate: number | null;
  total_before_vat: number | null;
  total_vat_value: number | null;
  total_after_vat: number | null;
  total: number | null;
  note: string | null;
  project_id: string | null;
  contract_no: string | null;
  submitted_by: string | null;
  submitter_name: string | null;
  submitted_at: string | null;
  approved_by: string | null;
  approver_name: string | null;
  approved_at: string | null;
  reject_reason: string | null;
  erp_creator_code: string | null;
  erp_creator_name: string | null;
  user_request: string | null;
  requester_name: string | null;
  create_datetime: string | null;
  created_by: string | null;
  created_at: string | null;
};

type Item = {
  doc_no: string;
  item_code: string | null;
  item_name: string | null;
  unit_code: string | null;
  qty: number | null;
  unit_price: number | null;
  total: number | null;
  wh_code: string | null;
  wh_name: string | null;
  shelf_name: string | null;
};

type Activity = {
  id: string;
  kind: string;
  body: string;
  created_by: string | null;
  author_name: string | null;
  created_at: string;
};

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: "var(--muted)" }}>
        {label}
      </p>
      <p className="mt-0.5 break-words text-[12.5px] font-medium" style={{ color: "var(--ink)" }}>
        {value ?? "-"}
      </p>
    </div>
  );
}

export default function PoDetailPage() {
  const { t } = useLanguage();
  const params = useParams<{ docNo: string }>();
  const docNo = decodeURIComponent(String(params?.docNo || ""));

  const [data, setData] = useState<{ doc: Doc; items: Item[]; activity: Activity[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErrorKey("");
    try {
      const response = await api.get(`/approvals/po/${encodeURIComponent(docNo)}`);
      if (response.data?.success) setData(response.data.data);
      else setErrorKey("app.error");
    } catch {
      setErrorKey("app.error");
    } finally {
      setLoading(false);
    }
  }, [docNo]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = async (action: "approve" | "reject") => {
    let reason: string | null = null;
    if (action === "approve") {
      if (!window.confirm(t("approve.confirmApprove"))) return;
    } else {
      const answer = window.prompt(t("approve.rejectReason"), "");
      if (answer === null) return;
      reason = answer.trim();
    }
    setBusy(true);
    setErrorKey("");
    try {
      await api.post("/approvals/po", { key: docNo, action, reason });
      await load();
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      setErrorKey(status === 409 ? "approve.alreadyHandled" : "approve.failed");
    } finally {
      setBusy(false);
    }
  };

  const doc = data?.doc;
  const items = data?.items || [];
  const itemTotal = items.reduce((sum, item) => sum + Number(item.total || 0), 0);

  return (
    <Page>
      <header className="po-detail-head">
        <div className="po-detail-title">
          <Link href="/approvals/po" className="po-back" aria-label={t("approve.back")}>
            <ArrowLeft size={18} />
          </Link>
          <div className="min-w-0">
            <p className="eyebrow">{t("sidebar.approvePo")}</p>
            <h1 className="num">{docNo}</h1>
            <p>{doc?.supplier_name || doc?.supplier_code || t("approve.po.subtitle")}</p>
          </div>
        </div>
        <div className="po-detail-actions">
          {doc && (
            <div className="po-head-total">
              <span>{t("approve.po.total")}</span>
              <strong className="num">{fmtNum(doc.total)} <small>{doc.currency_code}</small></strong>
            </div>
          )}
          {doc && <StatusPill status={doc.status} />}
          <button type="button" className="po-icon-button" onClick={load} disabled={loading} aria-label={t("approve.refresh")}>
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </button>
          {doc && normalizeStatus(doc.status) === "pending" && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => decide("approve")}
                className="po-decision is-approve"
              >
                <Check size={15} />
                <span>{t("approve.action.approve")}</span>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => decide("reject")}
                className="po-decision is-reject"
              >
                <X size={15} />
                <span>{t("approve.action.reject")}</span>
              </button>
            </>
          )}
        </div>
      </header>

      {errorKey && <ErrorNote text={t(errorKey)} />}

      {loading ? (
        <Loading text={t("app.loading")} />
      ) : !doc ? (
        <Empty text={t("approve.empty")} />
      ) : (
        <div className="flex flex-col gap-4">
          <Card className="approval-card po-document-card order-1" title={t("approve.po.header")}>
            <div className="po-document-grid">
              <div className="po-supplier-block">
                <span className="po-supplier-icon"><ShoppingBag size={20} /></span>
                <div>
                  <p>{t("approve.po.supplier")}</p>
                  <h2>{doc.supplier_name || doc.supplier_code || "-"}</h2>
                  <span className="num">{doc.supplier_code || "-"}</span>
                </div>
              </div>
              <div className="po-info-grid">
                <Detail label={t("approve.po.orderDate")} value={`${fmtDate(doc.order_date)}${doc.doc_time ? ` ${doc.doc_time}` : ""}`} />
                <Detail label={t("approve.po.expectedDate")} value={fmtDate(doc.expected_date)} />
                <Detail label={t("approve.po.creditDate")} value={fmtDate(doc.credit_date)} />
                <Detail label={t("approve.po.branch")} value={<span className="num">{doc.branch_code}</span>} />
                <Detail label={t("approve.po.currency")} value={`${doc.currency_code || "-"} × ${fmtNum(doc.exchange_rate)}`} />
                <Detail label={t("approve.po.vatRate")} value={`${fmtNum(doc.vat_rate)}%`} />
                <Detail label={t("approve.po.erpCreator")} value={doc.erp_creator_name || doc.erp_creator_code} />
                <Detail label={t("approve.po.requester")} value={doc.requester_name || doc.user_request} />
                <Detail label={t("approve.po.poaNo")} value={<span className="num">{doc.poa_no || doc.wpoa_no}</span>} />
                <Detail label={t("approve.po.createdAt")} value={fmtDate(doc.create_datetime || doc.created_at)} />
                {(doc.project_id || doc.contract_no) && (
                  <Detail label={t("approve.po.project")} value={[doc.project_id, doc.contract_no].filter(Boolean).join(" · ")} />
                )}
                <Detail
                  label={t("approve.by")}
                  value={doc.approved_by
                    ? `${doc.approver_name || doc.approved_by} · ${fmtDate(doc.approved_at)}`
                    : doc.submitted_by
                      ? `${doc.submitter_name || doc.submitted_by}`
                      : "-"}
                />
              </div>
            </div>
            {doc.note && (
              <p className="mt-3 border-t pt-3 text-[12px]" style={{ borderColor: "var(--line-soft)", color: "var(--ink-soft)" }}>
                <span className="muted">{t("approve.note")}: </span>
                <span className="whitespace-pre-wrap">{doc.note}</span>
              </p>
            )}
            {doc.reject_reason && (
              <p className="mt-2 text-[12px]" style={{ color: "var(--neg)" }}>
                {t("approve.reason")}: {doc.reject_reason}
              </p>
            )}
          </Card>

          <Card className="approval-card order-2" title={t("approve.po.items")} action={<span className="approval-card-hint">{items.length} {t("approve.pn.items")}</span>} flush>
            {items.length === 0 ? (
              <Empty text={t("approve.empty")} />
            ) : (
              <Table
                minWidth={880}
                heads={[
                  t("approve.pn.code"),
                  t("approve.po.item"),
                  t("approve.po.warehouse"),
                  t("approve.pn.unit"),
                  <span key="q" className="block text-right">{t("approve.po.qty")}</span>,
                  <span key="p" className="block text-right">{t("approve.po.unitPrice")}</span>,
                  <span key="s" className="block text-right">{t("approve.po.amount")}</span>,
                ]}
              >
                {items.map((item, index) => (
                  <tr key={`${item.item_code}-${index}`}>
                    <td className="num">{item.item_code || "-"}</td>
                    <td>
                      <span className="block max-w-[26rem] whitespace-normal break-words">{item.item_name || "-"}</span>
                    </td>
                    <td>{item.wh_name || item.wh_code || "-"}</td>
                    <td>{item.unit_code || "-"}</td>
                    <td className="num text-right">{fmtNum(item.qty)}</td>
                    <td className="num text-right">{fmtNum(item.unit_price)}</td>
                    <td className="num text-right font-semibold">{fmtNum(item.total)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={6} className="text-right font-semibold">
                    {t("approve.po.itemsTotal")}
                  </td>
                  <td className="num text-right font-bold">{fmtNum(itemTotal)}</td>
                </tr>
              </Table>
            )}
            <div className="po-totals">
              <Detail label={t("approve.po.beforeVat")} value={<span className="num">{fmtNum(doc.total_before_vat)}</span>} />
              <Detail label={t("approve.po.vat")} value={<span className="num">{fmtNum(doc.total_vat_value)}</span>} />
              <Detail label={t("approve.po.afterVat")} value={<span className="num">{fmtNum(doc.total_after_vat)}</span>} />
              <div className="po-grand-total">
                <span>{t("approve.po.total")}</span>
                <strong className="num">{fmtNum(doc.total)}</strong>
              </div>
            </div>
          </Card>

        </div>
      )}
    </Page>
  );
}
