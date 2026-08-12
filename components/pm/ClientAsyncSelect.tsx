"use client";

import { useSyncExternalStore } from "react";
import AsyncSelect, { type AsyncProps } from "react-select/async";
import type { GroupBase } from "react-select";

// false during SSR + the first hydration render, true once on the client —
// via useSyncExternalStore so there's no setState-in-effect (avoids the
// react-hooks lint error and cascading renders).
const subscribe = () => () => {};
const useMounted = () => useSyncExternalStore(subscribe, () => true, () => false);

// react-select injects emotion <style> tags that don't line up between the
// server render and client hydration in the App Router → hydration mismatch.
// Defer the widget to client mount: render an identical placeholder box on the
// server and first client render (so they match), then swap in the real select.
export default function ClientAsyncSelect<
  Option,
  IsMulti extends boolean = false,
  Group extends GroupBase<Option> = GroupBase<Option>,
>(props: AsyncProps<Option, IsMulti, Group>) {
  const mounted = useMounted();
  if (!mounted) {
    return (
      <div
        aria-hidden
        className="min-h-9 w-full rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-950"
      />
    );
  }
  return <AsyncSelect<Option, IsMulti, Group> {...props} />;
}
