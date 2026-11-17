import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTools } from "./tools.js";
import {
  ComputerControl, beginComputerAtStartup, beginFromEnvironment, checkPermissions, computerControl, computerHome, ensureHelper,
  computerSupported, glowNotifier, helperSource, resetComputerControlForTests,
} from "./computer.js";

// A stand-in for the compiled Swift helper: it reads one JSON line, appends it to
// a log and answers like the real one. Tests never inject real input.
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
let data = "";
process.stdin.on("data", chunk => { data += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(data.trim() || "{}");
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(request) + "\\n");
  if (request.action === "check") return console.log(JSON.stringify({ ok: true, accessibility: true, postEvent: true, screenRecording: true, displayScale: 2 }));
  if (request.action === "screenshot") { fs.writeFileSync(request.path, "png"); return console.log(JSON.stringify({ ok: true, path: request.path, bytes: 3 })); }
  if (request.action === "cursor") return console.log(JSON.stringify({ ok: true, x: 120, y: 340 }));
  if (request.action === "fail") return console.log(JSON.stringify({ ok: false, error: "模拟失败" }));
  console.log(JSON.stringify({ ok: true }));
});
`;

let root: string;
let helper: string;
let log: string;
const original = { helper: process.env.LUBAN_COMPUTER_HELPER, home: process.env.LUBAN_HOME, glow: process.env.LUBAN_GLOW_URL, token: process.env.LUBAN_GLOW_TOKEN, rim: process.env.LUBAN_GLOW_BINARY, mode: process.env.LUBAN_GLOW };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "luban-computer-"));
  helper = join(root, "fake-computer");
  log = join(root, "calls.log");
  await writeFile(helper, FAKE, { mode: 0o755 });
  process.env.LUBAN_COMPUTER_HELPER = helper;
  process.env.FAKE_LOG = log;
  delete process.env.LUBAN_GLOW_URL;
  delete process.env.LUBAN_GLOW_TOKEN;
  delete process.env.LUBAN_GLOW_BINARY;
  delete process.env.LUBAN_GLOW;
  resetComputerControlForTests();
});

afterEach(() => {
  for (const [key, value] of [["LUBAN_COMPUTER_HELPER", original.helper], ["LUBAN_HOME", original.home], ["LUBAN_GLOW_URL", original.glow], ["LUBAN_GLOW_TOKEN", original.token], ["LUBAN_GLOW_BINARY", original.rim], ["LUBAN_GLOW", original.mode]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.FAKE_LOG;
});

const calls = async (): Promise<Array<Record<string, unknown>>> => {
  const text = await readFile(log, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
};

// Every action spawns the helper process; under a 59-file parallel run the
// spawn alone can take seconds, so these cases get a generous budget.
describe("computer control", { timeout: 30_000 }, () => {
  it("refuses every action until a human opens the session", async () => {
    const control = new ComputerControl({ home: root, workspace: root });
    await expect(control.act("click", { x: 10, y: 20 })).rejects.toThrow("电脑操控未开启：请先在 luban 界面打开「电脑操控」开关；终端 TUI 可运行 /computer on，然后重试。");
    expect(await calls()).toEqual([]);
    await control.begin();
    await control.act("click", { x: 10, y: 20 });
    expect((await calls()).at(-1)).toMatchObject({ action: "click", x: 10, y: 20 });
  });

  it("speaks the helper's own verb for double and right clicks", async () => {
    const control = new ComputerControl({ home: root, workspace: root });
    await control.begin();
    const double = await control.act("double_click", { x: 30, y: 40 });
    expect(double.summary).toBe("双击 (30, 40)");
    const right = await control.act("right_click", { x: 30, y: 40 });
    expect(right.summary).toBe("右键点击 (30, 40)");
    expect(await calls()).toEqual([
      { action: "doubleclick", x: 30, y: 40 },
      { action: "rightclick", x: 30, y: 40 },
    ]);
  });

  it("aborts the next action when the desktop writes the stop flag", async () => {
    const control = new ComputerControl({ home: root, workspace: root });
    await control.begin();
    await control.act("move", { x: 1, y: 2 });
    await control.requestStop();
    await expect(control.act("move", { x: 3, y: 4 })).rejects.toThrow(/用户已中止/u);
    expect(control.enabled).toBe(false);
    // Reopening the switch clears the flag: otherwise it would abort forever.
    await control.begin();
    await control.act("move", { x: 5, y: 6 });
    expect((await calls()).at(-1)).toMatchObject({ action: "move", x: 5, y: 6 });
  });

  it("saves screenshots where the model can attach them and keeps the last 20", async () => {
    const workspace = join(root, "project");
    await mkdir(workspace, { recursive: true });
    const control = new ComputerControl({ home: root, workspace });
    await control.begin();
    const first = await control.screenshot();
    expect(first.path.startsWith(join(workspace, ".luban", "computer"))).toBe(true);
    expect(first.bytes).toBe(3);
    const directory = join(workspace, ".luban", "computer");
    for (let index = 0; index < 24; index += 1) {
      await writeFile(join(directory, `shot-00-${String(index).padStart(2, "0")}.png`), "x");
    }
    await control.screenshot();
    const kept = (await readdir(directory)).filter(name => name.endsWith(".png"));
    expect(kept.length).toBe(20);
  });

  it("reports permissions and a helpful message when they are missing", async () => {
    const missing = join(root, "denied");
    await writeFile(missing, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => console.log(JSON.stringify({ ok: true, accessibility: false, postEvent: false, screenRecording: true, displayScale: 2 })));
`, { mode: 0o755 });
    process.env.LUBAN_COMPUTER_HELPER = missing;
    const permissions = await checkPermissions(root);
    expect(permissions).toMatchObject({ accessible: false, postEvent: false, screenRecording: true, displayScale: 2 });
  });

  it("posts begin/action/end to the desktop glow endpoint", async () => {
    const seen: string[] = [];
    const server = await new Promise<import("node:http").Server>(resolve => {
      const created = require("node:http").createServer((request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => {
        let body = "";
        request.on("data", (chunk: Buffer) => { body += String(chunk); });
        request.on("end", () => {
          seen.push(`${request.headers["x-luban-glow-token"]}:${JSON.parse(body).event}`);
          response.writeHead(200).end("{}");
        });
      });
      created.listen(0, "127.0.0.1", () => resolve(created));
    });
    const port = (server.address() as { port: number }).port;
    process.env.LUBAN_GLOW_URL = `http://127.0.0.1:${port}/glow`;
    process.env.LUBAN_GLOW_TOKEN = "t0ken";
    const notify = glowNotifier();
    expect(notify).toBeTypeOf("function");
    const control = new ComputerControl({ home: root, workspace: root, notify });
    await control.begin("测试");
    await control.act("move", { x: 1, y: 1 });
    await control.end();
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
    server.close();
    expect(seen).toEqual(["t0ken:begin", "t0ken:action", "t0ken:end"]);
  });

  it("opens a session only for an explicit headless opt-in", async () => {
    expect(await beginFromEnvironment(root, root, {})).toBe(false);
    expect(await beginFromEnvironment(root, root, { LUBAN_COMPUTER: "0" })).toBe(false);
    expect(computerControl({ home: root, workspace: root }).enabled).toBe(false);
    expect(await beginFromEnvironment(root, root, { LUBAN_COMPUTER: "1" })).toBe(true);
    expect(computerControl({ home: root, workspace: root }).enabled).toBe(true);
  });

  it("accepts a configured default but explicit environment off wins", async () => {
    expect(await beginFromEnvironment(root, root, { LUBAN_COMPUTER: "0" }, true)).toBe(false);
    expect(await beginFromEnvironment(root, root, {}, true)).toBe(true);
  });

  it("does not reopen after manual off or a shared stop", async () => {
    expect(await beginComputerAtStartup(root, root, true, {})).toBe(true);
    await computerControl({ home: root, workspace: root }).end();
    expect(await beginComputerAtStartup(root, root, true, {})).toBe(false);
    resetComputerControlForTests();
    await mkdir(join(root, "computer"), { recursive: true });
    await writeFile(join(root, "computer", "stop"), "stopped");
    expect(await beginComputerAtStartup(root, root, true, { LUBAN_COMPUTER: "1" })).toBe(false);
  });

  it("locates the Swift source and honours an explicit helper override", async () => {
    expect(helperSource()).toMatch(/computer\.swift$/u);
    expect(await ensureHelper(root)).toBe(helper);
    // A stale override must say so instead of silently falling back.
    process.env.LUBAN_COMPUTER_HELPER = join(root, "ghost");
    await expect(ensureHelper(root)).rejects.toThrow(/不存在/u);
    expect(computerHome({ home: root })).toBe(root);
  });
});

// Terminal runs draw the rim themselves; the CLI is where users look for it.
describe("rim overlay", { timeout: 30_000 }, () => {
  const waitFor = async (ready: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (ready()) return;
      await new Promise(done => setTimeout(done, 50));
    }
    throw new Error("rim never started");
  };

  const fakeRim = async (): Promise<string> => {
    const rimLog = join(root, "rim.log");
    const rim = join(root, "fake-glow");
    await writeFile(rim, `#!/bin/sh\necho "$@" > '${rimLog}'\nexec sleep 30\n`, { mode: 0o755 });
    process.env.LUBAN_GLOW_BINARY = rim;
    return rimLog;
  };

  it("lights the screen when a session opens and clears it when it ends", async () => {
    if (process.platform !== "darwin") return; // the overlay is macOS-only
    const rimLog = await fakeRim();
    const control = new ComputerControl({ home: root, workspace: root });
    await control.begin("luban 正在操控 · 终端");
    await waitFor(() => control.rimPid !== undefined);
    let args = "";
    for (let attempt = 0; attempt < 100 && !args; attempt += 1) {
      args = await readFile(rimLog, "utf8").catch(() => "");
      if (!args) await new Promise(done => setTimeout(done, 50));
    }
    expect(args).toContain("luban 正在操控 · 终端");
    expect(args).toContain("--parent-pid");
    expect(args).toContain(join(root, "computer", "stop"));
    await control.end();
    expect(control.rimPid).toBeUndefined();
  });

  it("leaves the rim to the desktop app, which draws its own overlay", async () => {
    if (process.platform !== "darwin") return;
    await fakeRim();
    process.env.LUBAN_GLOW_URL = "http://127.0.0.1:7777/event";
    const control = new ComputerControl({ home: root, workspace: root });
    await control.begin();
    await new Promise(done => setTimeout(done, 200));
    expect(control.rimPid).toBeUndefined();
    await control.end();
  });

  it("stays controllable when the rim cannot start at all", async () => {
    if (process.platform !== "darwin") return;
    process.env.LUBAN_GLOW_BINARY = join(root, "missing-glow");
    const control = new ComputerControl({ home: root, workspace: root });
    await control.begin();
    await control.act("move", { x: 7, y: 8 });
    expect((await calls()).at(-1)).toMatchObject({ action: "move", x: 7, y: 8 });
    expect(control.rimPid).toBeUndefined();
  });
});

// The rest of luban must stay untouched where synthetic input cannot work.
describe("other platforms", () => {
  const asPlatform = async <T>(platform: string, body: () => Promise<T> | T): Promise<T> => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      return await body();
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  };

  it("claims support only on macOS", async () => {
    expect(computerSupported("darwin")).toBe(true);
    expect(computerSupported("linux")).toBe(false);
    expect(computerSupported("win32")).toBe(false);
    await asPlatform("linux", () => {
      expect(computerSupported()).toBe(false);
    });
  });

  it("refuses a session with a plain sentence instead of a swiftc error", async () => {
    await asPlatform("linux", async () => {
      const control = new ComputerControl({ home: root, workspace: root });
      await expect(control.begin()).rejects.toThrow(/只支持 macOS（当前是 linux）/u);
      await expect(control.act("move", { x: 1, y: 2 })).rejects.toThrow(/只支持 macOS/u);
      expect(control.enabled).toBe(false);
    });
  });

  it("hides the computer tool from the model where it cannot run", async () => {
    const config = {
      workspace: root, home: root, project: "test",
      model: { name: "test" }, permissionMode: "allow", theme: "auto",
    } as unknown as Parameters<typeof createTools>[0];
    const macTools = await asPlatform("darwin", () => createTools(config));
    expect(macTools.has("computer")).toBe(true);
    const linuxTools = await asPlatform("linux", () => createTools(config));
    expect(linuxTools.has("computer")).toBe(false);
    // Everything else is still there: the platform gate is one tool wide.
    expect(linuxTools.has("read_image")).toBe(true);
    expect(linuxTools.size).toBe(macTools.size - 1);
  });
});
