import type { RunMetrics } from "./types.js";

/**
 * Where a slow run actually went.
 *
 * A run that feels slow almost always has one or two calls that dominate: a
 * model may spend 145s and 24k hidden reasoning tokens on a single planning
 * turn while the other forty calls finish in seconds. Reporting the slowest
 * call next to the reasoning share is what separates "the tool is slow" from
 * "this model thinks too long here".
 */
export interface ReasoningShare {
  /** Reasoning tokens summed over every request in the run. */
  reasoning: number;
  /** Reasoning tokens divided by all output tokens. */
  share: number;
  /** 1-based index of the slowest request. */
  index: number;
  /** Latency of that slowest request, in milliseconds. */
  ms: number;
}

/**
 * Only worth reporting when thinking is a real part of the bill: inference
 * that never reasons is already explained by `s/call`, and a hint that fires on
 * every run is noise.
 */
export function reasoningShare(metrics: RunMetrics, threshold = 0.3): ReasoningShare | undefined {
  let reasoning = 0;
  let output = 0;
  let slowest: RunMetrics["requests"][number] | undefined;
  for (const request of metrics.requests) {
    reasoning += request.usage?.reasoning ?? 0;
    output += request.usage?.output ?? 0;
    if (!slowest || request.elapsedMs > slowest.elapsedMs) slowest = request;
  }
  if (!output || !slowest) return undefined;
  const share = reasoning / output;
  return share >= threshold ? { reasoning, share, index: slowest.index, ms: slowest.elapsedMs } : undefined;
}
