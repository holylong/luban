import { describe, expect, it } from "vitest";
import { isContextOverflowError, retryableModelError } from "./model-errors.js";

describe("model error classification", () => {
  it("detects context overflow without marking it retryable", () => {
    expect(isContextOverflowError(new Error("model HTTP 400: This model's maximum context length is 128000 tokens"))).toBe(true);
    expect(isContextOverflowError(new Error("Context budget exceeded by instructions"))).toBe(true);
    expect(isContextOverflowError(new Error("model HTTP 413: payload too large"))).toBe(true);
    expect(retryableModelError(new Error("model HTTP 400: maximum context length"))).toBe(false);
  });

  it("keeps transient transport errors retryable", () => {
    expect(retryableModelError(new Error("model HTTP 429: rate limited"))).toBe(true);
    expect(retryableModelError(new Error("model HTTP 503: overloaded"))).toBe(true);
    expect(retryableModelError(new Error("fetch failed"))).toBe(true);
    expect(retryableModelError(new Error("TOOL ERROR: permission denied"))).toBe(false);
  });
});
