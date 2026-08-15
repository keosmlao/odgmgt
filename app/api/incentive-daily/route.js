import { NextResponse } from "next/server";
import { rows } from "@/lib/db";
import { getCurrentUser } from "@/lib/route-auth";
import { swrCache } from "@/lib/cache";
import { POINTS_SQL } from "@/lib/incentive-points-sql";
import { ensurePriceBands } from "@/lib/migrations";

/**
 * One day of scoring, checked.
 *
 * The monthly report answers "what did everyone earn"; this answers "did today
 * score correctly", which is a different question and only useful while the day
 * is still fixable. A missing rule found on the 3rd costs one day of bonus; the
 * same rule found at month end has already been wrong twenty-eight times.
 *
 * It runs the report's own scoring query — not a copy of it. A second query
 * would drift, and a daily check that disagrees with the monthly report is
 * worse than no check at all: it turns every finding into an argument about
 * which screen is right.
 */

const RETAIL_BRANCH = process.env.ODG_RETAIL_BRANCH || "01";
const RETAIL_AR_GROUP = "101";

/**
 * The Vientiane calendar date of a timestamp.
 *
 * doc_date arrives as midnight Vientiane expressed in UTC — 2026-08-12 comes
 * back as 2026-08-11T17:00:00Z — so slicing the ISO string moves half the
 * month's sales to the previous day.
 */
const LAO_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Vientiane",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const laoDate = (value) => (value ? LAO_DATE.format(new Date(value)) : "");

/** Scored lines for a whole month, shared by every day of it. */
function monthLines(year, month, bypass) {
  return swrCache(
    `incentive-points:v2:${year}|${month}`,
    { ttl: 300_000, staleTtl: 24 * 3_600_000, bypass },
    () => rows(POINTS_SQL, [year, month, year, month, RETAIL_BRANCH, RETAIL_AR_GROUP]),
  );
}

/**
 * Who sold each bill, by name.
 *
 * The scoring query carries only the employee code, which is enough to pay the
 * right person and useless for reading a screen. It is resolved per bill rather
 * than per code so an unresolved seller still shows the spelling that failed —
 * that spelling is the fix, and a row saying only "—" hides it.
 */
async function sellersByBill(docNos) {
  if (!docNos.length) return new Map();
  const list = await rows(
    `SELECT d.doc_no,
            btrim(d.salename) AS salename,
            COALESCE(a.employee_code, e.employee_code) AS employee_code,
            COALESCE(NULLIF(btrim(named.fullname_lo), ''), NULLIF(btrim(e.fullname_lo), '')) AS full_name
       FROM public.odg_sale_detail d
       LEFT JOIN public.app_incentive_sale_alias a ON btrim(a.salename) = btrim(d.salename)
       LEFT JOIN public.odg_employee e ON btrim(e.fullname_lo) = btrim(d.salename)
       LEFT JOIN public.odg_employee named ON named.employee_code = a.employee_code
      WHERE d.doc_no = ANY(%s) AND d.branch_code = %s AND d.argroup_main = %s
      GROUP BY 1, 2, 3, 4`,
    [docNos, RETAIL_BRANCH, RETAIL_AR_GROUP],
  ).catch(() => []);

  const byDoc = new Map();
  for (const row of list) {
    const docNo = String(row.doc_no);
    const salename = String(row.salename || "").trim();
    const code = String(row.employee_code || "").trim();
    const seen = byDoc.get(docNo);
    // A bill written under two spellings keeps both, rather than picking one.
    if (seen && seen.salename && salename && !seen.salename.includes(salename)) {
      seen.salename = `${seen.salename} / ${salename}`;
      continue;
    }
    if (seen) continue;
    byDoc.set(docNo, {
      salename,
      employee_code: code || null,
      name: String(row.full_name || "").trim() || salename || "—",
    });
  }
  return byDoc;
}

/** The four dimensions a point rule is keyed by, as one string. */
const dimensionKey = (row) =>
  `${row.pcat}|${String(row.brand || "").trim()}|${row.design_token ?? ""}|${row.size_token ?? ""}`;

const middle = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * A rate far off what the same band pays everywhere else.
 *
 * A rule typed as 30 instead of 3 pays ten times over and looks entirely
 * normal on the bill — nothing else in the report would ever question it. The
 * comparison is within one category and band across brands, which is where
 * rates are genuinely close; comparing across categories would flag every
 * television for out-earning a fan.
 */
function outlierCheck(dayLines, monthly) {
  const peers = new Map();
  for (const row of monthly) {
    if (!row.pcat || !Number(row.unit_points)) continue;
    const key = `${row.pcat}|${row.size_token ?? ""}`;
    if (!peers.has(key)) peers.set(key, []);
    peers.get(key).push(Number(row.unit_points));
  }

  const flagged = [];
  for (const row of dayLines) {
    const unit = Number(row.unit_points || 0);
    if (!row.pcat || unit <= 0) continue;
    const sample = peers.get(`${row.pcat}|${row.size_token ?? ""}`) ?? [];
    // Three comparable lines is the least that can say what "normal" is here.
    if (sample.length < 3) continue;
    const median = middle(sample);
    if (!median) continue;
    const ratio = unit / median;
    if (ratio <= 3 && ratio >= 1 / 3) continue;
    flagged.push({
      doc_no: String(row.doc_no || "—"),
      item_code: String(row.item_code || ""),
      item_name: String(row.item_name || ""),
      dimension: dimensionKey(row).replace(/\|/g, " / "),
      unit_points: unit,
      median,
      ratio,
    });
  }
  return flagged;
}

/**
 * Rule dimensions sold today for the first time in the recent past.
 *
 * A brand or a band nobody has sold before is where the next missing rule comes
 * from, and it shows up here a day before it shows up as an unpaid bonus.
 */
function newDimensions(dayLines, history, day) {
  const seen = new Set();
  for (const row of history) {
    if (!row.pcat) continue;
    if (laoDate(row.doc_date) >= day) continue;
    seen.add(dimensionKey(row));
  }
  const found = new Map();
  for (const row of dayLines) {
    if (!row.pcat) continue;
    const key = dimensionKey(row);
    if (seen.has(key) || found.has(key)) continue;
    found.set(key, {
      dimension: key.replace(/\|/g, " / "),
      category_code: row.pcat,
      brand_code: String(row.brand || "").trim(),
      design_token: row.design_token ?? "",
      size_token: row.size_token ?? "",
      qty: 0,
      points: 0,
      has_rule: row.configured_points != null,
    });
  }
  for (const row of dayLines) {
    const entry = found.get(dimensionKey(row));
    if (!entry) continue;
    entry.qty += Number(row.qty || 0);
    entry.points += Number(row.points || 0);
  }
  return [...found.values()].sort((left, right) => right.qty - left.qty);
}

function buildDay(dayLines, monthly, history, day, sellerByBill) {
  const sellerOf = (docNo) => sellerByBill.get(String(docNo)) ?? { salename: "", employee_code: null, name: "—" };
  // Sold inside the scheme with no rule to price it — the check that costs
  // someone their bonus if it goes unanswered.
  const noRule = dayLines.filter(
    (row) => row.pcat && Number(row.points || 0) === 0 && row.configured_points == null,
  );
  // Points that landed on nobody: the seller's name never resolved to a code.
  const noSeller = dayLines.filter((row) => !String(row.employee_code ?? "").trim());

  const bills = new Map();
  for (const row of dayLines) {
    const docNo = String(row.doc_no || "—");
    const who = sellerOf(docNo);
    const bill = bills.get(docNo) || {
      doc_no: docNo,
      doc_date: row.doc_date,
      employee_code: String(row.employee_code ?? "").trim() || null,
      seller: who.name,
      salename: who.salename,
      qty: 0,
      amount: 0,
      points: 0,
      flags: [],
      lines: [],
    };
    const isNoRule = Boolean(row.pcat) && Number(row.points || 0) === 0 && row.configured_points == null;
    const isNoSeller = !String(row.employee_code ?? "").trim();
    bill.qty += Number(row.qty || 0);
    bill.amount += Number(row.amount || 0);
    bill.points += Number(row.points || 0);
    if (isNoRule && !bill.flags.includes("no_rule")) bill.flags.push("no_rule");
    if (isNoSeller && !bill.flags.includes("no_seller")) bill.flags.push("no_seller");
    bill.lines.push({
      item_code: String(row.item_code || ""),
      item_name: String(row.item_name || ""),
      category_name: String(row.category_name || "-"),
      pcat: row.pcat ?? null,
      brand: String(row.brand || "").trim(),
      qty: Number(row.qty || 0),
      amount: Number(row.amount || 0),
      price: Number(row.price || 0),
      unit_points: Number(row.unit_points || 0),
      points: Number(row.points || 0),
      in_scheme: Boolean(row.pcat),
      no_rule: isNoRule,
      rule: {
        category_code: row.pcat ?? null,
        brand_code: String(row.brand || "").trim() || null,
        design_token: row.design_token ?? "",
        size_token: row.size_token ?? "",
      },
    });
    bills.set(docNo, bill);
  }

  const outliers = outlierCheck(dayLines, monthly);
  const outlierBills = new Set(outliers.map((row) => row.doc_no));
  for (const bill of bills.values()) {
    if (outlierBills.has(bill.doc_no)) bill.flags.push("outlier");
  }

  const fresh = newDimensions(dayLines, history, day);
  const freshKeys = new Set(fresh.map((row) => row.dimension));
  for (const bill of bills.values()) {
    const hit = bill.lines.some((line) =>
      line.pcat && freshKeys.has(`${line.pcat} / ${line.brand} / ${line.rule.design_token} / ${line.rule.size_token}`),
    );
    if (hit) bill.flags.push("new_dimension");
  }

  // The sellers of the day, so "twelve bills and no points" is visible without
  // opening any of them.
  const sellers = new Map();
  for (const row of dayLines) {
    const code = String(row.employee_code ?? "").trim();
    const who = sellerOf(row.doc_no);
    // Unresolved sellers are kept apart by the spelling on the bill: two names
    // nobody matched are two people, and merging them into one "—" row would
    // say a single ghost sold everything.
    const key = code || `name:${who.salename || "—"}`;
    const seller = sellers.get(key) || {
      employee_code: code || null,
      name: code ? who.name : (who.salename || "—"),
      bills: new Set(),
      qty: 0,
      amount: 0,
      points: 0,
    };
    seller.bills.add(String(row.doc_no || ""));
    seller.qty += Number(row.qty || 0);
    seller.amount += Number(row.amount || 0);
    seller.points += Number(row.points || 0);
    sellers.set(key, seller);
  }

  const list = [...bills.values()].sort(
    (left, right) => right.amount - left.amount || left.doc_no.localeCompare(right.doc_no),
  );

  return {
    date: day,
    totals: {
      bills: list.length,
      lines: dayLines.length,
      qty: dayLines.reduce((sum, row) => sum + Number(row.qty || 0), 0),
      amount: dayLines.reduce((sum, row) => sum + Number(row.amount || 0), 0),
      points: dayLines.reduce((sum, row) => sum + Number(row.points || 0), 0),
    },
    checks: {
      no_rule: {
        lines: noRule.length,
        qty: noRule.reduce((sum, row) => sum + Number(row.qty || 0), 0),
        amount: noRule.reduce((sum, row) => sum + Number(row.amount || 0), 0),
        items: noRule.map((row) => ({
          doc_no: String(row.doc_no || "—"),
          item_code: String(row.item_code || ""),
          item_name: String(row.item_name || ""),
          dimension: dimensionKey(row).replace(/\|/g, " / "),
          qty: Number(row.qty || 0),
          amount: Number(row.amount || 0),
          rule: {
            category_code: row.pcat ?? null,
            brand_code: String(row.brand || "").trim() || null,
            design_token: row.design_token ?? "",
            size_token: row.size_token ?? "",
          },
        })),
      },
      no_seller: {
        lines: noSeller.length,
        qty: noSeller.reduce((sum, row) => sum + Number(row.qty || 0), 0),
        amount: noSeller.reduce((sum, row) => sum + Number(row.amount || 0), 0),
        points: noSeller.reduce((sum, row) => sum + Number(row.points || 0), 0),
        // Grouped by the spelling that failed to resolve, since that spelling
        // is what has to be added to the alias table to fix every bill at once.
        items: [...noSeller.reduce((map, row) => {
          const who = sellerOf(row.doc_no);
          const name = who.salename || "—";
          const entry = map.get(name) ?? { salename: name, bills: [], qty: 0, amount: 0 };
          const docNo = String(row.doc_no || "—");
          if (!entry.bills.includes(docNo)) entry.bills.push(docNo);
          entry.qty += Number(row.qty || 0);
          entry.amount += Number(row.amount || 0);
          return map.set(name, entry);
        }, new Map()).values()].sort((left, right) => right.bills.length - left.bills.length),
      },
      new_dimension: { lines: fresh.length, items: fresh },
      outlier: { lines: outliers.length, items: outliers },
    },
    sellers: [...sellers.values()]
      .map((row) => ({ ...row, bills: row.bills.size }))
      .sort((left, right) => right.points - left.points || right.amount - left.amount),
    bills: list,
  };
}

export async function GET(request) {
  try {
    if (!getCurrentUser(request)) {
      return NextResponse.json({ success: false, message: "unauthorized" }, { status: 401 });
    }

    const sp = request.nextUrl.searchParams;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.get("date") || "")
      ? sp.get("date")
      : laoDate(new Date());
    const [year, month] = day.split("-").map(Number);
    const bypass = sp.get("nocache") === "1";
    // The scoring query reads the bracket table; make sure it exists first.
    await ensurePriceBands();

    // The month holds today's lines; the month before it is what makes "first
    // seen" mean something on the 1st, when this month has no history yet.
    const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
    const [monthly, earlier] = await Promise.all([
      monthLines(year, month, bypass),
      monthLines(previous.year, previous.month, false).catch(() => []),
    ]);

    const dayLines = monthly.filter((row) => laoDate(row.doc_date) === day);
    const sellerByBill = await sellersByBill([...new Set(dayLines.map((row) => String(row.doc_no || "")))]);
    const data = buildDay(dayLines, monthly, [...earlier, ...monthly], day, sellerByBill);

    return NextResponse.json({
      success: true,
      data: { ...data, meta: { branch: RETAIL_BRANCH, year, month } },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
