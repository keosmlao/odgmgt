"use client";

import type { ReactNode } from "react";
import { ConfirmProvider } from "@/components/confirm-dialog";

/**
 * The bill pages copied from TMS call useConfirm(), which TMS mounts in its own
 * (dashboard) layout. Mounting the same provider here keeps those pages working
 * unchanged instead of rewriting their confirmation dialogs.
 */
export default function TransportLayout({ children }: { children: ReactNode }) {
  return <ConfirmProvider>{children}</ConfirmProvider>;
}
