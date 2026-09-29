import type { ChatMessage, SessionRecord } from "../core/types.js";
import { summarizeToolArgs } from "../core/tools.js";
import { executionRows, type ExecutionEntry, type ExecutionRow } from "./execution-view.js";

/**
 * One link in the transcript chain.
 *
 * The console used to render the conversation and the execution records as two
 * independent paged windows, so the reader saw fragments and the wheel could
 * only drive one of them. Everything now becomes a block in a single ordered
 * stream, which gives one scroll position and one reading order.
 */
export interface TranscriptBlock {
  id: string;
  kind: "user" | "assistant" | "tool" | "note";
  /** Estimated height in terminal lines; tools are exact, prose is wrapped. */
  lines: number;
  text?: string;
  tone?: "muted" | "accent" | "red" | "green" | "yellow";
  entry?: ExecutionEntry;
  /** Pre-flattened, one-line rows for a tool call. */
  rows?: ExecutionRow[];
}

/**
 * Something the runtime reported while the run was in flight — a retry, an idle
 * timeout, a compaction. These used to live only in the live working line, so
 * the explanation for a failure disappeared the moment the run ended; they are
 * interleaved into the transcript instead, which is the only durable record.
 */
export interface TranscriptNote {
  id: string;
  text: string;
  /** Message count when it arrived, so it lands in the right place. */
  at: number;
  tone?: TranscriptBlock["tone"];
}

export interface TranscriptOptions {
  expanded: boolean;
  /** Usable text width, used only to estimate wrapped prose height. */
  width: number;
  notes?: TranscriptNote[];
  edits?: SessionRecord["edits"];
  executions?: Array<ExecutionEntry & { id: string }>;
}

export function estimateLines(text: string, width: number): number {
  const usable = Math.max(20, Math.trunc(width) || 20);
  let lines = 0;
  for (const raw of text.replaceAll("\r", "").split("\n")) {
    const visible = raw.replaceAll("\t", "  ").length;
    lines += Math.max(1, Math.ceil(visible / usable));
  }
  return Math.max(1, lines);
}

function note(id: string, text: string, tone: TranscriptBlock["tone"] = "muted"): TranscriptBlock {
  return { id, kind: "note", text, tone, lines: 1 };
}

function toolBlock(id: string, entry: ExecutionEntry, expanded: boolean, width: number): TranscriptBlock {
  const rows = executionRows([entry], expanded, width);
  return { id, kind: "tool", entry, rows, lines: Math.max(1, rows.length) };
}

/** Exported for transports that build the same rows from a remote job's events. */
export function toolTranscriptBlock(id: string, entry: ExecutionEntry, expanded: boolean, width: number): TranscriptBlock {
  return toolBlock(id, entry, expanded, width);
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function entryFromCall(name: string, args: Record<string, unknown>): ExecutionEntry {
  // Same summarizer as the live trace, so historical and live rows read alike.
  return { name, detail: summarizeToolArgs(name, args), status: "running" };
}

function applyResult(entry: ExecutionEntry, message: ChatMessage): ExecutionEntry {
  const content = String(message.content ?? "");
  return {
    ...entry,
    status: content.startsWith("TOOL ERROR:") ? "failed" : "done",
    preview: content.slice(0, 4000),
    editPreview: message.editPreview || (content.startsWith("Edited ") ? content : undefined),
  };
}

/**
 * Build the ordered transcript.
 *
 * The agent appends the assistant tool-call message and every tool result to
 * the session array as it works, so the message list is already the true
 * interleaving of prose and tool activity. Compaction can drop old tool
 * messages while their durable edit record survives, so those records are
 * replayed up front rather than lost.
 */
export function buildTranscript(messages: ChatMessage[], options: TranscriptOptions): TranscriptBlock[] {
  const { expanded, width } = options;
  const executions = new Map((options.executions ?? []).map(entry => [entry.id, entry]));
  const results = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (message.role === "tool" && message.tool_call_id) results.set(message.tool_call_id, message);
  }

  const blocks: TranscriptBlock[] = [];
  const rendered = new Set<string>();
  // Notes arrive while the run is in flight and are stamped with the number of
  // messages known at the time, so they read in order rather than collecting at
  // the end of the transcript.
  const notes = [...options.notes ?? []].sort((a, b) => a.at - b.at);
  const flushNotes = (index: number): void => {
    while (notes.length && notes[0]!.at <= index) {
      const entry = notes.shift()!;
      blocks.push(note(`activity-${entry.id}`, entry.text, entry.tone ?? "muted"));
    }
  };

  // Compaction stores edits separately from the model context.
  const known = new Set(results.keys());
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) if (call.id) known.add(call.id);
  }
  for (const edit of options.edits ?? []) {
    if (known.has(edit.id)) continue;
    blocks.push(toolBlock(`saved-edit-${edit.id}`, {
      name: edit.name, detail: "", status: "done", editPreview: edit.preview,
    }, expanded, width));
  }

  messages.forEach((message, index) => {
    flushNotes(index);
    const content = String(message.content ?? "");

    if (message.role === "system") {
      if (content.startsWith("[luban context summary]")) blocks.push(note(`summary-${index}`, "较早对话已压缩为摘要"));
      return;
    }

    if (message.role === "user") {
      if (content.startsWith("(summarized")) { blocks.push(note(`summary-user-${index}`, "较早对话已压缩为摘要")); return; }
      blocks.push({ id: `user-${index}`, kind: "user", text: content, lines: estimateLines(content, width - 6) + 3 });
      return;
    }

    if (message.role === "assistant") {
      const text = content.trim();
      if (text) blocks.push({ id: `assistant-${index}`, kind: "assistant", text, lines: estimateLines(text, width - 4) + 1 });
      for (const call of message.tool_calls ?? []) {
        const name = call.function.name || "tool";
        const entry = entryFromCall(name, parseArgs(call.function.arguments));
        if (call.id) rendered.add(call.id);
        const result = call.id ? results.get(call.id) : undefined;
        const settled = result ? applyResult(entry, result) : entry;
        // tool-end arrives before its result is appended to the session array.
        const live = call.id ? executions.get(call.id) : undefined;
        blocks.push(toolBlock(`call-${call.id || `${index}-${name}`}`, live ? { ...settled, ...live } : settled, expanded, width));
      }
      return;
    }

    if (message.role === "tool") {
      const id = message.tool_call_id || `tool-${index}`;
      if (rendered.has(id)) return;
      if (message.editPreview || content.startsWith("Edited ")) {
        const entry: ExecutionEntry = { name: message.name || "edit_file", detail: "", status: "done" };
        blocks.push(toolBlock(`tool-${index}`, applyResult(entry, message), expanded, width));
        return;
      }
      if (/^TOOL ERROR:/u.test(content.trim())) {
        const entry: ExecutionEntry = { name: message.name || "tool", detail: "", status: "failed" };
        blocks.push(toolBlock(`tool-${index}`, applyResult(entry, message), expanded, width));
      }
    }
  });
  // Notes that arrived after the newest message (the common case: the run is
  // still going) belong at the end.
  flushNotes(Number.MAX_SAFE_INTEGER);
  return blocks;
}

/** Total estimated height of a block list. */
export function transcriptHeight(blocks: TranscriptBlock[]): number {
  return blocks.reduce((total, block) => total + Math.max(1, block.lines), 0);
}
