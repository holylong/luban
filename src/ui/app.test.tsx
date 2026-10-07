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
import { osc52CopySequence } from "./clipboard.js";
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

it("never erases the whole screen while repainting frames", async () => {
  // Ink treats a frame that fills the terminal as fullscreen and prefixes every
  // repaint with ESC[2J/ESC[3J. That erase-per-keystroke is what users see as
  // flicker, so the root frame must stay one row short of the terminal height.
  const home = await mkdtemp(join(tmpdir(), "luban-flicker-ui-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const oldHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  const config = loadConfig({ workspace });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 24, isTTY: true });
  let raw = "";
  let frame = "";
  stdout.on("data", data => {
    raw += String(data);
    const text = stripVTControlCharacters(String(data));
    if (text.includes("Auto")) frame = text;
  });
  // debug:false is required here: Ink's debug mode writes the raw frame and
  // returns before the fullscreen detection runs, which would make this pass
  // even with the bug present.
  const app = render(<App config={config} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: false, patchConsole: false, exitOnCtrlC: false,
  });
  try {
    await expect.poll(() => frame, { timeout: 5000 }).toContain("Message luban");
    for (const ch of "abcdefghij") {
      stdin.write(ch);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    expect(raw).not.toContain("\u001b[2J");
    expect(raw).not.toContain("\u001b[3J");
    expect(raw).toContain("abcdefghij");
  } finally {
    app.unmount();
    app.cleanup();
    if (oldHome === undefined) delete process.env.LUBAN_HOME;
    else process.env.LUBAN_HOME = oldHome;
  }
}, 10000);

// Replays just enough of the escape stream to know which terminal row each
// write landed on: cursor moves (A/B/E/F), line feeds and the literal marker.
// SGR, cursor-show/hide and sync markers carry no position, so they are skipped.
const markerRows = (raw: string, marker: string): number[] => {
  let y = 0;
  const rows: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\u001b") {
      const match = /^\u001b\[([0-9;?]*)([A-Za-z])/.exec(raw.slice(i));
      if (!match) continue;
      const count = match[1]!.includes("?") || match[1]!.split(";")[0] === "" ? 1 : Number(match[1]!.split(";")[0]);
      if (match[2] === "A" || match[2] === "F") y -= count;
      else if (match[2] === "B" || match[2] === "E") y += count;
      i += match[0].length - 1;
      continue;
    }
    if (raw[i] === "\n") y += 1;
    else if (raw.startsWith(marker, i)) rows.push(y);
  }
  return rows;
};

it("keeps the composer on one row while typing", async () => {
  // Regression: with incrementalRendering on, Ink assumes a fullscreen frame
  // (cursor resting on the last line) and rewrites each changed row one row too
  // low, so every keystroke stamped the composer onto a new line. The frame is
  // deliberately one row short, so the standard renderer must be used. The test
  // drives both renderers: the incremental one must show the drift, which proves
  // the row tracker detects the bug rather than passing vacuously.
  const home = await mkdtemp(join(tmpdir(), "luban-composer-ui-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const oldHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  const config = loadConfig({ workspace });

  const composerRows = async (incrementalRendering: boolean): Promise<number[]> => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    // Wide enough that no frame line wraps, so a row change means a real drift.
    const stdout = Object.assign(new PassThrough(), { columns: 200, rows: 24, isTTY: true });
    let raw = "";
    let frame = "";
    stdout.on("data", data => {
      raw += String(data);
      const text = stripVTControlCharacters(String(data));
      if (text.includes("Auto")) frame = text;
    });
    const app = render(<App config={config} />, {
      stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
      debug: false, patchConsole: false, exitOnCtrlC: false, incrementalRendering,
    });
    try {
      await expect.poll(() => frame, { timeout: 5000 }).toContain("Message luban");
      for (const ch of "abcdef") {
        stdin.write(ch);
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      expect(raw).not.toContain("\u001b[2J");
      expect(raw).not.toContain("\u001b[3J");
      return markerRows(raw, "\u276f");
    } finally {
      app.unmount();
      app.cleanup();
    }
  };

  try {
    const incremental = await composerRows(true);
    // Sanity: the tracker sees the composer, and the bug shows up as drift.
    expect(incremental.length).toBeGreaterThan(1);
    expect(new Set(incremental).size).toBeGreaterThan(1);

    const standard = await composerRows(false);
    expect(standard.length).toBeGreaterThan(0);
    expect(new Set(standard).size).toBe(1);
  } finally {
    if (oldHome === undefined) delete process.env.LUBAN_HOME;
    else process.env.LUBAN_HOME = oldHome;
  }
}, 15000);

it("starts the TUI with the drift-free renderer", async () => {
  // The composer test above proves the standard renderer is the correct one for
  // this frame; this pins the production entry point to it so a future edit
  // cannot silently switch back to the incremental renderer and reintroduce the
  // per-keystroke row growth.
  const cli = await readFile(new URL("../cli.tsx", import.meta.url), "utf8");
  expect(cli).toContain("incrementalRendering: false");
  expect(cli).not.toContain("incrementalRendering: true");
});

it("copies the last answer with Ctrl+Y", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-copy-ui-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const oldHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  const config = loadConfig({ workspace });
  const store = new SessionStore(home);
  const session = store.create(config.project, workspace, "auto", config.model.id, [
    { role: "user", content: "prompt" },
    { role: "assistant", content: "previous answer" },
  ]);
  await store.save(session);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true });
  let frame = "";
  let raw = "";
  stdout.on("data", data => {
    raw += String(data);
    const text = stripVTControlCharacters(String(data));
    if (text.includes("Auto")) frame = text;
  });
  const app = render(<App config={config} resume={session.id} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  try {
    await expect.poll(() => frame).toContain("previous answer");
    // Ctrl+Y is the keyboard copy (opencode-style); selection itself is the
    // terminal's Shift+drag, so there is no in-app selection mode.
    stdin.write("\u0019");
    await expect.poll(() => raw).toContain("\u001b]52;c;");
    const payload = /\]52;c;([A-Za-z0-9+/=]+)\u0007/u.exec(raw);
    expect(Buffer.from(payload![1]!, "base64").toString("utf8")).toContain("previous answer");
    await expect.poll(() => frame).toMatch(/已复制到系统剪贴板|已发送 OSC52|OSC52 已发送/u);
  } finally {
    app.unmount();
    app.cleanup();
    if (oldHome === undefined) delete process.env.LUBAN_HOME;
    else process.env.LUBAN_HOME = oldHome;
  }
}, 10000);

it("copies a dragged output selection on release", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-drag-ui-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const oldHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  const config = loadConfig({ workspace });
  const store = new SessionStore(home);
  const session = store.create(config.project, workspace, "auto", config.model.id, [
    { role: "user", content: "prompt" },
    { role: "assistant", content: "previous answer" },
  ]);
  await store.save(session);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true });
  let frame = "";
  let raw = "";
  stdout.on("data", data => {
    raw += String(data);
    const text = stripVTControlCharacters(String(data));
    if (text.includes("Auto")) frame = text;
  });
  const app = render(<App config={config} resume={session.id} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  try {
    await expect.poll(() => frame).toContain("previous answer");
    const displayed = frame.split("\n");
    const row = displayed.findIndex(line => line.includes("previous answer")) + 1;
    const column = displayed[row - 1]!.indexOf("previous answer") + 1;
    expect(row).toBeGreaterThan(0);
    const report = (code: number, x: number, end = "M") => `\u001b[<${code};${x};${row}${end}`;
    stdin.write(report(0, column));
    stdin.write(report(32, column + 8));
    stdin.write(report(0, column + 8, "m"));
    // A plain drag selects in-app and copies on release, like OpenCode.
    await expect.poll(() => raw).toContain(osc52CopySequence("previous"));
    await expect.poll(() => frame).toMatch(/已复制选中内容|已发送 OSC52/u);
    expect(frame).toContain("previous answer");
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
