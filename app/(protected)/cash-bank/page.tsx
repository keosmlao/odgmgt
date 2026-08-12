"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  Button, Card, Empty, ErrorNote, Loading, Mini, Page, PageHeader, Table,
  fmtDate, fmtDayMonth, fmtNum,
} from "@/components/ui";
import { useLanguage } from "@/context/LanguageContext";
import api from "@/service/api";

type Totals = { cash: number; transfer: number; cheque: number; card: number; deposit: number; net: number; docs: number };
type Data = {
  days: number;
  totals: Totals;
  daily: { day: string; cash: number; transfer: number; cheque: number; deposit: number; docs: number }[];
  monthly: { month: string; cash: number; transfer: number; cheque: number; deposit: number; net: number; docs: number }[];
  recent: { doc_no: string; doc_date: string; description: string; remark: string; cash: number; transfer: number; cheque: number; deposit: number; net: number }[];
};

export default function CashBankPage() {
  const { t } = useLanguage();
  const [days, setDays] = useState("90");
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorKey, setErrorKey] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErrorKey("");
    try {
      const response = await api.get("/cash-bank", { params: { days } });
      if (response.data?.success) setData(response.data.data);
      else setErrorKey("app.error");
    } catch {
      setErrorKey("app.error");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  const totals = data?.totals;
  const chart = (data?.daily || []).map((row) => ({ ...row, label: fmtDayMonth(row.day) }));

  return (
    <Page>
      <PageHeader
        eyebrow={t("cb.eyebrow")}
        title={t("sidebar.cashBank")}
        subtitle={t("cb.subtitle")}
        actions={
          <>
            <select value={days} onChange={(event) => setDays(event.target.value)} className="select !w-28">
              {["30", "90", "180", "365"].map((option) => (
                <option key={option} value={option}>{option} {t("ar.days")}</option>
              ))}
            </select>
            <Button variant="ghost" onClick={load} disabled={loading}>
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
              {t("approve.refresh")}
            </Button>
          </>
        }
      />

      {errorKey && <ErrorNote text={t(errorKey)} />}

      {loading || !totals ? (
        <Loading text={t("app.loading")} />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-5">
            <Mini label={t("cb.cash")} value={fmtNum(totals.cash)} tone="pos" />
            <Mini label={t("cb.transfer")} value={fmtNum(totals.transfer)} tone="brand" />
            <Mini label={t("cb.cheque")} value={fmtNum(totals.cheque)} tone="warn" />
            <Mini label={t("cb.deposit")} value={fmtNum(totals.deposit)} />
            <Mini label={t("cb.docs")} value={fmtNum(totals.docs)} />
          </div>

          <Card title={t("cb.daily")} action={<span className="muted text-[11px]">{t("cb.dailyHint")}</span>}>
            {chart.length === 0 ? (
              <Empty text={t("label.noData")} />
            ) : (
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chart} margin={{ top: 6, right: 6, bottom: 0, left: -12 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line-soft)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: "var(--muted)" }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: "var(--muted)" }} tickLine={false} axisLine={false} width={56} />
                    <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 12, fontSize: 12 }} />
                    <Area type="monotone" dataKey="transfer" name={t("cb.transfer")} stackId="1" stroke="#2b70b5" fill="#2b70b5" fillOpacity={0.25} />
                    <Area type="monotone" dataKey="cash" name={t("cb.cash")} stackId="1" stroke="#17876d" fill="#17876d" fillOpacity={0.3} />
                    <Area type="monotone" dataKey="cheque" name={t("cb.cheque")} stackId="1" stroke="#f5911f" fill="#f5911f" fillOpacity={0.3} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <Card title={t("cb.monthly")} flush>
            <Table
              minWidth={720}
              heads={[
                t("monthSummary.month"),
                <span key="c" className="block text-right">{t("cb.cash")}</span>,
                <span key="t" className="block text-right">{t("cb.transfer")}</span>,
                <span key="q" className="block text-right">{t("cb.cheque")}</span>,
                <span key="d" className="block text-right">{t("cb.deposit")}</span>,
                <span key="n" className="block text-right">{t("cb.net")}</span>,
              ]}
            >
              {(data?.monthly || []).map((row) => (
                <tr key={row.month}>
                  <td className="num font-semibold">{row.month}</td>
                  <td className="num text-right">{fmtNum(row.cash)}</td>
                  <td className="num text-right">{fmtNum(row.transfer)}</td>
                  <td className="num text-right">{fmtNum(row.cheque)}</td>
                  <td className="num text-right">{fmtNum(row.deposit)}</td>
                  <td className="num text-right font-semibold">{fmtNum(row.net)}</td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card title={t("cb.recent")} flush>
            <Table
              minWidth={880}
              heads={[
                t("approve.date"),
                t("ar.doc"),
                t("approve.pn.name"),
                <span key="c" className="block text-right">{t("cb.cash")}</span>,
                <span key="t" className="block text-right">{t("cb.transfer")}</span>,
                <span key="n" className="block text-right">{t("cb.net")}</span>,
              ]}
            >
              {(data?.recent || []).map((row) => (
                <tr key={row.doc_no}>
                  <td>{fmtDate(row.doc_date)}</td>
                  <td className="num">{row.doc_no}</td>
                  <td><span className="block max-w-[24rem] truncate">{row.description || row.remark || "-"}</span></td>
                  <td className="num text-right">{fmtNum(row.cash)}</td>
                  <td className="num text-right">{fmtNum(row.transfer)}</td>
                  <td className="num text-right font-semibold">{fmtNum(row.net)}</td>
                </tr>
              ))}
            </Table>
          </Card>

          <p className="text-[11px]" style={{ color: "var(--muted)" }}>{t("cb.note")}</p>
        </div>
      )}
    </Page>
  );
}
