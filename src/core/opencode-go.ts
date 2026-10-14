import { VERSION } from "../version.js";
import { describeModelError, isModelTimeoutError, retryableModelError } from "./model-errors.js";
import type { ModelRef } from "./types.js";

/** Go requires honest client identification and a stable, distinct conversation ID. */
export function goRequestHeaders(model: ModelRef, sessionId: string): Record<string, string> | undefined {
  if (model.provider !== "opencode-go") return model.headers;
  const headers = new Headers(model.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", `luban/${VERSION}`);
  if (!headers.has("x-opencode-client")) headers.set("x-opencode-client", "luban");
  // Older luban configs pinned every conversation to this shared placeholder.
  if (!headers.has("x-opencode-session") || headers.get("x-opencode-session") === "luban") {
    headers.set("x-opencode-session", sessionId);
  }
  return Object.fromEntries(headers);
}

/** Honor Retry-After; give Go's busy upstream more time instead of a hot retry loop. */
export function modelRetryDelay(response: Response | undefined, attempt: number, provider?: string, now = Date.now()): number {
  const header = response?.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
    if (Number.isFinite(duration)) return Math.min(60_000, Math.max(0, duration));
  }
  const go = provider === "opencode-go";
  return Math.min(go ? 30_000 : 10_000, (go ? 2000 : 500) * 2 ** attempt) + Math.floor(Math.random() * 250);
}

export async function waitForModelRetry(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = () => { signal.removeEventListener("abort", aborted); resolve(); };
    const timer = setTimeout(done, ms);
    const aborted = () => { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); };
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** Only the model request may be replayed, before any output or tool execution. */
export function recoverableGoStreamError(error: unknown): boolean {
  const message = describeModelError(error);
  if (/^model HTTP |model returned malformed|model returned invalid|model SSE event exceeds|tool arguments/i.test(message)) return false;
  return isModelTimeoutError(error) || retryableModelError(new Error(message))
    || /model stream ended before completion|model returned an empty (?:response|stream)/i.test(message);
}
