import { describe, expect, it } from "vitest";
import { parseMarkdownBlocks, parseMarkdownInline } from "./markdown.js";

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

  it("preserves ordered list numbers and delimiters", () => {
    expect(parseMarkdownBlocks("1. First\n2) Second\n- Last")).toEqual([
      { kind: "list", content: "First", marker: "1." },
      { kind: "list", content: "Second", marker: "2)" },
      { kind: "list", content: "Last" },
    ]);
  });

  it("keeps inline styles separate from visible text", () => {
    expect(parseMarkdownInline("完成 **加粗 `代码`** 与 __重点__、*强调*、~~删除~~")).toEqual([
      { text: "完成 " },
      { text: "加粗 ", bold: true },
      { text: "代码", code: true, bold: true },
      { text: " 与 " },
      { text: "重点", bold: true },
      { text: "、" },
      { text: "强调", italic: true },
      { text: "、" },
      { text: "删除", strike: true },
    ]);
  });

  it("retains link destinations and literal code contents", () => {
    expect(parseMarkdownInline("[文档](https://example.com/docs) `**literal**`")).toEqual([
      { text: "文档", link: true },
      { text: " (https://example.com/docs)", link: true },
      { text: " " },
      { text: "**literal**", code: true },
    ]);
    expect(parseMarkdownInline("正在输出 **")).toEqual([{ text: "正在输出 **" }]);
  });
});
