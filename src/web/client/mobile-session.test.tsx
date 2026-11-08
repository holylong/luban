import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MobileSessionHistory, sessionTimeline } from "./mobile-session";
import type { SessionDetail } from "./types";

function fixture(): SessionDetail {
  return {
    id: "session-a", title: "修复构建", project: "project", workspace: "/workspace", model: "test", mode: "agent",
    createdAt: "2026-11-08T00:00:00Z", updatedAt: "2026-11-08T00:00:00Z",
    messages: [
      { role: "system", content: "private harness" },
      { role: "user", content: "修复项目" },
      { role: "assistant", content: "检查配置", tool_calls: [{ id: "edit", type: "function", function: { name: "edit_file", arguments: '{"path":"a.ts"}' } }] },
      { role: "tool", tool_call_id: "edit", content: "已修改" },
      { role: "assistant", content: "历史答案" },
    ],
    edits: [{ id: "edit", name: "edit_file", preview: "Edited a.ts (+1 -1)\n1 -old\n1 +new" }],
  };
}

describe("mobile session transcript", () => {
  it("shows durable conversation, tool results and inline edits, never the system prompt", () => {
    const session = fixture();
    const items = sessionTimeline(session);
    const tool = items.find(item => item.kind === "tool");
    expect(tool).toMatchObject({ run: { callId: "edit", args: { path: "a.ts" }, status: "done", preview: "已修改", editPreview: session.edits![0]!.preview } });
    const html = renderToStaticMarkup(<MobileSessionHistory session={session} renderTool={run => <pre>{run.editPreview}</pre>} />);
    expect(html).toContain("修复项目");
    expect(html).toContain("历史答案");
    expect(html).toContain("Edited a.ts");
    expect(html).not.toContain("private harness");
  });

  it("adds a running TUI replay without duplicating the opening user message", () => {
    const session = fixture();
    session.live = { running: true, events: [
      { seq: 1, at: Date.now() / 1000, event: { kind: "delta", text: "正在测试" } },
      { seq: 2, at: Date.now() / 1000, event: { kind: "tool-start", callId: "test", name: "bash", args: { command: "npm test" }, summary: "npm test" } },
    ] };
    expect(sessionTimeline(session).filter(item => item.kind === "user")).toHaveLength(1);
    expect(sessionTimeline(session)).toContainEqual(expect.objectContaining({ kind: "assistant", text: "正在测试" }));
    expect(sessionTimeline(session)).toContainEqual(expect.objectContaining({ kind: "tool", run: expect.objectContaining({ callId: "test", status: "running" }) }));
    const html = renderToStaticMarkup(<MobileSessionHistory session={session} renderTool={run => <pre>{run.summary}</pre>} />);
    expect(html).toContain("电脑正在执行");
    expect(html).toContain("npm test");
    session.live = { running: false, events: [] };
    session.messages.push({ role: "assistant", content: "测试完成" });
    const finished = renderToStaticMarkup(<MobileSessionHistory session={session} renderTool={() => null} />);
    expect(finished).toContain("测试完成");
    expect(finished).not.toContain("电脑正在执行");
  });
});
