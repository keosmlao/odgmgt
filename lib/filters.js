import { isOnlineBillSql, ONLINE_CHANNEL_CODE } from "./online-channel.mjs";
import { parseIntSafe } from "./helpers";

/**
 * Channel codes follow public.ar_group:
 *   101 ຂາຍໜ້າຮ້ານ · 102 ຂາຍສົ່ງ · 103 ໂຄງການ · 106 ຂາຍຊ່າງ · 107 ອອນລາຍ
 * odg_sales_target stores the code, odg_sale_detail stores the name, so each
 * entry carries both and the two must stay in step.
 */
const channelMap = {
  RETAIL: { names: ["ຂາຍໜ້າຮ້ານ"], codes: ["101"] },
  WHOLESALE: { names: ["ຂາຍສົ່ງ"], codes: ["102"] },
  PROJECT: { names: ["ຂາຍໂຄງການ", "ໂຄງການ"], codes: ["103"] },
  TECH: { names: ["ຂາຍຊ່າງ"], codes: ["106"] },
  ONLINE: { names: ["ຂາຍອອນລາຍ", "ອອນລາຍ"], codes: ["107"] },
  101: { names: ["ຂາຍໜ້າຮ້ານ"], codes: ["101"] },
  102: { names: ["ຂາຍສົ່ງ"], codes: ["102"] },
  103: { names: ["ຂາຍໂຄງການ", "ໂຄງການ"], codes: ["103"] },
  106: { names: ["ຂາຍຊ່າງ"], codes: ["106"] },
  107: { names: ["ຂາຍອອນລາຍ", "ອອນລາຍ"], codes: ["107"] },
  "ຂາຍໜ້າຮ້ານ": { names: ["ຂາຍໜ້າຮ້ານ"], codes: ["101"] },
  "ຂາຍສົ່ງ": { names: ["ຂາຍສົ່ງ"], codes: ["102"] },
  "ຂາຍຊ່າງ": { names: ["ຂາຍຊ່າງ"], codes: ["106"] },
  "ຂາຍໂຄງການ": { names: ["ຂາຍໂຄງການ", "ໂຄງການ"], codes: ["103"] },
  "ໂຄງການ": { names: ["ຂາຍໂຄງການ", "ໂຄງການ"], codes: ["103"] },
  "ຂາຍອອນລາຍ": { names: ["ຂາຍອອນລາຍ", "ອອນລາຍ"], codes: ["107"] },
  "ອອນລາຍ": { names: ["ຂາຍອອນລາຍ", "ອອນລາຍ"], codes: ["107"] },
};

export { channelMap };

export function buildFilters(year, bu, channel, province, month = null) {
  const detailWhere = ["yeardoc = %s"];
  const detailParams = [year];
  const targetWhere = ["target_year = %s"];
  const targetParams = [year];

  if (bu && bu !== "ALL") {
    detailWhere.push("bu_code = %s");
    detailParams.push(bu);
    targetWhere.push("bu_code = %s");
    targetParams.push(bu);
  }

  if (province && province !== "ALL") {
    const provinceValues =
      typeof province === "string" ? province.split(",").filter(Boolean) : [...province];
    detailWhere.push("(province = ANY(%s) OR province_name = ANY(%s))");
    detailParams.push(provinceValues, provinceValues);
    targetWhere.push("province_code = ANY(%s)");
    targetParams.push(provinceValues);
  }

  if (channel && channel !== "ALL") {
    const channelValues =
      typeof channel === "string" ? channel.split(",").filter(Boolean) : [...channel];
    const names = [];
    const codes = [];
    for (const item of channelValues) {
      const mapped = channelMap[item] || { names: [item], codes: [item] };
      names.push(...mapped.names);
      codes.push(...mapped.codes);
    }
    // The name columns cannot answer for online: the ERP tags no sale with it,
    // so it is recognised from the bill's salesperson instead. Online rows are
    // subtracted from the name match as well — they are rung up as ຂາຍໜ້າຮ້ານ,
    // and a ຂາຍໜ້າຮ້ານ filter that swept them back in would double-count them
    // against the counter's plan. See lib/online-channel.mjs.
    const online = isOnlineBillSql();
    const byName =
      "(channel_name = ANY(%s) OR argroup = ANY(%s) OR argroup_main = ANY(%s) OR argroupsub = ANY(%s))";
    const wantsOnline = codes.includes(ONLINE_CHANNEL_CODE);
    detailWhere.push(
      wantsOnline ? `((${byName} AND NOT ${online}) OR ${online})` : `(${byName} AND NOT ${online})`,
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

/**
 * Filters for public.odg_sale_monthly (the pre-aggregated rollup). The rollup
 * already stores normalized ar_group channel codes, so channels filter on the
 * code alone instead of the four name columns of odg_sale_detail.
 */
export function buildMonthlyFilters(year, bu, channel, province, month = null) {
  const where = ["yeardoc = %s"];
  const params = [year];

  if (bu && bu !== "ALL") {
    where.push("bu_code = %s");
    params.push(String(bu));
  }

  if (province && province !== "ALL") {
    const values =
      typeof province === "string" ? province.split(",").filter(Boolean) : [...province];
    where.push("province = ANY(%s)");
    params.push(values);
  }

  if (channel && channel !== "ALL") {
    const values =
      typeof channel === "string" ? channel.split(",").filter(Boolean) : [...channel];
    const codes = [];
    for (const item of values) {
      const mapped = channelMap[item];
      if (mapped) codes.push(...mapped.codes);
      else codes.push(String(item));
    }
    where.push("channel_code = ANY(%s)");
    params.push(codes);
  }

  if (month && String(month) !== "ALL") {
    const value = parseIntSafe(month);
    if (value) {
      where.push("monthdoc = %s");
      params.push(value);
    }
  }

  return { where: where.join(" AND "), params };
}
