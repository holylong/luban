import { describe, expect, it } from "vitest";
import { responsesEndpoint, responsesInput, responsesTools, ResponsesClient } from "./responses.js";
import type { LubanConfig } from "./types.js";

function config(): LubanConfig {
  return {
    model: { id: "o/openai", provider: "o", model: "gpt-5", name: "gpt", baseUrl: "https://api.openai.com/v1", apiKey: "", api: "responses", capabilities: { vision: false, thinking: false, tools: true, responses: true } },
    maxTokens: 1000, temperature: 0.2, timeoutMs: 5000, maxRetries: 0,
  } as LubanConfig;
}

describe("responses API", () => {
  it("derives the endpoint from chat-style base urls", () => {
    expect(responsesEndpoint("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/responses");
    expect(responsesEndpoint("https://x/v1/chat/completions")).toBe("https://x/v1/responses");
    expect(responsesEndpoint("https://x/v1/responses")).toBe("https://x/v1/responses");
  });

  it("converts transcripts and tool schemas", async () => {
    const { instructions, input } = await responsesInput([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", name: "bash", tool_call_id: "c1", content: "ok" },
    ]);
    expect(instructions).toBe("sys");
    expect(input.map((item) => item.type ?? item.role)).toEqual(["user", "function_call", "function_call_output"]);
    const tools = responsesTools([{ type: "function", function: { name: "bash", description: "sh", parameters: { type: "object" } } }]);
    expect(tools[0]).toMatchObject({ type: "function", name: "bash" });
  });

  it("parses a non-stream JSON response", async () => {
    const client = new ResponsesClient(config());
    const original = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = async () => new Response(JSON.stringify({
      output: [
        { type: "message", content: [{ type: "output_text", text: "done" }] },
        { type: "function_call", call_id: "c1", name: "bash", arguments: "{\"command\":\"ls\"}" },
      ],
      usage: { input_tokens: 3, output_tokens: 5 },
    }), { headers: { "content-type": "application/json" } });
    try {
      const result = await client.complete([{ role: "user", content: "hi" }], [], new AbortController().signal);
      expect(result.content).toBe("done");
      expect(result.toolCalls[0]).toMatchObject({ id: "c1" });
      expect(result.usage).toEqual({ input: 3, output: 5 });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("parses streamed deltas into text and tool calls", async () => {
    const client = new ResponsesClient(config());
    const events = [
      `{"type":"response.output_item.added","item":{"type":"function_call","id":"i1","name":"bash"}}`,
      `{"type":"response.output_text.delta","delta":"hel"}`,
      `{"type":"response.output_text.delta","delta":"lo"}`,
      `{"type":"response.function_call_arguments.delta","item_id":"i1","delta":"{\\"command\\""}`,
      `{"type":"response.function_call_arguments.delta","item_id":"i1","delta":":\\"ls\\"}"}`,
      `{"type":"response.completed","response":{"output":[],"usage":{"input_tokens":1,"output_tokens":2}}}`,
    ].map((data) => `data: ${data}\n\n`).join("");
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(events)); controller.close(); } });
    const original = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = async () => new Response(stream, { headers: { "content-type": "text/event-stream" } });
    try {
      const seen: string[] = [];
      const result = await client.complete([{ role: "user", content: "hi" }], [], new AbortController().signal, (text) => seen.push(text));
      expect(result.content).toBe("hello");
      expect(seen.join("")).toBe("hello");
      expect(result.toolCalls[0]?.function.arguments).toBe("{\"command\":\"ls\"}");
    } finally {
      globalThis.fetch = original;
    }
  });
});
