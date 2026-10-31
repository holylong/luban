import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Transcript, thinkingSummary } from "./transcript";
import type { MeshJob, TimelineItem } from "./types";

const job = { id: "j1", project_id: "p", instruction: "check", title: "check", status: "done", created_at: 1, updated_at: 2, logs: [] } as unknown as MeshJob;
const thinking: TimelineItem = { kind: "thinking", id: "think-1", at: 1, text: "先看目录\n再读入口\n最后跑测试" };

it("summarizes reasoning by line and character count", () => {
  expect(thinkingSummary("  ")).toBe("");
  expect(thinkingSummary("one line")).toBe("1 行 · 8 字");
  expect(thinkingSummary("a\nb\nc\n")).toBe("3 行 · 5 字");
});

it("keeps reasoning collapsed behind a one-line summary", () => {
  const html = renderToStaticMarkup(
    <Transcript job={job} events={[thinking]} onCancel={() => {}} onResume={() => {}} />,
  );
  expect(html).toContain("<details class=\"thinking-block\">");
  expect(html).not.toMatch(/<details[^>]*open/);
  expect(html).toContain("思考过程");
  expect(html).toContain(`3 行 · ${thinking.kind === "thinking" ? thinking.text.length : 0} 字`);
  expect(html).toContain("最后跑测试");
});
