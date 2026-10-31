import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { conversationEntries, historyBeforeRun } from "./desktop-conversation";
import { DesktopChanges, collectDesktopEdits } from "./desktop-changes";
import { DesktopSessionHistory } from "./desktop";
import { Transcript } from "./transcript";
import { Composer } from "./app";
import type { WorkbenchStore } from "./store";
import type { MeshJob, SessionDetail, SessionSummary, TimelineItem } from "./types";

const job = { id: "round2", session_id: "s1", project_id: "p", instruction: "next", title: "next", status: "working", created_at: 100, updated_at: 101 } as MeshJob;
const session = { id: "s1", title: "conversation", updatedAt: new Date(101000).toISOString(), messages: [
  { role: "user", content: "original question" }, { role: "assistant", content: "original answer" },
  { role: "user", content: "next" }, { role: "assistant", content: "new answer" },
], edits: [{ id: "edit1", name: "edit_file", preview: "+++ b/a.ts\n+newCode" }] } as SessionDetail;
const edit: TimelineItem = { kind: "tool", id: "edit1", at: 101, run: { callId: "edit1", name: "edit_file", summary: "a.ts", args: {}, status: "done", seq: 1, editPreview: "+++ b/a.ts\n+newCode" } };

describe("desktop continuous conversations", () => {
  it("groups multiple rounds into one session and excludes other projects", () => {
    const entries = conversationEntries([{ id: "s1", title: "conversation" } as SessionSummary], [job, { ...job, id: "round1", created_at: 99 }, { ...job, id: "other", session_id: "other", project_id: "other" }], "p");
    expect(entries).toHaveLength(1);
    expect(entries[0].job?.id).toBe("round2");
  });
  it("keeps earlier messages and current execution in one scrollable thread without duplicating current turn", () => {
    const history = historyBeforeRun(session, job);
    expect(history.messages).toHaveLength(2);
    const html = renderToStaticMarkup(<Transcript job={job} events={[{ kind: "user", id: "next", text: "next", at: 100 }, edit]} history={<DesktopSessionHistory session={history} />} onCancel={() => {}} onResume={() => {}} />);
    expect(html).toContain("original answer");
    expect(html).toContain("Agent 正在执行");
    expect(html).not.toContain("修改详情见中间代码区");
    expect(html).toContain("newCode");
  });
  it("does not cut a repeated instruction out of an older transcript snapshot", () => {
    const older = { ...session, updatedAt: new Date(99000).toISOString() };
    expect(historyBeforeRun(older, job)).toBe(older);
  });
  it("shows deduplicated edit details in the code area without touching editor buffers", () => {
    expect(collectDesktopEdits(session, [edit])).toHaveLength(1);
    const html = renderToStaticMarkup(<DesktopChanges timeline={[edit]} />);
    expect(html).toContain("newCode");
    expect(html).toContain("不覆盖编辑器未保存内容");
  });
  it("replaces the previous file in the center while keeping both in Agent", () => {
    const next: TimelineItem = { ...edit, id: "edit2", run: { ...edit.run, callId: "edit2", editPreview: "+++ b/b.ts\n+secondCode" } };
    const center = renderToStaticMarkup(<DesktopChanges timeline={[edit, next]} />);
    expect(center).toContain("secondCode");
    expect(center).not.toContain("newCode");
    const agent = renderToStaticMarkup(<Transcript job={job} events={[edit, next]} onCancel={() => {}} onResume={() => {}} />);
    expect(agent).toContain("newCode");
    expect(agent).toContain("secondCode");
    expect(renderToStaticMarkup(<DesktopChanges timeline={[]} />)).toBe("");
  });
  it("shows model-specific effort choices only once in the shared composer", () => {
    const store = { connected: true, busy: false, queued: [], mode: "edits", project: "p", events: [], node: { model_id: "codex/gpt", models: [{ id: "codex/gpt", name: "GPT", provider: "codex", reasoning_efforts: ["low", "high", "xhigh", "max"], reasoning_effort: "xhigh" }], projects: {} } } as unknown as WorkbenchStore;
    const html = renderToStaticMarkup(<Composer store={store} />);
    expect(html.match(/aria-label="模型"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="推理强度"');
    expect(html).toContain('value="xhigh" selected');
    store.node!.models[0].reasoning_efforts = [];
    expect(renderToStaticMarkup(<Composer store={store} />)).not.toContain('aria-label="推理强度"');
  });
  it("invites a queued follow-up while the current round is still running", () => {
    const store = {
      connected: true, busy: false, queued: ["跑一遍完整测试"], mode: "edits", project: "p", events: [],
      job: { ...job }, notify: () => {}, clearQueue: () => {}, leaveSession: () => {},
      node: { model_id: "codex/gpt", models: [{ id: "codex/gpt", name: "GPT", provider: "codex" }], projects: {} },
    } as unknown as WorkbenchStore;
    const html = renderToStaticMarkup(<Composer store={store} />);
    expect(html).toContain("发送后自动排队");
    expect(html).toContain("队列 1 条");
    expect(html).toContain("1 条已排队等待本轮结束");
    expect(html).toContain("停止任务");
  });
});
