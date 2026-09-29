import { offsetAtColumn } from "./input-layout.js";

export interface SelectionPoint { row: number; column: number }
export interface TranscriptSelection { anchor: SelectionPoint; focus: SelectionPoint }

function ordered(selection: TranscriptSelection): [SelectionPoint, SelectionPoint] {
  const { anchor, focus } = selection;
  return anchor.row < focus.row || (anchor.row === focus.row && anchor.column <= focus.column)
    ? [anchor, focus] : [focus, anchor];
}

/** UTF-16 offsets for the selected part of one physical transcript row. */
export function selectionSpan(text: string, row: number, selection: TranscriptSelection | null): { start: number; end: number } | null {
  if (!selection) return null;
  const [first, last] = ordered(selection);
  if (row < first.row || row > last.row) return null;
  const start = row === first.row ? offsetAtColumn(text, first.column) : 0;
  const end = row === last.row ? offsetAtColumn(text, last.column) : text.length;
  return end > start ? { start, end } : null;
}

/** Copy exactly the displayed physical rows, including wrapped lines. */
export function selectedTranscriptText(lines: readonly string[], selection: TranscriptSelection): string {
  const [first, last] = ordered(selection);
  return lines.slice(first.row, last.row + 1).map((line, index) => {
    const row = first.row + index;
    const span = selectionSpan(line, row, selection);
    return span ? line.slice(span.start, span.end) : "";
  }).join("\n");
}
