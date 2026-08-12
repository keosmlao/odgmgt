"use client";

import { use } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import Link from "next/link";
import { Button, Card, Page, PageHeader } from "@/components/ui";
import { tmsUrl } from "@/components/tms-link";
import { useLanguage } from "@/context/LanguageContext";

/**
 * Safety net for TMS routes this app does not host. The copied pages link all
 * over the TMS app; TmsLink sends most of those straight to TMS, and anything
 * that slips through lands here instead of a 404.
 */
export default function TransportFallbackPage({
  params,
}: {
  params: Promise<{ rest: string[] }>;
}) {
  const { rest } = use(params);
  const path = `/${(rest || []).join("/")}`;
  const { t } = useLanguage();

  return (
    <Page>
      <PageHeader
        eyebrow={t("transport.eyebrow")}
        title={t("transport.notHere")}
        subtitle={t("transport.notHereHint")}
        actions={
          <Link href="/transport" className="btn btn-ghost">
            <ArrowLeft size={13} />
            {t("approve.back")}
          </Link>
        }
      />
      <Card>
        <p className="num text-[13px] font-semibold" style={{ color: "var(--ink)" }}>
          {path}
        </p>
        <p className="mt-1 text-[12px]" style={{ color: "var(--muted)" }}>
          {t("transport.notHereBody")}
        </p>
        <div className="mt-3">
          <a href={tmsUrl(path)} target="_blank" rel="noreferrer">
            <Button variant="primary">
              <ExternalLink size={13} />
              {t("transport.openInTms")}
            </Button>
          </a>
        </div>
      </Card>
    </Page>
  );
}
