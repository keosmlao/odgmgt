"use client";

import AsyncSelect from "@/components/pm/ClientAsyncSelect";

type Opt = { value: string; label: string };

export default function ProductSearchSelect({
  spareOnly,
  placeholder,
}: {
  spareOnly: boolean;
  placeholder: string;
}) {
  const loadOptions = async (input: string): Promise<Opt[]> => {
    if (!input.trim()) return [];
    const res = await fetch(
      `/api/inventory-search?q=${encodeURIComponent(input)}&spare=${spareOnly ? "1" : "0"}`,
    );
    if (!res.ok) return [];
    const rows: { code: string; name: string }[] = await res.json();
    return rows.map((r) => ({ value: r.code, label: `${r.code} · ${r.name}` }));
  };

  return (
    <AsyncSelect<Opt>
      name="related_code"
      instanceId="related-search"
      cacheOptions
      defaultOptions={false}
      loadOptions={loadOptions}
      placeholder={placeholder}
      loadingMessage={() => "ກຳລັງຄົ້ນຫາ..."}
      noOptionsMessage={({ inputValue }) =>
        inputValue ? "ບໍ່ພົບສິນຄ້າ" : "ພິມເພື່ອຄົ້ນຫາ"}
      unstyled
      classNames={{
        control: ({ isFocused }) =>
          [
            "min-h-11 min-w-0 flex-1 rounded-xl border bg-white px-1 text-sm transition dark:bg-slate-950",
            isFocused ? "border-teal-400" : "border-slate-200 dark:border-slate-700",
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
        menuList: () => "max-h-72 py-1",
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
      isClearable
    />
  );
}
