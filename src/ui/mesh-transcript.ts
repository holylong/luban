import { jobPhase } from "../core/mesh/job-stream-view.js";
import type { JobStreamRecord, MeshChatMessage } from "../core/mesh/runtime.js";
import type { ExecutionEntry } from "./execution-view.js";
import { estimateLines, toolTranscriptBlock, type TranscriptBlock } from "./transcript-blocks.js";
import { toolLabel } from "./tool-labels.js";

/**
 * A remote job rendered as transcript blocks.
 *
 * Work that arrives over the mesh used to show up as a single "last log line"
 * in a corner panel, so a task running on another node was a black box: no tool
 * calls, no edit records, no plan, no way to tell work from a hang. The events
 * for it were already being streamed and thrown away, so the same block model
 * that renders a local run is reused here — tool rows, inline edit records and
 * notes stay identical to local work, which is what makes the two comparable at
 * a glance.
 */

/** How many blocks one remote job may contribute, newest kept. */
export const MAX_REMOTE_BLOCKS = 240;
const TERMINAL = new Set(["done", "failed", "cancelled", "paused"]);

export interface RemoteJobView {
  id: string;
  source: string;
  target: string;
  status: string;
  instruction: string;
  title?: string;
  result?: string;
  error?: string;
}

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function note(id: string, text: string, tone: TranscriptBlock["tone"] = "muted"): TranscriptBlock {
  return { id, kind: "note", tone, lines: 1, text };
}

export interface RemoteJobBlockOptions {
  expanded: boolean;
  /** Usable text width, used only to estimate wrapped prose height. */
  width: number;
  /** This node's name, which decides whether the job is inbound or outbound. */
  localNode: string;
}

export function chatBlocks(chats: MeshChatMessage[], localNode: string, width: number): TranscriptBlock[] {
  return [...chats].reverse().flatMap((chat) => {
    const outbound = chat.from === localNode;
    const peer = outbound ? chat.to : chat.from;
    const stamp = new Date((chat.delivered_at ?? chat.received_at) * 1000).toLocaleTimeString();
    return [
      note(`mesh-chat-${chat.id}-head`, `${outbound ? "📤 发给" : "📨 来自"} ${peer} · ${stamp}`, "accent"),
      { id: `mesh-chat-${chat.id}-body`, kind: "assistant" as const, text: chat.text,
        lines: estimateLines(chat.text, width - 4) + 1 },
    ];
  });
}

export function jobBlocks(job: RemoteJobView, records: JobStreamRecord[], options: RemoteJobBlockOptions): TranscriptBlock[] {
  const { expanded, width, localNode } = options;
  const inbound = job.source !== localNode;
  const peer = inbound ? job.source : job.target;
  const blocks: TranscriptBlock[] = [note(
    `remote-${job.id}-head`,
    `${inbound ? "📥 来自" : "📤 已交给"} ${peer} · ${oneLine(job.instruction, 120)}`,
    "accent",
  )];

  // Consecutive deltas are one answer; a tool call or a note closes it, which is
  // the same grouping the local transcript uses.
  const positions = new Map<string, number>();
  let answer = "";
  let sawAnswer = false;
  const flushAnswer = (): void => {
    const text = answer.trim();
    answer = "";
    if (!text) return;
    sawAnswer = true;
    blocks.push({ id: `remote-${job.id}-answer-${blocks.length}`, kind: "assistant", text, lines: estimateLines(text, width - 4) + 1 });
  };

  for (const { seq, event } of records) {
    switch (event.kind) {
      case "delta":
        answer += event.text;
        break;
      // Reasoning stays on the live line, exactly as it does for a local run,
      // and the model-call/usage events only feed counters.
      case "thinking":
      case "model-call":
      case "usage":
        break;
      case "status":
        flushAnswer();
        blocks.push(note(`remote-${job.id}-status-${seq}`, event.text));
        break;
      case "error":
        flushAnswer();
        blocks.push(note(`remote-${job.id}-error-${seq}`, event.text, "red"));
        break;
      case "tool-start": {
        flushAnswer();
        const entry: ExecutionEntry = {
          name: toolLabel(event.name),
          detail: event.summary || oneLine(JSON.stringify(event.args), 160),
          status: "running",
        };
        positions.set(event.callId, blocks.length);
        blocks.push(toolTranscriptBlock(`remote-${job.id}-tool-${event.callId}`, entry, expanded));
        break;
      }
      case "tool-end": {
        flushAnswer();
        const index = positions.get(event.callId);
        const started = index === undefined ? undefined : blocks[index]?.entry;
        const entry: ExecutionEntry = {
          name: started?.name ?? toolLabel(event.name),
          detail: started?.detail ?? event.preview,
          status: event.ok ? "done" : "failed",
          elapsedMs: event.elapsedMs,
          preview: event.preview,
          ...(event.editPreview ? { editPreview: event.editPreview } : {}),
        };
        const block = toolTranscriptBlock(`remote-${job.id}-tool-${event.callId}`, entry, expanded);
        // Upgrade the row in place so the running call keeps its position, the
        // same way a local tool row does.
        if (index === undefined) { positions.set(event.callId, blocks.length); blocks.push(block); }
        else blocks[index] = block;
        break;
      }
    }
  }
  flushAnswer();

  if (TERMINAL.has(job.status)) {
    const calls = jobPhase(records)?.modelCalls ?? 0;
    const callsText = calls > 0 ? ` · ${calls} 次模型调用` : "";
    if (job.status === "failed" || job.status === "cancelled") {
      blocks.push(note(`remote-${job.id}-outcome`, `✗ ${job.status === "cancelled" ? "任务已取消" : "任务失败"} · ${oneLine(job.error || job.result || "", 160)}${callsText}`, "red"));
    } else {
      // The streamed answer already carried the text; the stored result is the
      // fallback for a job whose stream this node never saw from the start.
      if (!sawAnswer && job.result?.trim()) {
        blocks.push({ id: `remote-${job.id}-result`, kind: "assistant", text: job.result.trim(), lines: estimateLines(job.result, width - 4) + 1 });
      }
      const paused = job.status === "paused";
      blocks.push(note(`remote-${job.id}-outcome`, `${paused ? "⏸ 已暂停" : "✓ 任务完成"}${callsText}`, paused ? "yellow" : "green"));
    }
  }

  return blocks.length > MAX_REMOTE_BLOCKS ? blocks.slice(-MAX_REMOTE_BLOCKS) : blocks;
}
