import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { STALL_SECONDS, ThinkingLine, type LivePhase } from "./thinking-line.js";

const now = Date.now();
const startedAt = now - 120_000;

function render(phase: LivePhase, overrides: Partial<Parameters<typeof ThinkingLine>[0]> = {}): string {
  return renderToString(
    <ThinkingLine
      phase={phase}
      callIndex={3}
      reasoning=""
      responding=""
      status=""
      startedAt={startedAt}
      lastOutputAt={now}
      characters={0}
      {...overrides}
    />,
    { columns: 120 },
  );
}

describe("working line", () => {
  it("names the phase and the model round trip in flight", () => {
    const output = render({ kind: "waiting", detail: "", since: now - 4_000 });
    expect(output).toContain("等待模型响应");
    expect(output).toContain("#3");
    expect(output).toContain("本步 4s");
    expect(output).toContain("总 120s");
  });

  it("shows the newest reasoning line while the model reasons", () => {
    const output = render({ kind: "reasoning", detail: "", since: now - 2_000 }, {
      reasoning: "检查 sandbox 的路径解析顺序", characters: 1_400,
    });
    expect(output).toContain("推理中");
    expect(output).toContain("检查 sandbox 的路径解析顺序");
    expect(output).toContain("1.4k 字");
  });

  it("counts the silence once a model call stops producing output", () => {
    // The whole point: a stalled request must not read as hard thinking.
    const output = render(
      { kind: "waiting", detail: "", since: now - 640_000 },
      { lastOutputAt: now - (STALL_SECONDS + 585) * 1_000, status: "模型已 600s 没有任何输出，中断本次请求" },
    );
    expect(output).toContain("已 610s 无输出");
    expect(output).toContain("模型已 600s 没有任何输出");
    expect(output).toContain("总 120s");
    expect(output).not.toContain("本步");
  });

  it("keeps a running tool legible without calling its silence a stall", () => {
    const output = render(
      { kind: "tool", detail: "Shell · npm run build", since: now - (STALL_SECONDS + 95) * 1_000 },
      { lastOutputAt: now - (STALL_SECONDS + 95) * 1_000 },
    );
    expect(output).toContain("执行工具");
    expect(output).toContain("Shell · npm run build");
    expect(output).toContain("已运行 120s");
    expect(output).not.toContain("无输出");
  });

  it("falls back to the answer, then the last reasoning line, then a placeholder", () => {
    const responding = (overrides: Partial<Parameters<typeof ThinkingLine>[0]>): string =>
      render({ kind: "responding", detail: "", since: now - 1_000 }, overrides);
    expect(responding({ responding: "现在修改 config.ts" })).toContain("现在修改 config.ts");
    expect(responding({ reasoning: "先看 config.ts 的默认值" })).toContain("先看 config.ts 的默认值");
    expect(responding({})).toContain("正在生成回复…");
  });

  it("stays on one row when the reasoning line is longer than the terminal", () => {
    // A wrapped row changes the frame height mid-stream, which shifts the whole
    // transcript up and down and reads as flicker. The detail column must be
    // allowed to shrink below its content width so the metrics stay on the row.
    const long = "检查 sandbox 的路径解析顺序".repeat(12);
    for (const columns of [30, 40, 60, 80, 120]) {
      const output = renderToString(
        <ThinkingLine
          phase={{ kind: "reasoning", detail: "", since: now - 12_000 }}
          callIndex={3}
          reasoning={long}
          responding=""
          status=""
          startedAt={startedAt}
          lastOutputAt={now}
          characters={4_300}
        />,
        { columns },
      );
      expect(output.split("\n").filter((line) => line.trim()).length, `columns=${columns}`).toBe(1);
      // The metrics are the reason the row must not wrap: they stay on the row and
      // clip only when the terminal is too narrow for them at all.
      if (columns >= 60) expect(output, `columns=${columns}`).toContain("4.3k 字");
    }
  });
});
