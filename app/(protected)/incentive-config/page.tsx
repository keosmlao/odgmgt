"use client";

import { Fragment, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Check, CopyPlus, Cpu, ListTree, Plus, RefreshCw, RotateCcw, SlidersHorizontal, Trash2, TriangleAlert, X } from "lucide-react";
import Select from "react-select";
import api from "@/service/api";
import { useLanguage } from "@/context/LanguageContext";

type Cell = {
  id: number;
  points: number;
  effective_from: string;
  effective_to: string;
  /** Written FOR this month, rather than showing through from a longer rule. */
  own_month: boolean;
  /** Top of the band this rate covers; null is the open top. */
  max_value: number | null;
  band_kind: "size" | "price";
};
type Sale = { qty: number; amount: number; points: number };
type GridRow = {
  design: string;
  brand: string;
  cells: Record<string, Cell>;
  sales: Record<string, Sale>;
  qty: number;
  amount: number;
  /** Sales value in this row that scored nothing — why the row is worth opening. */
  unscored: number;
};
type Band = { token: string; max_value: number | null; kind: "size" | "price" };
type Category = {
  code: string;
  label: string;
  bands: Band[];
  rows: GridRow[];
  designs: string[];
  brands: string[];
};
/**
 * What a point is finally worth, and what scales it.
 *
 * The ladders decide how many POINTS a sale earns; these decide what a point
 * PAYS. Setting a band to 12 is choosing a payout, so the rate and the
 * multipliers belong on the same screen as the band.
 */
type Config = {
  base_amount: number;
  currency_code: string;
  low_max_pct: number;
  standard_max_pct: number;
  low_multiplier: number;
  standard_multiplier: number;
  high_multiplier: number;
  commission_base: number;
  commission_min_pct: number;
  commission_pivot_pct: number;
  commission_round_step: number;
};
type Payload = { year: number; month: number; categories: Category[]; config: Config | null };
/**
 * One product the month's sales were run through, and the band that caught it.
 *
 * `matched` false is the finding worth having: the product sold, and no band of
 * its brand and design covered the measurement it carries.
 */
type MatchItem = {
  brand: string;
  design: string;
  item_code: string;
  item_name: string;
  /** The ERP's own wording, beside the number derived from it. */
  size_name: string;
  design_name: string;
  measure: number | null;
  /** Ceiling of the band that caught it; null is the open top, or no band. */
  rule_max: number | null;
  rule_band: string | null;
  rule_kind: "size" | "price" | null;
  matched: boolean;
  unit_points: number;
  qty: number;
  amount: number;
  points: number;
  bills: number;
};
type MatchData = {
  items: MatchItem[];
  totals: {
    items: number; qty: number; amount: number; points: number;
    unmatched: number; unmatchedAmount: number;
  };
};
/** The ERP masters a rule may be keyed by. */
type Options = {
  brands: { code: string; label: string }[];
  /** Product categories, each carrying the point group a rule is stored under. */
  categories: { category_code: string; pointmap_category: string; sda_subtype: string | null; label: string }[];
  designs: Record<string, { token: string; label: string }[]>;
};

const MONTHS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];

/**
 * Where the chosen month is remembered.
 *
 * Configuring a scheme means leaving this screen and coming back — to the
 * reward report, to a bill, to yesterday's audit — and being returned to the
 * current month every time is how an edit ends up written against the wrong
 * one. The key is shared rather than page-specific so the other incentive
 * screens can settle on the same month as they adopt it.
 */
const PERIOD_KEY = "odg_incentive_period";
/**
 * And the category, remembered the same way and for the same reason.
 *
 * Own key, not a third field on the period: the month is shared with the other
 * incentive screens, while which point group is being configured means nothing
 * outside this one.
 */
const CATEGORY_KEY = "odg_incentive_category";
const rowKey = (row: { design: string; brand: string }) => `${row.design} ${row.brand}`;

/**
 * Where the band above a ceiling starts: one step of 0.1 past it.
 *
 * The ceiling is exact — 11.9 belongs to the band written ≤ 11.9 — so the band
 * above it opens at 12.0. Writing ceilings as x.9 therefore makes a ladder read
 * back in whole numbers ("6 – 11.9" then "12 – 14.9"), which is how the scheme
 * is written on paper. Rounded to one decimal because 11.9 + 0.1 is not 12 in
 * binary floating point.
 */
const nextFloor = (max: number) => Math.round((max + 0.1) * 10) / 10;

/** The inverse: the ceiling of the band that stops just under a floor. */
const prevCeiling = (floor: number) => Math.round((floor - 0.1) * 10) / 10;

/**
 * A band read as the range it actually covers.
 *
 * Only the ceiling is stored, because the floor is never a separate decision —
 * it is wherever the band below stops. Spelling it out is what makes a ladder
 * readable, and it reads back exactly as the scheme was written on paper:
 * "ຕ່ຳກວ່າ 6 · 6 – 11 · 12 – 14 · 15 – 19 · 20 ຂຶ້ນໄປ".
 */
const bandLabel = (max: number | null, below: number | null) => {
  if (max === null) return below === null ? "ທັງໝົດ" : `${nextFloor(below)} ຂຶ້ນໄປ`;
  if (below === null) return `ບໍ່ເກີນ ${max}`;
  return `${nextFloor(below)} – ${max}`;
};

/**
 * The name a new band is filed under.
 *
 * Bands used to be named by hand ("12-14") and matched by that name. They are
 * matched by their ceiling now, so the name is only a label — deriving it from
 * the ceiling keeps it honest, and keeps it unique within the row.
 */
const tokenFor = (max: number | null) => (max === null ? "∞" : `<=${max}`);

type Choice = { value: string; label: string };

/**
 * react-select, wearing the app's own tokens.
 *
 * The lists it stands in for are long — 745 brands — and a native dropdown of
 * that length is scrolled, not searched. Everything here is a colour or a
 * radius the rest of the screen already uses; nothing changes its behaviour.
 */
const selectStyles = {
  control: (base: Record<string, unknown>) => ({
    ...base,
    minHeight: "2.1rem",
    borderRadius: "var(--r-sm)",
    borderColor: "var(--line)",
    background: "var(--surface)",
    boxShadow: "none",
    fontSize: 12.5,
    ":hover": { borderColor: "var(--brand)" },
  }),
  valueContainer: (base: Record<string, unknown>) => ({ ...base, padding: "0 0.5rem" }),
  singleValue: (base: Record<string, unknown>) => ({ ...base, color: "var(--ink)" }),
  input: (base: Record<string, unknown>) => ({ ...base, color: "var(--ink)" }),
  placeholder: (base: Record<string, unknown>) => ({ ...base, color: "var(--muted)" }),
  menu: (base: Record<string, unknown>) => ({
    ...base,
    zIndex: 60,
    fontSize: 12.5,
    background: "var(--surface)",
    border: "1px solid var(--line)",
    borderRadius: "var(--r-sm)",
  }),
  option: (base: Record<string, unknown>, state: { isSelected: boolean; isFocused: boolean }) => ({
    ...base,
    background: state.isSelected ? "var(--brand-deep)" : state.isFocused ? "var(--brand-soft)" : "transparent",
    color: state.isSelected ? "#fff" : "var(--ink)",
  }),
  // The dialog clips its own overflow, and a list of 745 brands is taller than
  // the dialog is — so the menu is rendered against the document instead of
  // inside the card that would cut it off.
  menuPortal: (base: Record<string, unknown>) => ({ ...base, zIndex: 9999 }),
};

/**
 * The brand picker takes several at once.
 *
 * A scheme is written for brands in groups — the sheet prices "LG/SAMSUNG" on
 * one line — but a rule is keyed by ONE brand, because that is what a sale
 * carries. Choosing several and writing a row for each keeps both true: the
 * scheme is entered the way it was decided, and every brand still gets its own
 * rule that can later be changed on its own.
 */
function MultiPicker({ options, value, onChange, placeholder }: {
  options: Choice[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder: string;
}) {
  return (
    <Select<Choice, true>
      isMulti
      styles={selectStyles}
      placeholder={placeholder}
      options={options}
      value={options.filter((option) => value.includes(option.value))}
      onChange={(choices) => onChange(choices.map((choice) => choice.value))}
      menuPortalTarget={typeof document === "undefined" ? null : document.body}
      menuPosition="fixed"
      maxMenuHeight={220}
      closeMenuOnSelect={false}
      noOptionsMessage={() => "—"}
    />
  );
}

/** One place for the props all three pickers share. */
function Picker({ options, value, onChange, disabled, placeholder }: {
  options: Choice[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder: string;
}) {
  return (
    <Select<Choice>
      styles={selectStyles}
      isClearable
      isDisabled={disabled}
      placeholder={placeholder}
      options={options}
      value={options.find((option) => option.value === value) ?? null}
      onChange={(choice) => onChange(choice?.value ?? "")}
      menuPortalTarget={typeof document === "undefined" ? null : document.body}
      menuPosition="fixed"
      maxMenuHeight={220}
      noOptionsMessage={() => "—"}
    />
  );
}

const fmt = (value: number) =>
  Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** Five steps of one ramp, normalised per category so rows compare. */
function heat(points: number, top: number) {
  if (!(points > 0)) return "is-zero";
  const step = Math.ceil((points / (top || 1)) * 5);
  return `heat-${Math.min(5, Math.max(1, step))}`;
}

export default function IncentiveConfigPage() {
  const { t } = useLanguage();
  const now = new Date();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [data, setData] = useState<Payload | null>(null);
  const [options, setOptions] = useState<Options>({ brands: [], categories: [], designs: {} });
  const [pick, setPick] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  /** The band being typed into: "design brand token". */
  const [editing, setEditing] = useState("");
  /** Both halves of the band under the cursor: its rate, and its ceiling. */
  const [draft, setDraft] = useState("");
  const [draftMax, setDraftMax] = useState("");
  /** The row having a band added to it, and the two values being typed. */
  const [adding, setAdding] = useState("");
  const [newMax, setNewMax] = useState("");
  const [newPoints, setNewPoints] = useState("");
  /**
   * The result of running the month through the ladders, and how it is being
   * read: narrowed to one row, filtered by name, or cut to the gaps alone.
   */
  const [match, setMatch] = useState<MatchData | null>(null);
  const [scope, setScope] = useState<{ brand: string; design: string } | null>(null);
  const [find, setFind] = useState("");
  const [gapsOnly, setGapsOnly] = useState(false);
  /**
   * The "add" dialog: a whole row is described before anything is written.
   *
   * A row is only meaningful once it carries a ladder — a brand with no bands
   * prices nothing — so the dialog collects the category, the design, the brand
   * AND every band, and writes them together. Nothing half-made reaches the
   * database, and nothing half-made appears in the list.
   */
  const [form, setForm] = useState<null | {
    /** The product category chosen; the point group is read from it. */
    itemCategory: string;
    design: string;
    /** One row is written per brand chosen. */
    brands: string[];
    /**
     * Where the ladder starts. Empty means 0 — most do — but a scheme that
     * only pays from 12 kg up says so here, and everything under it is written
     * as an explicit 0 band rather than left out. See submitForm.
     */
    floor: string;
    bands: { max: string; points: string }[];
  }>(null);

  /** Restore the month and category last worked on, before the first load runs. */
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PERIOD_KEY) || "null");
      if (saved && saved.year && saved.month) {
        setYear(String(saved.year));
        setMonth(String(saved.month));
      }
    } catch {
      localStorage.removeItem(PERIOD_KEY);
    }
    setPick(localStorage.getItem(CATEGORY_KEY) || "");
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    localStorage.setItem(PERIOD_KEY, JSON.stringify({ year, month }));
  }, [restored, year, month]);

  const load = async (fresh = false) => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/incentive-points", {
        params: { year, month, ...(fresh ? { nocache: 1 } : {}) },
      });
      if (res.data?.success) setData(res.data.data);
      else setError(res.data?.message || t("app.error"));
    } catch {
      setError(t("app.error"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Waiting for the restore avoids loading this month and then the saved one.
    if (!restored) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored, year, month]);

  /** The masters change with the catalogue, not with the month. */
  useEffect(() => {
    api.get("/incentive-points/options")
      .then((res) => res.data?.success && setOptions(res.data.data))
      .catch(() => setOptions({ brands: [], categories: [], designs: {} }));
  }, []);

  /**
   * Every point group the payload carries, each one a tab.
   *
   * This screen used to draw one category and hide the rest, which made a rule
   * written for any other one invisible the moment the page was reloaded — the
   * row was in the database and nowhere on screen. The payload has always
   * carried them all, so they are all reachable.
   */
  const shown = useMemo(() => data?.categories ?? [], [data]);
  const category = useMemo(
    () => shown.find((item) => item.code === pick) || shown[0] || null,
    [shown, pick],
  );

  /** How many rows of a category actually carry rates — what its tab counts. */
  const ruled = (item: Category) => item.rows.filter((row) => Object.keys(row.cells).length > 0).length;

  /** The group's name in the reader's language, or whatever the ERP calls it. */
  const catLabel = (item: Category) => {
    const key = `incentiveCfg.cat${item.code}`;
    const name = t(key);
    return name === key ? item.label : name;
  };

  /** Come back to the group last configured, not to whichever sorts first. */
  useEffect(() => {
    if (!restored || !category) return;
    localStorage.setItem(CATEGORY_KEY, category.code);
  }, [restored, category]);

  /**
   * Only rows that carry rates, plus any row just added on screen.
   *
   * Every row keeps its OWN ladder now, so there is no shared header for rows
   * to line up against — and a row with no rates has nothing to draw. Its brand
   * and design are still offered by the row editor below.
   */
  const gridRows = useMemo(
    () => (category?.rows ?? []).filter((row) => Object.keys(row.cells).length > 0),
    [category],
  );

  /**
   * Those rows, gathered by design.
   *
   * A ladder is read against its neighbours — SAMSUNG's Front Load beside LG's
   * and HISENSE's — and a list ordered only by unpaid sales interleaves the
   * designs, so the three rows worth comparing end up scattered down the card.
   * Stating the design once, above the rows that share it, is what makes them
   * comparable; the groups themselves stay in order of the money at stake, so
   * the design worth opening is still the one at the top.
   */
  const groups = useMemo(() => {
    const byDesign = new Map<string, GridRow[]>();
    for (const row of gridRows) {
      byDesign.set(row.design, [...(byDesign.get(row.design) ?? []), row]);
    }
    return [...byDesign.entries()]
      .map(([design, rows]) => ({
        design,
        rows,
        unscored: rows.reduce((sum, row) => sum + row.unscored, 0),
      }))
      .sort((left, right) => right.unscored - left.unscored || left.design.localeCompare(right.design));
  }, [gridRows]);

  const top = useMemo(
    () => Math.max(0, ...gridRows.flatMap((row) => Object.values(row.cells).map((cell) => cell.points))),
    [gridRows],
  );

  /**
   * A row's OWN ladder: the ceilings it has rates for, smallest first.
   *
   * Not the category's ceilings. Rows here disagree about where the steps are —
   * one row is written 11.9 / 14.9 / ∞ and its neighbour 11 / 14 / 19 / ∞ — so
   * drawing the union gave every row eight or nine steps, nearly all of them
   * empty, and buried the three that the row actually pays. A ceiling a row is
   * missing is added to that row with `+`.
   */
  const ladderOf = (row: GridRow, kind: "size" | "price"): Band[] =>
    Object.entries(row.cells)
      .map(([token, cell]) => ({ token, max_value: cell.max_value, kind: cell.band_kind }))
      .filter((band) => band.kind === kind)
      .sort((left, right) => (left.max_value ?? Infinity) - (right.max_value ?? Infinity));

  /**
   * A row can be priced by TWO different measurements, and they are two
   * different ladders.
   *
   * Audio-visual is the case that proves it: a television is banded by its
   * screen in inches, everything else in the group by its price. Both sets of
   * rules live on the same brand, and sorting them together by their ceiling
   * produces a ladder that is not merely ugly but false — an inch band of 74
   * followed by a price band of 10000 reads as the range "74.1 – 10000", and
   * the open top of the INCH ladder ends up captioned as everything above
   * 20000 kip. The scoring query never confuses the two (it matches on
   * band_kind), so the screen must not either.
   */
  const KINDS: ("size" | "price")[] = ["size", "price"];

  /**
   * The columns a design's grid is drawn on: every ceiling any of its brands
   * uses, once, in order.
   *
   * This is the whole reason the rows are gathered by design first. Taken over
   * the CATEGORY the union was eight or nine ceilings and nearly every cell was
   * empty, which is what drove the ladders apart into their own rows in the
   * first place. Taken over one design the brands nearly agree — Front Load is
   * five ceilings for three brands — so the column a brand is missing is a real
   * finding rather than noise, and what SAMSUNG pays at 12 kg sits directly
   * above what LG pays at 12 kg.
   *
   * One grid per measurement, never one shared: a ceiling of 34 is 34 inches on
   * the size ladder and 34 kip on the price one.
   */
  const lanesOf = (rows: GridRow[]) =>
    KINDS.map((kind) => {
      const ceilings = new Map<string, number | null>();
      for (const row of rows) {
        for (const band of ladderOf(row, kind)) ceilings.set(String(band.max_value), band.max_value);
      }
      return {
        kind,
        ceilings: [...ceilings.values()].sort((left, right) => (left ?? Infinity) - (right ?? Infinity)),
      };
    }).filter((lane) => lane.ceilings.length > 0);

  /**
   * Write a band where the editor now says it is: both its ceiling and its rate.
   *
   * The ceiling is the half that MOVES a rule rather than changes it — a rule is
   * filed under the ceiling it covers, so 11.9 becoming 12.9 is a new rule at
   * the new ceiling and the old one gone. The new one is written FIRST, so a
   * move interrupted halfway leaves the band priced twice at worst, never
   * unpriced.
   */
  const saveBand = async (row: GridRow, band: Band, rawMax: string, rawPoints: string) => {
    if (!category) return;
    const maxText = rawMax.trim();
    const max = maxText === "" ? null : Number(maxText);
    if (maxText !== "" && !(Number.isFinite(max) && (max as number) > 0)) {
      setError(t("incentiveCfg.badCeiling"));
      return;
    }
    const pointsText = rawPoints.trim();
    const points = Number(pointsText === "" ? "0" : pointsText);
    if (!Number.isFinite(points) || points < 0) {
      setError(t("incentiveCfg.badPoints"));
      return;
    }
    // A ceiling is what a band IS, so no two bands of a row may share one —
    // the second would quietly overwrite the first and the ladder would lose a
    // step nobody asked it to lose. Two open tops are the same clash. Within
    // ONE measurement only: 34 inches and 34 kip are not the same band.
    if (ladderOf(row, band.kind).some((other) => other.token !== band.token && other.max_value === max)) {
      setError(t("incentiveCfg.dupCeiling"));
      return;
    }

    const address = {
      category_code: category.code,
      brand_code: row.brand,
      design_token: row.design,
      year, month,
    };
    // Only a real change of ceiling re-files the rule. Saving a rate alone
    // keeps whatever the band is already called, including the hand-written
    // names ("6-11") that predate ceilings.
    const moved = max !== band.max_value;
    setBusy(`${rowKey(row)} ${band.token}`);
    setError("");
    try {
      await api.post("/incentive-points", {
        ...address,
        size_token: moved ? tokenFor(max) : band.token,
        max_value: max,
        band_kind: band.kind,
        points,
      });
      if (moved && row.cells[band.token]) {
        await api.delete("/incentive-points", { data: { ...address, size_token: band.token } });
      }
      setEditing("");
      setAdding("");
      setNewMax("");
      setNewPoints("");
      await load(true);
    } catch (err: unknown) {
      const response = (err as { response?: { data?: { message?: string } } }).response;
      setError(response?.data?.message || t("app.error"));
    } finally {
      setBusy("");
    }
  };

  /**
   * Take one band out of a row, from this month onward.
   *
   * Removing a band is not the same as setting it to zero, and the ladder has
   * to be able to say both: a zero pays nothing on purpose, while a band that
   * is gone hands its sales up to the band above it. Confirmed, because the
   * second of those silently changes what the neighbouring band pays for.
   */
  const removeBand = async (row: GridRow, band: Band, label: string) => {
    if (!category || busy) return;
    if (!window.confirm(`${t("incentiveCfg.confirmBand")} ${label}`)) return;
    setBusy(`${rowKey(row)} ${band.token}`);
    setError("");
    try {
      await api.delete("/incentive-points", {
        data: {
          category_code: category.code,
          brand_code: row.brand,
          design_token: row.design,
          size_token: band.token,
          year, month,
        },
      });
      setEditing("");
      await load(true);
    } catch (err: unknown) {
      const response = (err as { response?: { data?: { message?: string } } }).response;
      setError(response?.data?.message || t("app.error"));
    } finally {
      setBusy("");
    }
  };

  /**
   * Add a ceiling to ONE ladder of ONE row.
   *
   * The kind comes from the ladder the `+` was pressed in, not from the
   * category: a category can price by both, and a band added to the inch ladder
   * that is written as a price would never be reached by any sale.
   */
  const addBand = async (row: GridRow, kind: "size" | "price") => {
    const text = newMax.trim();
    const max = text === "" ? null : Number(text);
    if (text !== "" && !Number.isFinite(max)) { setError(t("incentiveCfg.badCeiling")); return; }
    const existing = ladderOf(row, kind).find((band) => band.max_value === max);
    if (existing) { setError(t("incentiveCfg.dupCeiling")); return; }
    await saveBand(row, { token: tokenFor(max), max_value: max, kind }, newMax, newPoints);
  };

  /** Remove rates from this month onward: one row, or the whole category. */
  const wipe = async (target: { row?: GridRow; all?: boolean }) => {
    if (!category || busy) return;
    const what = target.all
      ? t("incentiveCfg.confirmAll")
      : `${t("incentiveCfg.confirmRow")} ${target.row?.design || "—"} · ${target.row?.brand}`;
    if (!window.confirm(what)) return;
    setBusy(target.all ? "wipe" : rowKey(target.row!));
    setError("");
    try {
      await api.delete("/incentive-points", {
        data: target.all
          ? { category_code: category.code, scope: "all", year, month }
          : { category_code: category.code, brand_code: target.row!.brand, design_token: target.row!.design, year, month },
      });
      await load(true);
    } catch (err: unknown) {
      const response = (err as { response?: { data?: { message?: string } } }).response;
      setError(response?.data?.message || t("app.error"));
    } finally {
      setBusy("");
    }
  };

  /**
   * Run the month's sales through the ladders as they now stand.
   *
   * A ladder can be read on this screen and still be wrong, because what it
   * pays turns on a number nobody types here — the size or price the ERP
   * carries on the sale. A band written to 11.9 where the models are 12.0 kg
   * looks perfectly ordinary and pays nothing all month. This is the answer to
   * the only question that settles it: which product landed in which band.
   *
   * Always recomputed rather than read from the cache — a scheme is processed
   * precisely BECAUSE it was just changed.
   */
  const fetchMatch = async (row?: GridRow) => {
    if (!category) return;
    const res = await api.get("/incentive-points/match", {
      params: { year, month, category: category.code, nocache: 1 },
    });
    if (!res.data?.success) {
      setError(res.data?.message || t("app.error"));
      return;
    }
    setMatch(res.data.data);
    setScope(row ? { brand: row.brand, design: row.design } : null);
    setFind("");
    setGapsOnly(false);
  };

  const runProcess = async (row?: GridRow) => {
    if (!category || busy) return;
    setBusy("process");
    setError("");
    try {
      await fetchMatch(row);
    } catch (err: unknown) {
      const response = (err as { response?: { data?: { message?: string } } }).response;
      setError(response?.data?.message || t("app.error"));
    } finally {
      setBusy("");
    }
  };

  /**
   * The band that caught a product, named the way the chips name it.
   *
   * Read off the row's own ladder rather than printed from the ceiling alone,
   * so the answer here — "12 – 14.9" — is the very chip on screen above, and
   * not a second way of writing the same band.
   */
  const hitLabel = (item: MatchItem) => {
    if (!item.matched) return t("incentiveCfg.noBand");
    const row = (category?.rows ?? []).find(
      (candidate) => candidate.brand === item.brand && candidate.design === item.design,
    );
    const ladder = row ? ladderOf(row, item.rule_kind ?? "size") : [];
    const at = ladder.findIndex((band) => band.max_value === item.rule_max);
    if (at < 0) return item.rule_max === null ? bandLabel(null, 0) : `≤ ${item.rule_max}`;
    return bandLabel(ladder[at].max_value, at > 0 ? ladder[at - 1].max_value : null);
  };

  /** The result, narrowed to what is being asked of it. */
  const shownItems = useMemo(() => {
    const text = find.trim().toLowerCase();
    return (match?.items ?? []).filter((item) => {
      if (scope && (item.brand !== scope.brand || item.design !== scope.design)) return false;
      if (gapsOnly && item.matched) return false;
      if (!text) return true;
      return [item.item_code, item.item_name, item.brand, item.design, item.size_name]
        .some((field) => String(field ?? "").toLowerCase().includes(text));
    });
  }, [match, scope, gapsOnly, find]);

  /**
   * Throw away every SCORE held for the month and work them out again.
   *
   * Points are never stored as a decision — they are what the rules make of the
   * month's sales, kept only in a cache so a report does not re-score a month
   * on every visit. That cache is the thing being cleared here. No rule is
   * touched: the ladders on this screen, and the ladders of every other
   * category, are exactly as they were before and after.
   *
   * Deliberately separate from the two "clear" buttons, which delete the rules
   * themselves. That distinction is the whole reason this exists: recalculating
   * and re-configuring must never be one gesture.
   */
  const recalculate = async () => {
    if (!category || busy) return;
    setBusy("recalc");
    setError("");
    try {
      await api.post("/incentive-points/match", { year, month });
      await load(true);
      await fetchMatch();
    } catch (err: unknown) {
      const response = (err as { response?: { data?: { message?: string } } }).response;
      setError(response?.data?.message || t("app.error"));
    } finally {
      setBusy("");
    }
  };

  const copyLastMonth = async () => {
    if (!category || busy) return;
    setBusy("copy");
    setError("");
    try {
      await api.put("/incentive-points", { category_code: category.code, year, month });
      await load(true);
    } catch (err: unknown) {
      const response = (err as { response?: { data?: { message?: string } } }).response;
      setError(response?.data?.message || t("app.error"));
    } finally {
      setBusy("");
    }
  };

  /** Write the whole row the dialog describes: every band, or nothing. */
  const submitForm = async () => {
    if (!form || busy) return;
    const brands = form.brands.map((brand) => brand.trim().toUpperCase()).filter(Boolean);
    if (brands.length === 0) { setError(t("incentiveCfg.needBrand")); return; }
    if (!formCategory) { setError(t("incentiveCfg.needCategory")); return; }
    const code = formCategory.pointmap_category;
    const kind = data?.categories.find((item) => item.code === code)?.bands[0]?.kind ?? "size";

    const bands = [];
    for (const band of form.bands) {
      const text = band.max.trim();
      const max = text === "" ? null : Number(text);
      if (text !== "" && !Number.isFinite(max)) { setError(t("incentiveCfg.badCeiling")); return; }
      const points = Number(band.points.trim() || "0");
      if (!Number.isFinite(points) || points < 0) { setError(t("incentiveCfg.badPoints")); return; }
      bands.push({ max, points });
    }
    if (bands.length === 0) { setError(t("incentiveCfg.needBand")); return; }
    if (bands.filter((band) => band.max === null).length > 1) { setError(t("incentiveCfg.oneOpenTop")); return; }

    /**
     * A ladder that starts above 0 is written as one that starts at 0 and pays
     * nothing until it does.
     *
     * Leaving the bottom out would not mean "earns nothing" — a rule is matched
     * by the SMALLEST ceiling that still covers the line, so a 5 kg sale under a
     * ladder beginning at 12 would find the 12–14 rule and be paid its rate. The
     * explicit 0 band is what actually stops it, and it is visible on the grid
     * afterwards, which a missing band never is.
     */
    const floorText = form.floor.trim();
    if (floorText !== "") {
      const floor = Number(floorText);
      const first = bands[0].max;
      if (!Number.isFinite(floor) || floor < 0 || (first !== null && floor > first)) {
        setError(t("incentiveCfg.badFloor"));
        return;
      }
      if (floor > 0) bands.unshift({ max: prevCeiling(floor), points: 0 });
    }
    // Ascending, with the open top last: a ladder out of order reads as one
    // thing on screen and scores as another.
    for (let index = 1; index < bands.length; index += 1) {
      const below = bands[index - 1].max;
      const here = bands[index].max;
      if (below === null || (here !== null && here <= below)) {
        setError(t("incentiveCfg.badOrder"));
        return;
      }
    }

    setBusy("form");
    setError("");
    try {
      for (const brand of brands) {
        for (const band of bands) {
          await api.post("/incentive-points", {
            category_code: code,
            brand_code: brand,
            design_token: form.design.trim(),
            size_token: tokenFor(band.max),
            max_value: band.max,
            band_kind: kind,
            points: band.points,
            year, month,
          });
        }
      }
      setPick(code);
      setForm(null);
      await load(true);
    } catch (err: unknown) {
      const response = (err as { response?: { data?: { message?: string } } }).response;
      setError(response?.data?.message || t("app.error"));
    } finally {
      setBusy("");
    }
  };

  const openForm = () => setForm({ itemCategory: "", design: "", brands: [], floor: "", bands: [{ max: "", points: "" }] });

  /** The point group behind the chosen product category. */
  const formCategory = options.categories.find((item) => item.category_code === form?.itemCategory) ?? null;

  return (
    <div className="min-h-screen">
      <header className="page-hd">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-[var(--r-md)] bg-[var(--brand-deep)] text-white">
            <SlidersHorizontal size={19} />
          </span>
          <div>
            <h1 className="page-title">{t("incentiveCfg.title")}</h1>
            <p className="page-sub">{t("incentiveCfg.subtitle")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="field-label">{t("incentiveCfg.effective")}</label>
            <div className="flex gap-1.5">
              <select className="select w-20" value={year} onChange={(event) => setYear(event.target.value)}>
                {[0, 1, 2].map((back) => {
                  const value = String(now.getFullYear() - back);
                  return <option key={value} value={value}>{value}</option>;
                })}
              </select>
              <select className="select w-20" value={month} onChange={(event) => setMonth(event.target.value)}>
                {MONTHS.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>
          </div>
          <button className="btn" onClick={() => load(true)}>
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> {t("monthSummary.refresh")}
          </button>
          {/* Beside the reload, because it is the same gesture one step further:
              reload re-reads the rules, this one runs the month's sales through
              them and reports what they caught. */}
          {/* Clear the scores and work them out again. Beside it, not merged
              into it: the rules stay exactly as they are. */}
          <button className="btn" onClick={recalculate} disabled={!!busy || !category}
                  title={t("incentiveCfg.recalcHint")}>
            <RotateCcw size={13} className={busy === "recalc" ? "animate-spin" : ""} /> {t("incentiveCfg.recalc")}
          </button>
          <button className="btn btn-primary" onClick={() => runProcess()} disabled={!!busy || !category}>
            <Cpu size={13} className={busy === "process" ? "animate-spin" : ""} /> {t("incentiveCfg.process")}
          </button>
        </div>
      </header>

      <div className="page">
        {error && (
          <div className="mb-3 rounded-[var(--r-md)] border px-3 py-2 text-[12px] font-medium"
               style={{ borderColor: "var(--neg)", background: "var(--neg-bg)", color: "var(--neg)" }}>
            {error}
          </div>
        )}

        {/* What a point is worth, beside the bands that earn them. Read-only
            here: these are set once for the scheme, not per category, and the
            ladders above are what this screen exists to change. */}
        {data?.config && (
          <div className="mb-3 grid gap-3 sm:grid-cols-3">
            <div className="card p-3.5">
              <p className="stat-label mb-1">{t("incentiveCfg.rate")}</p>
              <p className="stat-value">
                {fmt(data.config.base_amount)}{" "}
                <span className="text-sm font-semibold opacity-70">{data.config.currency_code}</span>
              </p>
              <p className="stat-sub">{t("incentiveCfg.ratePerPoint")}</p>
            </div>

            <div className="card p-3.5">
              <p className="stat-label mb-2">{t("incentiveCfg.bandTitle")}</p>
              <div className="space-y-1.5">
                {[
                  { label: t("incentiveCfg.tierLow"), range: `≤ ${Math.round(data.config.low_max_pct * 100)}%`, mul: data.config.low_multiplier, tone: "pill-neg" },
                  { label: t("incentiveCfg.tierStd"), range: `≤ ${Math.round(data.config.standard_max_pct * 100)}%`, mul: data.config.standard_multiplier, tone: "pill-warn" },
                  { label: t("incentiveCfg.tierHigh"), range: `> ${Math.round(data.config.standard_max_pct * 100)}%`, mul: data.config.high_multiplier, tone: "pill-pos" },
                ].map((tier) => (
                  <div key={tier.label} className="flex items-center justify-between gap-2 text-[12px]">
                    <span style={{ color: "var(--ink-soft)" }}>{tier.label}</span>
                    <span className="num" style={{ color: "var(--muted)" }}>{tier.range}</span>
                    <span className={`pill ${tier.tone}`}>×{fmt(tier.mul)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card p-3.5">
              <p className="stat-label mb-2">{t("incentiveCfg.commission")}</p>
              <div className="space-y-1.5 text-[12px]">
                <div className="flex justify-between">
                  <span style={{ color: "var(--ink-soft)" }}>{t("incentiveCfg.commissionBase")}</span>
                  <span className="num font-semibold">{fmt(data.config.commission_base)} {data.config.currency_code}</span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: "var(--ink-soft)" }}>{t("incentiveCfg.commissionMin")}</span>
                  <span className="num font-semibold">{Math.round(data.config.commission_min_pct * 100)}%</span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: "var(--ink-soft)" }}>{t("incentiveCfg.commissionPivot")}</span>
                  <span className="num font-semibold">{Math.round(data.config.commission_pivot_pct * 100)}%</span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: "var(--ink-soft)" }}>{t("incentiveCfg.roundStep")}</span>
                  <span className="num font-semibold">{fmt(data.config.commission_round_step)}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Which point group is being configured. The count is the number of
            rows in it that carry rates, so a group nobody has written a scheme
            for yet says so before it is opened. */}
        {shown.length > 1 && (
          <div className="tabs mb-3">
            {shown.map((item) => (
              <button
                key={item.code}
                className={`tab ${item.code === category?.code ? "is-active" : ""}`}
                onClick={() => setPick(item.code)}
              >
                {catLabel(item)}
                <span className="pill pill-muted">{ruled(item)}</span>
              </button>
            ))}
          </div>
        )}

        {category && (
          <div className="card">
            <div className="card-hd">
              <p className="page-sub min-w-0">{t("incentiveCfg.rowHint")}</p>
              <span className="ml-auto flex flex-wrap items-center gap-2">
                <button className="btn" onClick={copyLastMonth} disabled={!!busy}>
                  <CopyPlus size={13} /> {t("incentiveCfg.copyLastMonth")}
                </button>
                <button className="btn btn-ghost" onClick={() => wipe({ all: true })} disabled={!!busy}
                        style={{ color: "var(--neg)" }}>
                  <Trash2 size={13} /> {t("incentiveCfg.clearAll")}
                </button>
                <button className="btn btn-primary" onClick={openForm} disabled={!!busy}>
                  <Plus size={13} /> {t("incentiveCfg.addRow")}
                </button>
              </span>
            </div>

            {/* One block per row, under the design the row is for — the brands
                sharing a design are then read down a single column, and the
                design itself is stated once instead of on every row. */}
            <div className="card-bd-flush">
              {groups.map((group) => (
                <Fragment key={group.design || "—"}>
                  <div className="cfg-group">
                    <span>{group.design || "—"}</span>
                    <span className="pill pill-muted">{group.rows.length}</span>
                  </div>
                  {lanesOf(group.rows).map(({ kind, ceilings }) => (
                    <div className="matrix-wrap" key={kind}>
                      <table className="matrix-cfg">
                        <thead>
                          <tr>
                            {/* The corner names the measurement the columns
                                bound, when the design is priced by more than
                                one. Inches and kip never share a header. */}
                            <th className="brand-col">
                              {lanesOf(group.rows).length > 1
                                ? t(kind === "price" ? "incentiveCfg.kindPrice" : "incentiveCfg.kindSize")
                                : t("incentiveCfg.brandShort")}
                            </th>
                            {ceilings.map((max, index) => (
                              <th key={String(max)}>
                                {bandLabel(max, index > 0 ? ceilings[index - 1] : null)}
                              </th>
                            ))}
                            <th className="act-col" />
                          </tr>
                        </thead>
                        <tbody>
                          {group.rows.map((row) => {
                            const isAdding = adding === `${rowKey(row)} ${kind}`;
                            return (
                              <tr key={rowKey(row)}>
                                <td className="brand-col"><b>{row.brand}</b></td>

                                {ceilings.map((max, index) => {
                                  // A row need not have a rule at every ceiling
                                  // the design uses. Where it has none the cell
                                  // is a gap — a rate waiting to be typed, not a
                                  // rate of zero — and typing in it writes the
                                  // band as well as the rate.
                                  const band = ladderOf(row, kind).find((item) => item.max_value === max)
                                    ?? { token: tokenFor(max), max_value: max, kind };
                                  const cell = row.cells[band.token];
                                  const id = `${rowKey(row)} ${kind} ${String(max)}`;
                                  const label = bandLabel(max, index > 0 ? ceilings[index - 1] : null);
                                  const open = editing === id;
                                  const tone = [
                                    cell ? heat(cell.points, top) : "is-none",
                                    cell && !cell.own_month ? "is-inherited" : "",
                                  ].filter(Boolean).join(" ");
                                  // Enter writes both halves, Esc abandons them
                                  // both — the same contract on either field, so
                                  // it does not matter which one the typing
                                  // finished in.
                                  const keys = (event: KeyboardEvent) => {
                                    if (event.key === "Enter") saveBand(row, band, draftMax, draft);
                                    if (event.key === "Escape") setEditing("");
                                  };
                                  return (
                                    <td key={String(max)}>
                                      {open ? (
                                        /* The band opened in place: what it
                                           covers, what it pays, and the way out.
                                           Two short lines so an open cell widens
                                           the column as little as possible.
                                           Clicking away abandons the edit rather
                                           than writing half-typed numbers. */
                                        <span
                                          className="cell-edit"
                                          onBlur={(event) => {
                                            if (!event.currentTarget.contains(event.relatedTarget)) setEditing("");
                                          }}
                                        >
                                          <span className="cell-edit-row">
                                            <input
                                              className="input"
                                              placeholder="∞"
                                              inputMode="decimal"
                                              title={t("incentiveCfg.ceiling")}
                                              value={draftMax}
                                              onChange={(event) => setDraftMax(event.target.value)}
                                              onKeyDown={keys}
                                            />
                                            <input
                                              autoFocus
                                              className="input"
                                              inputMode="decimal"
                                              title={t("incentiveCfg.points")}
                                              value={draft}
                                              onChange={(event) => setDraft(event.target.value)}
                                              onKeyDown={keys}
                                            />
                                          </span>
                                          {/* Keeping the focus in the field is
                                              what lets the blur above mean
                                              "clicked away" and nothing else. */}
                                          <span className="cell-edit-act" onMouseDown={(event) => event.preventDefault()}>
                                            <button
                                              onClick={() => saveBand(row, band, draftMax, draft)}
                                              disabled={!!busy}
                                              title={t("incentiveCfg.saveBand")}
                                            >
                                              <Check size={12} />
                                            </button>
                                            <button
                                              className="is-danger"
                                              onClick={() => removeBand(row, band, label)}
                                              disabled={!!busy || !cell}
                                              title={t("incentiveCfg.deleteBand")}
                                            >
                                              <Trash2 size={12} />
                                            </button>
                                            <button onClick={() => setEditing("")} title={t("app.close")}>
                                              <X size={12} />
                                            </button>
                                          </span>
                                        </span>
                                      ) : (
                                        <button
                                          className={`cfg-cell ${tone}`}
                                          onClick={() => {
                                            if (busy) return;
                                            setEditing(id);
                                            setDraft(cell ? String(cell.points) : "");
                                            setDraftMax(max === null ? "" : String(max));
                                          }}
                                          title={`${row.brand} · ${label}\n${
                                            !cell ? t("incentiveCfg.legendNone")
                                              : cell.own_month ? t("incentiveCfg.ownMonth")
                                              : `${t("incentiveCfg.inherited")} ${cell.effective_from} → ${cell.effective_to}`
                                          }\n${t("incentiveCfg.saveHint")}`}
                                        >
                                          {cell ? cell.points : "—"}
                                        </button>
                                      )}
                                    </td>
                                  );
                                })}

                                <td className="act-col">
                                  {isAdding ? (
                                    <span className="cell-edit">
                                      <span className="cell-edit-row">
                                        <input className="input" placeholder="∞" inputMode="decimal"
                                               title={t("incentiveCfg.ceiling")}
                                               value={newMax} onChange={(event) => setNewMax(event.target.value)} />
                                        <input autoFocus className="input" inputMode="decimal"
                                               title={t("incentiveCfg.points")}
                                               value={newPoints}
                                               onChange={(event) => setNewPoints(event.target.value)}
                                               onKeyDown={(event) => event.key === "Enter" && addBand(row, kind)} />
                                      </span>
                                      <span className="cell-edit-act" onMouseDown={(event) => event.preventDefault()}>
                                        <button onClick={() => addBand(row, kind)} disabled={!!busy}
                                                title={t("incentiveCfg.addBand")}>
                                          <Check size={12} />
                                        </button>
                                        <button onClick={() => setAdding("")} title={t("app.close")}>
                                          <X size={12} />
                                        </button>
                                      </span>
                                    </span>
                                  ) : (
                                    <span className="row-act">
                                      {/* A ceiling this design does not use yet.
                                          Every ceiling it DOES use is already a
                                          column, so this is only ever for a new
                                          step. */}
                                      <button
                                        className="ladder-add"
                                        onClick={() => {
                                          setAdding(`${rowKey(row)} ${kind}`);
                                          setNewMax("");
                                          setNewPoints("");
                                        }}
                                        disabled={!!busy}
                                        title={t("incentiveCfg.addBand")}
                                      >
                                        +
                                      </button>
                                      <button
                                        className="btn btn-ghost btn-icon"
                                        onClick={() => runProcess(row)}
                                        disabled={!!busy}
                                        title={t("incentiveCfg.rowDetail")}
                                      >
                                        <ListTree size={13} />
                                      </button>
                                      <button
                                        className="btn btn-ghost btn-icon"
                                        onClick={() => wipe({ row })}
                                        disabled={!!busy}
                                        title={t("incentiveCfg.deleteRow")}
                                        style={{ color: "var(--neg)" }}
                                      >
                                        <Trash2 size={13} />
                                      </button>
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </Fragment>
              ))}
              {gridRows.length === 0 && (
                <p className="cfg-line" style={{ color: "var(--muted)" }}>{t("label.noData")}</p>
              )}
            </div>

            <div className="card-bd">
              <p className="page-sub">{t("incentiveCfg.monthNote")}</p>
            </div>
          </div>
        )}
      </div>

      {/* What the ladders caught. One line per product sold this month, the band
          that took it, and the points that band paid — the products no band
          covers first, because those are the ones the scheme is missing. */}
      {match && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 overflow-y-auto"
             onClick={() => setMatch(null)}>
          <div className="card w-full my-4" style={{ maxWidth: 1080 }} onClick={(event) => event.stopPropagation()}>
            <div className="card-hd">
              <h3 className="card-title">
                <ListTree size={14} /> {t("incentiveCfg.matchTitle")}
                {scope && <span className="pill pill-muted">{scope.brand} · {scope.design || "—"}</span>}
              </h3>
              <span className="ml-auto flex items-center gap-2">
                {scope && (
                  <button className="btn" onClick={() => setScope(null)}>{t("incentiveCfg.allRows")}</button>
                )}
                <button className="btn btn-ghost btn-icon" onClick={() => setMatch(null)} aria-label="close">
                  <X size={14} />
                </button>
              </span>
            </div>

            {/* The month in one line, so the detail below is read against it. */}
            <div className="card-bd flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
              <span><b>{fmt(match.totals.items)}</b> {t("incentiveCfg.products")}</span>
              <span><b>{fmt(match.totals.qty)}</b> {t("incentiveCfg.units")}</span>
              <span>{t("incentiveCfg.sold")} <b>{fmt(match.totals.amount)}</b></span>
              <span>{t("incentiveCfg.points")} <b>{fmt(match.totals.points)}</b></span>
              {match.totals.unmatched > 0 && (
                <button
                  className="pill pill-neg"
                  onClick={() => setGapsOnly(!gapsOnly)}
                  title={t("incentiveCfg.onlyGaps")}
                  style={gapsOnly ? { outline: "2px solid var(--neg)" } : undefined}
                >
                  <TriangleAlert size={11} />
                  {fmt(match.totals.unmatched)} {t("incentiveCfg.noBand")} · {fmt(match.totals.unmatchedAmount)}
                </button>
              )}
              <input
                className="input ml-auto"
                style={{ maxWidth: 220 }}
                placeholder={t("incentiveCfg.search")}
                value={find}
                onChange={(event) => setFind(event.target.value)}
              />
            </div>

            <div className="card-bd-flush overflow-x-auto">
              <table className="tbl" style={{ minWidth: 900 }}>
                <thead>
                  <tr>
                    <th className="text-left">{t("incentiveCfg.design")}</th>
                    <th className="text-left">{t("incentiveCfg.brandShort")}</th>
                    <th className="text-left">{t("incentiveCfg.product")}</th>
                    <th className="text-left">{t("incentiveCfg.measure")}</th>
                    <th className="text-left">{t("incentiveCfg.bandHit")}</th>
                    <th>{t("incentiveCfg.perUnit")}</th>
                    <th>{t("incentiveCfg.units")}</th>
                    <th>{t("incentiveCfg.sold")}</th>
                    <th>{t("incentiveCfg.points")}</th>
                  </tr>
                </thead>
                <tbody>
                  {shownItems.map((item) => (
                    <tr key={`${item.brand} ${item.design} ${item.item_code}`}
                        style={item.matched ? undefined : { background: "var(--neg-bg)" }}>
                      <td className="text-left">{item.design || "—"}</td>
                      <td className="text-left"><b>{item.brand || "—"}</b></td>
                      <td className="text-left" style={{ whiteSpace: "normal", minWidth: 200 }}>
                        {item.item_name}
                        <span className="block" style={{ color: "var(--muted)", fontSize: 10.5 }}>{item.item_code}</span>
                      </td>
                      {/* The wording the ERP wrote, and the number it produced.
                          When nothing matched, one of the two is the fault. */}
                      <td className="text-left">
                        {item.size_name || "—"}
                        <span className="block" style={{ color: "var(--muted)", fontSize: 10.5 }}>
                          {item.measure === null ? "—" : fmt(item.measure)}
                        </span>
                      </td>
                      <td className="text-left"
                          style={item.matched ? undefined : { color: "var(--neg)", fontWeight: 700 }}>
                        {hitLabel(item)}
                      </td>
                      <td>{fmt(item.unit_points)}</td>
                      <td>{fmt(item.qty)}</td>
                      <td>{fmt(item.amount)}</td>
                      <td style={item.points > 0 ? undefined : { color: "var(--neg)" }}>
                        <b>{fmt(item.points)}</b>
                      </td>
                    </tr>
                  ))}
                  {shownItems.length === 0 && (
                    <tr><td colSpan={9} className="text-left" style={{ color: "var(--muted)" }}>{t("label.noData")}</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="card-bd">
              <p className="page-sub">{t("incentiveCfg.matchNote")}</p>
            </div>
          </div>
        </div>
      )}

      {/* Describe the whole row first — category, design, brand and its ladder —
          then write it. Half a row prices nothing, so half a row is never
          written. */}
      {form && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
             onClick={() => setForm(null)}>
          <div className="card w-full" style={{ maxWidth: 560 }} onClick={(event) => event.stopPropagation()}>
            <div className="card-hd">
              <h3 className="card-title">{t("incentiveCfg.addTitle")}</h3>
              <button className="btn btn-ghost btn-icon" onClick={() => setForm(null)} aria-label="close">
                <X size={14} />
              </button>
            </div>

            <div className="card-bd grid gap-2 sm:grid-cols-2">
              <div>
                <label className="field-label">{t("incentiveCfg.category")}</label>
                <Picker
                  placeholder={t("incentiveCfg.search")}
                  options={options.categories.map((item) => ({
                    value: item.category_code,
                    label: `${item.label} · ${item.pointmap_category}`,
                  }))}
                  value={form.itemCategory}
                  onChange={(value) => setForm({ ...form, itemCategory: value, design: "" })}
                />
              </div>
              <div>
                <label className="field-label">{t("incentiveCfg.design")}</label>
                <Picker
                  placeholder={t("incentiveCfg.search")}
                  disabled={!form.itemCategory}
                  options={(options.designs[form.itemCategory] ?? []).map((item) => ({
                    value: item.token,
                    label: item.label === item.token ? item.token : `${item.label} · ${item.token}`,
                  }))}
                  value={form.design}
                  onChange={(value) => setForm({ ...form, design: value })}
                />
              </div>
              <div className="sm:col-span-2">
                <label className="field-label">{t("incentiveCfg.brand")}</label>
                <MultiPicker
                  placeholder={t("incentiveCfg.search")}
                  options={options.brands.map((item) => ({ value: item.code, label: item.label }))}
                  value={form.brands}
                  onChange={(value) => setForm({ ...form, brands: value })}
                />
              </div>
            </div>

            <div className="card-bd">
              <p className="field-label">{t("incentiveCfg.bandsTitle")}</p>
              <div className="band-grid">
                <span className="field-label">{t("incentiveCfg.floor")}</span>
                <span className="field-label">{t("incentiveCfg.ceiling")}</span>
                <span className="field-label">{t("incentiveCfg.points")}</span>
                <span />
                {form.bands.map((band, index) => (
                  <Fragment key={index}>
                    {/* Only the FIRST floor is a decision. Above it a band
                        starts where the one below stops, so a floor typed by
                        hand there could only disagree with it — but the bottom
                        of the ladder has nothing below to follow, and a scheme
                        that pays only from 12 kg up has no way to say so
                        otherwise. */}
                    {index === 0 ? (
                      <input
                        className="input"
                        placeholder="0"
                        inputMode="decimal"
                        value={form.floor}
                        onChange={(event) => setForm({ ...form, floor: event.target.value })}
                      />
                    ) : (
                      <input
                        className="input"
                        readOnly
                        tabIndex={-1}
                        style={{ color: "var(--muted)", background: "var(--surface-2)" }}
                        value={(() => {
                          const below = Number(form.bands[index - 1].max.trim());
                          return Number.isFinite(below) && form.bands[index - 1].max.trim() !== ""
                            ? String(nextFloor(below))
                            : "∞";
                        })()}
                      />
                    )}
                    <input
                      className="input"
                      placeholder="∞"
                      inputMode="decimal"
                      value={band.max}
                      onChange={(event) => setForm({
                        ...form,
                        bands: form.bands.map((item, at) => (at === index ? { ...item, max: event.target.value } : item)),
                      })}
                    />
                    <input
                      className="input"
                      inputMode="decimal"
                      value={band.points}
                      onChange={(event) => setForm({
                        ...form,
                        bands: form.bands.map((item, at) => (at === index ? { ...item, points: event.target.value } : item)),
                      })}
                    />
                    <button
                      className="btn btn-ghost btn-icon"
                      onClick={() => setForm({ ...form, bands: form.bands.filter((_, at) => at !== index) })}
                      aria-label="remove band"
                      style={{ color: "var(--muted)" }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </Fragment>
                ))}
              </div>
              <button
                className="btn mt-2"
                onClick={() => setForm({ ...form, bands: [...form.bands, { max: "", points: "" }] })}
              >
                <Plus size={13} /> {t("incentiveCfg.addBand")}
              </button>
              <p className="page-sub mt-2">{t("incentiveCfg.ladderHint")}</p>
            </div>

            <div className="card-bd flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setForm(null)}>{t("app.close")}</button>
              <button className="btn btn-primary" onClick={submitForm} disabled={!!busy || form.brands.length === 0 || !form.itemCategory}>
                <Check size={13} /> {t("incentiveCfg.addRow")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
