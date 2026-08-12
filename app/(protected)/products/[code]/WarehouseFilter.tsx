"use client";

import { useRouter } from "next/navigation";
import Select from "@/components/pm/ClientSelect";

type Opt = { value: string; label: string };

export default function WarehouseFilter({
  code,
  current,
  options,
}: {
  code: string;
  current: string;
  options: { warehouse: string; wh_name: string }[];
}) {
  const router = useRouter();
  const opts: Opt[] = [
    { value: "", label: "ທຸກສາງ" },
    ...options.map((o) => ({ value: o.warehouse, label: o.wh_name || o.warehouse })),
  ];
  const selected = opts.find((o) => o.value === current) ?? opts[0];

  return (
    <div className="mb-3 w-full max-w-xs">
      <Select<Opt>
        instanceId={`wh-${code}`}
        value={selected}
        options={opts}
        isSearchable
        placeholder="ທຸກສາງ"
        noOptionsMessage={() => "ບໍ່ພົບ"}
        menuPortalTarget={typeof document !== "undefined" ? document.body : undefined}
        onChange={(o) => {
          const v = o?.value ?? "";
          const base = `/products/${encodeURIComponent(code)}`;
          router.push(v ? `${base}?wh=${encodeURIComponent(v)}#movements` : `${base}#movements`);
        }}
        unstyled
        classNames={{
          control: ({ isFocused }) =>
            [
              "min-h-11 rounded-xl border bg-slate-50 px-1 text-sm transition dark:bg-slate-950",
              isFocused ? "border-teal-400 dark:border-teal-500" : "border-slate-200 dark:border-slate-700",
            ].join(" "),
          valueContainer: () => "px-2 py-0.5",
          placeholder: () => "text-slate-400",
          input: () => "text-slate-900 dark:text-white",
          singleValue: () => "text-slate-900 dark:text-white",
          indicatorsContainer: () => "text-slate-400",
          dropdownIndicator: () => "px-1",
          indicatorSeparator: () => "bg-slate-200 dark:bg-slate-700",
          menu: () =>
            "mt-1 overflow-hidden rounded-lg glass shadow-lg dark:border-slate-700 dark:bg-slate-900",
          menuList: () => "max-h-60 py-1",
          option: ({ isFocused, isSelected }) =>
            [
              "cursor-pointer px-3 py-2 text-sm",
              isSelected
                ? "bg-teal-600 text-white"
                : isFocused
                  ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-white"
                  : "text-slate-700 dark:text-slate-300",
            ].join(" "),
        }}
        styles={{ menuPortal: (base) => ({ ...base, zIndex: 50 }) }}
      />
    </div>
  );
}
