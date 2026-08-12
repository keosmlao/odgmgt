"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, RefreshCw } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  Button, Card, Empty, ErrorNote, Loading, Page, PageHeader, StatTile, Table,
  fmtDate, fmtDayMonth, fmtNum,
} from "@/components/ui";
import { useLanguage } from "@/context/LanguageContext";
import api from "@/service/api";

type Account = { code: string; name: string; kind: "cash" | "bank"; money_in: number; money_out: number; balance: number };
type Group = { kind: "cash" | "bank"; accounts: number; money_in: number; money_out: number; balance: number };
type Data = {
  days: number;
  totals: { opening: number; money_in: number; money_out: number; net: number; closing: number; docs: number };
  groups: Group[];
  accounts: Account[];
  daily: { day: string; money_in: number; money_out: number; net: number }[];
  monthly: { month: string; money_in: number; money_out: number; net: number }[];
  recent: {
    doc_no: string; line_number: number; doc_date: string; account_code: string;
    account_name: string; description: string | null; money_in: number; money_out: number;
  }[];
};

/** Money in is green, money out is red — everywhere on this page. */
const IN = "var(--pos)";
const OUT = "var(--neg)";

function Flow({ value, direction }: { value: number; direction: "in" | "out" }) {
  if (!value) return <span style={{ color: "var(--muted)" }}>–</span>;
  return (
    <span className="num font-semibold" style={{ color: direction === "in" ? IN : OUT }}>
      {direction === "in" ? "+" : "−"}{fmtNum(value)}
    </span>
  );
}

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

  const chart = useMemo(
    () => (data?.daily || []).map((row) => ({ ...row, label: fmtDayMonth(row.day) })),
    [data],
  );
  const totals = data?.totals;
  const cash = data?.groups.find((group) => group.kind === "cash");
  const bank = data?.groups.find((group) => group.kind === "bank");

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
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <StatTile
              featured
              label={t("cb.closing")}
              value={fmtNum(totals.closing)}
              sub={`${t("cb.opening")} ${fmtNum(totals.opening)}`}
            />
            <StatTile
              label={t("cb.in")}
              value={fmtNum(totals.money_in)}
              sub={`${totals.docs} ${t("cb.docs")}`}
              tone="pos"
              icon={<ArrowDownLeft size={15} />}
            />
            <StatTile
              label={t("cb.out")}
              value={fmtNum(totals.money_out)}
              tone="neg"
              icon={<ArrowUpRight size={15} />}
            />
            <StatTile
              label={t("cb.net")}
              value={`${totals.net >= 0 ? "+" : "−"}${fmtNum(Math.abs(totals.net))}`}
              sub={t("cb.netHint")}
              tone={totals.net >= 0 ? "pos" : "neg"}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {[["cash", cash] as const, ["bank", bank] as const].map(([kind, group]) => (
              <Card key={kind} title={t(kind === "cash" ? "cb.groupCash" : "cb.groupBank")}>
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <p className="num text-[22px] font-bold">{fmtNum(group?.balance || 0)}</p>
                    <p className="text-[11px]" style={{ color: "var(--muted)" }}>
                      {group?.accounts || 0} {t("cb.accounts")}
                    </p>
                  </div>
                  <div className="text-right text-[12px] leading-relaxed">
                    <p><Flow value={group?.money_in || 0} direction="in" /></p>
                    <p><Flow value={group?.money_out || 0} direction="out" /></p>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          <Card title={t("cb.daily")} action={<span className="muted text-[11px]">{t("cb.dailyHint")}</span>}>
            {chart.length === 0 ? (
              <Empty text={t("label.noData")} />
            ) : (
              <div style={{ height: 250 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chart} margin={{ top: 6, right: 6, bottom: 0, left: -12 }} stackOffset="sign">
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line-soft)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: "var(--muted)" }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: "var(--muted)" }} tickLine={false} axisLine={false} width={60} />
                    <Tooltip
                      cursor={{ fill: "var(--surface-2)" }}
                      contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 12, fontSize: 12 }}
                      formatter={(value, name) => [fmtNum(Math.abs(Number(value) || 0)), name]}
                    />
                    <Bar dataKey="money_in" name={t("cb.in")} fill={IN} radius={[3, 3, 0, 0]} />
                    <Bar dataKey="money_out" name={t("cb.out")} fill={OUT} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <Card title={t("cb.byAccount")} flush>
            <Table
              minWidth={760}
              heads={[
                t("cb.account"),
                <span key="i" className="block text-right">{t("cb.in")}</span>,
                <span key="o" className="block text-right">{t("cb.out")}</span>,
                <span key="b" className="block text-right">{t("cb.balance")}</span>,
              ]}
            >
              {(data?.accounts || []).map((row) => (
                <tr key={row.code}>
                  <td>
                    <span className="block max-w-[30rem] whitespace-normal text-[12px] font-medium leading-snug">{row.name}</span>
                    <span className="num text-[10px]" style={{ color: "var(--muted)" }}>
                      {row.code} · {t(row.kind === "cash" ? "cb.groupCash" : "cb.groupBank")}
                    </span>
                  </td>
                  <td className="text-right"><Flow value={row.money_in} direction="in" /></td>
                  <td className="text-right"><Flow value={row.money_out} direction="out" /></td>
                  <td className="num text-right font-bold" style={{ color: row.balance < 0 ? OUT : "var(--ink)" }}>
                    {fmtNum(row.balance)}
                  </td>
                </tr>
              ))}
            </Table>
          </Card>

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <Card title={t("cb.monthly")} flush>
              <Table
                minWidth={420}
                heads={[
                  t("monthSummary.month"),
                  <span key="i" className="block text-right">{t("cb.in")}</span>,
                  <span key="o" className="block text-right">{t("cb.out")}</span>,
                  <span key="n" className="block text-right">{t("cb.net")}</span>,
                ]}
              >
                {(data?.monthly || []).map((row) => (
                  <tr key={row.month}>
                    <td className="num font-semibold">{row.month}</td>
                    <td className="text-right"><Flow value={row.money_in} direction="in" /></td>
                    <td className="text-right"><Flow value={row.money_out} direction="out" /></td>
                    <td className="num text-right font-bold" style={{ color: row.net >= 0 ? IN : OUT }}>
                      {row.net >= 0 ? "+" : "−"}{fmtNum(Math.abs(row.net))}
                    </td>
                  </tr>
                ))}
              </Table>
            </Card>

            <Card title={t("cb.recent")} flush>
              <Table
                minWidth={520}
                heads={[
                  t("approve.date"),
                  t("cb.account"),
                  <span key="i" className="block text-right">{t("cb.in")}</span>,
                  <span key="o" className="block text-right">{t("cb.out")}</span>,
                ]}
              >
                {(data?.recent || []).map((row) => (
                  <tr key={`${row.doc_no}-${row.line_number}`}>
                    <td>
                      <span className="block text-[12px]">{fmtDate(row.doc_date)}</span>
                      <span className="num text-[10px]" style={{ color: "var(--muted)" }}>{row.doc_no}</span>
                    </td>
                    <td>
                      <span className="block max-w-[22rem] whitespace-normal text-[12px] leading-snug">{row.account_name}</span>
                      {row.description && (
                        <span className="block max-w-[22rem] truncate text-[10px]" style={{ color: "var(--muted)" }}>
                          {row.description}
                        </span>
                      )}
                    </td>
                    <td className="text-right"><Flow value={row.money_in} direction="in" /></td>
                    <td className="text-right"><Flow value={row.money_out} direction="out" /></td>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>

          <p className="text-[11px]" style={{ color: "var(--muted)" }}>{t("cb.note")}</p>
        </div>
      )}
    </Page>
  );
}
