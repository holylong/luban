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
});
