"use client";

import { useState } from "react";

export type Tab = { id: string; label: string; content: React.ReactNode };

export default function Tabs({ tabs, initialTab }: { tabs: Tab[]; initialTab?: string }) {
  const [active, setActive] = useState(
    initialTab && tabs.some((t) => t.id === initialTab) ? initialTab : tabs[0]?.id,
  );

  const select = (id: string) => {
    setActive(id);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", id);
    window.history.replaceState(null, "", url.toString());
  };

  return (
    <div>
      <div className="flex gap-5 overflow-x-auto border-b border-slate-200 px-1 dark:border-slate-800">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => select(t.id)}
            className={`whitespace-nowrap border-b-2 px-1 py-3 text-xs font-semibold transition ${
              active === t.id
                ? "border-teal-500 text-teal-700 dark:text-teal-300"
                : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="pt-4">
        {tabs.map((t) => (
          <div key={t.id} className={active === t.id ? "" : "hidden"}>
            {t.content}
          </div>
        ))}
      </div>
    </div>
  );
}
