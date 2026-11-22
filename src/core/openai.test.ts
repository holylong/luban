import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { OpenAiClient, openAiWireMessages, resetOutputCeilings, usageDetails } from "./openai.js";
import type { LubanConfig } from "./types.js";

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve()));

describe("usageDetails", () => {
  it("reads prompt caching under every provider dialect", () => {
    // DeepSeek reports both names; OpenAI and Anthropic each report one.
    expect(usageDetails({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80 }))
      .toEqual({ input: 100, output: 5, cached: 80 });
    expect(usageDetails({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 64 } }))
      .toEqual({ input: 100, output: 5, cached: 64 });
    expect(usageDetails({ input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 96 }))
      .toEqual({ input: 100, output: 5, cached: 96 });
    expect(usageDetails({ input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 32 } }))
      .toEqual({ input: 100, output: 5, cached: 32 });
    expect(usageDetails({ prompt_tokens: 10, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 18 } }))
      .toEqual({ input: 10, output: 20, reasoning: 18 });
    // A server that reports nothing must not invent a cache hit.
    expect(usageDetails({ prompt_tokens: 10, completion_tokens: 2 })).toEqual({ input: 10, output: 2 });
  });
});

describe("OpenAiClient cached tokens", () => {
  it("keeps the cache hit count from a streamed usage chunk", async () => {
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
        response.write('data: {"choices":[],"usage":{"prompt_tokens":6036,"completion_tokens":15,"prompt_cache_hit_tokens":5888,"completion_tokens_details":{"reasoning_tokens":13}}}\n\n');
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test address");
    const client = new OpenAiClient({
      home: "/tmp", workspace: "/tmp", project: "test", maxTokens: 1_000, temperature: 0, timeoutMs: 5_000, maxRetries: 0,
      model: { id: "test/model", provider: "test", model: "model", name: "model", api: "openai",
        baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", capabilities: { vision: false, thinking: false, tools: true, responses: false } },
    } as LubanConfig);
    const result = await client.complete([{ role: "user", content: "hi" }], [], new AbortController().signal);
    expect(result.usage).toEqual({ input: 6036, output: 15, cached: 5888, reasoning: 13 });
  });
});

describe("OpenAiClient output ceiling", () => {
  /** Stream one answer and record the request bodies the client sent. */
  async function serve(bodies: Array<Record<string, unknown>>, rejectAbove?: number): Promise<string> {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        bodies.push(body);
        if (rejectAbove !== undefined && Number(body.max_tokens) > rejectAbove) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: `max_tokens is too large: ${String(body.max_tokens)}` } }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
        response.write('data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n');
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test address");
    return `http://127.0.0.1:${address.port}/v1`;
  }

  function settings(baseUrl: string, maxOutputTokens?: number): LubanConfig {
    return {
      home: "/tmp", workspace: "/tmp", project: "test", maxTokens: 64_000, temperature: 0.2, timeoutMs: 5_000, maxRetries: 0,
      model: {
        id: "test/model", provider: "test", model: "model", name: "model", api: "openai", baseUrl, apiKey: "",
        capabilities: { vision: false, thinking: false, tools: true, responses: false, ...(maxOutputTokens ? { maxOutputTokens } : {}) },
      },
    } as LubanConfig;
  }

  it("sends the client ceiling, lowered by a provider limit from the config", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const baseUrl = await serve(bodies);
    const client = new OpenAiClient(settings(baseUrl, 8_000));
    await client.complete([{ role: "user", content: "hi" }], [], new AbortController().signal);
    expect(bodies[0]?.max_tokens).toBe(8_000);
  });

  it("halves the budget when the provider rejects it and remembers nothing larger", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const baseUrl = await serve(bodies, 4_096);
    const client = new OpenAiClient(settings(baseUrl));
    const result = await client.complete([{ role: "user", content: "hi" }], [], new AbortController().signal);
    expect(result.content).toBe("ok");
    // Each rejected budget is halved until the provider's real limit is reached.
    expect(bodies.map((body) => body.max_tokens)).toEqual([64_000, 32_000, 16_000, 8_000, 4_096]);
    // The accepted limit is remembered, so the next turn starts there instead.
    await client.complete([{ role: "user", content: "again" }], [], new AbortController().signal);
    expect(bodies.at(-1)?.max_tokens).toBe(4_096);
    resetOutputCeilings();
  });
});

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

  it("retains reasoning and supplies empty fields for legacy DeepSeek assistant messages only", async () => {
    const messages = [
      { role: "assistant" as const, content: "old summary" },
      { role: "user" as const, content: "continue" },
      { role: "assistant" as const, content: "", reasoning_content: "inspect first",
        tool_calls: [{ id: "a", type: "function" as const, function: { name: "probe", arguments: "{}" } }] },
      { role: "tool" as const, tool_call_id: "a", content: "result" },
    ];
    const before = JSON.stringify(messages);
    const model = { id: "opencode-go/deepseek-v4.1-flash", model: "deepseek-v4.1-flash" } as LubanConfig["model"];
    const wire = await openAiWireMessages(messages, "", model);
    expect(wire[0]).toHaveProperty("reasoning_content", "");
    expect(wire[2]).toHaveProperty("reasoning_content", "inspect first");
    expect(wire[1]).not.toHaveProperty("reasoning_content");
    expect(wire[3]).not.toHaveProperty("reasoning_content");
    expect((await openAiWireMessages(messages))[0]).not.toHaveProperty("reasoning_content");
    expect(JSON.stringify(messages)).toBe(before);
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

  it("uses each model's native thinking switch without sending Qwen fields to DeepSeek", async () => {
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

    await run(configFor("opencode-go/deepseek-v4.1-flash", "deepseek-v4.1-flash"));
    await run(configFor("qwen-local/qwen3.8-flash", "qwen3.8-flash"));
    const forced = configFor("opencode-go/deepseek-v4.1-flash", "deepseek-v4.1-flash");
    forced.enableThinking = true;
    await run(forced);

    expect(bodies[0]).not.toHaveProperty("chat_template_kwargs");
    expect(bodies[1]?.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(bodies[2]).not.toHaveProperty("chat_template_kwargs");
    expect(bodies[0]?.thinking).toEqual({ type: "enabled" });
    expect(bodies[2]?.thinking).toEqual({ type: "enabled" });
    await run(forced, false);
    expect(bodies[3]?.thinking).toEqual({ type: "disabled" });
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

describe("parallel tool-call streaming", () => {
  const chunk = (toolCalls: unknown[]) => JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls } }] });
  const serve = (lines: string[]) => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const line of lines) response.write(`data: ${line}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    return new Promise<string>(resolve => server!.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (!address || typeof address === "string") throw new Error("no test address");
      resolve(`http://127.0.0.1:${address.port}/v1`);
    }));
  };
  const configFor = (baseUrl: string) => {
    const model = { id: "test/model", provider: "test", model: "model", name: "model", baseUrl, apiKey: "" };
    return { home: ".", workspace: ".", project: "test", model, models: [model], maxTokens: 100, temperature: 0, timeoutMs: 2_000, maxSteps: 2, backendUrl: "", permissionMode: "allow" } as LubanConfig;
  };
  const run = async (lines: string[], names: string[] = []) => {
    const baseUrl = await serve(lines);
    const tools = names.map(name => ({ type: "function", function: { name, parameters: { type: "object" } } }));
    return new OpenAiClient(configFor(baseUrl)).complete([{ role: "user", content: "go" }], tools, new AbortController().signal);
  };
  const names = (calls: Array<{ function: { name: string; arguments: string } }>) => calls.map(call => call.function);

  it("keeps calls apart when a gateway labels fragments only by id", async () => {
    const result = await run([
      chunk([{ id: "c1", function: { name: "record_verification", arguments: '{"pas' } }]),
      chunk([{ function: { arguments: 's":true}' } }]),
      chunk([{ id: "c2", function: { name: "update_plan", arguments: '{"plan":[]}' } }]),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ]);
    // Concatenating the names produced "record_verificationupdate_plan", which
    // the agent answered with "TOOL ERROR: unknown tool".
    expect(names(result.toolCalls)).toEqual([
      { name: "record_verification", arguments: '{"pass":true}' },
      { name: "update_plan", arguments: '{"plan":[]}' },
    ]);
    expect(result.toolCalls.map(call => call.id)).toEqual(["c1", "c2"]);
  });

  it("keeps calls apart when a gateway always reports index 0", async () => {
    const result = await run([
      chunk([{ index: 0, id: "c1", function: { name: "edit_file", arguments: "{}" } }]),
      chunk([{ index: 0, id: "c2", function: { name: "edit_file", arguments: "{}" } }]),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ]);
    // Two identical edits used to collapse into the single name "edit_fileedit_file".
    expect(names(result.toolCalls)).toEqual([
      { name: "edit_file", arguments: "{}" },
      { name: "edit_file", arguments: "{}" },
    ]);
    expect(result.toolCalls.map(call => call.id)).toEqual(["c1", "c2"]);
  });

  it("keeps calls apart when a gateway sends neither index nor id", async () => {
    const result = await run([
      chunk([{ function: { name: "record_verification", arguments: '{"pass":true}' } }]),
      chunk([{ function: { name: "update_plan", arguments: '{"plan":[]}' } }]),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ], ["record_verification", "update_plan"]);
    // The advertised names decide: neither completes the other, so the second
    // name is a second call rather than a fragment of the first.
    expect(names(result.toolCalls)).toEqual([
      { name: "record_verification", arguments: '{"pass":true}' },
      { name: "update_plan", arguments: '{"plan":[]}' },
    ]);
  });

  it("joins a split tool name instead of inventing a second call", async () => {
    const result = await run([
      chunk([{ function: { name: "read_" } }]),
      chunk([{ function: { name: "file", arguments: '{"path":"a"}' } }]),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ], ["read_file"]);
    expect(names(result.toolCalls)).toEqual([{ name: "read_file", arguments: '{"path":"a"}' }]);
  });

  it("ignores a repeated complete name on the same call", async () => {
    const result = await run([
      chunk([{ index: 0, id: "c1", function: { name: "read_file" } }]),
      chunk([{ index: 0, function: { name: "read_file", arguments: "{}" } }]),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ]);
    expect(names(result.toolCalls)).toEqual([{ name: "read_file", arguments: "{}" }]);
  });
});
