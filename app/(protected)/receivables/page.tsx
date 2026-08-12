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
    settled_after: number; unpaid_after: number;
  }[];
};


/** Share of a balance that is already overdue — high is bad, unlike an achievement. */
function OverdueRow({
  label,
  bills,
  balance,
  overdue,
  share,
}: {
  label: string;
  bills: number;
  balance: number;
  overdue: number;
  /** This row's cut of the whole receivables book, when the caller supplies it. */
  share?: number;
}) {
  const pct = balance > 0 ? (overdue / balance) * 100 : 0;
  const tone = pct >= 75 ? "neg" : pct >= 40 ? "warn" : "pos";
  return (
    <div className="mb-2.5 last:mb-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[12.5px] font-medium" style={{ color: "var(--ink)" }}>{label}</span>
        <span className="shrink-0 whitespace-nowrap text-[11.5px]">
          {share != null && <span className="num font-semibold" style={{ color: "var(--brand)" }}>{fmtPct(share, 1)}</span>}
          <span className="num ml-1.5" style={{ color: "var(--muted)" }}>{fmtNum(balance)}</span>
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <div className="bar" style={{ height: 4 }}>
          <div className={`bar-fill is-${tone}`} style={{ width: `${Math.min(pct, 100)}%` }} />
        </div>
        <span className="shrink-0"><Pill tone={tone}>{fmtPct(pct, 0)}</Pill></span>
      </div>
      <p className="muted mt-0.5 text-[10px]">{bills} · {fmtNum(overdue)}</p>
    </div>
  );
}

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

            <Card title={t("ar.byBu")} action={<span className="muted text-[11px]">{t("ar.buShareHint")}</span>}>
              {(data?.byBu || []).map((row) => (
                <OverdueRow
                  key={row.bu_code}
                  label={`${row.bu_name} · ${fmtNum(row.bills)} ${t("approve.pn.items")}`}
                  bills={row.bills}
                  balance={row.balance}
                  overdue={row.overdue}
                  share={summary.total_balance > 0 ? (row.balance / summary.total_balance) * 100 : 0}
                />
              ))}
            </Card>

            <Card title={t("ar.byBranch")} action={<span className="muted text-[11px]">{t("ar.overdueShare")}</span>}>
              {(data?.byBranch || []).map((row) => (
                <OverdueRow
                  key={row.branch}
                  label={`${row.branch} · ${fmtNum(row.bills)} ${t("approve.pn.items")}`}
                  bills={row.bills}
                  balance={row.balance}
                  overdue={row.overdue}
                />
              ))}
            </Card>
          </div>

          <Card title={t("ar.worstBills")} action={<span className="muted text-[11px]">{t("ar.worstHint")}</span>} flush>
            <Table
              minWidth={1200}
              heads={[
                t("ar.doc"),
                t("label.customer"),
                t("ar.salesperson"),
                t("ar.dueDate"),
                <span key="d" className="block text-right">{t("ar.overdueDays")}</span>,
                t("ar.stillBuying"),
                t("ar.settledAfter"),
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
                  <td>
                    {row.purchases_after === 0 ? (
                      <span className="muted text-[11px]">—</span>
                    ) : row.settled_after > 0 ? (
                      <span className="whitespace-nowrap">
                        <Pill tone="pos">{fmtNum(row.settled_after)}</Pill>
                        {row.unpaid_after > 0 && (
                          <span className="muted ml-1.5 text-[10px]">{t("ar.stillOwing")} {fmtNum(row.unpaid_after)}</span>
                        )}
                      </span>
                    ) : (
                      <Pill tone="neg">{t("ar.neverPaid")}</Pill>
                    )}
                  </td>
                  <td>
                    {row.purchases_after === 0 ? (
                      <span className="muted text-[11px]">—</span>
                    ) : row.settled_after > 0 ? (
                      <span className="whitespace-nowrap">
                        <Pill tone="pos">{fmtNum(row.settled_after)}</Pill>
                        {row.unpaid_after > 0 && (
                          <span className="muted ml-1.5 text-[10px]">{t("ar.stillOwing")} {fmtNum(row.unpaid_after)}</span>
                        )}
                      </span>
                    ) : (
                      <Pill tone="neg">{t("ar.neverPaid")}</Pill>
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
