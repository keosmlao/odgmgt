"use client";

import { useSyncExternalStore } from "react";
import Select from "@/components/pm/ClientSelect";
import type { Option } from "@/lib/pm/products";

type Opt = { value: string; label: string };

export default function FilterSelect({
  name,
  label,
  value,
  options,
  onValueChange,
  disabled = false,
}: {
  name: string;
  label: string;
  value: string;
  options: Option[];
  onValueChange?: (value: string) => void;
  disabled?: boolean;
}) {
  const opts: Opt[] = options.map((o) => ({
    value: o.code,
    label: o.name || o.code,
  }));
  const selected = opts.find((o) => o.value === value) ?? null;

  // react-select renders client-only (avoids SSR/hydration crash under Next 16 + React 19).
  const mounted = useSyncExternalStore(() => () => {}, () => true, () => false);

  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </span>
      {!mounted ? (
        <div className="flex min-h-10 items-center rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-400 dark:border-slate-700 dark:bg-slate-950">
          {selected?.label ?? "ທັງໝົດ"}
        </div>
      ) : (
      <Select<Opt>
        name={name}
        instanceId={name}
        value={onValueChange ? selected : undefined}
        defaultValue={onValueChange ? undefined : selected}
        onChange={(option) => onValueChange?.(option?.value ?? "")}
        options={opts}
        isDisabled={disabled}
        isClearable
        isSearchable
        placeholder="ທັງໝົດ"
        noOptionsMessage={() => "ບໍ່ພົບ"}
        menuPortalTarget={typeof document !== "undefined" ? document.body : undefined}
        unstyled
        classNames={{
          control: ({ isFocused }) =>
            [
              "min-h-10 rounded-lg border bg-white px-1 text-xs transition dark:bg-slate-950",
              disabled ? "cursor-not-allowed opacity-55" : "",
              isFocused
                ? "border-teal-400 bg-white dark:border-teal-500"
                : "border-slate-200 hover:border-slate-300 dark:border-slate-700",
            ].join(" "),
          valueContainer: () => "px-2 py-0.5",
          placeholder: () => "text-slate-400",
          input: () => "text-slate-900 dark:text-white",
          singleValue: () => "text-slate-900 dark:text-white",
          indicatorsContainer: () => "text-slate-400",
          dropdownIndicator: () => "px-1",
          clearIndicator: () => "px-1 hover:text-slate-600 dark:hover:text-slate-200",
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
      )}
    </label>
  );
}
