/** Parse SSE frames across arbitrary byte boundaries, including CRLF and multi-line data. */
export async function* sseData(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  const aborted = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener("abort", aborted, { once: true });
  const data = (event: string) => event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
  try {
    for (;;) {
      const { value, done } = await reader.read();
      ended = done;
      buffer += decoder.decode(value, { stream: !done });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        if (match.index > 1_048_576) throw new Error("model SSE event exceeds 1 MiB");
        const raw = data(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (raw) yield raw;
      }
      if (buffer.length > 1_048_576) throw new Error("model SSE event exceeds 1 MiB");
      if (done) break;
    }
    const raw = data(buffer);
    if (raw) yield raw;
  } finally {
    signal?.removeEventListener("abort", aborted);
    if (!ended) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function parseModelEvent(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("model returned malformed SSE JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("model returned invalid SSE event");
  const event = parsed as Record<string, unknown>;
  if (event.error || event.type === "error") {
    const error = event.error as Record<string, unknown> | undefined;
    throw new Error(`model stream error: ${String(error?.message ?? error?.type ?? "unknown provider error").slice(0, 600)}`);
  }
  return event;
}

/** What validation found about one completion. */
export interface CompletionCheck {
  /** The provider stopped because the output budget ran out, not because it finished. */
  truncated: boolean;
}

/**
 * Validate one completion.
 *
 * Truncation is reported rather than thrown. Running out of output budget is a
 * property of the response, not a broken request, and the caller that keeps the
 * partial text can ask the model to continue where it stopped — which is what a
 * provider's own output cap requires, since repeating the same request truncates
 * the same way. A response cut off mid-tool-call is a different matter: its
 * arguments cannot be trusted, so the callers drop those calls and re-ask
 * instead of executing a half-written action.
 */
export function validateCompletion(content: string, calls: import("./types.js").ToolCall[], reason?: unknown): CompletionCheck {
  if (reason === "content_filter" || reason === "refusal") throw new Error(`model response stopped: ${reason}`);
  const truncated = reason === "length" || reason === "max_tokens";
  if (!truncated) {
    for (const call of calls) {
      if (!call?.function?.name || typeof call.function.arguments !== "string") throw new Error("model returned an incomplete tool call");
      // Completed calls reach AgentRunner, which reports malformed arguments to the model.
      // Without a completion reason, invalid JSON may be a cut-off call.
      if (reason == null) {
        try { JSON.parse(call.function.arguments); } catch { throw new Error("model returned incomplete or invalid tool arguments"); }
      }
    }
    if (!content.trim() && !calls.length) throw new Error("model returned an empty response");
  }
  return { truncated };
}
