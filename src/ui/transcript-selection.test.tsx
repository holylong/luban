import { describe, expect, it } from "vitest";
import { selectedTranscriptText, selectionSpan } from "./transcript-selection.js";

describe("transcript selection", () => {
  it("copies a drag across wrapped rows in either direction", () => {
    const lines = ["abc中文", "next line", "tail"];
    const selection = { anchor: { row: 2, column: 2 }, focus: { row: 0, column: 3 } };
    expect(selectedTranscriptText(lines, selection)).toBe("中文\nnext line\nta");
    expect(selectionSpan(lines[0]!, 0, selection)).toEqual({ start: 3, end: 5 });
  });

  it("returns no span outside the selection range", () => {
    const selection = { anchor: { row: 1, column: 0 }, focus: { row: 1, column: 4 } };
    expect(selectionSpan("abcdef", 0, selection)).toBeNull();
    expect(selectionSpan("abcdef", 2, selection)).toBeNull();
  });

  it("treats an empty selection as no span", () => {
    const selection = { anchor: { row: 0, column: 2 }, focus: { row: 0, column: 2 } };
    expect(selectionSpan("abcdef", 0, selection)).toBeNull();
  });
});
