import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { callMcpTool, listMcpTools, McpManager } from "./mcp.js";
import type { LubanConfig } from "./types.js";

const fakeServer = String.raw`
const readline = require("node:readline");
let calls = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  let result = {};
  if (m.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } };
  if (m.method === "tools/list") result = { tools: [{ name: "echo", description: "echo input", inputSchema: { type: "object" } }] };
  if (m.method === "tools/call") result = { content: [{ type: "text", text: m.params.arguments.text }], call: ++calls };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n");
});
`;

describe("MCP stdio bridge", () => {
  it("discovers and invokes tools using the MCP lifecycle", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-mcp-"));
    const config = {
      workspace,
      mcpServers: { fake: { command: process.execPath, args: ["-e", fakeServer], env: {}, enabled: true } },
    } as LubanConfig;
    const signal = new AbortController().signal;
    const listed = await listMcpTools(config, signal);
    expect(listed).toContain('"name": "echo"');
    const called = await callMcpTool(config, "fake", "echo", { text: "hello" }, signal);
    expect(called).toContain("hello");
  });

  it("registers trusted tools natively and keeps their server session alive", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-mcp-persistent-"));
    const config = {
      workspace,
      mcpServers: { fake: { command: process.execPath, args: ["-e", fakeServer], env: {}, enabled: true, trusted: true } },
    } as LubanConfig;
    const manager = new McpManager(config);
    const signal = new AbortController().signal;
    try {
      const discovered = await manager.discoverNativeTools(signal);
      expect(discovered.errors).toEqual([]);
      expect(discovered.tools[0]?.name).toBe("mcp_fake_echo");
      await expect(discovered.tools[0]!.execute({ text: "first" }, signal)).resolves.toContain('"call": 1');
      await expect(discovered.tools[0]!.execute({ text: "second" }, signal)).resolves.toContain('"call": 2');
    } finally {
      manager.close();
    }
  });

  it("uses a persistent Streamable HTTP session and parses SSE responses", async () => {
    let calls = 0;
    let auth = "";
    const http = createServer(async (request, response) => {
      auth = String(request.headers.authorization || "");
      if (request.method === "DELETE") { response.writeHead(204).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      response.setHeader("mcp-session-id", "session-1");
      if (message.method === "initialize") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }));
      } else if (message.method === "tools/list") {
        response.setHeader("content-type", "text/event-stream");
        response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "remote", inputSchema: { type: "object" } }] } })}\n\n`);
      } else {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { call: ++calls } }));
      }
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    try {
      const address = http.address();
      if (!address || typeof address === "string") throw new Error("no test address");
      const config = {
        workspace: ".",
        mcpServers: { remote: { url: `http://127.0.0.1:${address.port}/mcp`, args: [], env: {}, headers: { authorization: "Bearer test" }, enabled: true, trusted: true } },
      } as LubanConfig;
      const manager = new McpManager(config);
      const signal = new AbortController().signal;
      const discovered = await manager.discoverNativeTools(signal);
      expect(discovered.tools[0]?.name).toBe("mcp_remote_remote");
      await expect(discovered.tools[0]!.execute({}, signal)).resolves.toContain('"call": 1');
      await expect(discovered.tools[0]!.execute({}, signal)).resolves.toContain('"call": 2');
      expect(auth).toBe("Bearer test");
      manager.close();
    } finally {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });
});
