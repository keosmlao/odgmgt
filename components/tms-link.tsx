"use client";

import NextLink, { type LinkProps } from "next/link";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { ExternalLink } from "lucide-react";

/**
 * Drop-in replacement for next/link inside the pages copied from TMS.
 *
 * Those pages link across the whole TMS app (/jobs, /bills-pending, …) but only
 * three of its screens live here, so the rest would 404. Anything that has a
 * local equivalent stays in this app; everything else opens in TMS in a new
 * tab, marked with an icon so it is clear the user is leaving.
 */
const LOCAL_ROUTES: Record<string, string> = {
  "/": "/transport",
  "/reports/delivery-performance": "/transport/delivery-performance",
  "/tracking/gps-monthly-summary": "/transport/gps-monthly",
  "/tracking/cars-map": "/transport/cars-map",
  "/tracking/phones-map": "/transport/phones-map",
};

export function tmsUrl(path: string) {
  const base = (process.env.NEXT_PUBLIC_TMS_URL || "https://tms.odienmall.com").replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** A path this app serves itself, or null when it belongs to TMS. */
export function localRouteFor(path: string) {
  return LOCAL_ROUTES[path.split("?")[0]] ?? null;
}

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> &
  Omit<LinkProps, "href"> & { href: string; children?: ReactNode; showIcon?: boolean };

export default function TmsLink({ href, children, showIcon = false, ...rest }: Props) {
  const path = String(href ?? "");

  if (!path.startsWith("/")) {
    return (
      <a href={path} {...rest}>
        {children}
      </a>
    );
  }

  const local = localRouteFor(path);
  if (local) {
    return (
      <NextLink href={local} {...rest}>
        {children}
      </NextLink>
    );
  }

  return (
    <a href={tmsUrl(path)} target="_blank" rel="noreferrer" {...rest}>
      {children}
      {showIcon && <ExternalLink size={11} className="ml-1 inline-block align-[-1px] opacity-70" />}
    </a>
  );
}
