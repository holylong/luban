import React from "react";
import { Box, Text } from "ink";
import { HighlightedCodeLine } from "./markdown.js";
import { listWindow, scrollPercent } from "./scroll.js";
import { theme } from "./theme.js";

export interface ExecutionEntry {
  name: string; detail: string; status: "running" | "done" | "failed";
  preview?: string; editPreview?: string; elapsedMs?: number;
}
export interface ExecutionRow { kind: "header" | "argument" | "output" | "edit" | "gap"; text: string; entry: ExecutionEntry }
export function executionRows(entries: ExecutionEntry[], expanded = true): ExecutionRow[] {
  return entries.flatMap(entry => [
    { kind: "gap" as const, text: "", entry },
    { kind: "header" as const, text: entry.name, entry },
    ...(entry.detail ? [{ kind: "argument" as const, text: entry.detail, entry }] : []),
    ...(entry.editPreview
      ? entry.editPreview.split("\n").map(text => ({ kind: "edit" as const, text, entry }))
      : (entry.preview || "").split("\n").filter(Boolean).flatMap((text, index) =>
        expanded || index < 2 ? [{ kind: "output" as const, text, entry }]
          : index === 2 ? [{ kind: "output" as const, text: "… /details 展开更多输出", entry }] : [])),
  ]);
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
export function ExecutionRowView({ row }: { row: ExecutionRow }) {
  const { entry, text, kind } = row;
  if (kind === "gap") return <Text> </Text>;
  if (kind === "edit") return <DiffLine line={text} />;
  if (kind === "header") {
    const color = entry.status === "failed" ? theme.red : entry.status === "running" ? theme.yellow : theme.green;
    const toolColor = entry.name === "bash" ? theme.yellow : /edit|write|patch/u.test(entry.name) ? theme.purple : theme.accent;
    return <Text wrap="truncate-end"><Text color={color}>{entry.status === "failed" ? "✗" : entry.status === "running" ? "●" : "✓"} </Text><Text color={toolColor} bold>{labels[entry.name] || entry.name}</Text><Text color={theme.muted}> · {entry.status === "running" ? "执行中" : entry.status === "failed" ? "失败" : "完成"}{entry.elapsedMs === undefined ? "" : " · " + (entry.elapsedMs / 1000).toFixed(1) + "s"}</Text></Text>;
  }
  if (kind === "argument") return <Box overflow="hidden"><Text color={theme.yellow}>  {entry.name === "bash" ? "$" : "›"} </Text><HighlightedCodeLine line={text} /></Box>;
  return <Text wrap="truncate-end"><Text color={theme.dim}>  ↳ </Text><Text color={entry.status === "failed" ? theme.red : theme.muted}>{text}</Text></Text>;
}

export function ExecutionTimeline({ entries, expanded, offset = 0, pageSize = 14 }: { entries: ExecutionEntry[]; expanded: boolean; offset?: number; pageSize?: number }) {
  const all = executionRows(entries, expanded);
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
