import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AnthropicClient } from "./anthropic.js";
import type { LubanConfig } from "./types.js";

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve()));

describe("AnthropicClient", () => {
  it("converts messages and tool schemas to the Messages API", async () => {
    let requestBody: Record<string, unknown> = {};
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
        ],
        usage: { input_tokens: 9, output_tokens: 4 },
      }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test address");
    const model = { id: "anthropic/test", provider: "anthropic", model: "test", name: "test", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "key", api: "anthropic" as const };
    const config = {
      model, maxTokens: 100, temperature: 0, timeoutMs: 2_000, maxRetries: 0,
    } as LubanConfig;
    const result = await new AnthropicClient(config).complete(
      [{ role: "system", content: "rules" }, { role: "user", content: "inspect" }],
      [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } }],
      new AbortController().signal,
    );
    expect(requestBody.system).toBe("rules");
    expect(requestBody.tools).toEqual([{ name: "read_file", description: "read", input_schema: { type: "object" } }]);
    expect(result.content).toBe("checking");
    expect(result.toolCalls[0]?.function).toEqual({ name: "read_file", arguments: '{"path":"a.ts"}' });
    expect(result.usage).toEqual({ input: 9, output: 4 });
  });

  it("streams text, thinking, tool arguments and usage", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":8}}}\n\n');
      response.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan "}}\n\n');
      response.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hello"}}\n\n');
      response.write('event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"t1","name":"read_file","input":{}}}\n\n');
      response.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}\n\n');
      response.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n');
      response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test address");
    const model = { id: "anthropic/test", provider: "anthropic", model: "test", name: "test", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", api: "anthropic" as const };
    const config = { model, maxTokens: 100, temperature: 0, timeoutMs: 2_000, maxRetries: 0 } as LubanConfig;
    const deltas: string[] = [];
    const result = await new AnthropicClient(config).complete(
      [{ role: "user", content: "go" }], [], new AbortController().signal, (text) => deltas.push(text),
    );
    expect(result.content).toBe("hello");
    expect(result.reasoning).toBe("plan ");
    expect(result.toolCalls[0]?.function).toEqual({ name: "read_file", arguments: '{"path":"a.ts"}' });
    expect(result.usage).toEqual({ input: 8, output: 5 });
    expect(deltas).toEqual(["plan ", "hello"]);
  });
});
