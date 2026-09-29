import React from "react";
import { renderToString, Box } from "ink";
import { describe, expect, it } from "vitest";
import { transcriptLines, TranscriptLineView } from "./transcript-lines.js";
import { buildTranscript } from "./transcript-blocks.js";
import { listWindow } from "./scroll.js";
import { displayWidth } from "./input-layout.js";

const options = { expanded: true, width: 30 };
describe("physical transcript rows", () => {
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

  it("shows user text literally with an explicit speaker", () => {
    const rows = transcriptLines(buildTranscript([{ role: "user", content: "# heading\n*literal*" }], options), 30);
    expect(rows.map(row => row.text)).toEqual(["你", "  # heading", "  *literal*", ""]);
  });
});
