import { parseIntSafe } from "./helpers";
import type { BuiltFilters, ChannelMapEntry, FilterValue } from "./types";

const channelMap: Record<string, ChannelMapEntry> = {
  RETAIL: { names: ["ຂາຍໜ້າຮ້ານ"], codes: ["101"] },
  WHOLESALE: { names: ["ຂາຍສົ່ງ"], codes: ["102"] },
  TECH: { names: ["ຂາຍຊ່າງ"], codes: ["103"] },
  PROJECT: { names: ["ຂາຍໂຄງການ", "ໂຄງການ"], codes: ["106"] },
  ONLINE: { names: ["ຂາຍອອນລາຍ"], codes: ["107"] },
  101: { names: ["ຂາຍໜ້າຮ້ານ"], codes: ["101"] },
  102: { names: ["ຂາຍສົ່ງ"], codes: ["102"] },
  103: { names: ["ຂາຍຊ່າງ"], codes: ["103"] },
  106: { names: ["ຂາຍໂຄງການ", "ໂຄງການ"], codes: ["106"] },
  107: { names: ["ຂາຍອອນລາຍ"], codes: ["107"] },
  "ຂາຍໜ້າຮ້ານ": { names: ["ຂາຍໜ້າຮ້ານ"], codes: ["101"] },
  "ຂາຍສົ່ງ": { names: ["ຂາຍສົ່ງ"], codes: ["102"] },
  "ຂາຍຊ່າງ": { names: ["ຂາຍຊ່າງ"], codes: ["103"] },
  "ຂາຍໂຄງການ": { names: ["ຂາຍໂຄງການ", "ໂຄງການ"], codes: ["106"] },
  "ໂຄງການ": { names: ["ຂາຍໂຄງການ", "ໂຄງການ"], codes: ["106"] },
  "ຂາຍອອນລາຍ": { names: ["ຂາຍອອນລາຍ"], codes: ["107"] },
};

export { channelMap };

function toValues(value: string | string[]): string[] {
  return typeof value === "string" ? value.split(",").filter(Boolean) : [...value];
}

export function buildFilters(
  year: number,
  bu: FilterValue,
  channel: FilterValue,
  province: FilterValue,
  month: FilterValue | number = null,
): BuiltFilters {
  const detailWhere = ["yeardoc = %s"];
  const detailParams: unknown[] = [year];
  const targetWhere = ["target_year = %s"];
  const targetParams: unknown[] = [year];

  if (bu && bu !== "ALL") {
    detailWhere.push("bu_code = %s");
    detailParams.push(bu);
    targetWhere.push("bu_code = %s");
    targetParams.push(bu);
  }

  if (province && province !== "ALL") {
    const provinceValues = toValues(province);
    detailWhere.push("(province = ANY(%s) OR province_name = ANY(%s))");
    detailParams.push(provinceValues, provinceValues);
    targetWhere.push("province_code = ANY(%s)");
    targetParams.push(provinceValues);
  }

  if (channel && channel !== "ALL") {
    const channelValues = toValues(channel);
    const names: string[] = [];
    const codes: string[] = [];
    for (const item of channelValues) {
      const mapped = channelMap[item] || { names: [item], codes: [item] };
      names.push(...mapped.names);
      codes.push(...mapped.codes);
    }
    detailWhere.push(
      "(channel_name = ANY(%s) OR argroup = ANY(%s) OR argroup_main = ANY(%s) OR argroupsub = ANY(%s))",
    );
    detailParams.push(names, names, names, names);
    targetWhere.push("(sale_channel = ANY(%s) OR sale_channel = ANY(%s))");
    targetParams.push(codes, names);
  }

  if (month && String(month) !== "ALL") {
    const monthValue = parseIntSafe(month);
    if (monthValue) {
      detailWhere.push("monthdoc = %s");
      detailParams.push(monthValue);
      targetWhere.push("target_month = %s");
      targetParams.push(monthValue);
    }
  }

  return {
    detailWhere: detailWhere.join(" AND "),
    detailParams,
    targetWhere: targetWhere.join(" AND "),
    targetParams,
  };
}
