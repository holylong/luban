import type { JobStreamRecord, MeshJob, TimelineItem, ToolRun } from "./types";

/**
 * Project a job's structured event stream onto transcript rows.
 *
 * The server keeps a bounded per-job event buffer, so this replays from the
 * first retained event. When the buffer has been trimmed the caller still has
 * the durable job record (`logs`, `result`), which supplies the opening
 * instruction and the final answer, and the replay simply starts mid-task.
 */
export function deriveTimeline(job: Pick<MeshJob, "id" | "instruction" | "created_at"> & { mode?: string }, events: JobStreamRecord[]): TimelineItem[] {
  const items: TimelineItem[] = [{
    kind: "user",
    id: `${job.id}-user`,
    text: job.instruction,
    at: job.created_at,
    jobId: job.id,
    mode: job.mode,
  }];
  const tools = new Map<string, ToolRun>();
  let assistant: { id: string; text: string; at: number } | undefined;

  const flushAssistant = (): void => {
    if (!assistant || !assistant.text) { assistant = undefined; return; }
    items.push({ kind: "assistant", id: assistant.id, text: assistant.text, at: assistant.at });
    assistant = undefined;
  };

  for (const record of events) {
    const event = record.event;
    switch (event.kind) {
      case "thinking":
        flushAssistant();
        items.push({ kind: "thinking", id: `think-${record.seq}`, text: event.text, at: record.at });
        break;
      case "status":
        flushAssistant();
        items.push({ kind: "status", id: `status-${record.seq}`, text: event.text, at: record.at });
        break;
      case "delta": {
        // Consecutive deltas belong to one assistant bubble; a tool call or a
        // new status closes it so ordering in the transcript stays truthful.
        if (!assistant) assistant = { id: `assistant-${record.seq}`, text: "", at: record.at };
        assistant.text += event.text;
        break;
      }
      case "tool-start": {
        flushAssistant();
        const run: ToolRun = {
          callId: event.callId, name: event.name, args: event.args, summary: event.summary,
          status: "running", seq: record.seq,
        };
        tools.set(event.callId, run);
        items.push({ kind: "tool", id: `tool-${event.callId}`, run, at: record.at });
        break;
      }
      case "tool-end": {
        flushAssistant();
        const existing = tools.get(event.callId);
        const run: ToolRun = existing
          ? { ...existing, status: event.ok ? "done" : "failed", elapsedMs: event.elapsedMs, preview: event.preview, editPreview: event.editPreview }
          : { callId: event.callId, name: event.name, args: {}, summary: event.name, status: event.ok ? "done" : "failed", elapsedMs: event.elapsedMs, preview: event.preview, editPreview: event.editPreview, seq: record.seq };
        tools.set(event.callId, run);
        const index = items.findIndex(item => item.kind === "tool" && item.run.callId === event.callId);
        if (index >= 0) items[index] = { kind: "tool", id: `tool-${event.callId}`, run, at: record.at };
        else items.push({ kind: "tool", id: `tool-${event.callId}`, run, at: record.at });
        break;
      }
      case "error":
        flushAssistant();
        items.push({ kind: "error", id: `error-${record.seq}`, text: event.text, at: record.at });
        break;
      case "usage":
        break;
      case "model-call":
        // Not a transcript row: it is what the live indicator is derived from.
        break;
      default:
        break;
    }
  }
  flushAssistant();
  return items;
}

/** Seconds of silence after which the console calls a round trip stalled. */
export const STALL_SECONDS = 25;

export interface LiveProgress {
  /** Phase name, matching the wording of the terminal's working line. */
  label: string;
  /** Newest reasoning or answer line, or the running tool's summary. */
  detail: string;
  /** Seconds spent in the current step. */
  seconds: number;
  /** Seconds since the job produced anything at all. */
  silentSeconds: number;
  stalled: boolean;
}

/** Last non-empty line of a streamed buffer, for the one-line detail. */
function tailLine(text: string): string {
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? "").slice(-160);
}

/**
 * What the running job is doing, reconstructed from the tail of the event
 * buffer.
 *
 * The terminal derives this from live callbacks; the console only sees the
 * event stream. Without it a request that never comes back is indistinguishable
 * from an agent that is thinking hard — and the idle timeout is ten minutes, so
 * that state can last a long time.
 */
export function liveProgress(events: JobStreamRecord[], now = Date.now() / 1000): LiveProgress | null {
  const last = events[events.length - 1];
  if (!last) return null;
  const newest = last.event.kind;
  const label = newest === "thinking" ? "推理中"
    : newest === "delta" ? "生成回复"
      : newest === "tool-start" ? "执行工具"
        : "等待模型响应";
  // Walk back to the start of this step, collecting the prose it produced so
  // the detail is a real line instead of the last couple of streamed characters.
  let phaseAt = last.at;
  let toolDetail = "";
  const fragments: string[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const record = events[index];
    const kind = record.event.kind;
    if (kind === "model-call" || kind === "tool-start") {
      phaseAt = record.at;
      if (record.event.kind === "tool-start") toolDetail = record.event.summary;
      break;
    }
    if ((kind === "thinking" || kind === "delta") && fragments.length < 200) fragments.push(record.event.text);
  }
  const seconds = Math.max(0, Math.round(now - phaseAt));
  const silentSeconds = Math.max(0, Math.round(now - last.at));
  const detail = toolDetail
    || tailLine([...fragments].reverse().join(""))
    || (newest === "thinking" ? "正在推理…" : newest === "delta" ? "正在生成回复…" : "");
  return {
    label, detail, seconds, silentSeconds,
    stalled: newest !== "tool-start" && silentSeconds >= STALL_SECONDS,
  };
}

/** Append the job outcome after the event-derived rows. */
export function withOutcome(items: TimelineItem[], job: MeshJob): TimelineItem[] {
  const active = ["queued", "pending", "working"].includes(job.status);
  if (active) return items;
  if (job.status === "cancelled") {
    return [...items, { kind: "result", id: `${job.id}-result`, text: job.error || "任务已取消", at: job.done_at ?? job.updated_at, status: job.status }];
  }
  if (job.status === "failed") {
    return [...items, { kind: "result", id: `${job.id}-result`, text: job.error || "任务失败", at: job.done_at ?? job.updated_at, status: job.status }];
  }
  // A paused job keeps its partial summary: it is what the user resumes from.
  const text = job.result || (job.status === "paused" ? "已达到步数上限，可继续执行。" : "");
  if (!text) return items;
  return [...items, { kind: "result", id: `${job.id}-result`, text, at: job.done_at ?? job.updated_at, status: job.status }];
}

const EDIT_TOOLS = /^(edit_file|write_file|apply_patch)$/u;

export function isEditRun(run: ToolRun): boolean {
  return EDIT_TOOLS.test(run.name) && Boolean(run.editPreview);
}

// The record format is owned by the runtime; re-exported here so browser
// components keep one import site while the parser stays single-sourced.
export { editRecordStats, editRecordTitle, parseEditRecord } from "../../core/edit-preview";
export type { EditRecordRow, EditRecordStats } from "../../core/edit-preview";

/** Human label for a tool call, matching the terminal surface. */
export const TOOL_LABELS: Record<string, string> = {
  bash: "Shell", read_file: "Read", edit_file: "Edit", write_file: "Write", apply_patch: "Patch",
  grep_files: "Search", glob_files: "Glob", list_dir: "List", web_fetch: "Fetch",
  read_image: "Image", delegate_task: "Delegate", update_plan: "Plan", read_plan: "Plan",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] || name;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function formatClock(seconds?: number | null): string {
  if (!seconds) return "";
  const date = new Date(seconds * 1000);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function relativeTime(seconds?: number | null): string {
  if (!seconds) return "";
  const delta = Math.max(0, Date.now() / 1000 - seconds);
  if (delta < 60) return `${Math.floor(delta)}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86_400)}d`;
}

export const STATUS_LABELS: Record<string, string> = {
  queued: "排队中", pending: "等待中", working: "执行中", paused: "已暂停",
  done: "已完成", failed: "失败", cancelled: "已取消",
};
