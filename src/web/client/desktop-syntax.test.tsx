import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { HighlightedCode, editorLanguage, highlightable, MAX_HIGHLIGHT_CHARS } from "./desktop-syntax";

it("derives a tokenizer language from the file name", () => {
  expect(editorLanguage("src/web/client/desktop.tsx")).toBe("tsx");
  expect(editorLanguage("/tmp/a/b/app.TS")).toBe("ts");
  expect(editorLanguage("Makefile")).toBe("makefile");
  expect(editorLanguage(".gitignore")).toBe("gitignore");
  expect(editorLanguage("")).toBe("");
});

it("paints keywords, strings, numbers and comments as tokens", () => {
  const html = renderToStaticMarkup(<HighlightedCode content={'const count = 42; // note\nconst name = "luban";'} language="ts" />);
  expect(html).toContain('class="tok-key">const');
  expect(html).toContain('class="tok-num">42');
  expect(html).toContain('class="tok-com">// note');
  expect(html).toContain('class="tok-str">&quot;luban&quot;');
});

it("keeps every line break and escapes buffer text", () => {
  const html = renderToStaticMarkup(<HighlightedCode content={"a\n\nb <script>x</script>\n"} language="ts" />);
  expect(html).toContain("\n\n");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(renderToStaticMarkup(<HighlightedCode content="" language="ts" />)).toBe("");
});

it("falls back to plain text for oversized buffers", () => {
  expect(highlightable("x".repeat(MAX_HIGHLIGHT_CHARS))).toBe(true);
  expect(highlightable("x".repeat(MAX_HIGHLIGHT_CHARS + 1))).toBe(false);
  expect(highlightable("\n".repeat(5_000))).toBe(false);
});

it("aligns the highlight layer with the textarea", () => {
  const css = readFileSync(new URL("./desktop.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.desktop-code-highlight\s*\{[^}]*font: 13px\/21px var\(--mono\)/);
  expect(css).toMatch(/\.desktop-code-highlight\s*\{[^}]*padding: 12px/);
  expect(css).toMatch(/\.desktop-code-highlight\s*\{[^}]*pointer-events: none/);
  expect(css).toMatch(/textarea\.highlighted\s*\{[^}]*color: transparent[^}]*caret-color: var\(--fg\)/);
  expect(css).toMatch(/\.desktop-code-editor textarea, \.desktop-line-numbers\s*\{[^}]*font: 13px\/21px var\(--mono\)/);
});
