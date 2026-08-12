"use client";

import { useState } from "react";
import type { Option } from "@/lib/pm/products";
import FilterSelect from "./FilterSelect";

export default function ProductGroupFilters({
  groupMain,
  groupSub,
  groupSub2,
  mainOptions,
  subOptions,
  sub2Options,
  locked = false,
}: {
  groupMain: string;
  groupSub: string;
  groupSub2: string;
  mainOptions: Option[];
  subOptions: Option[];
  sub2Options: Option[];
  locked?: boolean;
}) {
  const selectedSub2 = sub2Options.find((option) => option.code === groupSub2);
  const derivedSub = groupSub || selectedSub2?.groupSubCode || "";
  const selectedSub = subOptions.find((option) => option.code === derivedSub);
  const derivedMain = groupMain || selectedSub?.mainGroup || selectedSub2?.mainGroup || "";

  const [main, setMain] = useState(derivedMain);
  const [sub, setSub] = useState(derivedSub);
  const [sub2, setSub2] = useState(groupSub2);

  const availableSubs = main
    ? subOptions.filter((option) => option.mainGroup === main)
    : [];
  const availableSub2 = sub
    ? sub2Options.filter(
        (option) => option.mainGroup === main && option.groupSubCode === sub,
      )
    : [];

  return (
    <>
      <FilterSelect
        name="group_main"
        label={locked ? "ກຸ່ມຫຼັກ (ຮັບຜິດຊອບ)" : "ກຸ່ມຫຼັກ"}
        value={main}
        options={mainOptions}
        disabled={locked}
        onValueChange={(value) => {
          setMain(value);
          setSub("");
          setSub2("");
        }}
      />
      <FilterSelect
        name="group_sub"
        label="ກຸ່ມຍ່ອຍ"
        value={sub}
        options={availableSubs}
        disabled={locked || !main}
        onValueChange={(value) => {
          setSub(value);
          setSub2("");
        }}
      />
      <FilterSelect
        name="group_sub2"
        label="ກຸ່ມຍ່ອຍ 1"
        value={sub2}
        options={availableSub2}
        disabled={locked || !sub}
        onValueChange={setSub2}
      />
    </>
  );
}
