import React from "react";
import { Box, Text } from "ink";
import { editDisplayRows, editPairText, parseEditRecord, type EditCell } from "../core/edit-preview.js";
import { HighlightedCodeLine } from "./markdown.js";
import { listWindow, scrollPercent } from "./scroll.js";
import { theme } from "./theme.js";

export interface ExecutionEntry {
  name: string; detail: string; status: "running" | "done" | "failed";
  preview?: string; editPreview?: string; elapsedMs?: number;
}
export interface ExecutionRow {
  kind: "header" | "argument" | "output" | "edit" | "edit-pair" | "gap";
  text: string;
  entry: ExecutionEntry;
  /** Position among this entry's output rows; only the first gets the ↳ marker. */
  outputIndex?: number;
  /** Cells for an `edit-pair` row: removed/context on the left, added on the right. */
  left?: EditCell;
  right?: EditCell;
}

/** Below this usable width a split view is too cramped; the unified list is kept. */
export const SIDE_BY_SIDE_MIN_WIDTH = 72;

/**
 * Turn one edit record into transcript rows.
 *
 * Wide terminals get one aligned `edit-pair` row per change; narrow ones get
 * the unified `- old` / `+ new` lines the record already stores, so no terminal
 * has to read a two-column layout squeezed into a few characters.
 */
function editRows(preview: string, entry: ExecutionEntry, width: number): ExecutionRow[] {
  const rows: ExecutionRow[] = [];
  for (const row of editDisplayRows(parseEditRecord(preview))) {
    if (row.kind === "header" || row.kind === "meta") { rows.push({ kind: "edit", text: row.text, entry }); continue; }
    if (width < SIDE_BY_SIDE_MIN_WIDTH) {
      if (row.left.kind !== "empty") rows.push({ kind: "edit", text: `${String(row.left.line ?? "").padStart(6)} ${row.left.kind === "remove" ? "-" : " "}${row.left.text}`, entry });
      if (row.right.kind !== "empty" && row.right.kind !== "context") rows.push({ kind: "edit", text: `${String(row.right.line ?? "").padStart(6)} +${row.right.text}`, entry });
      continue;
    }
    rows.push({ kind: "edit-pair", text: editPairText(row.left, row.right), entry, left: row.left, right: row.right });
  }
  return rows;
}

export function executionRows(entries: ExecutionEntry[], expanded = true, width = 80): ExecutionRow[] {
  return entries.flatMap(entry => [
    { kind: "gap" as const, text: "", entry },
    { kind: "header" as const, text: entry.name, entry },
    ...(entry.detail ? [{ kind: "argument" as const, text: entry.detail, entry }] : []),
    ...(entry.editPreview
      ? editRows(entry.editPreview, entry, width)
      : (entry.preview || "").split("\n").filter(Boolean).flatMap((text, index) =>
        expanded || index < 2 ? [{ kind: "output" as const, text, entry, outputIndex: index }]
          : index === 2 ? [{ kind: "output" as const, text: "… /details 展开更多输出", entry, outputIndex: index }] : [])),
  ]);
}

/** One side of a split edit row: line number, sign, and syntax-highlighted code. */
function EditHalf({ cell }: { cell: EditCell }) {
  const background = cell.kind === "add" ? theme.codeAddedBackground
    : cell.kind === "remove" ? theme.codeRemovedBackground : theme.codeBackground;
  const sign = cell.kind === "add" ? "+" : cell.kind === "remove" ? "-" : " ";
  const signColor = cell.kind === "add" ? theme.green : cell.kind === "remove" ? theme.red : theme.dim;
  return <Box flexGrow={1} flexBasis={0} overflow="hidden" backgroundColor={background}>
    <Text color={theme.muted}>{cell.line === undefined ? "    " : String(cell.line).padStart(4)} </Text>
    <Text color={signColor}>{sign} </Text>
    <Box flexGrow={1} overflow="hidden"><HighlightedCodeLine line={cell.text || " "} /></Box>
  </Box>;
}

/** Removed text on the left, its replacement on the right, split by a divider. */
export function SideBySideEditRow({ left, right }: { left: EditCell; right: EditCell }) {
  return <Box flexShrink={0} flexGrow={1} flexDirection="row" overflow="hidden">
    <EditHalf cell={left} />
    <Text color={theme.border}>│</Text>
    <EditHalf cell={right} />
  </Box>;
}

export function DiffLine({ line }: { line: string }) {
  const numbered = line.match(/^(\s*\d+) ([ +\-])(.*)$/u);
  const unified = !/^(---|\+\+\+)/u.test(line) ? line.match(/^([ +\-])(.*)$/u) : null;
  const sign = numbered?.[2] ?? unified?.[1];
  const code = numbered?.[3] ?? unified?.[2];
  if (code !== undefined) return <Box flexShrink={0} overflow="hidden">
    <Text color={theme.muted}>{(numbered?.[1] || "").padStart(6)} </Text>
    <Text color={sign === "+" ? theme.green : sign === "-" ? theme.red : theme.dim}>{sign} </Text>
    <Box flexGrow={1} overflow="hidden" backgroundColor={sign === "+" ? theme.codeAddedBackground : sign === "-" ? theme.codeRemovedBackground : theme.codeBackground}>
      <HighlightedCodeLine line={code || " "} />
    </Box>
  </Box>;
  const header = line.match(/^Edited (.*) \(\+(\d+) -(\d+)\)$/u);
  if (header) return <Text wrap="truncate-end"><Text color={theme.accent} bold>  Edited </Text><Text color={theme.primary}>{header[1]}</Text><Text color={theme.green}> +{header[2]}</Text><Text color={theme.red}> −{header[3]}</Text></Text>;
  return <Text color={theme.muted} wrap="truncate-end">{line || " "}</Text>;
}

const labels: Record<string, string> = { bash: "Shell", read_file: "Read", edit_file: "Edit", write_file: "Write", apply_patch: "Patch", grep_files: "Search", glob_files: "Glob", list_dir: "List" };

/** `    12 | code` — the line-numbered shape read_file returns. */
const NUMBERED_LINE = /^\s*(\d+) \| (.*)$/u;

/**
 * One result line. A read_file row keeps its number in a dim gutter and the
 * code is syntax-highlighted, so file content reads like code instead of a
 * single-colour block; other output stays plain and aligned under the marker.
 */
function OutputLine({ text, marker, failed }: { text: string; marker: string; failed: boolean }) {
  const numbered = NUMBERED_LINE.exec(text);
  if (numbered) return <Box flexShrink={0} overflow="hidden">
    <Text color={theme.dim}>{marker}</Text>
    <Text color={theme.muted}>{numbered[1]!.padStart(5)} </Text>
    <Text color={theme.dim}>│ </Text>
    <Box flexGrow={1} overflow="hidden"><HighlightedCodeLine line={numbered[2]!} /></Box>
  </Box>;
  return <Text wrap="truncate-end"><Text color={theme.dim}>{marker}</Text><Text color={failed ? theme.red : theme.muted}>{text}</Text></Text>;
}

export function ExecutionRowView({ row }: { row: ExecutionRow }) {
  const { entry, text, kind } = row;
  if (kind === "gap") return <Text> </Text>;
  if (kind === "edit") return <DiffLine line={text} />;
  if (kind === "edit-pair") return <SideBySideEditRow left={row.left!} right={row.right!} />;
  if (kind === "header") {
    const color = entry.status === "failed" ? theme.red : entry.status === "running" ? theme.yellow : theme.green;
    const toolColor = entry.name === "bash" ? theme.yellow : /edit|write|patch/u.test(entry.name) ? theme.purple : theme.accent;
    return <Text wrap="truncate-end"><Text color={color}>{entry.status === "failed" ? "✗" : entry.status === "running" ? "●" : "✓"} </Text><Text color={toolColor} bold>{labels[entry.name] || entry.name}</Text><Text color={theme.muted}> · {entry.status === "running" ? "执行中" : entry.status === "failed" ? "失败" : "完成"}{entry.elapsedMs === undefined ? "" : " · " + (entry.elapsedMs / 1000).toFixed(1) + "s"}</Text></Text>;
  }
  if (kind === "argument") return <Box overflow="hidden"><Text color={theme.yellow}>  {entry.name === "bash" ? "$" : "›"} </Text><HighlightedCodeLine line={text} /></Box>;
  // One marker per result, not per line: a wall of arrows down the left edge is
  // noise, and it is copied along with the text. Continuations stay aligned.
  return <OutputLine text={text} marker={row.outputIndex === 0 ? "  ↳ " : "    "} failed={entry.status === "failed"} />;
}

export function ExecutionTimeline({ entries, expanded, offset = 0, pageSize = 14, width = 80 }: { entries: ExecutionEntry[]; expanded: boolean; offset?: number; pageSize?: number; width?: number }) {
  const all = executionRows(entries, expanded, width);
  if (!all.length) return null;
  // Clamp here rather than trusting the call site: an over-scrolled wheel
  // offset used to make the view stick at the top while the counter kept
  // rising, so scrolling back down did nothing for the same number of notches.
  const view = listWindow(all.length, pageSize, offset);
  const rows = all.slice(view.start, view.end);
  const position = view.scrollable
    ? `${view.start + 1}–${view.end}/${all.length} · ${scrollPercent(view)}%${view.atTop ? " · 已到最早" : view.atBottom ? " · 已到最新" : ""}`
    : `${all.length} 行`;
  return <Box flexDirection="column" paddingX={1} flexShrink={0}>
    {rows.map((row, index) => <ExecutionRowView key={view.start + index} row={row} />)}
    {/* The pane is bottom-anchored in a clipped column, so a title above the
        rows is the first thing lost when the terminal is short. Keeping the
        position readout below the rows guarantees the scroll feedback stays
        visible exactly when the user is scrolling. */}
    <Text color={theme.muted} wrap="truncate-end">
      执行详情 · {entries.length} 次调用 · {expanded ? `${position} · /details 收起` : "/details 展开完整输出"} · 滚轮 / PageUp / PageDown 翻阅
    </Text>
  </Box>;
}
