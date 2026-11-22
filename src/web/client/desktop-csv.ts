// CSV/TSV preview support for the desktop editor. Everything that decides what
// the preview shows lives here — path detection, delimiter sniffing, the parser
// and its limits — so the button, the shortcut and the tests ask one module the
// same question instead of each keeping its own idea of what a table is.

/** Extensions the table preview renders. Anything else stays in the code editor. */
const TABLE_EXTENSIONS = new Set(["csv", "tsv", "tab"]);

export type CsvDelimiter = "," | "\t" | ";" | "|";

/** Human name for the separator, printed above the table. */
const DELIMITER_NAMES: Record<CsvDelimiter, string> = { ",": "逗号分隔", "\t": "Tab 分隔", ";": "分号分隔", "|": "竖线分隔" };

/** Candidates in preference order: a tie keeps the earlier one, so a file with
 * one tab and one comma is read as TSV, which is what the extension promises. */
const DELIMITERS: CsvDelimiter[] = ["\t", ",", ";", "|"];

/** Rows and columns rendered. A 200k-row export must not become 200k <tr>. */
export const MAX_ROWS = 400;
export const MAX_COLUMNS = 60;
/** One cell is a preview, not a transcript: Excel exports embed whole essays. */
const MAX_CELL_CHARS = 240;

export interface CsvCell {
  text: string;
  numeric: boolean;
}

export interface CsvRow {
  /** Position in the file, 1-based, so "第 12 行" means the same thing in the
   * table and in the text editor. */
  index: number;
  cells: CsvCell[];
}

export interface CsvGrid {
  delimiter: CsvDelimiter;
  /** Column titles: the file's first row when it looks like one, otherwise
   * spreadsheet letters (A, B, C…). */
  header: string[];
  rows: CsvRow[];
  columns: number;
  /** Body rows counted in the file, including the ones not rendered. */
  totalRows: number;
  truncatedRows: number;
  truncatedColumns: number;
}

function extensionOf(path: string): string {
  const name = path.split("/").at(-1) ?? "";
  if (!name) return "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** True for the delimited text files the table preview applies to. */
export function isTablePath(path: string): boolean {
  return TABLE_EXTENSIONS.has(extensionOf(path));
}

export interface PreviewAction {
  label: string;
  title: string;
  pressed: boolean;
}

/** The preview button's state for a table, or null for every other file. */
export function csvPreviewAction(path: string, previewing: boolean): PreviewAction | null {
  if (!isTablePath(path)) return null;
  return previewing
    ? { label: "编辑", title: "回到编辑(⌘/Ctrl+Shift+V)", pressed: true }
    : { label: "表格预览", title: "把 CSV/TSV 显示成表格(⌘/Ctrl+Shift+V)", pressed: false };
}

/** 0 -> A, 25 -> Z, 26 -> AA. A header-less CSV keeps spreadsheet-style names. */
export function columnLabel(index: number): string {
  let label = "";
  let value = index;
  while (value >= 0) {
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  }
  return label;
}

const PLAIN_NUMBER = /^[-+]?(?:\d+|\d*\.\d+)(?:[eE][-+]?\d+)?$/u;
const GROUPED_NUMBER = /^[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u;

/** A field is a number when the whole cell is one — `12abc` and `1 2` are not. */
export function isNumericCell(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  return PLAIN_NUMBER.test(value) || GROUPED_NUMBER.test(value);
}

/**
 * Pick the separator from the first line. Quotes are respected, so a header
 * like `"Smith, John"` does not turn a single-column file into a comma one.
 */
export function sniffDelimiter(text: string): CsvDelimiter {
  const counts = new Map<CsvDelimiter, number>(DELIMITERS.map(entry => [entry, 0]));
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { index += 1; continue; }
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (char === "\n" || char === "\r") break;
    const known = DELIMITERS.find(entry => entry === char);
    if (known) counts.set(known, counts.get(known)! + 1);
  }
  let best: CsvDelimiter = ",";
  let bestCount = 0;
  for (const entry of DELIMITERS) {
    const count = counts.get(entry)!;
    if (count > bestCount) { best = entry; bestCount = count; }
  }
  return best;
}

/**
 * RFC 4180 with the usual lenient edges: CRLF or LF, escaped quotes (`""`),
 * newlines inside quoted cells, and a quote that appears mid-field (`a"b`) kept
 * literally instead of swallowing the rest of the file.
 */
export function splitRecords(text: string, delimiter: CsvDelimiter): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 2; continue; }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === "") { quoted = true; index += 1; continue; }
    if (char === delimiter) { record.push(field); field = ""; index += 1; continue; }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  // A trailing newline ends the last record above, so an empty tail is not one.
  if (field !== "" || record.length > 0) { record.push(field); records.push(record); }
  return records;
}

/** A first row is a header when it is complete text and a later row has data in
 * it: `name,city` / `Ada,London` gets a header, `1,2,3` does not. */
function looksLikeHeader(records: string[][]): boolean {
  if (records.length < 2) return false;
  const first = records[0]!;
  return first.length > 0 && first.every(cell => cell.trim() !== "" && !isNumericCell(cell));
}

function toCell(text: string): CsvCell {
  const clipped = text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text;
  return { text: clipped.replace(/\r/gu, " "), numeric: isNumericCell(text) };
}

/**
 * Parse a buffer into rows the preview can render, or null when there is
 * nothing to show. Widths are padded to the widest row so every cell keeps its
 * column; rows and columns past the caps are counted, not dropped silently.
 */
export function parseDelimited(content: string, options: { maxRows?: number; maxColumns?: number } = {}): CsvGrid | null {
  const maxRows = options.maxRows ?? MAX_ROWS;
  const maxColumns = options.maxColumns ?? MAX_COLUMNS;
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  if (!text.trim()) return null;
  const delimiter = sniffDelimiter(text);
  const records = splitRecords(text, delimiter);
  if (!records.length) return null;
  const headerRow = looksLikeHeader(records);
  const body = headerRow ? records.slice(1) : records;
  if (!body.length) return null;
  const columns = Math.min(Math.max(...records.map(record => record.length)), maxColumns);
  const header = headerRow
    ? Array.from({ length: columns }, (_, position) => toCell(records[0]![position] ?? "").text || columnLabel(position))
    : Array.from({ length: columns }, (_, position) => columnLabel(position));
  const widest = Math.max(...records.map(record => record.length));
  const rows: CsvRow[] = body.slice(0, maxRows).map((record, position) => ({
    index: position + (headerRow ? 2 : 1),
    cells: Array.from({ length: columns }, (_, column) => toCell(record[column] ?? "")),
  }));
  return {
    delimiter,
    header,
    rows,
    columns,
    totalRows: body.length,
    truncatedRows: Math.max(0, body.length - rows.length),
    truncatedColumns: Math.max(0, widest - columns),
  };
}

/** One line of context above the table: how it was read and what is missing. */
export function gridSummary(grid: CsvGrid): string {
  const parts = [DELIMITER_NAMES[grid.delimiter], `${grid.columns} 列`, `${grid.totalRows} 行`];
  if (grid.truncatedRows > 0) parts.push(`另有 ${grid.truncatedRows} 行未显示`);
  if (grid.truncatedColumns > 0) parts.push(`另有 ${grid.truncatedColumns} 列未显示`);
  return parts.join(" · ");
}
