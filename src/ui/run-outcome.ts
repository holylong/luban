import type { RunMetrics } from "../core/types.js";
import type { TranscriptBlock } from "./transcript-blocks.js";

export interface RunOutcome {
  status: "completed" | "failed" | "paused" | "cancelled";
  text: string;
  /** Short, actionable conclusion shown when execution cannot finish. */
  detail?: string;
  steps?: number;
  /** Model round-trips and wall time, so "it felt slow" becomes a number. */
  modelCalls?: number;
  elapsedMs?: number;
  metrics?: RunMetrics;
}

const PRESENTATION: Record<RunOutcome["status"], { icon: string; label: string; tone: NonNullable<TranscriptBlock["tone"]> }> = {
  completed: { icon: "✓", label: "任务已完成", tone: "green" },
  paused: { icon: "⏸", label: "任务已暂停", tone: "yellow" },
  cancelled: { icon: "⊘", label: "任务已取消", tone: "muted" },
  failed: { icon: "✗", label: "任务执行失败", tone: "red" },
};

/**
 * A final status and, on failure, a short conclusion in the transcript.
 *
 * It used to be a bordered box of its own, which split the console into
 * fragments; as the last block of the single stream it stays in reading order
 * and the answer above it already carries the text.
 */
export function outcomeNote(outcome: RunOutcome): TranscriptBlock {
  const presentation = PRESENTATION[outcome.status];
  const detail = outcome.status === "failed" ? outcome.detail?.trim() : undefined;
  const timing = outcome.metrics ? `\n模型 ${(outcome.metrics.modelMs / 1000).toFixed(1)}s · 工具累计 ${(outcome.metrics.toolMs / 1000).toFixed(1)}s · 审批 ${(outcome.metrics.approvalMs / 1000).toFixed(1)}s · 压缩 ${outcome.metrics.compactions} 次` : "";
  return {
    id: "outcome",
    kind: "note",
    tone: presentation.tone,
    lines: 1 + (detail ? detail.split("\n").length : 0) + (timing ? 1 : 0),
    text: `${presentation.icon} ${presentation.label}${outcome.steps === undefined ? "" : ` · ${outcome.steps} 步`}${outcome.modelCalls ? ` · ${outcome.modelCalls} 次模型调用` : ""}${outcome.elapsedMs ? ` · ${(outcome.elapsedMs / 1000).toFixed(1)}s` : ""}${timing}${detail ? `\n${detail}` : ""}`,
  };
}
