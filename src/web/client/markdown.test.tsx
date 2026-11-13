import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Markdown } from "./markdown";

const html = (text: string): string => renderToStaticMarkup(<Markdown text={text} />);

it("gives a bold lead-in its own heading instead of burying it in prose", () => {
  const out = html("先说结论：可以。\n\n**契约**：`POST /match` 返回成员。\n\n**限制**：只支持本机。");
  expect(out).toContain('<h3 class="md-lead">契约</h3>');
  expect(out).toContain('<h3 class="md-lead">限制</h3>');
  // The label is a section header, not emphasis inside the paragraph.
  expect(out).not.toContain("<strong>契约</strong>");
  expect(out).toContain("<p><code class=\"inline\">POST /match</code> 返回成员。</p>");
});

it("moves a label's parenthetical beside the heading", () => {
  const out = html("**契约**（`identity.py`）：`POST /match` 返回成员。");
  expect(out).toContain('<h3 class="md-lead">契约<span class="md-lead-note"> <code class="inline">identity.py</code></span></h3>');
  expect(out).toContain('<p><code class="inline">POST /match</code> 返回成员。</p>');
});

it("keeps an emphasised sentence as emphasis", () => {
  const out = html("**是的，可以。** 具体来说只需要补一条兜底。");
  expect(out).not.toContain("md-lead");
  expect(out).toContain("<strong>是的，可以。</strong>");
});

it("breaks a one-sentence-per-line answer into separate paragraphs", () => {
  const out = html("修复了 A。\n修复了 B。\n测试全绿，没有新增失败。");
  expect(out.match(/<p>/gu)?.length).toBe(3);
  expect(out).toContain("<p>修复了 B。</p>");
});

it("joins a wrapped sentence without inventing spaces inside Chinese text", () => {
  expect(html("这一行没有说完\n继续写下一行")).toContain("<p>这一行没有说完继续写下一行</p>");
  expect(html("wrapped english line\ncontinues here")).toContain("<p>wrapped english line continues here</p>");
});

it("starts a new block at a label even without a blank line before it", () => {
  const out = html("第一段结论。\n**下一步**：跑全量测试。");
  expect(out).toContain('<h3 class="md-lead">下一步</h3>');
  expect(out).toContain("<p>第一段结论。</p>");
});

it("leaves headings, lists and tables untouched", () => {
  const out = html("## 结论\n\n- 甲\n- 乙\n\n| 项 | 值 |\n| --- | --- |\n| a | 1 |");
  expect(out).toContain("<h2>结论</h2>");
  expect(out).toContain("<li>甲</li>");
  expect(out).toContain("<table>");
  expect(out).not.toContain("md-lead");
});
