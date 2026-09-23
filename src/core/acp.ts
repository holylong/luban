import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

type JsonObject = Record<string, unknown>;

export interface AcpPromptPart { type: string; text?: string }
export interface AcpRunHandler {
  (sessionId: string, workspace: string, text: string, onChunk: (text: string) => void, signal: AbortSignal): Promise<string>;
}

interface AcpSession { id: string; workspace: string; controller?: AbortController }

function rpcError(id: unknown, code: number, message: string): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`;
}

function rpcResult(id: unknown, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
}

function notification(method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
}

/** Minimal Agent Client Protocol endpoint over newline-delimited JSON-RPC. */
export class AcpServer {
  private readonly sessions = new Map<string, AcpSession>();

  constructor(
    private readonly defaultWorkspace: string,
    private readonly run: AcpRunHandler,
    private readonly send: (line: string) => void,
  ) {}

  sessionCount(): number {
    return this.sessions.size;
  }

  async handleLine(line: string): Promise<void> {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return;
    }
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
    const id = message.id;
    const params = (message.params ?? {}) as JsonObject;
    try {
      if (message.method === "initialize") {
        this.send(rpcResult(id, {
          protocolVersion: 1,
          agentCapabilities: {
            promptCapabilities: { image: false, embeddedContext: true },
            mcpCapabilities: { http: false, sse: false },
          },
        }));
      } else if (message.method === "session/new") {
        const workspace = typeof params.cwd === "string" && params.cwd ? resolve(params.cwd) : this.defaultWorkspace;
        const session: AcpSession = { id: randomUUID(), workspace };
        this.sessions.set(session.id, session);
        this.send(rpcResult(id, { sessionId: session.id }));
      } else if (message.method === "session/prompt") {
        const session = this.sessions.get(String(params.sessionId ?? ""));
        if (!session) throw new Error(`unknown session: ${String(params.sessionId ?? "")}`);
        const parts = Array.isArray(params.prompt) ? params.prompt as AcpPromptPart[] : [];
        const text = parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();
        if (!text) throw new Error("prompt is empty");
        session.controller?.abort(new Error("superseded by a new prompt"));
        const controller = new AbortController();
        session.controller = controller;
        const onChunk = (chunk: string) => {
          this.send(notification("session/update", {
            sessionId: session.id,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } },
          }));
        };
        try {
          await this.run(session.id, session.workspace, text, onChunk, controller.signal);
          this.send(rpcResult(id, { stopReason: "end_turn" }));
        } finally {
          if (session.controller === controller) session.controller = undefined;
        }
      } else if (message.method === "session/cancel") {
        const session = this.sessions.get(String(params.sessionId ?? ""));
        if (!session) throw new Error(`unknown session: ${String(params.sessionId ?? "")}`);
        session.controller?.abort(new Error("cancelled by client"));
        this.send(rpcResult(id, { ok: true }));
      } else {
        throw new Error(`unknown method: ${message.method}`);
      }
    } catch (error) {
      if (id !== undefined) this.send(rpcError(id, -32000, error instanceof Error ? error.message : String(error)));
    }
  }
}
