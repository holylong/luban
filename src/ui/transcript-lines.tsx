import React from "react";
import { Text } from "ink";
import { layoutInput } from "./input-layout.js";
import { parseMarkdownBlocks, HighlightedCodeLine } from "./markdown.js";
import { ExecutionRowView, type ExecutionRow } from "./execution-view.js";
import type { TranscriptBlock } from "./transcript-blocks.js";
import { theme } from "./theme.js";

export interface TranscriptLine {
  id: string;
  text: string;
  kind: "text" | "heading" | "code" | "user" | "note" | "tool";
  tone?: TranscriptBlock["tone"];
  execution?: ExecutionRow;
}

/** Produce physical terminal rows before paging, including rows inside long messages. */
export function transcriptLines(blocks: TranscriptBlock[], width: number): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  const usable = Math.max(1, width);
  for (const block of blocks) {
    let index = 0;
    const add = (text: string, kind: TranscriptLine["kind"], prefix = "") => {
      const rows = layoutInput(text, 0, Math.max(1, usable - prefix.length), Number.MAX_SAFE_INTEGER).rows;
      for (const row of rows) lines.push({ id: `${block.id}:${index++}`, text: prefix + row.text, kind, tone: block.tone });
    };
    if (block.kind === "tool") {
      for (const row of block.rows ?? []) {
        lines.push({ id: `${block.id}:${index++}`, text: row.text, kind: "tool", execution: row });
      }
      continue;
    }
    if (block.kind === "note") { add(block.text ?? "", "note"); continue; }
    add(block.kind === "user" ? "你" : "luban", "heading");
    if (block.kind === "user") {
      add(block.text ?? "", "user", "  ");
    } else {
      for (const part of parseMarkdownBlocks(block.text ?? "")) {
        if (part.kind === "code") {
          add(part.language || "code", "heading");
          add(part.content, "code");
        } else if (part.kind === "rule") {
          add("─".repeat(Math.min(24, usable)), "note");
        } else {
          const text = part.content.replace(/`([^`]+)`|\*\*([^*]+)\*\*/gu, (_, code: string, bold: string) => code ?? bold);
          add(text, part.kind === "heading" ? "heading" : "text", part.kind === "list" ? "• " : part.kind === "quote" ? "┃ " : "");
        }
      }
    }
    add("", "text");
  }
  return lines;
}

export function TranscriptLineView({ line, selected = false }: { line: TranscriptLine; selected?: boolean }) {
  if (line.execution) return <ExecutionRowView row={line.execution} />;
  if (line.kind === "code") return <HighlightedCodeLine line={line.text || " "} backgroundColor={selected ? theme.selected : theme.codeBackground} />;
  const color = line.kind === "heading" ? theme.accent
    : line.kind === "note" ? (line.tone && line.tone in theme ? theme[line.tone as keyof typeof theme] : theme.dim)
      : theme.text;
  return <Text wrap="truncate-end" color={color} bold={line.kind === "heading"}
    backgroundColor={selected ? theme.selected : line.kind === "user" ? theme.panel : undefined}>{line.text || " "}</Text>;
}
