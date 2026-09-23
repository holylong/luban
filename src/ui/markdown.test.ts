import { describe, expect, it } from "vitest";
import { parseMarkdownBlocks } from "./markdown.js";

describe("parseMarkdownBlocks", () => {
  it("recognizes the terminal markdown elements used in agent replies", () => {
    expect(parseMarkdownBlocks("# Result\n\n- done\n\n```ts\nconst ok = true;\n```"))
      .toEqual([
        { kind: "heading", content: "Result", level: 1 },
        { kind: "list", content: "done" },
        { kind: "code", content: "const ok = true;", language: "ts" },
      ]);
  });

  it("preserves regular multiline paragraphs", () => {
    expect(parseMarkdownBlocks("one\ntwo"))
      .toEqual([{ kind: "paragraph", content: "one\ntwo" }]);
  });
});
