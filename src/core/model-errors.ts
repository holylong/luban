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

/** Tool effects already happened once; only model-transport calls may retry, never tool.execute. */
export function retryableModelError(error: unknown): boolean {
  if (isContextOverflowError(error)) return false;
  const text = error instanceof Error ? error.message : String(error);
  return /model HTTP (408|409|425|429|5\d\d)|timed out|idle timeout|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i.test(text);
}
