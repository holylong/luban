import React from "react";
import { describe, expect, it } from "vitest";
import { SelectableTranscriptLine } from "./transcript-lines.js";
import { selectedTranscriptText, selectionSpan } from "./transcript-selection.js";
import { theme } from "./theme.js";

describe("transcript selection", () => {
  it("copies a drag across wrapped rows in either direction", () => {
    const lines = ["abc中文", "next line", "tail"];
    const selection = { anchor: { row: 2, column: 2 }, focus: { row: 0, column: 3 } };
    expect(selectedTranscriptText(lines, selection)).toBe("中文\nnext line\nta");
    expect(selectionSpan(lines[0]!, 0, selection)).toEqual({ start: 3, end: 5 });
  });

  it("renders the selected slice with the accent background", () => {
    const line = { id: "one", text: "answer", kind: "text" as const };
    const element = SelectableTranscriptLine({ line, span: { start: 1, end: 4 } });
    const fragment = element.props.children as React.ReactElement<{ children: React.ReactNode }>;
    const parts = React.Children.toArray(fragment.props.children) as Array<React.ReactElement<{
      backgroundColor?: string; children?: React.ReactNode;
    }> | string>;
    const textOf = (part: (typeof parts)[number]): React.ReactNode => typeof part === "string" ? part : part.props.children;
    const highlighted = parts.find((part) => typeof part !== "string" && part.props.backgroundColor);
    expect(textOf(highlighted!)).toBe("nsw");
    expect((highlighted as React.ReactElement<{ backgroundColor?: string }>).props.backgroundColor).toBe(theme.accent);
    expect(parts.filter((part) => typeof part === "string" || !part.props.backgroundColor).map(textOf)).toEqual(["a", "er"]);
  });

  it("renders the row unhighlighted when nothing is selected", () => {
    const line = { id: "one", text: "answer", kind: "text" as const };
    const element = SelectableTranscriptLine({ line, span: null });
    expect(element.props.children).toBe("answer");
  });
});
