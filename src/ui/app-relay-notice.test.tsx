import React from "react";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { expect, it } from "vitest";
import { App } from "./app.js";
import { loadConfig } from "../core/config.js";

/**
 * The relay reconnects every few seconds while a phone link flaps. Printing each
 * notice with console.error makes Ink erase the frame, write the line and repaint
 * everything, which is the full-screen flash reported over ssh. The notice
 * belongs to one status row instead.
 */
it("shows relay notices in a status row instead of the console", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-relay-notice-"));
  const oldHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const listeners = new Set<(message: string) => void>();
  const subscribeRelayLog = (listener: (message: string) => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: true });
  let raw = "";
  stdout.on("data", (data) => { raw += String(data); });
  const app = render(
    <App config={loadConfig({ workspace })} subscribeRelayLog={subscribeRelayLog} />,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false, exitOnCtrlC: false, incrementalRendering: false,
    },
  );
  try {
    await expect.poll(() => stripVTControlCharacters(raw)).toContain("Message luban");
    expect(listeners.size).toBe(1);
    for (const listener of listeners) listener("relay reconnecting in 2s");
    await expect.poll(() => stripVTControlCharacters(raw)).toContain("relay reconnecting in 2s");
    const text = stripVTControlCharacters(raw);
    expect(text).toContain("手机远控");
    // A status row, not a transcript entry: the composer stays on the last rows.
    expect(text.indexOf("手机远控")).toBeGreaterThan(text.indexOf("Message luban"));
  } finally {
    app.unmount();
    app.cleanup();
    if (oldHome === undefined) delete process.env.LUBAN_HOME;
    else process.env.LUBAN_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
}, 15000);
