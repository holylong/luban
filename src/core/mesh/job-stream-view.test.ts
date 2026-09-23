import { describe, expect, it } from "vitest";
import { jobPhase, jobPlan, jobUsage, STALL_SECONDS } from "./job-stream-view.js";
import type { JobStreamEvent, JobStreamRecord } from "./runtime.js";

const base = 1_700_000_000;
const at = (seq: number, offset: number, event: JobStreamEvent): JobStreamRecord => ({ seq, at: base + offset, event });

describe("jobPhase", () => {
  it("reports the phase, the step clock and the model round trips", () => {
    const records = [
      at(1, 0, { kind: "status", text: "start" }),
      at(2, 1, { kind: "model-call", index: 1 }),
      at(3, 4, { kind: "thinking", text: "先读" }),
      at(4, 5, { kind: "thinking", text: " config.ts 的默认值" }),
    ];
    expect(jobPhase(records, base + 30)).toMatchObject({
      kind: "reasoning",
      detail: "先读 config.ts 的默认值",
      stepSeconds: 29,
      silentSeconds: 25,
      stalled: true,
      modelCalls: 1,
    });
  });

  it("calls a quiet model call stalled but never a running tool", () => {
    const modelCall = [at(1, 0, { kind: "model-call", index: 2 }), at(2, 1, { kind: "delta", text: "hel" })];
    expect(jobPhase(modelCall, base + 1 + STALL_SECONDS + 5)).toMatchObject({ kind: "responding", stalled: true, modelCalls: 1 });

    const tool = [at(1, 0, { kind: "model-call", index: 1 }), at(2, 1, {
      kind: "tool-start", callId: "c1", name: "bash", args: { command: "npm run build" }, summary: "npm run build",
    })];
    const phase = jobPhase(tool, base + 1 + STALL_SECONDS + 90);
    expect(phase).toMatchObject({ kind: "tool", detail: "npm run build", stalled: false });
    expect(phase!.silentSeconds).toBeGreaterThan(STALL_SECONDS);
  });

  it("asks for nothing before the stream has produced anything", () => {
    expect(jobPhase([])).toBeNull();
  });
});

describe("jobPlan", () => {
  const call = (seq: number, offset: number, args: unknown): JobStreamRecord =>
    at(seq, offset, { kind: "tool-start", callId: `c${seq}`, name: "update_plan", args: args as Record<string, unknown>, summary: "2 steps" });

  it("takes the newest valid plan a remote job published", () => {
    const records = [
      call(1, 0, { plan: [{ step: "read", status: "in_progress" }] }),
      call(2, 1, { explanation: "why", plan: [{ step: "read", status: "completed" }, { step: "write", status: "in_progress" }] }),
    ];
    expect(jobPlan(records)).toEqual({ explanation: "why", plan: [{ step: "read", status: "completed" }, { step: "write", status: "in_progress" }] });
  });

  it("ignores malformed plans and unrelated tools", () => {
    const records = [
      call(1, 0, { plan: [{ step: "read", status: "in_progress" }] }),
      call(2, 1, { plan: [{ step: "read", status: "nonsense" }] }),
      call(3, 2, { plan: [] }),
      at(4, 3, { kind: "tool-start", callId: "c4", name: "bash", args: { command: "ls" }, summary: "ls" }),
      at(5, 4, { kind: "delta", text: "done" }),
    ];
    expect(jobPlan(records)).toEqual({ explanation: "", plan: [{ step: "read", status: "in_progress" }] });
    expect(jobPlan([at(1, 0, { kind: "status", text: "start" })])).toBeUndefined();
  });
});

describe("jobUsage", () => {
  it("sums what the provider reported", () => {
    expect(jobUsage([
      at(1, 0, { kind: "usage", input: 10, output: 2 }),
      at(2, 1, { kind: "delta", text: "x" }),
      at(3, 2, { kind: "usage", input: 5, output: 7 }),
    ])).toEqual({ input: 15, output: 9 });
  });
});
