import { expect, it } from "vitest";
import { sameTimelineItem } from "./timeline";
import type { TimelineItem, ToolRun } from "./types";

it("reuses replayed rows while admitting text, time, mode and outcome updates", () => {
  const assistant: TimelineItem = { kind: "assistant", id: "a", at: 1, text: "hello", streaming: true };
  expect(sameTimelineItem(assistant, { ...assistant })).toBe(true);
  for (const changed of [{ text: "hello again" }, { at: 2 }, { id: "b" }, { streaming: false }]) {
    expect(sameTimelineItem(assistant, { ...assistant, ...changed })).toBe(false);
  }
  const user: TimelineItem = { kind: "user", id: "u", at: 1, text: "hello", mode: "ask", jobId: "one" };
  expect(sameTimelineItem(user, { ...user, mode: "agent" })).toBe(false);
  expect(sameTimelineItem(user, { ...user, jobId: "two" })).toBe(false);
  const result: TimelineItem = { kind: "result", id: "r", at: 1, text: "done", status: "done" };
  expect(sameTimelineItem(result, { ...result, status: "failed" })).toBe(false);
  expect(sameTimelineItem(user, { kind: "assistant", id: "u", at: 1, text: "hello" })).toBe(false);
});

it("refreshes every tool field, especially completion status and durable edit records", () => {
  const run: ToolRun = { callId: "c", name: "edit_file", args: { path: "a.ts" }, summary: "edit a.ts", status: "running", seq: 1 };
  const item: TimelineItem = { kind: "tool", id: "t", at: 1, run };
  expect(sameTimelineItem(item, { ...item, run: { ...run } })).toBe(true);
  const updates: Partial<ToolRun>[] = [
    { callId: "next" }, { name: "bash" }, { args: { command: "echo hi" } }, { summary: "new summary" },
    { status: "done" }, { elapsedMs: 20 }, { preview: "output" }, { editPreview: "Edited a.ts (+1 -1)\n1 -old\n1 +new" }, { seq: 2 },
  ];
  for (const update of updates) expect(sameTimelineItem(item, { ...item, run: { ...run, ...update } })).toBe(false);
});
