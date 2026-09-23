import { describe, expect, it } from "vitest";
import { AcpServer } from "./acp.js";

async function drive(inputs: string[], run?: (id: string, workspace: string, text: string, onChunk: (text: string) => void, signal: AbortSignal) => Promise<string>) {
  const out: string[] = [];
  const server = new AcpServer("/tmp/ws", run ?? (async (_id, _ws, text, onChunk) => {
    onChunk(`echo:${text}`);
    return `echo:${text}`;
  }), (line) => out.push(line));
  for (const line of inputs) await server.handleLine(line);
  return { out: out.map((line) => JSON.parse(line)), server };
}

describe("acp server", () => {
  it("negotiates capabilities", async () => {
    const { out } = await drive([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })]);
    expect(out[0].result.agentCapabilities.promptCapabilities.embeddedContext).toBe(true);
  });

  it("creates sessions and streams prompt chunks", async () => {
    const first = await drive([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp/ws" } })]);
    const sessionId = first.out[0].result.sessionId as string;
    expect(typeof sessionId).toBe("string");
    const second = await drive([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} }),
    ]);
    const id = second.out[0].result.sessionId as string;
    const { out } = await (async () => {
      const lines: string[] = [];
      const server = new AcpServer("/tmp/ws", async (_sid, _ws, text, onChunk) => {
        onChunk(`echo:${text}`);
        return "done";
      }, (line) => lines.push(line));
      await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} }));
      const created = JSON.parse(lines[0]).result.sessionId as string;
      await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: created, prompt: [{ type: "text", text: "hi" }] } }));
      void id;
      return { out: lines.map((line) => JSON.parse(line)), server };
    })();
    const update = out.find((message) => message.method === "session/update");
    expect(update.params.update.content.text).toBe("echo:hi");
    expect(out.at(-1).result).toEqual({ stopReason: "end_turn" });
  });

  it("rejects unknown sessions and methods", async () => {
    const { out } = await drive([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "nope", prompt: [] } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "nope/method", params: {} }),
    ]);
    expect(out[0].error.message).toMatch(/unknown session/);
    expect(out[1].error.message).toMatch(/unknown method/);
  });

  it("cancels an in-flight prompt", async () => {
    const lines: string[] = [];
    const server = new AcpServer("/tmp/ws", (_id, _ws, _text, _onChunk, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled by client")), { once: true });
    }), (line) => lines.push(line));
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} }));
    const sessionId = JSON.parse(lines[0]).result.sessionId as string;
    const pending = server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "slow" }] } }));
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/cancel", params: { sessionId } }));
    await pending;
    const parsed = lines.map((line) => JSON.parse(line));
    expect(parsed.find((message) => message.id === 3).result).toEqual({ ok: true });
    expect(parsed.find((message) => message.id === 2).error.message).toMatch(/cancelled/);
  });
});
