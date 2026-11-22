import { PLAN_MARKER, VERIFICATION_MARKER } from "./plan.js";
import type { ChatMessage } from "./types.js";

/**
 * Prompt caches are prefix caches: every provider that reports cache hits
 * (DeepSeek, OpenAI, Anthropic, Gemini) reuses tokens only up to the first byte
 * that differs from the previous request. Anything luban rewrites *near the
 * front* of the prompt therefore throws away the whole conversation, even when
 * the change is a 200-token status record.
 *
 * The transcript mixes two very different kinds of system message:
 *
 *  - the static head (base prompt, workspace/platform facts, AGENTS.md scoped to
 *    a directory, a compaction summary) — stable for a whole run;
 *  - volatile records (`[luban task plan]`, `[luban verification]`) that
 *    `update_plan`/`record_verification` replace or append mid-run.
 *
 * `update_plan` writes its record right after the leading system run and
 * `record_verification` appends at the end, but transports used to concatenate
 * *every* system message into one leading system block, so both landed at the
 * front. One plan update or one recorded check then cost a full prompt-cache
 * miss on the next request.
 *
 * `splitPrompt` fixes that at the transport boundary: only the stable head is
 * merged into the leading system block, and volatile records are re-emitted at
 * the tail in transcript order, where a change can only invalidate what follows
 * them.
 */

interface PromptParts {
  /** Stable leading system text, merged into one system block. */
  head: string;
  /** Non-system transcript, unchanged and in order. */
  conversation: ChatMessage[];
  /** Volatile records, in transcript order, to be re-emitted at the tail. */
  runtime: string[];
}

function isRuntimeRecord(content: string): boolean {
  return [PLAN_MARKER, VERIFICATION_MARKER].some((marker) => content.startsWith(marker));
}

export function splitPrompt(messages: ChatMessage[]): PromptParts {
  const head: string[] = [];
  const runtime: string[] = [];
  const conversation: ChatMessage[] = [];
  let seenConversation = false;
  for (const message of messages) {
    if (message.role !== "system") {
      seenConversation = true;
      conversation.push(message);
      continue;
    }
    const content = String(message.content ?? "").trim();
    if (!content) continue;
    // A system record that arrives after the conversation started cannot be part
    // of a leading block without moving the cached prefix, and a plan or check
    // record is volatile wherever it sits.
    if (seenConversation || isRuntimeRecord(content)) runtime.push(content);
    else head.push(content);
  }
  return { head: head.join("\n\n"), conversation, runtime };
}
