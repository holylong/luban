import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { expect, it } from "vitest";
import { loadConfig } from "../core/config.js";
import { SessionStore } from "../core/session-store.js";
import { App } from "./app.js";

it("keeps the composer visible when a terminal reconnects at a smaller size", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-resize-ui-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const oldHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  const config = loadConfig({ workspace });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: true });
  let frame = "";
  stdout.on("data", data => {
    const text = stripVTControlCharacters(String(data));
    if (text.includes("Auto")) frame = text;
  });
  const app = render(<App config={config} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  try {
    await expect.poll(() => frame, { timeout: 5000 }).toContain("Message luban");
    stdout.rows = 18;
    stdout.columns = 80;
    stdout.emit("resize");
    await expect.poll(() => frame.split("\n").length).toBeLessThanOrEqual(19);
    expect(frame).toContain("Message luban");
    stdin.write("restored input");
    await expect.poll(() => frame).toContain("restored input");
  } finally {
    app.unmount();
    app.cleanup();
    if (oldHome === undefined) delete process.env.LUBAN_HOME;
    else process.env.LUBAN_HOME = oldHome;
  }
}, 10000);

it("keeps the live composer on screen and pages inside a restored long reply", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-ui-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const oldHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  const config = loadConfig({ workspace });
  const store = new SessionStore(home);
  const session = store.create(config.project, workspace, "auto", config.model.id, [
    { role: "user", content: "previous prompt" },
    { role: "assistant", content: Array.from({ length: 100 }, (_, i) => `answer-line-${i}`).join("\n") },
  ]);
  await store.save(session);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true });
  let frame = "";
  stdout.on("data", data => { const text = stripVTControlCharacters(String(data)); if (text.includes("Auto")) frame = text; });
  const app = render(<App config={config} resume={session.id} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  try {
    await expect.poll(() => frame, { timeout: 5000 }).toContain("answer-line-99");
    expect(frame.split("\n").length).toBeLessThanOrEqual(25);
    stdin.write("\u001b[5~");
    await expect.poll(() => frame).not.toContain("answer-line-99");
    expect(frame).toContain("answer-line-");
    stdin.write(Array.from({ length: 30 }, (_, i) => `paste-${i}`).join("\n"));
    await expect.poll(() => frame).toContain("paste-29");
    expect(frame).not.toContain("paste-0\n");
    expect(frame.split("\n").length).toBeLessThanOrEqual(25);
    stdin.write("\u0001");
    await expect.poll(() => frame).toContain("paste-0");
    stdin.write("\u0005");
    await expect.poll(() => frame).toContain("paste-29");
  } finally {
    app.unmount();
    app.cleanup();
    if (oldHome === undefined) delete process.env.LUBAN_HOME;
    else process.env.LUBAN_HOME = oldHome;
  }
}, 15000);

it("confirms the export filename in a dialog and writes the edited name", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-export-ui-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const oldHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  const config = loadConfig({ workspace });
  const store = new SessionStore(home);
  const session = store.create(config.project, workspace, "auto", config.model.id, [
    { role: "user", content: "previous prompt" },
    { role: "assistant", content: "previous answer" },
  ]);
  await store.save(session);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 24, isTTY: true });
  let frame = "";
  stdout.on("data", data => { const text = stripVTControlCharacters(String(data)); if (text.includes("Auto")) frame = text; });
  const app = render(<App config={config} resume={session.id} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  try {
    await expect.poll(() => frame, { timeout: 5000 }).toContain("previous answer");
    await new Promise(resolve => setTimeout(resolve, 300));
    stdin.write("/export");
    await new Promise(resolve => setTimeout(resolve, 100));
    stdin.write("\r");
    // The dialog shows the default name and the resolved destination before writing.
    await expect.poll(() => frame).toContain("导出 Markdown");
    expect(frame).toContain("luban-export-");
    expect(frame).toContain("保存到");
    // Edit the name to an absolute path inside the temp home, then confirm.
    stdin.write("\u0015");
    const target = join(home, "renamed-export.md");
    stdin.write(target);
    await expect.poll(() => frame).toContain("renamed-export.md");
    stdin.write("\r");
    await expect.poll(() => frame).not.toContain("导出 Markdown");
    await expect.poll(async () => {
      try { return await readFile(target, "utf8"); } catch { return ""; }
    }, { timeout: 5000 }).toContain("previous answer");
  } finally {
    app.unmount();
    app.cleanup();
    if (oldHome === undefined) delete process.env.LUBAN_HOME;
    else process.env.LUBAN_HOME = oldHome;
  }
}, 15000);
