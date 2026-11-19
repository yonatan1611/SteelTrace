import ExcelJS from "exceljs";

/**
 * Parses a Bar Bending Schedule / Engineering Takeoff workbook (CLAUDE.md
 * §2.16) into plain rows this module's routes can turn into `bbs_lines`.
 * Column layouts are genuinely different between the two formats the
 * client's real spreadsheets use, and several fields BbsLine's schema
 * requires (NOT NULL `reinforcementPurposeId`/`shapeCodeId`/`grade`) are
 * simply ABSENT from one or both formats — this parser never invents a
 * specific value for those; it returns `null` for an unresolvable field
 * and leaves resolution (including the caller-supplied fallbacks for rows
 * that don't name anything) to the route handler, which has company
 * context this module intentionally does not.
 */

export type BbsFormat = "A" | "B";

/** One parsed spreadsheet row, pre-resolution — strings/numbers only, no DB lookups done here. */
export interface ParsedBbsRow {
  rowNumber: number; // 1-based spreadsheet row, for error/warning messages
  drawingNumber: string | null;
  drawingRevision: string | null;
  structuralElementText: string | null; // Format A's "Structural Element" column, or Format B's "Location"
  barMark: string; // Format A's "BBS Mark", Format B's "Ref No"
  diameterMm: number;
  grade: string | null; // present only in Format A
  shapeCode: string | null; // present only in Format A
  dimAMm: number | null;
  dimBMm: number | null;
  dimCMm: number | null;
  dimDMm: number | null;
  cutLengthM: number;
  barsPerMember: number;
  memberCount: number;
  totalBarsRequired: number;
  /** True when `barMark`/Ref No looks like a stirrup/link mark (st, st1, st-a, st-b, ...) — §2.16's inline-mark-to-purpose mapping. */
  looksLikeStirrup: boolean;
}

export interface ParsedBbsSheet {
  format: BbsFormat;
  rows: ParsedBbsRow[];
  /** Non-blocking issues found anywhere in the sheet (e.g. the wastage-multiplier anomaly) — never prevent import, only surface for review. */
  warnings: string[];
  /** Blocking issues with specific rows (missing required numeric fields, etc.) — these rows are excluded from `rows`. */
  rowErrors: { rowNumber: number; message: string }[];
}

// Format A: "Drawing No., Revision, Structural Element, Level/Grid, BBS Mark,
// Bar Dia (mm), Grade, Shape Code, A..D (mm), Cut Length (m), No. Bars Required."
const FORMAT_A_HEADERS = ["drawing no", "bbs mark", "bar dia", "shape code"];
// Format B: "Drg.No, Location, Ref No, Dia, Length, No of bar, No of member."
const FORMAT_B_HEADERS = ["drg.no", "ref no", "no of bar", "no of member"];

const STIRRUP_MARK_PATTERN = /^st[-_]?\d*[a-z]?$/i;

function normalizeHeader(cell: unknown): string {
  return String(cell ?? "").trim().toLowerCase();
}

function findHeaderRow(sheet: ExcelJS.Worksheet): { rowNumber: number; headers: string[] } | null {
  // Scan the first 20 rows for one that contains enough recognizable
  // column names — BBS workbooks commonly have a title/drawing-info block
  // above the actual table.
  for (let r = 1; r <= Math.min(20, sheet.rowCount); r++) {
    const row = sheet.getRow(r);
    const headers: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => headers.push(normalizeHeader(cell.value)));
    const joined = headers.join("|");
    const matchesA = FORMAT_A_HEADERS.filter((h) => joined.includes(h)).length;
    const matchesB = FORMAT_B_HEADERS.filter((h) => joined.includes(h)).length;
    if (matchesA >= 3 || matchesB >= 3) {
      return { rowNumber: r, headers };
    }
  }
  return null;
}

function colIndex(headers: string[], ...needles: string[]): number {
  for (const needle of needles) {
    const idx = headers.findIndex((h) => h.includes(needle));
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * For single-letter dimension columns ("A", "B", "C", "D") — `colIndex`'s
 * substring match is unsafe here (almost every other header contains the
 * letter "a" somewhere, e.g. "Grade", "Bar Dia"), so these need an EXACT
 * match after normalization, with the longer "a (mm)"/"dim a" spellings
 * as a secondary, still-substring-based fallback for sheets that spell
 * the column out.
 */
function exactOrFallbackColIndex(headers: string[], exact: string, ...fallbackNeedles: string[]): number {
  const exactIdx = headers.findIndex((h) => h === exact);
  if (exactIdx !== -1) return exactIdx;
  return colIndex(headers, ...fallbackNeedles);
}

function cellText(row: ExcelJS.Row, col: number): string | null {
  if (col === -1) return null;
  const v = row.getCell(col + 1).value;
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "object" && "text" in (v as object)) return String((v as { text: unknown }).text).trim();
  return String(v).trim();
}

function cellNumber(row: ExcelJS.Row, col: number): number | null {
  const text = cellText(row, col);
  if (text === null) return null;
  const n = Number(text.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Wastage anomaly check (CLAUDE.md §2.16's importer requirement): scans
 * every row for a text cell mentioning "wastage" alongside a percentage
 * (e.g. "Add 5% wastage"), then looks across the REST of that same row
 * for a numeric cell shaped like a multiplier (1.0-2.0) and compares it
 * against the multiplier the stated percentage implies (1 + pct/100).
 * A real spreadsheet's wastage note and its applied multiplier are
 * typically on the same line (label in one cell, factor in another) —
 * this is a heuristic, not a layout this codebase has a real sample of,
 * so it is deliberately permissive about where the multiplier cell sits
 * and never blocks import on a mismatch, only reports it.
 */
function findWastageAnomalies(sheet: ExcelJS.Worksheet): string[] {
  const warnings: string[] = [];
  const pctPattern = /(\d+(?:\.\d+)?)\s*%/;

  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    let labelText: string | null = null;
    let labelCol = -1;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const text = String(cell.value ?? "");
      if (/wastage/i.test(text) && pctPattern.test(text)) {
        labelText = text;
        labelCol = col;
      }
    });
    if (!labelText) continue;
    const label: string = labelText;

    const pctMatch = pctPattern.exec(label);
    const statedPct = pctMatch ? Number(pctMatch[1]) : null;
    if (statedPct === null) continue;
    const expectedMultiplier = 1 + statedPct / 100;

    let foundMultiplier: number | null = null;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      if (col === labelCol) return;
      const v = cell.value;
      if (typeof v === "number" && v > 1.0 && v < 2.0) {
        foundMultiplier = v;
      }
    });

    const multiplier: number = foundMultiplier === null ? NaN : Number(foundMultiplier);
    if (!Number.isNaN(multiplier) && Math.abs(multiplier - expectedMultiplier) > 0.01) {
      const expectedStr = expectedMultiplier.toFixed(3);
      const foundStr = multiplier.toFixed(3);
      warnings.push(
        `Row ${r}: label "${label.trim()}" implies a wastage multiplier of ${expectedStr}, ` +
          `but the sheet applies ${foundStr} — confirm which figure is correct before relying on this schedule's quantities.`,
      );
    }
  }
  return warnings;
}

export async function parseBbsWorkbook(buffer: Buffer): Promise<ParsedBbsSheet> {
  const workbook = new ExcelJS.Workbook();
  // exceljs's own type declarations predate modern @types/node's generic
  // `Buffer<ArrayBufferLike>` — the runtime call is fine either way.
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error("Workbook contains no worksheets");
  }

  const header = findHeaderRow(sheet);
  if (!header) {
    throw new Error("Could not find a recognizable BBS header row (neither Format A nor Format B columns matched)");
  }
  const { headers } = header;
  const joined = headers.join("|");
  const isFormatA = FORMAT_A_HEADERS.filter((h) => joined.includes(h)).length >= FORMAT_B_HEADERS.filter((h) => joined.includes(h)).length;
  const format: BbsFormat = isFormatA ? "A" : "B";

  const warnings = findWastageAnomalies(sheet);
  const rows: ParsedBbsRow[] = [];
  const rowErrors: { rowNumber: number; message: string }[] = [];

  if (format === "A") {
    const col = {
      drawingNo: colIndex(headers, "drawing no"),
      revision: colIndex(headers, "revision"),
      structuralElement: colIndex(headers, "structural element"),
      barMark: colIndex(headers, "bbs mark"),
      barDia: colIndex(headers, "bar dia"),
      grade: colIndex(headers, "grade"),
      shapeCode: colIndex(headers, "shape code"),
      dimA: exactOrFallbackColIndex(headers, "a", "a (mm)", "dim a"),
      dimB: exactOrFallbackColIndex(headers, "b", "b (mm)", "dim b"),
      dimC: exactOrFallbackColIndex(headers, "c", "c (mm)", "dim c"),
      dimD: exactOrFallbackColIndex(headers, "d", "d (mm)", "dim d"),
      cutLength: colIndex(headers, "cut length"),
      noBars: colIndex(headers, "no. bars", "no of bars", "bars required"),
    };

    for (let r = header.rowNumber + 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const barMark = cellText(row, col.barMark);
      if (!barMark) continue; // blank trailing row

      const diameterMm = cellNumber(row, col.barDia);
      const cutLengthM = cellNumber(row, col.cutLength);
      const totalBarsRequired = cellNumber(row, col.noBars);
      if (diameterMm === null || cutLengthM === null || totalBarsRequired === null) {
        rowErrors.push({ rowNumber: r, message: `Row ${r} ("${barMark}") is missing a required numeric field (Bar Dia / Cut Length / No. Bars Required)` });
        continue;
      }

      rows.push({
        rowNumber: r,
        drawingNumber: cellText(row, col.drawingNo),
        drawingRevision: cellText(row, col.revision),
        structuralElementText: cellText(row, col.structuralElement),
        barMark,
        diameterMm,
        grade: cellText(row, col.grade),
        shapeCode: cellText(row, col.shapeCode),
        dimAMm: cellNumber(row, col.dimA),
        dimBMm: cellNumber(row, col.dimB),
        dimCMm: cellNumber(row, col.dimC),
        dimDMm: cellNumber(row, col.dimD),
        cutLengthM,
        // Format A gives only a single total — modeled as 1 member carrying
        // the full count, so BbsLine's `total_bars_required = bars_per_member
        // * member_count` CHECK holds trivially (documented assumption,
        // §2.16: this format doesn't distinguish "per member" from "total").
        barsPerMember: totalBarsRequired,
        memberCount: 1,
        totalBarsRequired,
        looksLikeStirrup: STIRRUP_MARK_PATTERN.test(barMark.trim()),
      });
    }
  } else {
    const col = {
      drawingNo: colIndex(headers, "drg.no", "drg no"),
      location: colIndex(headers, "location"),
      refNo: colIndex(headers, "ref no"),
      dia: colIndex(headers, "dia"),
      length: colIndex(headers, "length"),
      noOfBar: colIndex(headers, "no of bar"),
      noOfMember: colIndex(headers, "no of member"),
    };

    for (let r = header.rowNumber + 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const refNo = cellText(row, col.refNo);
      if (!refNo) continue;

      const diameterMm = cellNumber(row, col.dia);
      const cutLengthM = cellNumber(row, col.length);
      const barsPerMember = cellNumber(row, col.noOfBar);
      const memberCount = cellNumber(row, col.noOfMember);
      if (diameterMm === null || cutLengthM === null || barsPerMember === null || memberCount === null) {
        rowErrors.push({ rowNumber: r, message: `Row ${r} ("${refNo}") is missing a required numeric field (Dia / Length / No of bar / No of member)` });
        continue;
      }

      rows.push({
        rowNumber: r,
        drawingNumber: cellText(row, col.drawingNo),
        drawingRevision: null, // not present in Format B
        structuralElementText: cellText(row, col.location),
        barMark: refNo,
        diameterMm,
        grade: null, // not present in Format B — caller-supplied default required
        shapeCode: null, // not present in Format B — caller-supplied default required
        dimAMm: null,
        dimBMm: null,
        dimCMm: null,
        dimDMm: null,
        cutLengthM,
        barsPerMember,
        memberCount,
        totalBarsRequired: barsPerMember * memberCount,
        looksLikeStirrup: STIRRUP_MARK_PATTERN.test(refNo.trim()),
      });
    }
  }

  return { format, rows, warnings, rowErrors };
}
