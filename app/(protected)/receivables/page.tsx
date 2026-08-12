"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, Users, Wallet } from "lucide-react";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Loading,
  Mini,
  Page,
  PageHeader,
  Pill,
  Rank,
  StatTile,
  Table,
  fmtDate,
  fmtNum,
  fmtPct,
} from "@/components/ui";
import { useLanguage } from "@/context/LanguageContext";
import { downloadCsv } from "@/lib/csv";
import api from "@/service/api";

type Data = {
  summary: { total_balance: number; overdue_balance: number; overdue_pct: number; dso: number };
  buckets: { bucket: string; bills: number; balance: number }[];
  topDebtors: { ar_code: string; name: string; sale_name: string; balance: number; bills: number; max_overdue_days: number }[];
  bySalesperson: { sale_name: string; department_name: string; bills: number; customers: number; balance: number; overdue: number; max_overdue_days: number }[];
  byBranch: { branch: string; bills: number; balance: number; overdue: number }[];
  byBu: { bu_code: string; bu_name: string; bills: number; balance: number; overdue: number }[];
  worstBills: {
    doc_no: string; ar_code: string; name: string; doc_date: string; due_date: string;
    sale_name: string; balance: number; overdue_days: number;
    last_purchase: string | null; purchases_after: number; bought_after: number;
  }[];
};

const overdueTone = (days: number) => (days > 90 ? "neg" : days > 30 ? "warn" : "muted");

export default function ReceivablesPage() {
  const { t } = useLanguage();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorKey, setErrorKey] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErrorKey("");
    try {
      const response = await api.get("/receivables");
      if (response.data?.success) setData(response.data.data);
      else setErrorKey("app.error");
    } catch {
      setErrorKey("app.error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const exportCsv = () => {
    downloadCsv(
      "receivables",
      [t("ar.salesperson"), t("ar.department"), t("ar.customers"), t("approve.pn.items"), t("ar.balance"), t("ar.overdue"), t("ar.maxOverdue")],
      (data?.bySalesperson || []).map((row) => [
        row.sale_name, row.department_name, row.customers, row.bills,
        Math.round(row.balance), Math.round(row.overdue), row.max_overdue_days,
      ]),
    );
  };

  const summary = data?.summary;

  return (
    <Page>
      <PageHeader
        eyebrow={t("ar.eyebrow")}
        title={t("sidebar.receivables")}
        subtitle={t("ar.subtitle")}
        actions={
          <>
            <Button variant="ghost" onClick={exportCsv} disabled={loading || !data}>CSV</Button>
            <Button variant="ghost" onClick={load} disabled={loading}>
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
              {t("approve.refresh")}
            </Button>
          </>
        }
      />

      {errorKey && <ErrorNote text={t(errorKey)} />}

      {loading || !summary ? (
        <Loading text={t("app.loading")} />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile featured label={t("ar.totalBalance")} value={fmtNum(summary.total_balance)} sub={t("ar.unit")} icon={<Wallet size={14} />} />
            <StatTile
              label={t("ar.overdue")}
              value={fmtNum(summary.overdue_balance)}
              sub={`${fmtPct(summary.overdue_pct, 1)} ${t("ar.ofTotal")}`}
              pct={summary.overdue_pct}
              tone={summary.overdue_pct > 30 ? "neg" : "warn"}
              icon={<AlertTriangle size={14} />}
            />
            <StatTile label="DSO" value={`${summary.dso.toFixed(1)} ${t("ar.days")}`} sub={t("ar.dsoHint")} tone="muted" />
            <StatTile
              label={t("ar.customersOwing")}
              value={fmtNum(new Set((data?.topDebtors || []).map((row) => row.ar_code)).size)}
              sub={t("ar.topDebtorsHint")}
              tone="muted"
              icon={<Users size={14} />}
            />
          </div>

          <Card title={t("ar.aging")}>
            <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 xl:grid-cols-7">
              {(data?.buckets || []).map((row) => (
                <Mini key={row.bucket} label={`${row.bucket} · ${fmtNum(row.bills)}`} value={fmtNum(row.balance)} />
              ))}
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={t("ar.bySalesperson")} flush>
              {(data?.bySalesperson || []).length === 0 ? (
                <Empty text={t("label.noData")} />
              ) : (
                <Table
                  minWidth={520}
                  heads={[
                    t("ar.salesperson"),
                    <span key="c" className="block text-right">{t("ar.customers")}</span>,
                    <span key="b" className="block text-right">{t("ar.balance")}</span>,
                    <span key="o" className="block text-right">{t("ar.overdue")}</span>,
                  ]}
                >
                  {(data?.bySalesperson || []).slice(0, 15).map((row, index) => (
                    <tr key={`${row.sale_name}-${index}`}>
                      <td>
                        <span className="font-medium">{row.sale_name}</span>
                        <span className="muted ml-1.5 text-[10px]">{row.department_name}</span>
                      </td>
                      <td className="num text-right">{fmtNum(row.customers)}</td>
                      <td className="num text-right font-semibold">{fmtNum(row.balance)}</td>
                      <td className="text-right">
                        <Pill tone={row.overdue > 0 ? overdueTone(row.max_overdue_days) : "muted"}>{fmtNum(row.overdue)}</Pill>
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>

            <Card title={t("ar.byBu")} action={<span className="muted text-[11px]">{t("ar.byBuHint")}</span>}>
              {(data?.byBu || []).map((row, index) => (
                <Rank
                  key={row.bu_code}
                  index={index}
                  label={`${row.bu_name} · ${fmtNum(row.bills)} ${t("approve.pn.items")}`}
                  value={fmtNum(row.balance)}
                  pct={row.balance > 0 ? (row.overdue / row.balance) * 100 : 0}
                />
              ))}
            </Card>

            <Card title={t("ar.byBranch")}>
              {(data?.byBranch || []).map((row, index) => (
                <Rank
                  key={row.branch}
                  index={index}
                  label={`${row.branch} · ${fmtNum(row.bills)} ${t("approve.pn.items")}`}
                  value={fmtNum(row.balance)}
                  pct={row.balance > 0 ? (row.overdue / row.balance) * 100 : 0}
                />
              ))}
            </Card>
          </div>

          <Card title={t("ar.worstBills")} action={<span className="muted text-[11px]">{t("ar.worstHint")}</span>} flush>
            <Table
              minWidth={1040}
              heads={[
                t("ar.doc"),
                t("label.customer"),
                t("ar.salesperson"),
                t("ar.dueDate"),
                <span key="d" className="block text-right">{t("ar.overdueDays")}</span>,
                t("ar.stillBuying"),
                <span key="b" className="block text-right">{t("ar.balance")}</span>,
              ]}
            >
              {(data?.worstBills || []).map((row) => (
                <tr key={row.doc_no}>
                  <td className="num">{row.doc_no}</td>
                  <td><span className="block max-w-[18rem] truncate">{row.name}</span></td>
                  <td>{row.sale_name}</td>
                  <td>{fmtDate(row.due_date)}</td>
                  <td className="text-right">
                    <Pill tone={overdueTone(row.overdue_days)}>{fmtNum(row.overdue_days)}</Pill>
                  </td>
                  <td>
                    {row.purchases_after > 0 ? (
                      <span className="whitespace-nowrap">
                        <Pill tone="neg">{fmtNum(row.purchases_after)} {t("ar.times")}</Pill>
                        <span className="muted ml-1.5 text-[10px]">{fmtDate(row.last_purchase)}</span>
                      </span>
                    ) : (
                      <span className="muted text-[11px]">
                        {t("ar.noPurchase")}
                        {row.last_purchase && ` · ${fmtDate(row.last_purchase)}`}
                      </span>
                    )}
                  </td>
                  <td className="num text-right font-semibold">{fmtNum(row.balance)}</td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card title={t("an.topDebtors")} flush>
            <Table
              minWidth={620}
              heads={[
                t("label.customer"),
                t("ar.salesperson"),
                <span key="b" className="block text-right">{t("an.bills")}</span>,
                <span key="d" className="block text-right">{t("ar.maxOverdue")}</span>,
                <span key="a" className="block text-right">{t("ar.balance")}</span>,
              ]}
            >
              {(data?.topDebtors || []).map((row) => (
                <tr key={row.ar_code}>
                  <td>
                    <span className="block max-w-[20rem] truncate font-medium">{row.name}</span>
                    <span className="muted num text-[10px]">{row.ar_code}</span>
                  </td>
                  <td>{row.sale_name}</td>
                  <td className="num text-right">{fmtNum(row.bills)}</td>
                  <td className="text-right">
                    <Pill tone={overdueTone(row.max_overdue_days)}>{fmtNum(row.max_overdue_days)}</Pill>
                  </td>
                  <td className="num text-right font-semibold">{fmtNum(row.balance)}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      )}
    </Page>
  );
}
