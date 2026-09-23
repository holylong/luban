import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { LubanConfig } from "./types.js";

export interface LspServerSettings {
  command: string;
  args: string[];
  languages: string[];
  enabled: boolean;
}

type JsonObject = Record<string, unknown>;

/** Minimal stdio LSP client (Content-Length framing) for definition/reference/symbol queries. */
export class LspClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly opened = new Set<string>();
  private readonly published = new Map<string, JsonObject[]>();

  constructor(private readonly workspace: string, private readonly settings: LspServerSettings) {
    this.child = spawn(settings.command, settings.args, {
      cwd: workspace, env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stderr.on("data", () => undefined);
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("close", (code) => this.failAll(new Error(`LSP server exited with ${code}`)));
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (this.buffer.length > 8_000_000) this.buffer = Buffer.alloc(0);
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      if (!Number.isFinite(length) || length > 8_000_000) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      if (this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      let message: JsonObject;
      try {
        message = JSON.parse(body) as JsonObject;
      } catch {
        continue;
      }
      if (typeof message.id !== "number") {
        if (message.method === "textDocument/publishDiagnostics" && message.params && typeof message.params === "object") {
          const params = message.params as JsonObject;
          if (typeof params.uri === "string") {
            this.published.set(params.uri, Array.isArray(params.diagnostics) ? params.diagnostics as JsonObject[] : []);
          }
        }
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error && typeof message.error === "object") {
        const error = message.error as JsonObject;
        pending.reject(new Error(`LSP error ${String(error.code ?? "")}: ${String(error.message ?? "unknown")}`));
      } else pending.resolve(message.result);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private send(message: JsonObject): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]));
  }

  request(method: string, params: JsonObject, signal: AbortSignal, timeoutMs = 20_000): Promise<unknown> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal.removeEventListener("abort", abort);
        rejectRequest(new Error(`LSP ${method} timed out after ${timeoutMs / 1_000}s`));
      }, timeoutMs);
      const abort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        rejectRequest(signal.reason ?? new Error("aborted"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolveRequest(value); },
        reject: (error) => { clearTimeout(timer); signal.removeEventListener("abort", abort); rejectRequest(error); },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: JsonObject = {}): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async initialize(signal: AbortSignal): Promise<void> {
    await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(resolve(this.workspace)).toString(),
      capabilities: {},
    }, signal);
    this.notify("initialized");
  }

  publishedDiagnostics(uri: string): JsonObject[] {
    return this.published.get(uri) ?? [];
  }

  /** Pull diagnostics when the server supports textDocument/diagnostic. */
  async pullDiagnostics(uri: string, signal: AbortSignal): Promise<JsonObject[] | undefined> {
    try {
      const result = await this.request("textDocument/diagnostic", { textDocument: { uri } }, signal) as JsonObject;
      const items = (result as JsonObject).items ?? (result as JsonObject).diagnostics;
      return Array.isArray(items) ? items as JsonObject[] : [];
    } catch (error) {
      if (error instanceof Error && /-32601|Method not found/i.test(error.message)) return undefined;
      throw error;
    }
  }

  async openDocument(absPath: string, signal: AbortSignal): Promise<string> {
    const uri = pathToFileURL(absPath).toString();
    if (this.opened.has(uri)) return uri;
    const text = await readFile(absPath, "utf8");
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId: "plaintext", version: 1, text } });
    this.opened.add(uri);
    return uri;
  }

  close(): void {
    try {
      this.child.stdin.end();
    } catch { /* already gone */ }
    this.child.kill("SIGTERM");
  }
}

const EXTENSION_LANGUAGE: Array<[RegExp, string]> = [
  [/\.pyi?$/i, "python"], [/\.go$/i, "go"], [/\.rs$/i, "rust"],
  [/\.java$/i, "java"], [/\.kt$/i, "kotlin"], [/\.c$/i, "c"],
  [/\.h$/i, "c"], [/\.cpp$/i, "cpp"], [/\.hpp$/i, "cpp"],
  [/\.rb$/i, "ruby"], [/\.php$/i, "php"], [/\.swift$/i, "swift"],
  [/\.ts$/i, "typescript"], [/\.tsx$/i, "typescriptreact"],
  [/\.js$/i, "javascript"], [/\.jsx$/i, "javascriptreact"],
];

export function languageOfPath(path: string): string {
  for (const [pattern, language] of EXTENSION_LANGUAGE) if (pattern.test(path)) return language;
  return "";
}

/** Lazily started LSP servers, keyed by server name. */
export class LspManager {
  private readonly clients = new Map<string, LspClient>();

  constructor(private readonly config: LubanConfig) {}

  serverFor(language: string): { name: string; settings: LspServerSettings } | undefined {
    const servers = this.config.lspServers ?? {};
    for (const [name, settings] of Object.entries(servers)) {
      if (!settings.enabled || !settings.command) continue;
      if (settings.languages.map((item) => item.toLowerCase()).includes(language.toLowerCase())) return { name, settings };
    }
    return undefined;
  }

  async client(name: string, settings: LspServerSettings, signal: AbortSignal): Promise<LspClient> {
    const existing = this.clients.get(name);
    if (existing) return existing;
    const created = new LspClient(this.config.workspace, settings);
    try {
      await created.initialize(signal);
      this.clients.set(name, created);
      return created;
    } catch (error) {
      created.close();
      throw error;
    }
  }

  close(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }
}

export function lspLocationToPath(uri: string, workspace: string): string | null {
  try {
    const url = new URL(String(uri));
    if (url.protocol !== "file:") return null;
    const rel = resolve(workspace);
    void rel;
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}
