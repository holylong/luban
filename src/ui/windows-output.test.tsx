import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { expect, it } from "vitest";
import { App } from "./app.js";
import { loadConfig } from "../core/config.js";
import { createWindowsFrameWriter, windowsOutput } from "./windows-output.js";

const erase = (rows: number) => Array.from({ length: rows }, (_, i) => `\u001b[2K${i < rows - 1 ? "\u001b[1A" : "\u001b[G"}`).join("");

it("overwrites changed rows without blanking the frame and restores the trailing cursor row", () => {
  const write = createWindowsFrameWriter();
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
  const write = createWindowsFrameWriter();
  write("a\nb\n");
  const resized = erase(3) + "c\n";
  expect(write(resized)).toBe(resized);
  expect(write(erase(2) + "d\n")).not.toContain("\u001b[2K");
  expect(write(erase(2))).toBe(erase(2));
  expect(write("log\n")).toBe("log\n");
  expect(write("d\n")).toBe("d\n");
  expect(write(erase(2) + "e\n")).not.toContain("\u001b[2K");
});

it("leaves non-Windows and redirected output untouched", () => {
  const stream = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.WriteStream;
  expect(windowsOutput(stream, "linux")).toBe(stream);
  stream.isTTY = false;
  expect(windowsOutput(stream, "win32")).toBe(stream);
});

it("keeps the Windows composer in place without frame erases while typing and after resize", async () => {
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
      fullFrameRows = stripVTControlCharacters(chunk).split("\n").length - 1;
    }
  });
  const app = render(<App config={loadConfig({ workspace })} />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: windowsOutput(stdout as unknown as NodeJS.WriteStream, "win32"),
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
  } finally {
    app.unmount();
    app.cleanup();
    if (oldHome === undefined) delete process.env.LUBAN_HOME;
    else process.env.LUBAN_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
}, 15000);
