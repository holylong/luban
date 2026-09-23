import type { TranscriptBlock } from "./transcript-blocks.js";

export interface RunOutcome {
  status: "completed" | "failed" | "paused" | "cancelled";
  text: string;
  steps?: number;
  /** Model round-trips and wall time, so "it felt slow" becomes a number. */
  modelCalls?: number;
  elapsedMs?: number;
}

const PRESENTATION: Record<RunOutcome["status"], { icon: string; label: string; tone: NonNullable<TranscriptBlock["tone"]> }> = {
  completed: { icon: "✓", label: "任务已完成", tone: "green" },
  paused: { icon: "⏸", label: "任务已暂停", tone: "yellow" },
  cancelled: { icon: "⊘", label: "任务已取消", tone: "muted" },
  failed: { icon: "✗", label: "任务执行失败", tone: "red" },
};

/**
 * One line appended to the transcript when a run reaches a terminal state.
 *
 * It used to be a bordered box of its own, which split the console into
 * fragments; as the last block of the single stream it stays in reading order
 * and the answer above it already carries the text.
 */
export function outcomeNote(outcome: RunOutcome): TranscriptBlock {
  const presentation = PRESENTATION[outcome.status];
  return {
    id: "outcome",
    kind: "note",
    tone: presentation.tone,
    lines: 1,
    text: `${presentation.icon} ${presentation.label}${outcome.steps === undefined ? "" : ` · ${outcome.steps} 步`}${outcome.modelCalls ? ` · ${outcome.modelCalls} 次模型调用` : ""}${outcome.elapsedMs ? ` · ${(outcome.elapsedMs / 1000).toFixed(1)}s` : ""}`,
  };
}
