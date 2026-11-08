import React from "react";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { afterEach, expect, it } from "vitest";
import { loadConfig } from "../core/config.js";
import { App } from "./app.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("opens /relay login and confirms the email before asking for a password", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-relay-command-"));
  const oldHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  cleanups.push(async () => {
    if (oldHome === undefined) delete process.env.LUBAN_HOME;
    else process.env.LUBAN_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  });
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const config = loadConfig({ workspace });
  config.remote.relayUrl = "https://relay.example.com";
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: true });
  let frame = "";
  stdout.on("data", data => { frame = stripVTControlCharacters(String(data)); });
  const app = render(<App config={config} />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  cleanups.push(async () => { app.unmount(); app.cleanup(); });
  await expect.poll(() => frame, { timeout: 5000 }).toContain("Message luban");
  stdin.write("/relay login");
  await new Promise(resolve => setTimeout(resolve, 80));
  stdin.write("\r");
  await expect.poll(() => frame).toContain("中继账户登录");
  expect(frame).toContain("邮箱：");
  stdin.write("owner@example.com");
  await expect.poll(() => frame).toContain("owner@example.com");
  await new Promise(resolve => setTimeout(resolve, 20));
  stdin.write("\r");
  await expect.poll(() => frame).toContain("邮箱已记录：owner@example.com");
  expect(frame).toContain("密码：");
  stdin.write("\u001b");
  await expect.poll(() => frame).not.toContain("中继账户登录");
});
