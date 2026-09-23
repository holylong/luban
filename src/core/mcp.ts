import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import type { LubanConfig, McpServerSettings, ToolDefinition } from "./types.js";
import { VERSION } from "../version.js";

type JsonObject = Record<string, unknown>;

interface McpSession {
  request(method: string, params: JsonObject, signal: AbortSignal, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: JsonObject): Promise<void>;
  close(): void;
}

class StdioMcpSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private nextId = 1;
  private buffer = "";
  private stderr = "";

  constructor(settings: McpServerSettings & { command: string }, workspace: string) {
    this.child = spawn(settings.command, settings.args, {
      cwd: settings.cwd ? resolve(workspace, settings.cwd) : workspace,
      env: { ...process.env, ...settings.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-4_000); });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("close", (code) => this.failAll(new Error(`MCP server exited with ${code}${this.stderr ? `: ${this.stderr.trim()}` : ""}`)));
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonObject;
      try { message = JSON.parse(line) as JsonObject; } catch { continue; }
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error && typeof message.error === "object") {
        const error = message.error as JsonObject;
        pending.reject(new Error(`MCP error ${String(error.code ?? "")}: ${String(error.message ?? "unknown error")}`));
      } else pending.resolve(message.result);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async notify(method: string, params: JsonObject = {}): Promise<void> {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async request(method: string, params: JsonObject, signal: AbortSignal, timeoutMs = 30_000): Promise<unknown> {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    const id = this.nextId++;
    return await new Promise((resolveRequest, rejectRequest) => {
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
      const abort = () => { this.pending.delete(id); cleanup(); rejectRequest(signal.reason ?? new Error("aborted")); };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal.removeEventListener("abort", abort);
        rejectRequest(new Error(`MCP ${method} timed out after ${timeoutMs / 1_000}s`));
      }, timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => { cleanup(); resolveRequest(value); },
        reject: (error) => { cleanup(); rejectRequest(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close(): void {
    this.child.kill("SIGTERM");
  }
}

class HttpMcpSession implements McpSession {
  private nextId = 1;
  private sessionId = "";

  constructor(private readonly settings: McpServerSettings) {}

  private async send(message: JsonObject, signal: AbortSignal): Promise<Response> {
    if (!this.settings.url) throw new Error("MCP HTTP server is missing url");
    return await fetch(this.settings.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...this.settings.headers,
      },
      body: JSON.stringify(message),
      signal,
    });
  }

  async request(method: string, params: JsonObject, signal: AbortSignal, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => controller.abort(new Error(`MCP ${method} timed out after ${timeoutMs / 1_000}s`)), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.send({ jsonrpc: "2.0", id, method, params }, controller.signal);
      this.sessionId = response.headers.get("mcp-session-id") || this.sessionId;
      if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${(await response.text()).slice(0, 600)}`);
      const type = response.headers.get("content-type") || "";
      let message: JsonObject;
      if (type.includes("text/event-stream")) {
        const text = await response.text();
        const events = text.split(/\r?\n\r?\n/).flatMap((event) => {
          const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (!data) return [];
          try { return [JSON.parse(data) as JsonObject]; } catch { return []; }
        });
        message = events.find((event) => event.id === id) ?? {};
      } else message = await response.json() as JsonObject;
      if (message.error && typeof message.error === "object") {
        const error = message.error as JsonObject;
        throw new Error(`MCP error ${String(error.code ?? "")}: ${String(error.message ?? "unknown error")}`);
      }
      return message.result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  async notify(method: string, params: JsonObject = {}): Promise<void> {
    const response = await this.send({ jsonrpc: "2.0", method, params }, new AbortController().signal);
    if (!response.ok) throw new Error(`MCP HTTP notification failed with ${response.status}`);
  }

  close(): void {
    if (!this.settings.url || !this.sessionId) return;
    void fetch(this.settings.url, {
      method: "DELETE",
      headers: { "mcp-session-id": this.sessionId, "mcp-protocol-version": "2025-06-18", ...this.settings.headers },
    }).catch(() => undefined);
  }
}

function createSession(settings: McpServerSettings, workspace: string): McpSession {
  if (settings.url) return new HttpMcpSession(settings);
  if (!settings.command) throw new Error("MCP stdio server is missing command");
  return new StdioMcpSession({ ...settings, command: settings.command }, workspace);
}

async function initialize(session: McpSession, signal: AbortSignal): Promise<void> {
  await session.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "luban", version: VERSION },
  }, signal);
  await session.notify("notifications/initialized");
}

async function withServer<T>(settings: McpServerSettings, workspace: string, signal: AbortSignal, action: (session: McpSession) => Promise<T>): Promise<T> {
  const session = createSession(settings, workspace);
  try {
    await initialize(session, signal);
    return await action(session);
  } finally {
    session.close();
  }
}

function safeToolPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "tool";
}

/** Persistent MCP connections used by one AgentRunner across multiple turns. */
export class McpManager {
  private readonly sessions = new Map<string, McpSession>();
  private readonly nativeNames = new Map<string, { server: string; tool: string }>();

  constructor(private readonly config: LubanConfig) {}

  private async session(name: string, signal: AbortSignal): Promise<McpSession> {
    const existing = this.sessions.get(name);
    if (existing) return existing;
    const settings = this.config.mcpServers?.[name];
    if (!settings?.enabled) throw new Error(`unknown or disabled MCP server: ${name}`);
    const created = createSession(settings, this.config.workspace);
    try {
      await initialize(created, signal);
      this.sessions.set(name, created);
      return created;
    } catch (error) {
      created.close();
      throw error;
    }
  }

  async discoverNativeTools(signal: AbortSignal): Promise<{ tools: ToolDefinition[]; errors: string[] }> {
    const tools: ToolDefinition[] = [];
    const errors: string[] = [];
    // Lazy mode keeps schemas out of every turn: only a dispatcher is registered
    // and concrete schemas are fetched through mcp_search_tools / mcp_call.
    if (this.config.mcpLazy) return { tools, errors };
    const maxTools = Math.max(4, Math.min(256, this.config.mcpMaxTools ?? 64));
    const servers = Object.entries(this.config.mcpServers ?? {}).filter(([, settings]) => settings.enabled && settings.trusted);
    await Promise.all(servers.map(async ([serverName]) => {
      try {
        const session = await this.session(serverName, signal);
        const result = await session.request("tools/list", {}, signal) as JsonObject;
        const listed = Array.isArray(result?.tools) ? result.tools as JsonObject[] : [];
        for (const item of listed) {
          if (tools.length >= maxTools) {
            errors.push(`MCP schema budget reached (${maxTools}); remaining tools available via mcp_search_tools/mcp_call`);
            break;
          }
          const remoteName = String(item.name || "");
          if (!remoteName) continue;
          let nativeName = `mcp_${safeToolPart(serverName)}_${safeToolPart(remoteName)}`.slice(0, 64);
          let suffix = 2;
          while (this.nativeNames.has(nativeName) && this.nativeNames.get(nativeName)?.tool !== remoteName) {
            nativeName = `${nativeName.slice(0, 60)}_${suffix++}`;
          }
          this.nativeNames.set(nativeName, { server: serverName, tool: remoteName });
          const description = String(item.description || "External MCP tool");
          tools.push({
            name: nativeName,
            description: `[MCP ${serverName}/${remoteName}] ${description.slice(0, 400)}`,
            risk: "network",
            parameters: item.inputSchema && typeof item.inputSchema === "object" ? item.inputSchema as JsonObject : { type: "object" },
            execute: (args, callSignal) => this.call(serverName, remoteName, args, callSignal),
          });
        }
      } catch (error) {
        errors.push(`${serverName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    return { tools: tools.slice(0, maxTools), errors };
  }

  async call(serverName: string, toolName: string, args: JsonObject, signal: AbortSignal): Promise<string> {
    const session = await this.session(serverName, signal);
    const result = await session.request("tools/call", { name: toolName, arguments: args }, signal);
    return JSON.stringify(result, null, 2);
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}

export async function listMcpTools(config: LubanConfig, signal: AbortSignal): Promise<string> {
  const entries = Object.entries(config.mcpServers ?? {}).filter(([, server]) => server.enabled);
  if (!entries.length) return "(no MCP servers configured)";
  const groups = await Promise.all(entries.map(async ([serverName, settings]) => {
    try {
      const result = await withServer(settings, config.workspace, signal, (session) => session.request("tools/list", {}, signal)) as JsonObject;
      const tools = Array.isArray(result?.tools) ? result.tools as JsonObject[] : [];
      return tools.map((tool) => ({ server: serverName, name: String(tool.name || ""), description: String(tool.description || ""), inputSchema: tool.inputSchema ?? {} }));
    } catch (error) {
      return [{ server: serverName, error: error instanceof Error ? error.message : String(error) }];
    }
  }));
  return JSON.stringify(groups.flat(), null, 2);
}

export async function searchMcpTools(config: LubanConfig, query: string, limit: number, signal: AbortSignal): Promise<string> {
  const raw = await listMcpTools(config, signal);
  let entries: Array<Record<string, unknown>>;
  try {
    entries = JSON.parse(raw) as Array<Record<string, unknown>>;
  } catch {
    return raw;
  }
  const needle = query.trim().toLowerCase();
  const scored = entries.map((entry) => {
    const hay = `${String(entry.server ?? "")} ${String(entry.name ?? "")} ${String(entry.description ?? "")}`.toLowerCase();
    const score = !needle ? 1 : hay.includes(needle) ? 2 + (String(entry.name ?? "").toLowerCase().includes(needle) ? 1 : 0) : 0;
    return { entry, score };
  }).filter((item) => item.score > 0);
  scored.sort((a, b) => b.score - a.score);
  const sliced = scored.slice(0, Math.max(1, Math.min(50, limit))).map((item) => item.entry);
  if (!sliced.length) return `(no MCP tools match ${JSON.stringify(query)}; use mcp_list_tools for the full catalogue)`;
  return JSON.stringify(sliced, null, 2);
}

export async function callMcpTool(config: LubanConfig, serverName: string, toolName: string, args: JsonObject, signal: AbortSignal): Promise<string> {
  const settings = config.mcpServers?.[serverName];
  if (!settings?.enabled) throw new Error(`unknown or disabled MCP server: ${serverName}`);
  const result = await withServer(settings, config.workspace, signal, (session) => session.request("tools/call", { name: toolName, arguments: args }, signal));
  return JSON.stringify(result, null, 2);
}
