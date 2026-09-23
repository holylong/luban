import type { ChatMessage } from "../core/types.js";

export const MAX_INPUT_HISTORY = 200;

/** Append a submitted input to history. Trims, drops empties and consecutive duplicates. */
export function pushInputHistory(history: string[], value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return history;
  if (history.at(-1) === trimmed) return history;
  return [...history, trimmed].slice(-MAX_INPUT_HISTORY);
}

/** Seed input history from user messages so Up works after --resume / session switch. */
export function historyFromMessages(messages: ChatMessage[], limit = 100): string[] {
  const out: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = String(message.content ?? "").trim();
    if (!text) continue;
    if (out.at(-1) === text) continue;
    out.push(text);
  }
  return out.slice(-limit);
}

export interface HistoryRecall {
  index: number | null;
  input: string;
  draft: string;
}

/** Up arrow: stash the current edit on first step, then walk backwards. */
export function recallUp(
  history: string[],
  index: number | null,
  currentInput: string,
  draft: string,
): HistoryRecall {
  if (!history.length) return { index, input: currentInput, draft };
  if (index === null) {
    const next = history.length - 1;
    return { index: next, input: history[next]!, draft: currentInput };
  }
  const next = Math.max(0, index - 1);
  return { index: next, input: history[next]!, draft };
}

/** Down arrow: walk forward, restoring the stashed draft past the newest entry. */
export function recallDown(
  history: string[],
  index: number | null,
  draft: string,
): HistoryRecall {
  if (index === null || !history.length) return { index, input: "", draft };
  if (index >= history.length - 1) return { index: null, input: draft, draft };
  const next = index + 1;
  return { index: next, input: history[next]!, draft };
}
