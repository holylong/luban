import { describe, expect, it } from "vitest";
import { describeModelError, isContextOverflowError, retryableModelError } from "./model-errors.js";

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

describe("describeModelError", () => {
  it("surfaces the cause behind a bare `fetch failed`", () => {
    const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(describeModelError(new TypeError("fetch failed", { cause }))).toBe("fetch failed: socket hang up (ECONNRESET)");
    // The code is not repeated when the cause message already spells it out.
    const spelled = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(describeModelError(new TypeError("fetch failed", { cause: spelled }))).toBe("fetch failed: read ECONNRESET");
  });

  it("falls back to the message when there is no cause", () => {
    expect(describeModelError(new Error("model timed out after 120s"))).toBe("model timed out after 120s");
    expect(describeModelError("plain string")).toBe("plain string");
  });
});
