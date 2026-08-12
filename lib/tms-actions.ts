import { tmsUrl } from "@/components/tms-link";

/**
 * The bill pages copied from TMS carry operational buttons (delete a trip,
 * move a bill to another branch). Those mutate delivery data and must run
 * against the operator's own TMS session, so this app does not proxy them —
 * it sends the user to TMS to do it there.
 */
export function runInTms(path: string, message: string): never | void {
  if (typeof window === "undefined") return;
  if (window.confirm(`${message}\n\n${tmsUrl(path)}`)) {
    window.open(tmsUrl(path), "_blank", "noreferrer");
  }
}
