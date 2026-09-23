/**
 * Layout for the multi-line prompt box.
 *
 * The composer used to be a single-line `ink-text-input`: a pasted block was
 * stored correctly but the box grew without bound, so a long paste pushed the
 * cursor and everything after it off the top of the terminal. This module turns
 * a value plus a cursor into the visual rows that fit, with the cursor's row
 * always inside the window.
 */

export interface InputRow {
  text: string;
  /** Offset of the row's first character inside the value. */
  start: number;
}

export interface InputLayout {
  rows: InputRow[];
  total: number;
  /** Visual row holding the cursor. */
  cursorRow: number;
  /** Cursor offset within its own row. */
  cursorColumn: number;
  /** First visible row (inclusive). */
  first: number;
  /** Last visible row (exclusive). */
  last: number;
  hiddenAbove: number;
  hiddenBelow: number;
}

/** Approximate East Asian display width of one code point. */
export function charWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f)
    || (codePoint >= 0x2e80 && codePoint <= 0x303e)
    || (codePoint >= 0x3041 && codePoint <= 0x33ff)
    || (codePoint >= 0x3400 && codePoint <= 0x4dbf)
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    || (codePoint >= 0xa000 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1f64f)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) return 2;
  return 1;
}

export function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) width += charWidth(char.codePointAt(0) ?? 0);
  return width;
}

/** Normalize pasted text: unify line endings so one paste is one edit. */
export function normalizeInsert(text: string): string {
  return text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    // The value never carries tabs: a tab has no fixed width here, and
    // expanding on the way in keeps cursor columns equal to character offsets.
    .replaceAll("\t", "    ")
    // eslint-disable-next-line no-control-regex
    .replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}

function step(value: string, index: number, direction: 1 | -1): number {
  if (direction === 1) {
    if (index >= value.length) return value.length;
    const cp = value.codePointAt(index) ?? 0;
    return index + (cp > 0xffff ? 2 : 1);
  }
  if (index <= 0) return 0;
  const previous = value.charCodeAt(index - 1);
  const beforePrevious = index >= 2 ? value.charCodeAt(index - 2) : 0;
  // Step over a surrogate pair as one character.
  return previous >= 0xdc00 && previous <= 0xdfff && beforePrevious >= 0xd800 && beforePrevious <= 0xdbff
    ? index - 2
    : index - 1;
}

export { step as stepCursor };

/** Translate a terminal column into a safe UTF-16 offset. */
export function offsetAtColumn(value: string, column: number): number {
  let offset = 0;
  let used = 0;
  for (const char of value) {
    const size = displayWidth(char);
    if (used + size > column) break;
    used += size;
    offset += char.length;
  }
  return offset;
}

/**
 * Offset of the character a click lands on.
 *
 * `row` and `column` are cells relative to the box as drawn, one row per
 * visible line and one column per display cell. The window is measured against
 * the frame on screen right now — that is, with the caret where it currently
 * is — so clicking the last visible row cannot scroll the text out from under
 * the pointer.
 */
export function offsetAtCell(
  value: string,
  cursor: number,
  width: number,
  maxRows: number,
  row: number,
  column: number,
): number {
  const layout = layoutInput(value, cursor, width, maxRows);
  const lastRow = Math.max(0, layout.last - layout.first - 1);
  const visible = Math.min(Math.max(0, Math.trunc(row) || 0), lastRow);
  const target = layout.rows[layout.first + visible];
  return target ? target.start + offsetAtColumn(target.text, Math.max(0, Math.trunc(column) || 0)) : 0;
}

export function layoutInput(value: string, cursor: number, width: number, maxRows: number): InputLayout {
  const usable = Math.max(1, Math.trunc(width) || 1);
  const limit = Math.max(1, Math.trunc(maxRows) || 1);
  const position = Math.min(Math.max(0, Math.trunc(cursor) || 0), value.length);

  const rows: InputRow[] = [];
  let rowStart = 0;
  let column = 0;
  let index = 0;
  const push = (end: number): void => { rows.push({ text: value.slice(rowStart, end), start: rowStart }); };

  while (index < value.length) {
    if (value[index] === "\n") {
      push(index);
      index += 1;
      rowStart = index;
      column = 0;
      continue;
    }
    const codePoint = value.codePointAt(index) ?? 0;
    const size = codePoint > 0xffff ? 2 : 1;
    const charColumns = charWidth(codePoint);
    if (column + charColumns > usable && column > 0) {
      push(index);
      rowStart = index;
      column = 0;
    }
    column += charColumns;
    index += size;
  }
  push(value.length);

  let cursorRow = 0;
  for (const [rowIndex, row] of rows.entries()) {
    if (row.start <= position) cursorRow = rowIndex;
  }
  const cursorColumn = position - rows[cursorRow]!.start;

  const total = rows.length;
  let first = 0;
  if (total > limit) first = Math.min(Math.max(0, cursorRow - limit + 1), total - limit);
  const last = Math.min(total, first + limit);

  return {
    rows,
    total,
    cursorRow,
    cursorColumn,
    first,
    last,
    hiddenAbove: first,
    hiddenBelow: total - last,
  };
}
