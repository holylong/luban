import React from "react";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { render } from "ink";
import { expect, it } from "vitest";
import { loadConfig } from "../core/config.js";
import { SessionStore } from "../core/session-store.js";
import { App } from "./app.js";
import { readFrame } from "./test-frames.js";

/** A minimal stdio MCP server: initialize + tools/list, nothing else. */
const DEMO_SERVER = `let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    const result = msg.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "demo", version: "1" } }
      : msg.method === "tools/list"
        ? { tools: [{ name: "ping", description: "ping" }, { name: "echo", description: "echo" }] }
        : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  }
});
`;

async function harness(options: { servers?: Record<string, unknown> } = {}) {
  const home = await mkdtemp(join(tmpdir(), "luban-mcp-ui-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const serverPath = join(home, "demo-server.mjs");
  await writeFile(serverPath, DEMO_SERVER);
  const configPath = join(home, "config.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: options.servers ?? { demo: { command: process.execPath, args: [serverPath], trusted: true } } }, null, 2));
  const oldHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  const config = loadConfig({ workspace });
  const store = new SessionStore(home);
  const session = store.create(config.project, workspace, "auto", config.model.id, [
    { role: "user", content: "original request" },
    { role: "assistant", content: "previous answer" },
  ]);
  await store.save(session);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: true });
  let frame = "";
  stdout.on("data", (data) => { frame = readFrame(stdout, data); });
  const app = render(<App config={config} resume={session.id} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: false, patchConsole: false, exitOnCtrlC: false, incrementalRendering: false,
  });
  const composer = () => frame.slice(frame.lastIndexOf("❯"));
  return {
    stdin, frame: () => frame, composer, configPath, serverPath,
    type: (text: string) => stdin.write(text),
    press: (key: string) => stdin.write(key),
    saved: async () => JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>,
    cleanup: () => {
      app.unmount();
      app.cleanup();
      if (oldHome === undefined) delete process.env.LUBAN_HOME;
      else process.env.LUBAN_HOME = oldHome;
    },
  };
}

it("lists MCP servers and toggles enabled/trust in the config file", async () => {
  const ui = await harness();
  try {
    await expect.poll(() => ui.frame(), { timeout: 5000 }).toContain("previous answer");
    ui.type("/mcp");
    await expect.poll(ui.composer).toContain("/mcp");
    ui.press("\r");
    await expect.poll(() => ui.frame(), { timeout: 5000 }).toContain("MCP · Enter 试连");
    await expect.poll(() => ui.frame()).toContain("demo");
    await expect.poll(() => ui.frame()).toContain("trusted（工具直接注册）");
    // `e` flips the enabled flag on disk and the row says so immediately.
    ui.press("e");
    await expect.poll(async () => (await ui.saved()).mcpServers.demo.enabled, { timeout: 5000 }).toBe(false);
    await expect.poll(() => ui.frame()).toContain("（停用）");
    await expect.poll(() => ui.frame()).toContain("已停用");
    ui.press("t");
    await expect.poll(async () => (await ui.saved()).mcpServers.demo.trusted, { timeout: 5000 }).toBe(false);
    await expect.poll(() => ui.frame()).toContain("需批准后调用");
    // Deleting takes two presses: the first one only arms the confirmation.
    ui.press("x");
    await expect.poll(() => ui.frame()).toContain("确认删除？");
    expect((await ui.saved()).mcpServers.demo).toBeDefined();
    ui.press("x");
    await expect.poll(async () => (await ui.saved()).mcpServers ?? {}, { timeout: 5000 }).toEqual({});
    await expect.poll(() => ui.frame()).toContain("已删除 MCP 服务 demo");
  } finally {
    ui.cleanup();
  }
}, 20000);

it("test-connects the selected MCP server and reports its tools", async () => {
  const ui = await harness();
  try {
    await expect.poll(() => ui.frame(), { timeout: 5000 }).toContain("previous answer");
    ui.type("/mcp");
    await expect.poll(ui.composer).toContain("/mcp");
    ui.press("\r");
    await expect.poll(() => ui.frame(), { timeout: 5000 }).toContain("MCP · Enter 试连");
    ui.press("\r");
    await expect.poll(() => ui.frame(), { timeout: 15000 }).toContain("连接成功 · 2 个工具");
    await expect.poll(() => ui.frame()).toContain("ping");
    await expect.poll(() => ui.frame()).toContain("2 个工具");
  } finally {
    ui.cleanup();
  }
}, 25000);

it("explains an empty MCP configuration instead of opening an empty list", async () => {
  const ui = await harness({ servers: {} });
  try {
    await expect.poll(() => ui.frame(), { timeout: 5000 }).toContain("previous answer");
    ui.type("/mcp");
    await expect.poll(ui.composer).toContain("/mcp");
    ui.press("\r");
    await expect.poll(() => ui.frame(), { timeout: 5000 }).toContain("没有配置 MCP 服务");
    expect(ui.frame()).not.toContain("MCP · Enter 试连");
  } finally {
    ui.cleanup();
  }
}, 15000);
