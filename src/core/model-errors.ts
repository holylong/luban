/** Classify model transport failures so retries never duplicate tool side effects. */
export function isContextOverflowError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { stack?: unknown }).stack ?? "")}` : String(error);
  return /context[_ -]?length|context[_ -]?window|maximum context|too many tokens|input.*too (long|large)|prompt.*too (long|large)|context[_ -]?budget exceeded|invalid_request_error.*context/i.test(text)
    || /model HTTP 400[\s\S]{0,2000}(context|maximum|too many|too large)/i.test(text)
    || /model HTTP 413/.test(text);
}

export function isTruncationError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /truncated by output token limit|response truncated/i.test(text);
}

/** A stalled model request can be retried without repeating any tool effect. */
export function isModelTimeoutError(error: unknown): boolean {
  return /timed out|timeout|ETIMEDOUT|超时|没有任何输出/i.test(describeModelError(error));
}

/** Tool effects already happened once; only model-transport calls may retry, never tool.execute. */
export function retryableModelError(error: unknown): boolean {
  if (isContextOverflowError(error)) return false;
  const text = error instanceof Error ? error.message : String(error);
  return /model HTTP (408|409|425|429|529|5\d\d)|timed out|idle timeout|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|overloaded|rate[ -]?limit|temporarily unavailable|try again|service unavailable|bad gateway|gateway timeout/i.test(text);
}

/**
 * A short, user-facing description of a transport failure.
 *
 * Node's `fetch` collapses every network problem into `TypeError: fetch failed`;
 * the actionable part — `ECONNRESET`, `UND_ERR_CONNECT_TIMEOUT`, a TLS error —
 * lives in `error.cause`. The retry notice should name it, so a provider that is
 * down (connection refused) is not confused with one that is merely slow.
 */
export function describeModelError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message && cause.message !== error.message) {
    const code = (cause as { code?: unknown }).code;
    const suffix = typeof code === "string" && code && !cause.message.includes(code) ? ` (${code})` : "";
    return `${error.message}: ${cause.message}${suffix}`;
  }
  return error.message;
}
