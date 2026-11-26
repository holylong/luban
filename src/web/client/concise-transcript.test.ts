import { describe, expect, it } from "vitest";
import { conciseTimeline } from "./timeline";
import type { TimelineItem } from "./types";

const run = { callId: "call-1", name: "read_file", args: "{}", summary: "read_file src/a.ts", status: "done" as const, seq: 2 };

const items: TimelineItem[] = [
  { kind: "user", id: "u", text: "帮我修一下这个失败的测试", at: 1 },
  { kind: "thinking", id: "t", text: "先看看测试文件", at: 2 },
  { kind: "assistant", id: "a1", text: "我先读一下测试文件。", at: 3 },
  { kind: "tool", id: "tool-1", run, at: 4 },
  { kind: "status", id: "s1", text: "正在读取", at: 5 },
  { kind: "error", id: "e1", text: "命令失败：exit 1", at: 6 },
  { kind: "assistant", id: "a2", text: "已修复：断言改成了 3。", at: 7 },
];

describe("极简模式 transcript", () => {
  it("keeps only the question, the failure and the conclusion", () => {
    const kept = conciseTimeline(items);
    expect(kept.map(item => item.kind)).toEqual(["user", "error", "assistant"]);
    expect(kept.at(-1)).toMatchObject({ text: "已修复：断言改成了 3。" });
  });

  it("drops narration that a later step superseded", () => {
    const narration = conciseTimeline(items).filter(item => item.kind === "assistant");
    expect(narration).toHaveLength(1);
    expect(narration[0]).toMatchObject({ id: "a2" });
  });

  it("leaves the full record untouched when the switch is off", () => {
    expect(items).toHaveLength(7);
    expect(conciseTimeline(items).length).toBeLessThan(items.length);
  });

  it("keeps an uncovered answer whole, including its thinking", () => {
    const only: TimelineItem[] = [
      { kind: "user", id: "u", text: "1+1 等于几", at: 1 },
      { kind: "thinking", id: "t", text: "简单", at: 2 },
      { kind: "assistant", id: "a", text: "2", at: 3 },
      { kind: "result", id: "r", text: "2", at: 4, status: "done" },
    ];
    expect(conciseTimeline(only).map(item => item.kind)).toEqual(["user", "assistant", "result"]);
  });
});
