import { describe, expect, it } from "vitest";
import { outcomeNote, type RunOutcome } from "./run-outcome.js";

describe("run outcome line", () => {
  it.each([
    ["completed", "✓ 任务已完成", "green"],
    ["failed", "✗ 任务执行失败", "red"],
    ["paused", "⏸ 任务已暂停", "yellow"],
    ["cancelled", "⊘ 任务已取消", "muted"],
  ] as const)("states %s explicitly", (status, text, tone) => {
    const note = outcomeNote({ status, text: "具体原因", steps: 3 });
    expect(note.text).toBe(`${text} · 3 步`);
    expect(note.tone).toBe(tone);
    expect(note.lines).toBe(1);
  });

  it("omits the step count when the run did not report one", () => {
    expect(outcomeNote({ status: "completed", text: "" }).text).toBe("✓ 任务已完成");
  });

  it("keeps a failed run's reason and next action in the transcript", () => {
    const note = outcomeNote({ status: "failed", text: "timeout", detail: "原因：模型请求重试后仍超时\n当前执行记录已保留；发送“继续”接着处理。" });
    expect(note.text).toContain("原因：模型请求重试后仍超时");
    expect(note.text).toContain("发送“继续”");
    expect(note.lines).toBe(3);
  });
});
