import { expect, it } from "vitest";
import { reasoningShare } from "./run-metrics.js";
import type { RunMetrics } from "./types.js";

const metrics = (requests: RunMetrics["requests"]): RunMetrics => ({ modelMs: 0, toolMs: 0, approvalMs: 0, compactions: 0, requests });

it("reports the slowest call and the reasoning share of a thinking-heavy run", () => {
  // The shape measured on a real voxel-garden run: one planning call burned
  // 145s and 24.6k reasoning tokens, the rest finished in seconds.
  const run = metrics([
    { index: 1, purpose: "task", elapsedMs: 145_000, ok: true, usage: { input: 6_948, output: 24_649, reasoning: 24_591 } },
    { index: 2, purpose: "task", elapsedMs: 28_000, ok: true, usage: { input: 30_000, output: 7_639, reasoning: 10 } },
    { index: 3, purpose: "task", elapsedMs: 3_000, ok: true, usage: { input: 40_000, output: 900, reasoning: 0 } },
  ]);
  expect(reasoningShare(run)).toEqual({ reasoning: 24_601, share: 24_601 / 33_188, index: 1, ms: 145_000 });
});

it("stays quiet when the model does not reason, so the hint is not noise", () => {
  const run = metrics([
    { index: 1, purpose: "task", elapsedMs: 9_000, ok: true, usage: { input: 1_000, output: 2_000 } },
    { index: 2, purpose: "task", elapsedMs: 4_000, ok: true, usage: { input: 2_000, output: 500, reasoning: 100 } },
  ]);
  expect(reasoningShare(run)).toBeUndefined();
});

it("ignores a run that never produced output", () => {
  expect(reasoningShare(metrics([{ index: 1, purpose: "task", elapsedMs: 1_000, ok: false }]))).toBeUndefined();
});
