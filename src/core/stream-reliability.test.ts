import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { OpenAiClient } from "./openai.js";
import { AnthropicClient } from "./anthropic.js";
import { sseData } from "./sse.js";
import type { LubanConfig } from "./types.js";
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function endpoint(body: string, json = false) {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { "content-type": json ? "application/json" : "text/event-stream" });
    response.end(body);
  }); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const config = { model: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test", apiKey: "" }, timeoutMs: 1000, maxRetries: 2, maxTokens: 100 } as LubanConfig;
  return { config, requests: () => requests };
}
const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const openText = frame({ choices: [{ delta: { content: "partial" } }] });
const anthropicText = frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } });

for (const [name, Client, text] of [["openai", OpenAiClient, openText], ["anthropic", AnthropicClient, anthropicText]] as const) {
  describe(name, () => {
    it("rejects premature EOF without retrying or duplicating streamed text", async () => {
      const fixture = await endpoint(text);
      const deltas: string[] = [];
      await expect(new Client(fixture.config).complete([], [], new AbortController().signal, (text) => deltas.push(text))).rejects.toThrow("stream ended");
      expect(fixture.requests()).toBe(1);
      expect(deltas).toEqual(["partial"]);
    });
    it("surfaces provider error events even after partial text", async () => {
      const fixture = await endpoint(text + frame({ type: "error", error: { message: "overloaded" } }));
      await expect(new Client(fixture.config).complete([], [], new AbortController().signal)).rejects.toThrow("overloaded");
      expect(fixture.requests()).toBe(1);
    });
    it("does not silently discard malformed events", async () => {
      const fixture = await endpoint(text + "data: {broken\n\n");
      await expect(new Client(fixture.config).complete([], [], new AbortController().signal)).rejects.toThrow("malformed");
      expect(fixture.requests()).toBe(1);
    });
    it("does not make a request with an already aborted signal", async () => {
      const fixture = await endpoint(text);
      const controller = new AbortController(); controller.abort(new Error("cancelled"));
      await expect(new Client(fixture.config).complete([], [], controller.signal)).rejects.toThrow("cancelled");
      expect(fixture.requests()).toBe(0);
    });
  });
}
it("keeps the text of a truncated response and refuses incomplete tool arguments", async () => {
  // Hitting the provider's output cap still produced real text. Reporting it as
  // data lets the run continue from there; throwing used to throw the answer away.
  const exhausted = await endpoint(openText + frame({ choices: [{ delta: {}, finish_reason: "length" }] }) + "data: [DONE]\n\n");
  expect(await new OpenAiClient(exhausted.config).complete([], [], new AbortController().signal))
    .toMatchObject({ content: "partial", truncated: true, toolCalls: [] });
  const anthropic = await endpoint(anthropicText + frame({ type: "message_delta", delta: { stop_reason: "max_tokens" } }) + frame({ type: "message_stop" }));
  expect(await new AnthropicClient(anthropic.config).complete([], [], new AbortController().signal))
    .toMatchObject({ content: "partial", truncated: true, toolCalls: [] });

  // A response cut off inside a tool call is different: those arguments cannot
  // be trusted, so they are rejected rather than executed half-written.
  const incomplete = await endpoint(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "write_file", arguments: '{"path":' } }] } }] }) + "data: [DONE]\n\n");
  await expect(new OpenAiClient(incomplete.config).complete([], [], new AbortController().signal)).rejects.toThrow("tool arguments");
});
it("accepts a completed compatible stream without DONE and rejects empty JSON success", async () => {
  const finished = await endpoint(openText + frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
  expect((await new OpenAiClient(finished.config).complete([], [], new AbortController().signal)).content).toBe("partial");
  const empty = await endpoint("{}", true);
  await expect(new OpenAiClient(empty.config).complete([], [], new AbortController().signal)).rejects.toThrow("empty");
  expect(empty.requests()).toBe(1);
});
it("parses multi-line SSE data and UTF-8 split at every byte boundary", async () => {
  const bytes = new TextEncoder().encode(': ping\r\ndata: {"text":\r\ndata: "中文🙂"}\r\n\r\ndata: [DONE]');
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (index === bytes.length) controller.close(); else controller.enqueue(bytes.slice(index, ++index));
  } });
  const events: string[] = [];
  for await (const raw of sseData(stream)) events.push(raw);
  expect(JSON.parse(events[0]!)).toEqual({ text: "中文🙂" });
  expect(events[1]).toBe("[DONE]");
});

it("explains a retryable failure before retrying it", async () => {
  let calls = 0;
  const server = createServer((request, response) => {
    calls += 1;
    if (calls === 1) {
      response.writeHead(429, { "content-type": "application/json" });
      response.end('{"error":{"message":"rate limited"}}');
      return;
    }
    // Each client speaks its own dialect, and they differ only by request path.
    const anthropic = (request.url ?? "").endsWith("/messages");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(anthropic
      ? anthropicText + frame({ type: "message_delta", delta: { stop_reason: "end_turn" } }) + frame({ type: "message_stop" })
      : openText + frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const config = { model: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test", apiKey: "" }, timeoutMs: 1000, maxRetries: 2, maxTokens: 100 } as LubanConfig;
  // A silent retry is indistinguishable from a slow model, so both clients owe
  // the user a line saying what failed and when the next attempt starts.
  for (const [name, Client] of [["openai", OpenAiClient], ["anthropic", AnthropicClient]] as const) {
    calls = 0;
    const notices: string[] = [];
    const result = await new Client(config).complete([], [], new AbortController().signal, undefined, (text) => notices.push(text));
    expect({ name, content: result.content, calls }).toEqual({ name, content: "partial", calls: 2 });
    expect(notices.join("\n")).toContain("HTTP 429");
    expect(notices.join("\n")).toContain("第 2/3 次");
  }
});

it("announces a stream that went quiet instead of only aborting it", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    // Headers only: the model accepted the request and then never answered.
    response.flushHeaders();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const config = {
    model: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test", apiKey: "" },
    timeoutMs: 1000, thinkingTimeoutMs: 120, maxRetries: 0, maxTokens: 100,
  } as LubanConfig;
  const notices: string[] = [];
  const startedAt = Date.now();
  await expect(new OpenAiClient(config).complete([], [], new AbortController().signal, undefined, (text) => notices.push(text))).rejects.toThrow();
  expect(notices.join("\n")).toContain("没有任何输出");
  // The user must not have to sit through the ten-minute default to learn it.
  expect(Date.now() - startedAt).toBeLessThan(2_000);
});
