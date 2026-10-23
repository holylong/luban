import React from "react";
import { renderToString, Box } from "ink";
import { describe, expect, it } from "vitest";
import { createTranscriptLayout, transcriptLines, TranscriptLineView } from "./transcript-lines.js";
import { buildTranscript } from "./transcript-blocks.js";
import { listWindow } from "./scroll.js";
import { displayWidth } from "./input-layout.js";
import { selectedTranscriptText } from "./transcript-selection.js";

const options = { expanded: true, width: 30 };
describe("physical transcript rows", () => {
  it("reuses history rows while re-parsing the growing Markdown tail", () => {
    const history = buildTranscript([{ role: "assistant", content: "历史中文\n```ts\nconst old = 1;\n```" }], options);
    const layout = createTranscriptLayout();
    const prepared = layout(history, [], 30);
    for (const text of ["正在输出 **", "正在输出 **加粗**", "```ts\nconst live = 2;", "```ts\nconst live = 2;\n```\n结束"]) {
      const tail = [{ id: "streaming", kind: "assistant" as const, text, lines: 1 }];
      const result = layout(history, tail, 30);
      expect(result).toEqual(transcriptLines([...history, ...tail], 30));
      for (let i = 0; i < prepared.length; i++) expect(result[i]).toBe(prepared[i]);
    }
    expect(layout(history, [], 30)).toBe(prepared);
  });

  it("invalidates prepared rows on width, session and execution-detail changes", () => {
    const layout = createTranscriptLayout();
    const history = buildTranscript([{ role: "user", content: "中文内容".repeat(10) }], options);
    const wide = layout(history, [], 30);
    const narrow = layout(history, [], 15);
    expect(narrow).toEqual(transcriptLines(history, 15));
    expect(narrow).not.toBe(wide);
    const preview = "Edited a.ts (+1 -1)\n     1 -old\n     1 +new";
    const restored = buildTranscript([], { ...options, edits: [{ id: "e", name: "edit_file", preview }] });
    expect(layout(restored, [], 30)).toEqual(transcriptLines(restored, 30));
    const empty = layout([], [], 30);
    expect(empty).toEqual([]);
    expect(layout(history, [], 30)).not.toBe(wide);
  });

  it("scrolls inside a long reply instead of repeating its tail", () => {
    const text = Array.from({ length: 80 }, (_, index) => `line-${index}`).join("\n");
    const rows = transcriptLines(buildTranscript([{ role: "assistant", content: text }], options), 30);
    const page = (offset: number) => {
      const view = listWindow(rows.length, 8, offset);
      return rows.slice(view.start, view.end).map(row => row.text);
    };
    expect(page(0)).toContain("line-79");
    expect(page(2)).toContain("line-77");
    expect(page(2)).not.toContain("line-79");
    expect(page(1000)).toContain("line-0");
  });

  it("keeps Chinese prose and code inside the physical width", () => {
    const rows = transcriptLines(buildTranscript([{ role: "assistant", content: "中文内容".repeat(15) + "\n```ts\n" + "const x = 123; ".repeat(10) + "\n```" }], options), 20);
    expect(rows.every(row => displayWidth(row.text) <= 20)).toBe(true);
    const output = renderToString(<Box flexDirection="column">{rows.map(row => <TranscriptLineView key={row.id} line={row} />)}</Box>, { columns: 20 });
    expect(output.split("\n")).toHaveLength(rows.length);
  });

  it("retains restored edits with counts and before/after line numbers once", () => {
    const preview = "Edited src/a.ts (+1 -1)\n     2 -old\n     2 +new";
    const edits = [{ id: "saved", name: "edit_file", preview }];
    const restored = buildTranscript([], { ...options, edits });
    const rows = transcriptLines(restored, 80);
    expect(rows.map(row => row.text).join("\n")).toContain(preview);
    const messages = [{ role: "tool" as const, tool_call_id: "saved", name: "edit_file", content: preview, editPreview: preview }];
    expect(buildTranscript(messages, { ...options, edits })).toHaveLength(1);
  });

  it("keeps both sides of a wide edit visible inside a one-line transcript row", () => {
    const preview = "Edited a.ts (+1 -1)\n     1 -old code\n     1 +new code";
    const blocks = buildTranscript(
      [{ role: "tool" as const, name: "edit_file", tool_call_id: "edit-1", content: preview, editPreview: preview }],
      { expanded: true, width: 120 },
    );
    const rows = transcriptLines(blocks, 120);
    const output = renderToString(
      <Box flexDirection="column">
        {rows.map(row => <Box key={row.id} height={1} flexShrink={0}><TranscriptLineView line={row} /></Box>)}
      </Box>,
      { columns: 120 },
    );
    // The split row must fill the row width; a content-sized box collapsed the
    // two halves to nothing and left only the divider, so the code vanished
    // until Ctrl+Y switched to the plain selectable renderer.
    const line = output.split("\n").find(text => text.includes("old code"));
    expect(line).toBeDefined();
    expect(line).toContain("│");
    expect(line).toContain("new code");
  });

  it("preserves Markdown styles across Chinese and emoji line wraps", () => {
    const text = "**中文😀加粗内容继续** `inline-code-long`";
    const rows = transcriptLines(buildTranscript([{ role: "assistant", content: text }], options), 10);
    const styled = rows.filter(row => row.spans?.length);
    expect(styled.length).toBeGreaterThan(2);
    expect(styled.map(row => row.text).join("")).toBe("中文😀加粗内容继续 inline-code-long");
    expect(styled.flatMap(row => row.spans ?? []).filter(span => span.bold).map(span => span.text).join("")).toBe("中文😀加粗内容继续");
    expect(styled.flatMap(row => row.spans ?? []).filter(span => span.code).map(span => span.text).join("")).toBe("inline-code-long");
    for (const row of styled) {
      expect(row.spans!.map(span => span.text).join("")).toBe(row.text);
      expect(displayWidth(row.text)).toBeLessThanOrEqual(10);
    }
    const output = renderToString(<Box flexDirection="column">{rows.map(row => <TranscriptLineView key={row.id} line={row} />)}</Box>, { columns: 10 });
    expect(output.split("\n")).toHaveLength(rows.length);
    expect(output).not.toContain("**");
    expect(output).not.toContain("`");
  });

  it("separates paragraphs and indents wrapped numbered list items", () => {
    const text = "## 结果\n\n已完成\n\n1. **abcdefghijklm**\n2. 下一项\n\n验证通过";
    const rows = transcriptLines(buildTranscript([{ role: "assistant", content: text }], options), 12);
    expect(rows.map(row => row.text)).toEqual([
      "luban", "结果", "", "已完成", "",
      "1. abcdefghi", "   jklm", "2. 下一项", "", "验证通过", "",
    ]);
    expect(rows.find(row => row.text === "   jklm")?.spans).toEqual([
      { text: "   " }, { text: "jklm", bold: true },
    ]);
    const restored = JSON.parse(JSON.stringify([{ role: "assistant", content: text }]));
    expect(transcriptLines(buildTranscript(restored, options), 12)).toEqual(rows);
  });

  it("copies formatted rows with link destinations and no style markers", () => {
    const text = "**完成**：查看 [文档](https://example.com/docs) 和 `代码`";
    const rows = transcriptLines(buildTranscript([{ role: "assistant", content: text }], options), 24);
    const last = rows.length - 2;
    const copied = selectedTranscriptText(rows.map(row => row.text), {
      anchor: { row: 1, column: 0 },
      focus: { row: last, column: displayWidth(rows[last]!.text) },
    });
    expect(copied).toBe(rows.slice(1, last + 1).map(row => row.text).join("\n"));
    expect(copied.replaceAll("\n", "")).toBe("完成：查看 文档 (https://example.com/docs) 和 代码");
  });

  it("shows user text literally with an explicit speaker", () => {
    const rows = transcriptLines(buildTranscript([{ role: "user", content: "# heading\n*literal*" }], options), 30);
    expect(rows.map(row => row.text)).toEqual(["你", "  # heading", "  *literal*", ""]);
  });
});
