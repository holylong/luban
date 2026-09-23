import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";

const SPINNER_FRAMES = ["⬒", "⬔", "⬓", "⬕"] as const;

export function Spinner({ color = theme.muted }: { color?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((value) => (value + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(timer);
  }, []);
  return <Text color={color}>{SPINNER_FRAMES[frame]}</Text>;
}

/** Which part of the agent loop is spending the wall-clock time right now. */
export type LivePhaseKind = "waiting" | "reasoning" | "responding" | "tool";

export interface LivePhase {
  kind: LivePhaseKind;
  detail: string;
  since: number;
}

export const PHASE_LABELS: Record<LivePhaseKind, string> = {
  waiting: "等待模型响应",
  reasoning: "推理中",
  responding: "生成回复",
  tool: "执行工具",
};

/** Seconds of no output before the live line says so instead of looking busy. */
export const STALL_SECONDS = 25;

/**
 * One line that keeps changing while the model works.
 *
 * A run with a reasoning model can be silent for a long time, and a bare
 * spinner reads as "stuck". The newest reasoning line is shown as it arrives,
 * truncated to the row, next to the elapsed time and how much has been
 * produced — so progress is visible without the reasoning entering the
 * transcript or the saved session.
 *
 * The line also names the phase and the model round trip in flight, because the
 * genuinely confusing case is not "thinking hard", it is a request that never
 * comes back: an idle stream is only aborted after the configured idle timeout
 * (ten minutes by default) and is then retried, so a stalled provider can burn
 * a long time while a bare spinner claims the agent is working. Once the phase
 * goes quiet the silence is counted in seconds and highlighted, and the retry
 * that follows is written into the transcript by the client's notice.
 */
export function ThinkingLine({ phase, callIndex, prefix = "", reasoning, responding, status, startedAt, lastOutputAt, characters }: {
  phase: LivePhase;
  callIndex: number;
  /** Marks whose work this is, e.g. a peer name for a remote job. */
  prefix?: string;
  reasoning: string;
  responding: string;
  status: string;
  startedAt: number | null;
  lastOutputAt: number;
  characters: number;
}) {
  const now = Date.now();
  const totalSeconds = startedAt ? Math.floor((now - startedAt) / 1000) : 0;
  const phaseSeconds = Math.max(0, Math.floor((now - phase.since) / 1000));
  const silentSeconds = Math.max(0, Math.floor((now - Math.max(lastOutputAt, phase.since)) / 1000));
  // A tool is expected to be quiet for as long as it runs, and its own elapsed
  // time already says so; a *model* call going quiet is the warning.
  const stalled = phase.kind !== "tool" && silentSeconds >= STALL_SECONDS;
  const detail = phase.kind === "reasoning" ? (reasoning || "正在推理…")
    : phase.kind === "responding" ? (responding || reasoning || "正在生成回复…")
      : phase.kind === "tool" ? phase.detail
        : status || phase.detail || "正在发送请求…";
  const produced = phase.kind === "reasoning" && characters > 0
    ? characters >= 1000 ? ` · ${(characters / 1000).toFixed(1)}k 字` : ` · ${characters} 字`
    : "";
  const metrics = stalled
    // The silence is the story once it dominates: it is what the idle timeout
    // and the retry notices are counting down against.
    ? `已 ${silentSeconds}s 无输出 · 总 ${totalSeconds}s`
    : `${phase.kind === "tool" ? "已运行" : "本步"} ${phaseSeconds}s · 总 ${totalSeconds}s${produced}`;
  return (
    <Box paddingLeft={3} height={1} flexShrink={0}>
      <Spinner color={stalled ? theme.yellow : theme.muted} />
      {prefix ? <Text color={theme.accent} bold>{` ${prefix}`}</Text> : null}
      <Text color={stalled ? theme.yellow : theme.accent} bold> {PHASE_LABELS[phase.kind]}</Text>
      {callIndex > 0 ? <Text color={theme.muted}>{` #${callIndex}`}</Text> : null}
      <Box marginLeft={1} flexGrow={1} flexShrink={1} overflow="hidden">
        <Text color={stalled ? theme.yellow : theme.dim} wrap="truncate-end">{detail}</Text>
      </Box>
      <Text color={stalled ? theme.yellow : theme.dim}>{metrics}</Text>
    </Box>
  );
}
