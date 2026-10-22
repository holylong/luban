import { describe, expect, it } from "vitest";
import { describeModelError, isContextOverflowError, isFreeTierError, isModelTimeoutError, recoverableModelConnectionError, retryableModelError } from "./model-errors.js";

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

  it("treats the OpenCode Zen free-tier gate as terminal, not retryable", () => {
    const body = 'model HTTP 403: {"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode."}}';
    expect(isFreeTierError(new Error(body))).toBe(true);
    expect(retryableModelError(new Error(body))).toBe(false);
    // A plain 403 without the free-tier marker stays a normal failure.
    expect(isFreeTierError(new Error("model HTTP 403: forbidden"))).toBe(false);
  });
});

describe("recoverableModelConnectionError", () => {
  it.each([
    "Codex CLI failed: stream disconnected before completion", "Codex CLI failed: error sending request",
    "model stream idle timeout", "model HTTP 503: overloaded", "model HTTP 429: rate limited",
    "model stream error: upstream 502", "model stream ended before completion",
  ])("recovers temporary connection failure: %s", message => {
    expect(recoverableModelConnectionError(new Error(message))).toBe(true);
  });
  it.each([
    "model HTTP 401: connection closed", "Codex CLI failed: authentication required",
    'Codex CLI failed: status_code: 403 stream disconnected',
    "model HTTP 429: insufficient_quota", "usage limit reached; try again later",
    "model HTTP 400: maximum context length", "FreeTierError",
    "ENOENT: missing executable", "TOOL ERROR: permission denied",
  ])("does not reconnect permanent failures: %s", message => {
    expect(recoverableModelConnectionError(new Error(message))).toBe(false);
  });
  it("keeps missing Codex output distinct from missing local files", () => {
    expect(recoverableModelConnectionError(Object.assign(new Error("missing response"), { code: "CODEX_OUTPUT_MISSING" }))).toBe(true);
    expect(recoverableModelConnectionError(new TypeError("fetch failed", { cause: new Error("ECONNRESET") }))).toBe(true);
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

describe("isModelTimeoutError", () => {
  it("recognizes idle and transport timeouts without treating other failures as timeouts", () => {
    expect(isModelTimeoutError(new Error("model stream idle timeout after 30s"))).toBe(true);
    expect(isModelTimeoutError(new TypeError("fetch failed", { cause: new Error("connect ETIMEDOUT") }))).toBe(true);
    expect(isModelTimeoutError("模型已 30s 没有任何输出")).toBe(true);
    expect(isModelTimeoutError(new Error("model HTTP 401"))).toBe(false);
  });
});
