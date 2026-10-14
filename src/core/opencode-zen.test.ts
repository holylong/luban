import { afterEach, describe, expect, it, vi } from "vitest";
import { isZenFreeModel, OpenCodeZenClient } from "./opencode-zen.js";
import type { ChatMessage, LubanConfig } from "./types.js";

function config(api: "openai" | "responses", headers?: Record<string, string>): LubanConfig {
  return {
    model: { id: "opencode-zen/exo-free", provider: "opencode-zen", model: "exo-free", name: "Exo",
      baseUrl: "https://opencode.ai/zen/v1", apiKey: "saved-zen-key", api, headers,
      capabilities: { vision: false, thinking: false, tools: true, responses: api === "responses" } },
    maxTokens: 1000, temperature: 0.2, timeoutMs: 5000, maxRetries: 0,
  } as LubanConfig;
}

const tools = ["read_file", "bash", "glob_files", "grep_files", "edit_file", "write_file"].map(name => ({
  type: "function", function: { name, description: name, parameters: {
    type: "object", properties: { path: { type: "string" } }, required: ["path"],
  } },
}));
const messages: ChatMessage[] = [
  { role: "user", content: "Read a.txt" },
  { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function",
    function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] },
  { role: "tool", name: "read_file", tool_call_id: "c1", content: "file content" },
];

afterEach(() => vi.unstubAllGlobals());

describe("Zen free model transport", () => {
  it.each(["openai", "responses"] as const)("round-trips real tool names and history through %s", async api => {
    const requests: Array<{ url: string; headers: Headers; body: any }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      const call = { name: "read", arguments: '{"path":"b.txt"}' };
      return new Response(JSON.stringify(api === "openai"
        ? { choices: [{ message: { content: "", tool_calls: [{ id: "c2", type: "function", function: call }] }, finish_reason: "tool_calls" }] }
        : { output: [{ type: "function_call", call_id: "c2", ...call }] }),
      { headers: { "content-type": "application/json" } });
    });
    const before = JSON.stringify({ messages, tools });
    const client = new OpenCodeZenClient(config(api));
    const started = Date.now();
    const result = await client.complete(messages, tools, new AbortController().signal);
    expect(result.toolCalls[0]?.function).toEqual({ name: "read_file", arguments: '{"path":"b.txt"}' });
    expect(JSON.stringify({ messages, tools })).toBe(before);
    const { body, headers, url } = requests[0]!;
    expect(headers.get("authorization")).toBe("Bearer saved-zen-key");
    expect(headers.get("user-agent")).toMatch(/^opencode\/1\.19\.0 luban\//);
    expect(headers.get("x-opencode-client")).toBe("luban");
    const session = headers.get("x-opencode-session")!;
    expect(session).toMatch(/^ses_[0-9a-f]{12}[a-zA-Z0-9]{14}$/);
    expect(headers.get("x-opencode-session-id")).toBe(session);
    const time = Number(((~BigInt(`0x${session.slice(4, 16)}`)) & 0xffffffffffffn) / 0x1000n);
    // OpenCode keeps the low 48 bits of (milliseconds << 12), so the decoded
    // timestamp wraps every 2^36 milliseconds, just like the official IDs.
    expect(Math.abs(time - (started % 2 ** 36))).toBeLessThan(1000);
    expect(body.stream).toBe(true);
    expect(body.tools.map((tool: any) => api === "openai" ? tool.function.name : tool.name))
      .toEqual(["read", "bash", "glob", "grep", "edit", "write"]);
    if (api === "openai") {
      expect(url).toMatch(/\/chat\/completions$/);
      expect(body.messages[1].tool_calls[0].function.name).toBe("read");
      expect(body.messages[2].name).toBe("read");
    } else {
      expect(url).toMatch(/\/responses$/);
      expect(body.input[1]).toMatchObject({ name: "read", arguments: '{"path":"a.txt"}' });
      expect(body.input[2]).toMatchObject({ call_id: "c1", output: "file content" });
    }
    await client.complete(messages, tools, new AbortController().signal);
    expect(requests[1]?.headers.get("x-opencode-session")).toBe(session);
  });

  it("uses anonymous access without a key and respects explicit headers regardless of case", async () => {
    let headers = new Headers();
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      headers = new Headers(init.headers);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
        { headers: { "content-type": "application/json" } });
    });
    const settings = config("openai", { "User-Agent": "custom-client", "X-Opencode-Session": "custom-session" });
    settings.model.apiKey = "";
    await new OpenCodeZenClient(settings).complete(messages, tools, new AbortController().signal);
    expect(headers.get("authorization")).toBe("Bearer public");
    expect(headers.get("user-agent")).toBe("custom-client");
    expect(headers.get("x-opencode-session")).toBe("custom-session");
    expect(settings.model.apiKey).toBe("");
  });

  it("does not confuse an existing tool called read with the read_file alias", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ choices: [{ message: {
      tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: "{}" } }],
    }, finish_reason: "tool_calls" }] }), { headers: { "content-type": "application/json" } }));
    const withRead = [...tools, { type: "function", function: { name: "read", parameters: {} } }];
    const result = await new OpenCodeZenClient(config("openai")).complete(messages, withRead, new AbortController().signal);
    expect(result.toolCalls[0]?.function.name).toBe("read");
  });

  it("limits this compatibility transport to Zen free models", () => {
    const model = config("openai").model;
    expect(isZenFreeModel(model)).toBe(true);
    expect(isZenFreeModel({ ...model, model: "big-pickle" })).toBe(true);
    expect(isZenFreeModel({ ...model, model: "gpt-6-luna" })).toBe(false);
    expect(isZenFreeModel({ ...model, provider: "opencode-go" })).toBe(false);
  });
});
