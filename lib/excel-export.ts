"use client";

import * as XLSX from "xlsx";

// Generic single-sheet export. Pass an array of plain objects + the desired
// column order; column header text is taken from `headers`. The file is
// downloaded as <filename>.xlsx with the Lao text intact (UTF-8).
//
// Use exportSheets() for workbooks with multiple sheets (e.g. one per
// department/transport group in a pivot report).
export function exportToExcel<T extends Record<string, unknown>>(
  filename: string,
  rows: T[],
  columns: { key: keyof T; header: string; width?: number }[]
) {
  const sheet = buildSheet(rows, columns);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
  XLSX.writeFile(wb, ensureExtension(filename));
}

// Multi-sheet workbook. Each entry becomes its own tab.
export function exportSheets<T extends Record<string, unknown>>(
  filename: string,
  sheets: {
    name: string;
    rows: T[];
    columns: { key: keyof T; header: string; width?: number }[];
  }[]
) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const sheet = buildSheet(s.rows, s.columns);
    // Sheet names: Excel caps at 31 chars + bans /\\?*[]:
    const safe = s.name.replace(/[\\/?*[\]:]/g, "_").slice(0, 31) || "Sheet";
    XLSX.utils.book_append_sheet(wb, sheet, safe);
  }
  XLSX.writeFile(wb, ensureExtension(filename));
}

function buildSheet<T extends Record<string, unknown>>(
  rows: T[],
  columns: { key: keyof T; header: string; width?: number }[]
) {
  const headerRow = columns.map((c) => c.header);
  const dataRows = rows.map((r) => columns.map((c) => formatCell(r[c.key])));
  const sheet = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);
  // Column widths in characters; defaults to header length + 2 for breathing
  // room. Long Lao text often needs more space than English equivalents.
  sheet["!cols"] = columns.map((c) => ({
    wch: c.width ?? Math.max(c.header.length + 2, 12),
  }));
  return sheet;
}

function formatCell(value: unknown): string | number {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "ແມ່ນ" : "ບໍ່";
  return String(value);
}

function ensureExtension(name: string) {
  return /\.xlsx$/i.test(name) ? name : `${name}.xlsx`;
}
