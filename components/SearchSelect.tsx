"use client";

import { useId, useSyncExternalStore } from "react";
import Select, { type StylesConfig } from "react-select";

/**
 * The app's searchable dropdown.
 *
 * A native <select> is fine for five options and unusable for the roster's 257
 * staff, and its multiple form asks the user to hold Ctrl/Cmd — a convention
 * nobody outside a spreadsheet knows, with no visible sign of what is already
 * chosen. This types to filter, and shows the picks as removable chips.
 *
 * Styled from the app's CSS variables rather than a fixed palette, so it
 * follows the theme the way .input and .select already do. The other
 * react-select wrappers in this repo (components/pm, components/ods) were
 * carried over from other apps and hardcode their own colours; this one is for
 * screens built against this design system.
 */
export type Option = { value: string; label: string };

/** Menus portal to <body> so a drawer's overflow can never clip them. */
const portal: StylesConfig<Option, boolean> = {
  // Above the drawer (z-50) and its backdrop (z-40).
  menuPortal: (base) => ({ ...base, zIndex: 60 }),
};

const classNames = {
  control: ({ isFocused, isDisabled }: { isFocused: boolean; isDisabled: boolean }) =>
    [
      "min-h-[2.25rem] w-full rounded-lg border bg-[var(--surface)] text-sm transition",
      isDisabled ? "cursor-not-allowed opacity-55" : "",
      isFocused
        ? "border-[var(--brand)] shadow-[0_0_0_3px_var(--info-bg)]"
        : "border-[var(--line)] hover:border-[var(--muted)]",
    ].join(" "),
  valueContainer: () => "gap-1 px-2 py-1",
  placeholder: () => "text-[var(--muted)]",
  input: () => "text-[var(--ink)]",
  singleValue: () => "text-[var(--ink)]",
  multiValue: () => "rounded-md bg-[var(--info-bg)] pl-2",
  multiValueLabel: () => "py-0.5 text-xs font-medium text-[var(--brand)]",
  multiValueRemove: () =>
    "rounded-r-md px-1 text-[var(--brand)] hover:bg-[var(--neg-bg)] hover:text-[var(--neg)]",
  indicatorsContainer: () => "text-[var(--muted)]",
  dropdownIndicator: () => "px-1.5 hover:text-[var(--ink-soft)]",
  clearIndicator: () => "px-1 hover:text-[var(--neg)]",
  indicatorSeparator: () => "bg-[var(--line)]",
  menu: () =>
    "mt-1 overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--surface)] shadow-lg",
  menuList: () => "max-h-60 py-1",
  noOptionsMessage: () => "px-3 py-2 text-xs text-[var(--muted)]",
  option: ({ isFocused, isSelected }: { isFocused: boolean; isSelected: boolean }) =>
    [
      "cursor-pointer px-3 py-2 text-sm",
      isSelected
        ? "bg-[var(--brand-deep)] text-white"
        : isFocused
          ? "bg-[var(--surface-2)] text-[var(--ink)]"
          : "text-[var(--ink-soft)]",
    ].join(" "),
};

/** react-select renders client-only: its emotion styles break SSR hydration. */
const useMounted = () =>
  useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

function Skeleton({ label }: { label: string }) {
  return (
    <div className="flex min-h-[2.25rem] items-center rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-sm text-[var(--muted)]">
      {label}
    </div>
  );
}

export function SearchSelect({
  value,
  options,
  onChange,
  placeholder = "Select...",
  isDisabled,
  isClearable = true,
}: {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  placeholder?: string;
  isDisabled?: boolean;
  isClearable?: boolean;
}) {
  const instanceId = useId();
  const mounted = useMounted();
  const selected = options.find((o) => o.value === value) ?? null;

  if (!mounted) return <Skeleton label={selected?.label ?? placeholder} />;

  return (
    <Select<Option>
      instanceId={instanceId}
      value={selected}
      options={options}
      onChange={(option) => onChange(option?.value ?? "")}
      placeholder={placeholder}
      isDisabled={isDisabled}
      isClearable={isClearable}
      isSearchable
      noOptionsMessage={() => "ບໍ່ພົບ"}
      menuPortalTarget={typeof document !== "undefined" ? document.body : undefined}
      unstyled
      classNames={classNames}
      styles={portal}
    />
  );
}

export function MultiSearchSelect({
  values,
  options,
  onChange,
  placeholder = "Select...",
  isDisabled,
}: {
  values: string[];
  options: Option[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  isDisabled?: boolean;
}) {
  const instanceId = useId();
  const mounted = useMounted();
  const selected = options.filter((o) => values.includes(o.value));

  if (!mounted) {
    return <Skeleton label={selected.length ? `${selected.length} selected` : placeholder} />;
  }

  return (
    <Select<Option, true>
      instanceId={instanceId}
      isMulti
      value={selected}
      options={options}
      onChange={(picked) => onChange(picked.map((o) => o.value))}
      placeholder={placeholder}
      isDisabled={isDisabled}
      isSearchable
      closeMenuOnSelect={false}
      hideSelectedOptions={false}
      noOptionsMessage={() => "ບໍ່ພົບ"}
      menuPortalTarget={typeof document !== "undefined" ? document.body : undefined}
      unstyled
      classNames={classNames}
      styles={portal}
    />
  );
}
