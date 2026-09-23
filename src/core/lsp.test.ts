import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LspClient, LspManager, languageOfPath } from "./lsp.js";
import type { LubanConfig } from "./types.js";

const MOCK_SERVER = `
let buffer = Buffer.alloc(0);
function send(obj, id) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, ...obj }), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\\r\\n\\r\\n");
    if (end < 0) return;
    const len = Number(buffer.subarray(0, end).toString().match(/Content-Length:\\s*(\\d+)/i)[1]);
    if (buffer.length < end + 4 + len) return;
    const msg = JSON.parse(buffer.subarray(end + 4, end + 4 + len).toString("utf8"));
    buffer = buffer.subarray(end + 4 + len);
    if (msg.method === "initialize") send({ result: { capabilities: {} } }, msg.id);
    else if (msg.method === "textDocument/documentSymbol") send({ result: [{ name: "hello", kind: 12, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } }, selectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } } }] }, msg.id);
    else if (msg.method === "textDocument/definition") {
      const uri = msg.params.textDocument.uri;
      send({ result: [{ uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }] }, msg.id);
    } else if (msg.method && msg.id !== undefined) send({ result: null }, msg.id);
  }
});
`;

describe("lsp bridge", () => {
  it("maps extensions to languages", () => {
    expect(languageOfPath("a.py")).toBe("python");
    expect(languageOfPath("a.go")).toBe("go");
    expect(languageOfPath("a.rs")).toBe("rust");
    expect(languageOfPath("notes.md")).toBe("");
  });

  it("queries symbols and definitions through a mock server", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-lsp-"));
    const serverPath = join(root, "mock-lsp.mjs");
    await writeFile(serverPath, MOCK_SERVER);
    await writeFile(join(root, "app.py"), "def hello():\n    pass\n");
    const signal = new AbortController().signal;
    const client = new LspClient(root, { command: process.execPath, args: [serverPath], languages: ["python"], enabled: true });
    try {
      await client.initialize(signal);
      const uri = await client.openDocument(join(root, "app.py"), signal);
      expect(uri).toBe(pathToFileURL(join(root, "app.py")).toString());
      const symbols = await client.request("textDocument/documentSymbol", { textDocument: { uri } }, signal) as Array<{ name: string }>;
      expect(symbols[0]?.name).toBe("hello");
      const defs = await client.request("textDocument/definition",
        { textDocument: { uri }, position: { line: 0, character: 5 } }, signal) as Array<{ uri: string }>;
      expect(defs[0]?.uri).toBe(uri);
    } finally {
      client.close();
    }
  });

  it("resolves servers per language from config", () => {
    const manager = new LspManager({
      workspace: "/tmp/ws",
      lspServers: { py: { command: "pyright-langserver", args: ["--stdio"], languages: ["python"], enabled: true } },
    } as LubanConfig);
    expect(manager.serverFor("python")?.name).toBe("py");
    expect(manager.serverFor("go")).toBeUndefined();
    manager.close();
  });
});
