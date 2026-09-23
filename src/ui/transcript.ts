import type { ChatMessage } from "../core/types.js";
import { enforceAgentIdentity, extractFinalAnswer } from "../core/reasoning.js";

/** Show only the current streamed line; a newline replaces the previous line. */
export function currentStreamLine(value: string): string {
  const lines = value.replace(/\r/gu, "").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.replace(/[\t\f\v ]+/gu, " ").trim();
    if (line) return line;
  }
  return "";
}

/** Tool-calling assistant messages are intermediate reasoning, not transcript replies. */
export function visibleConversationMessages(messages: ChatMessage[], limit = 12): ChatMessage[] {
  let lastUser = "";
  return messages
    .map((message) => {
      if (message.role === "user") lastUser = String(message.content ?? "");
      return message.role === "assistant" && !message.tool_calls?.length
        ? { ...message, content: enforceAgentIdentity(lastUser, extractFinalAnswer(message.content ?? "")) }
        : message;
    })
    .filter((message) => (
      message.role === "user"
      || (message.role === "assistant" && Boolean(message.content?.trim()) && !message.tool_calls?.length)
    ))
    .slice(-limit);
}

/**
 * Height budget for the pinned conclusion. The conclusion is always rendered
 * directly; expanding execution details only compresses it and can never hide it,
 * so users no longer need /details to read the task result.
 */
export function conclusionMaxLines(showDetails: boolean, rows: number): number {
  return showDetails ? Math.max(6, Math.floor(rows / 4)) : Math.max(12, rows - 10);
}
