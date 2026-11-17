import React from "react";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { afterEach, expect, it } from "vitest";
import { loadConfig } from "../core/config.js";
import { computerControl, resetComputerControlForTests } from "../core/computer.js";
import { App } from "./app.js";

const original = { home: process.env.LUBAN_HOME, helper: process.env.LUBAN_COMPUTER_HELPER };
const reset = process.env.LUBAN_COMPUTER_HELPER;

// The terminal has no rim to glow, so `/computer` is the only switch there: it
// must flip the same session flag the desktop pill uses, and report the OS
// permissions the helper actually sees.
it("turns computer control on, reports permissions, and refuses while off", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-computer-ui-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const helper = join(home, "fake-computer");
  await writeFile(helper, `#!/usr/bin/env node
let data = "";
process.stdin.on("data", chunk => { data += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(data.trim() || "{}");
  if (request.action === "check") return console.log(JSON.stringify({ ok: true, accessibility: true, postEvent: true, screenRecording: false, displayScale: 2 }));
  console.log(JSON.stringify({ ok: true }));
});
`, { mode: 0o755 });
  process.env.LUBAN_HOME = home;
  process.env.LUBAN_COMPUTER_HELPER = helper;
  resetComputerControlForTests();

  const config = loadConfig({ workspace });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 110, rows: 40, isTTY: true });
  let frame = "";
  stdout.on("data", (data) => { frame = stripVTControlCharacters(String(data)); });
  const app = render(<App config={config} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const type = async (text: string): Promise<void> => {
    stdin.write(text);
    await new Promise((resolve) => setTimeout(resolve, 80));
    stdin.write("\r");
  };
  const control = computerControl({ home: config.home, workspace: config.workspace });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Startup follows the default-on config; explicit off remains effective.
    await expect.poll(() => control.enabled, { timeout: 5000 }).toBe(true);
    await type("/computer off");
    await expect.poll(() => control.enabled, { timeout: 5000 }).toBe(false);
    // The missing Screen Recording grant is named instead of hidden.
    await type("/computer status");
    await expect.poll(() => frame, { timeout: 5000 }).toContain("电脑操控：关");
    expect(frame).toContain("屏幕录制 ✗");
    expect(frame).toContain("辅助功能 ✓");

    await type("/computer on");
    await expect.poll(() => frame).toContain("电脑操控已开启");
    expect(control.enabled).toBe(true);
    await expect.poll(() => frame).toContain("⌁ 电脑操控");

    // A bare command flips the switch back off.
    await type("/computer");
    await expect.poll(() => frame).toContain("电脑操控已关闭");
    expect(control.enabled).toBe(false);
  } finally {
    app.unmount();
    resetComputerControlForTests();
    if (original.home === undefined) delete process.env.LUBAN_HOME; else process.env.LUBAN_HOME = original.home;
    if (reset === undefined) delete process.env.LUBAN_COMPUTER_HELPER; else process.env.LUBAN_COMPUTER_HELPER = reset;
  }
}, 30_000);

afterEach(() => {
  resetComputerControlForTests();
  if (original.helper === undefined) delete process.env.LUBAN_COMPUTER_HELPER;
  else process.env.LUBAN_COMPUTER_HELPER = original.helper;
});
