import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { expect, it } from "vitest";
import { App } from "./app.js";
import { loadConfig } from "../core/config.js";
import { createTerminalFrameWriter, terminalOutput } from "./terminal-output.js";

const erase = (rows: number) => Array.from({ length: rows }, (_, i) => `\u001b[2K${i < rows - 1 ? "\u001b[1A" : "\u001b[G"}`).join("");

it("overwrites changed rows without blanking the frame and restores the trailing cursor row", () => {
  const write = createTerminalFrameWriter();
  expect(write("header\nlong input\nfooter\n")).toBe("header\nlong input\nfooter\n");
  write("\u001b[?2026h");
  const result = write(erase(4) + "header\nx\nfooter\n");
  expect(result).toBe("\u001b[3A\u001b[G\u001b[E\u001b[Gx\u001b[K\n\u001b[E");
  expect(result).not.toContain("\u001b[2K");
  // Changed row is overwritten before clearing its obsolete tail.
  expect(result.indexOf("x")).toBeLessThan(result.indexOf("\u001b[K"));
  expect(write(erase(4) + "header\ny\nfooter\n")).toContain("\u001b[3A");
});

it("falls back on resize and external logs, then resumes row updates", () => {
  const write = createTerminalFrameWriter();
  write("a\nb\n");
  const resized = erase(3) + "c\n";
  expect(write(resized)).toBe(resized);
  expect(write(erase(2) + "d\n")).not.toContain("\u001b[2K");
  expect(write(erase(2))).toBe(erase(2));
  expect(write("log\n")).toBe("log\n");
  expect(write("d\n")).toBe("d\n");
  expect(write(erase(2) + "e\n")).not.toContain("\u001b[2K");
});

it("repairs stale composer rows even after cursor drift and shrinking a pasted draft", () => {
  const write = createTerminalFrameWriter(() => ({ rows: 8, columns: 80 }));
  const screen = Array<string>(8).fill("stale previous instruction");
  let row = 7;
  const replay = (output: string) => {
    for (const token of output.split(/(\u001b\[[\d;]*[A-Za-z])/).filter(Boolean)) {
      const position = /^\u001b\[(\d+);1H$/.exec(token);
      if (position) { row = Number(position[1]) - 1; screen[row] = ""; }
      else if (token === "\u001b[K") { /* all test writes start at column 1 */ }
      else if (!token.startsWith("\u001b")) screen[row] = token;
    }
  };
  replay(write("header\nmesh\nbody\nold command\nold command\nfooter\nnotice\n"));
  row = 3; // terminal cursor no longer agrees with Ink's trailing-row model
  const update = write(erase(8) + "header\nmesh\nbody\n\nnew prompt\nfooter\nnotice\n");
  // Verify blank lines are explicitly painted/cleared, not skipped as unchanged.
  expect(update).toContain("\u001b[4;1H\u001b[K");
  replay(update);
  expect(screen[4]).toBe("new prompt");
  expect(update).not.toContain("old command");
  expect(screen[3]).toBe("");
  expect(screen.join("\n")).not.toContain("old command");
  expect(update.endsWith("\u001b[8;1H\u001b[K")).toBe(true);
  expect(update).not.toContain("\n"); // cannot scroll at the terminal's bottom
});

it("repaints only the rows that changed, so an ssh link is not repainting the screen", () => {
  const write = createTerminalFrameWriter(() => ({ rows: 6, columns: 80 }));
  const first = write("header\nbody\nfooter\nold input\nnotice\n");
  // The first frame has nothing to compare against: every row is painted,
  // plus the trailing status row.
  expect([...first.matchAll(/\u001b\[\d+;1H/g)]).toHaveLength(6);
  const second = write(erase(6) + "header\nbody\nfooter\nnew input\nnotice\n");
  expect([...second.matchAll(/\u001b\[\d+;1H/g)].map(match => match[0])).toEqual(["\u001b[4;1H", "\u001b[6;1H"]);
  expect(second).toContain("new input");
  expect(second).not.toContain("header");
  // An identical frame paints nothing but the trailing status row.
  const third = write(erase(6) + "header\nbody\nfooter\nnew input\nnotice\n");
  expect([...third.matchAll(/\u001b\[\d+;1H/g)].map(match => match[0])).toEqual(["\u001b[6;1H"]);
});

it("uses absolute rows for any frame that fits, not only the rows - 1 layout", () => {
  const write = createTerminalFrameWriter(() => ({ rows: 8, columns: 80 }));
  // Dialogs and short screens are not screen-sized; falling back to Ink's
  // erase-and-repaint path for them is what made those screens flicker.
  const painted = write(erase(4) + "modal\nrow two\nrow three\n");
  expect(painted).not.toContain("\u001b[2K");
  expect(painted).toContain("\u001b[1;1Hmodal");
  expect(painted.endsWith("\u001b[8;1H\u001b[K")).toBe(true);
});

it("traces every write when LUBAN_TUI_TRACE names a file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luban-tui-trace-"));
  const file = join(dir, "tui.log");
  const old = process.env.LUBAN_TUI_TRACE;
  process.env.LUBAN_TUI_TRACE = file;
  try {
    const write = createTerminalFrameWriter(() => ({ rows: 4, columns: 80 }));
    write("a\nb\nc\n");
    write(erase(4) + "a\nx\nc\n");
    write("\u001b[?25l");
    write("cursor moved\u001b[3;5H");
    const log = await readFile(file, "utf8");
    expect(log).toContain("absolute rows=3/4 painted=3");
    expect(log).toContain("absolute rows=3/4 painted=1");
    expect(log).toContain("ink bytes=6 rows=0 erase2k=0 control");
    // Anything that moves the cursor is reported without the control marker, so
    // the log shows exactly which writes forced a full repaint.
    expect(log).toMatch(/ink bytes=18 rows=0 erase2k=0$/m);
  } finally {
    if (old === undefined) delete process.env.LUBAN_TUI_TRACE;
    else process.env.LUBAN_TUI_TRACE = old;
    await rm(dir, { recursive: true, force: true });
  }
});

it("repaints the whole viewport after a resize", () => {
  let rows = 6;
  const write = createTerminalFrameWriter(() => ({ rows, columns: 80 }));
  write("a\nb\nc\nd\ne\n");
  rows = 4;
  const resized = write(erase(4) + "a\nb\nc\n");
  expect([...resized.matchAll(/\u001b\[\d+;1H/g)]).toHaveLength(4);
  expect(resized.endsWith("\u001b[4;1H\u001b[K")).toBe(true);
  // Ink 6 already wraps frames in DECSET 2026; tallied here so a change in that
  // behaviour shows up as a test failure instead of silent tearing.
  expect(resized).not.toContain("2026");
});

it("wraps TTY output on every platform and leaves redirected output untouched", () => {
  const stream = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.WriteStream;
  expect(terminalOutput(stream)).not.toBe(stream);
  stream.isTTY = false;
  expect(terminalOutput(stream)).toBe(stream);
});

it("invalidates cached rows after binary writes and keeps screen-reader streams untouched", () => {
  const stream = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.WriteStream;
  let raw = "";
  stream.on("data", data => { raw += String(data); });
  const output = terminalOutput(stream);
  output.write("header\na\n");
  output.write(Buffer.from("external log\n"));
  raw = "";
  const frame = erase(3) + "header\nb\n";
  output.write(frame);
  expect(raw).toBe(frame);
  const old = process.env.INK_SCREEN_READER;
  process.env.INK_SCREEN_READER = "true";
  try { expect(terminalOutput(stream)).toBe(stream); }
  finally {
    if (old === undefined) delete process.env.INK_SCREEN_READER;
    else process.env.INK_SCREEN_READER = old;
  }
});

it("keeps the composer in place without frame erases while typing and after resize", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-windows-output-"));
  const oldHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 200, rows: 24 });
  let raw = "";
  let fullFrameRows = 0;
  stdout.on("data", data => {
    const chunk = String(data);
    raw += chunk;
    if (stripVTControlCharacters(chunk).includes("Auto · workspace")) {
      const addresses = [...chunk.matchAll(/\u001b\[(\d+);1H/g)].map(match => Number(match[1]));
      fullFrameRows = addresses.length ? Math.max(...addresses) - 1 : stripVTControlCharacters(chunk).split("\n").length - 1;
    }
  });
  const app = render(<App config={loadConfig({ workspace })} />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: terminalOutput(stdout as unknown as NodeJS.WriteStream),
    patchConsole: false, exitOnCtrlC: false, incrementalRendering: false,
  });
  // Replay row movements rather than merely checking raw frame strings.
  const composerRows = (output: string) => {
    let row = 0;
    const positions: number[] = [];
    for (let i = 0; i < output.length; i++) {
      if (output[i] === "\u001b") {
        const control = /^\u001b\[([\d;?]*)([A-Za-z])/.exec(output.slice(i));
        if (control) {
          const count = Number(control[1]) || 1;
          if (control[2] === "H") row = Number(control[1]!.split(";")[0]) - 1;
          if (control[2] === "A" || control[2] === "F") row -= count;
          if (control[2] === "B" || control[2] === "E") row += count;
          i += control[0].length - 1;
        }
      } else if (output[i] === "\n") row++;
      else if (output[i] === "❯") positions.push(row);
    }
    return positions;
  };
  try {
    await expect.poll(() => stripVTControlCharacters(raw)).toContain("Message luban");
    const start = raw.length;
    for (const ch of "abcdef") {
      stdin.write(ch);
      await expect.poll(() => stripVTControlCharacters(raw)).toContain(`❯ ${"abcdef".slice(0, "abcdef".indexOf(ch) + 1)}`);
    }
    const updates = raw.slice(start);
    expect(updates).not.toContain("\u001b[2K");
    expect(updates).not.toContain("\u001b[2J");
    const positions = composerRows(raw);
    expect(positions.length).toBeGreaterThan(1);
    expect(new Set(positions).size).toBe(1);
    stdout.columns = 100;
    stdout.rows = 18;
    stdout.emit("resize");
    // Ink first lays out its old tree at the new width; React then updates the
    // root height. Wait for that real resized frame, not an arbitrary delay.
    await expect.poll(() => fullFrameRows).toBe(17);
    const afterResize = raw.length;
    stdin.write("g");
    await expect.poll(() => raw.slice(afterResize)).toContain("abcdefg");
    expect(raw.slice(afterResize)).not.toContain("\u001b[2K");
    // A keystroke repaints the rows it changed, not the whole viewport: that
    // full-screen repaint per key is what flickers over ssh.
    const beforeEdit = raw.length;
    stdin.write("z");
    await expect.poll(() => stripVTControlCharacters(raw.slice(beforeEdit))).toContain("abcdefgz");
    const oneEdit = raw.slice(beforeEdit);
    expect((oneEdit.match(/\u001b\[\d+;1H/g) ?? []).length).toBeLessThan(6);
    expect(oneEdit.length).toBeLessThan(400);
  } finally {
    app.unmount();
    app.cleanup();
    if (oldHome === undefined) delete process.env.LUBAN_HOME;
    else process.env.LUBAN_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
}, 15000);
