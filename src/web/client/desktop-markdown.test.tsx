import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isMarkdownPath, isPreviewShortcut, previewAction, previewSource } from "./desktop-markdown";
import { MarkdownDocument } from "./desktop-markdown-view";

it("offers the preview only for Markdown documents", () => {
  expect(isMarkdownPath("README.md")).toBe(true);
  expect(isMarkdownPath("/work/docs/guide.MARKDOWN")).toBe(true);
  expect(isMarkdownPath("notes/a.mdx")).toBe(true);
  expect(isMarkdownPath("CHANGELOG.mdown")).toBe(true);
  expect(isMarkdownPath("src/app.tsx")).toBe(false);
  expect(isMarkdownPath("notes.md.bak")).toBe(false);
  expect(isMarkdownPath("markdown")).toBe(false);
  expect(isMarkdownPath("")).toBe(false);
});

it("labels the toggle with the mode it switches to", () => {
  expect(previewAction("src/app.ts", false)).toBeNull();
  expect(previewAction("README.md", false)).toMatchObject({ label: "预览", pressed: false });
  expect(previewAction("README.md", true)).toMatchObject({ label: "编辑", pressed: true });
  expect(previewAction("README.md", false).title).toContain("⌘/Ctrl+Shift+V");
});

it("toggles on ⌘/Ctrl+Shift+V but never swallows plain paste", () => {
  expect(isPreviewShortcut({ key: "v", metaKey: true, shiftKey: true })).toBe(true);
  expect(isPreviewShortcut({ key: "V", ctrlKey: true, shiftKey: true })).toBe(true);
  expect(isPreviewShortcut({ key: "v", metaKey: true, shiftKey: false })).toBe(false);
  expect(isPreviewShortcut({ key: "v", shiftKey: true })).toBe(false);
  expect(isPreviewShortcut({ key: "s", metaKey: true, shiftKey: true })).toBe(false);
});

it("renders the live buffer as a document and escapes its HTML", () => {
  const html = renderToStaticMarkup(<MarkdownDocument path="README.md" content={"# 标题\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n\n<script>alert(1)</script>"} />);
  expect(html).toContain('class="desktop-markdown-doc"');
  expect(html).toContain('aria-label="预览 README.md"');
  expect(html).toContain("<h1>标题</h1>");
  expect(html).toContain("<th>a</th>");
  expect(html).toContain('class="tok-key">const');
  // Raw HTML in the buffer is markup, not text: the preview drops it instead
  // of printing tag soup, and never injects it either.
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("alert(1)");
});

it("says the document is empty instead of rendering a blank page", () => {
  const html = renderToStaticMarkup(<MarkdownDocument path="notes.md" content={"  \n"} />);
  expect(html).toContain("desktop-markdown-empty");
  expect(html).toContain("这个文件还是空的");
});

it("styles the preview as a reading column and lights the active toggle", () => {
  const css = readFileSync(new URL("./desktop.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.desktop-markdown-doc\s*\{[^}]*overflow: auto/);
  expect(css).toMatch(/\.desktop-markdown-page\s*\{[^}]*max-width: 860px/);
  expect(css).toMatch(/\.desktop-markdown-doc \.md h1[^{]*\{[^}]*border-bottom/);
  expect(css).toMatch(/\.desktop-preview-toggle\.on\s*\{[^}]*color: var\(--blue\)/);
});

it("strips README HTML but keeps the text inside it", () => {
  const source = previewSource('<div align="center">\n<!-- logo -->\n<img src="assets/luban.png" alt="luban" />\n\n# luban-plugins\n<sub>one JSON catalog</sub></div>\n\n<a href="https://example.com">站点</a>');
  expect(source).not.toContain("<div");
  expect(source).not.toContain("<img");
  expect(source).not.toContain("<!--");
  expect(source).toContain("# luban-plugins");
  expect(source).toContain("one JSON catalog");
  expect(source).toContain("![luban](assets/luban.png)");
  expect(source).toContain("[站点](https://example.com)");
  // A hard break inside a table cell must not split the row.
  expect(previewSource("| a | b |\n| --- | --- |\n| 1<br>2 | 3 |")).toContain("| 1 2 | 3 |");
});
