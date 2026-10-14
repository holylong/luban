import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiClient } from "./openai.js";
import { ResponsesClient } from "./responses.js";
import { AnthropicClient } from "./anthropic.js";
import { goRequestHeaders, modelRetryDelay, recoverableGoStreamError, waitForModelRetry } from "./opencode-go.js";
import type { LubanConfig } from "./types.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const upstream = "Upstream request failed: Endpoint is unavailable.";
function config(api: "openai" | "responses" | "anthropic"): LubanConfig {
  return { model: { id: "opencode-go/cat-jam-free", provider: "opencode-go", model: "cat-jam-free", name: "Cat Jam",
    baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "go-test-key", api,
    headers: { "x-opencode-session": "luban" }, capabilities: { vision: false, thinking: false, tools: true } },
    maxTokens: 1000, temperature: 0.2, timeoutMs: 5000, maxRetries: 3,
  } as LubanConfig;
}
function success(api: string): Response {
  return Response.json(api === "responses" ? { output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] }
    : api === "anthropic" ? { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" }
    : { choices: [{ message: { content: "done" }, finish_reason: "stop" }] });
}
const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

describe("Go request routing and recovery", () => {
  it.each([
    ["openai", OpenAiClient], ["responses", ResponsesClient], ["anthropic", AnthropicClient],
  ] as const)("retries transient 429s using the same conversation on %s", async (api, Client) => {
    const seen: Headers[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers));
      if (seen.length < 4) return new Response(JSON.stringify({ error: { type: "server_error", message: upstream } }),
        { status: 429, headers: { "retry-after": "0", "content-type": "application/json" } });
      return success(api);
    });
    const notices: string[] = [];
    const client = new Client(config(api));
    const result = await client.complete([{ role: "user", content: "hi" }], [], new AbortController().signal,
      undefined, text => notices.push(text), { conversationId: "one-conversation" });
    expect(result.content).toBe("done");
    expect(seen).toHaveLength(4);
    expect(seen.every(headers => headers.get("x-opencode-session") === "one-conversation")).toBe(true);
    expect(seen[0]!.get("user-agent")).toMatch(/^luban\//);
    expect(seen[0]!.get(api === "anthropic" ? "x-api-key" : "authorization"))
      .toBe(api === "anthropic" ? "go-test-key" : "Bearer go-test-key");
    expect(notices.join("\n")).toContain("HTTP 429");
    expect(notices.join("\n")).not.toContain("undefined");
    await client.complete([], [], new AbortController().signal);
    await client.complete([], [], new AbortController().signal);
    await new Client(config(api)).complete([], [], new AbortController().signal);
    expect(seen[4]!.get("x-opencode-session")).toBe(seen[5]!.get("x-opencode-session"));
    expect(seen[4]!.get("x-opencode-session")).not.toBe(seen[6]!.get("x-opencode-session"));
    expect(seen[4]!.get("x-opencode-session")).not.toBe("luban");
  });

  it.each([
    ["openai", OpenAiClient], ["responses", ResponsesClient], ["anthropic", AnthropicClient],
  ] as const)("keeps partial text but discards unfinished tool calls on a transient %s stream error", async (api, Client) => {
    const text = api === "responses" ? { type: "response.output_text.delta", delta: "kept text" }
      : api === "anthropic" ? { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "kept text" } }
      : { choices: [{ delta: { content: "kept text", tool_calls: [{ index: 0, id: "incomplete",
        function: { name: "write_file", arguments: '{"path":' } }] } }] };
    vi.stubGlobal("fetch", async () => new Response(frame(text) + frame({ type: "error", error: { message: upstream } }),
      { headers: { "content-type": "text/event-stream" } }));
    const result = await new Client(config(api)).complete([], [], new AbortController().signal);
    expect(result).toMatchObject({ content: "kept text", truncated: true, streamEnded: true, toolCalls: [] });
  });

  it("uses a slower Go backoff and respects numeric and date Retry-After", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect([0, 1, 2, 3, 4, 5].map(attempt => modelRetryDelay(undefined, attempt, "opencode-go")))
      .toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
    expect(modelRetryDelay(undefined, 0, "other")).toBe(500);
    expect(modelRetryDelay(new Response(null, { headers: { "retry-after": "12" } }), 0, "opencode-go")).toBe(12000);
    const now = Date.UTC(2026, 9, 14);
    expect(modelRetryDelay(new Response(null, { headers: { "retry-after": new Date(now + 20_000).toUTCString() } }), 0, "opencode-go", now)).toBe(20000);
    expect(modelRetryDelay(new Response(null, { headers: { "retry-after": "invalid" } }), 1, "opencode-go")).toBe(4000);
  });

  it("preserves explicit headers and leaves other providers alone", () => {
    const model = config("openai").model;
    model.headers = { "X-Opencode-Session": "custom-session", "User-Agent": "custom-client/1", "x-project": "my-project" };
    const headers = new Headers(goRequestHeaders(model, "generated-session"));
    expect(headers.get("x-opencode-session")).toBe("custom-session");
    expect(headers.get("user-agent")).toBe("custom-client/1");
    expect(headers.get("x-project")).toBe("my-project");
    expect(goRequestHeaders({ ...model, provider: "other" }, "generated-session")).toBe(model.headers);
  });

  it("stops waiting immediately when cancelled", async () => {
    const controller = new AbortController();
    const waiting = waitForModelRetry(60_000, controller.signal);
    controller.abort(new Error("cancelled by user"));
    await expect(waiting).rejects.toThrow("cancelled by user");
  });

  it("does not replay exhausted HTTP errors, malformed data or authentication errors", () => {
    expect(recoverableGoStreamError(new Error(`model HTTP 429: ${upstream}`))).toBe(false);
    expect(recoverableGoStreamError(new Error(`model stream error: ${upstream}`))).toBe(true);
    expect(recoverableGoStreamError(new Error("model stream ended before completion"))).toBe(true);
    expect(recoverableGoStreamError(new Error("model returned malformed SSE JSON"))).toBe(false);
    expect(recoverableGoStreamError(new Error("model stream error: FreeTierError"))).toBe(false);
    expect(recoverableGoStreamError(new Error("model stream error: invalid API key"))).toBe(false);
  });
});
