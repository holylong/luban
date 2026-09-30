import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { OpenAiClient, openAiWireMessages } from "./openai.js";
import type { LubanConfig } from "./types.js";

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve()));

describe("OpenAiClient", () => {
  it("merges late and repeated system records into one leading message", async () => {
    const wire = await openAiWireMessages([
      { role: "system", content: "base rules" },
      { role: "user", content: "work" },
      { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "1", name: "read_file", content: "result", editPreview: "local only" },
      { role: "system", content: "late plan" },
    ]);
    expect(wire.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(wire[0]?.content).toBe("base rules\n\nlate plan");
    expect(wire.filter((message) => message.role === "system")).toHaveLength(1);
    expect(wire[3]).not.toHaveProperty("editPreview");
  });

  it("aggregates fragmented SSE text, tool calls and usage", async () => {
    let requestBody: Record<string, unknown> | undefined;
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('data: {"choices":[{"delta":{"reasoning_content":"checking\\n"}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"content":"hel","tool_calls":[{"index":0,"id":"c1","function":{"name":"read_","arguments":"{\\"pa"}}]}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"function":{"name":"file","arguments":"th\\":\\"a\\"}"}}]}}]}\n\n');
        response.write('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n');
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test address");
    const model = {
      id: "test/model", provider: "test", model: "model", name: "model",
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "",
    };
    const config: LubanConfig = {
      home: ".", workspace: ".", project: "test", model, models: [model], maxTokens: 100,
      temperature: 0, timeoutMs: 2_000, maxSteps: 2, backendUrl: "", permissionMode: "allow",
    };
    const deltas: Array<[string, string]> = [];
    const result = await new OpenAiClient(config).complete(
      [{ role: "user", content: "hi" }], [], new AbortController().signal, (text, kind) => deltas.push([kind, text]),
    );
    expect(result.content).toBe("hello");
    expect(result.reasoning).toBe("checking\n");
    expect(deltas).toEqual([["reasoning", "checking\n"], ["content", "hel"], ["content", "lo"]]);
    expect(result.toolCalls[0]?.function).toEqual({ name: "read_file", arguments: '{"path":"a"}' });
    expect(result.usage).toEqual({ input: 7, output: 3 });
    // The TUI token counters depend on the provider echoing usage in the
    // stream, which OpenAI-compatible servers only do when asked.
    expect(requestBody?.stream_options).toEqual({ include_usage: true });
  });

  it("sends enable_thinking only for Qwen or an explicit thinking setting", async () => {
    const bodies: Record<string, unknown>[] = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test address");
    const configFor = (id: string, model: string): LubanConfig => {
      const ref = { id, provider: "p", model, name: model, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "" };
      return { home: ".", workspace: ".", project: "test", model: ref, models: [ref], maxTokens: 100, temperature: 0, timeoutMs: 2_000, maxSteps: 2, backendUrl: "", permissionMode: "allow" };
    };
    const run = (config: LubanConfig, thinking = true) =>
      new OpenAiClient(config).complete([{ role: "user", content: "hi" }], [], new AbortController().signal, undefined, undefined, { enableThinking: thinking });

    // DeepSeek on the same gateway must not be told to think: enable_thinking
    // there turns on heavy reasoning that can eat the whole output budget.
    await run(configFor("opencode-go/deepseek-v4.1-flash", "deepseek-v4.1-flash"));
    await run(configFor("qwen-local/qwen3.8-flash", "qwen3.8-flash"));
    const forced = configFor("opencode-go/deepseek-v4.1-flash", "deepseek-v4.1-flash");
    forced.enableThinking = true;
    await run(forced);

    expect(bodies[0]).not.toHaveProperty("chat_template_kwargs");
    expect(bodies[1]?.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(bodies[2]?.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it("retries a transient rate limit response", async () => {
    let requests = 0;
    server = createServer((_request, response) => {
      requests += 1;
      if (requests === 1) {
        response.writeHead(429, { "content-type": "text/plain", "retry-after": "0" });
        response.end("slow down");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "recovered" } }], usage: {} }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test address");
    const model = { id: "test/model", provider: "test", model: "model", name: "model", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "" };
    const config = {
      home: ".", workspace: ".", project: "test", model, models: [model], maxTokens: 100,
      temperature: 0, timeoutMs: 2_000, maxSteps: 2, contextWindow: 8_192, contextReserve: 1_024,
      maxRetries: 1, backendUrl: "", permissionMode: "allow" as const,
    } as LubanConfig;
    const result = await new OpenAiClient(config).complete([{ role: "user", content: "hi" }], [], new AbortController().signal);
    expect(result.content).toBe("recovered");
    expect(requests).toBe(2);
  });
});
