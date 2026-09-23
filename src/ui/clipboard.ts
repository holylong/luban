import type { ChatMessage, PendingInput } from "../core/types.js";
import type { ExecutionEntry } from "./execution-view.js";

/** OSC 52 clipboard write. Works in xterm/Windows Terminal/iTerm2/ghostty even with mouse reporting on. */
export function osc52CopySequence(text: string): string {
  const payload = Buffer.from(text, "utf8").toString("base64");
  return `\x1b]52;c;${payload}\x07`;
}

export function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === "assistant" && !m.tool_calls?.length && String(m.content ?? "").trim()) {
      return String(m.content);
    }
  }
  return "";
}

/** Plain-text bundle for /copy: last answer + recent tool results + pending steering. */
export function buildCopyText(
  messages: ChatMessage[],
  entries: ExecutionEntry[] = [],
  pending: PendingInput[] = [],
  outcomeText = "",
): string {
  const parts: string[] = [];
  const answer = lastAssistantText(messages);
  if (answer.trim()) parts.push(`## luban 回答\n\n${answer.trim()}`);
  const recent = entries.slice(-6);
  if (recent.length) {
    const lines = recent.map((e) => {
      const head = `- ${e.name}${e.detail ? ` ${e.detail}` : ""} [${e.status}]`;
      const preview = (e.preview || e.editPreview || "").trim().split("\n").slice(0, 20).join("\n");
      return preview ? `${head}\n${preview}` : head;
    });
    parts.push(`## 最近工具调用\n\n${lines.join("\n\n")}`);
  }
  if (outcomeText.trim()) parts.push(`## 运行状态\n\n${outcomeText.trim()}`);
  if (pending.length) {
    parts.push(`## 待处理补充指令\n\n${pending.map((p) => `- [${p.delivery}] ${p.content}`).join("\n")}`);
  }
  return parts.length ? `${parts.join("\n\n")}\n` : "";
}
