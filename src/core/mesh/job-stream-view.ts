import type { JobStreamRecord } from "./runtime.js";

/**
 * Reading a remote job's event stream.
 *
 * A job that ran on another node (or arrived from one) exposes the same
 * structured events as a local run, but the surfaces that show them were
 * written separately: the browser workbench derived its live line and timeline
 * in `web/client/timeline.ts`, while the terminal only ever read the last log
 * line. These helpers are transport-neutral so both read the stream the same
 * way, and so the reasoning is testable without a terminal or a socket.
 */

/** Seconds of silence after which a model call counts as stalled rather than slow. */
export const STALL_SECONDS = 25;

export type JobPhaseKind = "waiting" | "reasoning" | "responding" | "tool";

export interface JobPhaseSnapshot {
  kind: JobPhaseKind;
  /** Newest reasoning or answer line, or the summary of the running tool. */
  detail: string;
  /** Seconds spent in the current step: one model round trip or one tool run. */
  stepSeconds: number;
  /** Seconds since the job produced anything at all. */
  silentSeconds: number;
  /** A quiet *model* call is a stall; a tool is allowed to take as long as it takes. */
  stalled: boolean;
  /** Model round trips seen in this stream. */
  modelCalls: number;
}

export interface JobPlanStep { step: string; status: "pending" | "in_progress" | "completed" }
export interface JobPlan { explanation: string; plan: JobPlanStep[] }

/** Last non-empty line of a streamed buffer, for one-line summaries. */
function tailLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return (lines.at(-1) ?? "").slice(-160);
}

function defaultDetail(kind: JobPhaseKind): string {
  if (kind === "reasoning") return "正在推理…";
  return kind === "responding" ? "正在生成回复…" : "";
}

/**
 * What a remote job is doing right now.
 *
 * Returns null before the job has produced anything, which is the honest answer
 * for a job that is still queued: there is no step to report yet.
 */
export function jobPhase(records: JobStreamRecord[], now = Date.now() / 1000, stallSeconds = STALL_SECONDS): JobPhaseSnapshot | null {
  const last = records.at(-1);
  if (!last) return null;
  let modelCalls = 0;
  for (const record of records) if (record.event.kind === "model-call") modelCalls += 1;

  const newest = last.event.kind;
  const kind: JobPhaseKind = newest === "thinking" ? "reasoning"
    : newest === "delta" ? "responding"
      : newest === "tool-start" ? "tool"
        : "waiting";

  // Walk back to the start of the current step, collecting the prose it produced
  // so the detail is a real line rather than the last few streamed characters.
  let stepStartedAt = last.at;
  let toolDetail = "";
  const fragments: string[] = [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const { at, event } = records[index]!;
    if (event.kind === "model-call" || event.kind === "tool-start") {
      stepStartedAt = at;
      if (event.kind === "tool-start") toolDetail = event.summary;
      break;
    }
    if ((event.kind === "thinking" || event.kind === "delta") && fragments.length < 200) fragments.push(event.text);
  }
  const detail = toolDetail || tailLine(fragments.reverse().join("")) || defaultDetail(kind);
  const silentSeconds = Math.max(0, Math.round(now - last.at));
  return {
    kind,
    detail,
    stepSeconds: Math.max(0, Math.round(now - stepStartedAt)),
    silentSeconds,
    stalled: kind !== "tool" && silentSeconds >= stallSeconds,
    modelCalls,
  };
}

function parsePlan(args: Record<string, unknown>): JobPlan | undefined {
  if (!Array.isArray(args.plan) || args.plan.length < 1 || args.plan.length > 20) return undefined;
  const plan: JobPlanStep[] = [];
  for (const item of args.plan) {
    if (!item || typeof item !== "object") return undefined;
    const { step, status } = item as Record<string, unknown>;
    if (typeof step !== "string" || !step.trim()) return undefined;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") return undefined;
    plan.push({ step: step.trim().slice(0, 500), status });
  }
  return { explanation: typeof args.explanation === "string" ? args.explanation : "", plan };
}

/**
 * The task plan a remote job published, taken from its `update_plan` calls.
 *
 * A remote job's plan lives in the peer's session file, which this node cannot
 * read, so it is reconstructed from the call itself. The newest valid call wins,
 * matching how the runtime replaces a plan rather than appending to it.
 */
export function jobPlan(records: JobStreamRecord[]): JobPlan | undefined {
  let plan: JobPlan | undefined;
  for (const { event } of records) {
    if (event.kind !== "tool-start" || event.name !== "update_plan") continue;
    plan = parsePlan(event.args) ?? plan;
  }
  return plan;
}

/** Token totals the provider reported for this job. */
export function jobUsage(records: JobStreamRecord[]): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const { event } of records) {
    if (event.kind !== "usage") continue;
    input += event.input;
    output += event.output;
  }
  return { input, output };
}
