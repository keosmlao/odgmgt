"use client";

import { useSyncExternalStore } from "react";
import Select, { type Props, type GroupBase } from "react-select";

// See ClientAsyncSelect: same SSR emotion hydration fix, for the plain Select.
const subscribe = () => () => {};
const useMounted = () => useSyncExternalStore(subscribe, () => true, () => false);

export default function ClientSelect<
  Option,
  IsMulti extends boolean = false,
  Group extends GroupBase<Option> = GroupBase<Option>,
>(props: Props<Option, IsMulti, Group>) {
  const mounted = useMounted();
  if (!mounted) {
    return (
      <div
        aria-hidden
        className="min-h-9 w-full rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-950"
      />
    );
  }
  return <Select<Option, IsMulti, Group> {...props} />;
}
