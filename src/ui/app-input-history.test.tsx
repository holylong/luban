import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { expect, it } from "vitest";
import { loadConfig } from "../core/config.js";
import { SessionStore } from "../core/session-store.js";
import { App } from "./app.js";

it("recalls wrapped inputs and slash commands, preserves navigation after cursor motion, and restores drafts", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-history-ui-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const oldHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  const config = loadConfig({ workspace });
  const store = new SessionStore(home);
  const session = store.create(config.project, workspace, "auto", config.model.id, [
    { role: "user", content: "original request" },
    { role: "assistant", content: "previous answer" },
  ]);
  session.inputHistory = ["oldest input", "/status", "wrapped input ".repeat(15).trim(), "first line\nsecond line"];
  await store.save(session);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 30, isTTY: true });
  let frame = "";
  stdout.on("data", data => {
    const text = stripVTControlCharacters(String(data));
    if (text.includes("Auto")) frame = text;
  });
  const app = render(<App config={config} resume={session.id} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const composer = () => frame.slice(frame.lastIndexOf("❯"));
  const press = async (key: string, expected: string) => {
    stdin.write(key);
    await expect.poll(composer).toContain(expected);
    await new Promise(resolve => setTimeout(resolve, 80));
  };
  try {
    await expect.poll(() => frame).toContain("previous answer");
    await press("draft text", "draft text");
    await press("\u001b[A", "second line");
    await press("\u001b[A", "wrapped input");
    await press("\u001b[A", "/status");
    // Moving the caret must not restart recall at the latest history entry.
    await press("\u001b[D", "/status");
    await press("\u001b[A", "oldest input");
    await press("\u001b[B", "/status");
    await press("\u001b[B", "wrapped input");
    await press("\u001b[B", "second line");
    await press("\u001b[B", "draft text");
    // Editing a recalled entry starts a new draft.
    await press("\u001b[A", "second line");
    await press(" edited", "second line edited");
    await press("\u001b[A", "second line edited");
    expect(composer()).not.toContain("wrapped input");
    // View commands must survive saving and loading, including their raw input.
    stdin.write("\u0005");
    await new Promise(resolve => setTimeout(resolve, 80));
    stdin.write("\u0015");
    await expect.poll(composer).toContain("Message luban");
    await press("/pending", "/pending");
    stdin.write("\r");
    await expect.poll(async () => (await store.load(session.id, config.project))?.inputHistory?.at(-1)).toBe("/pending");
  } finally {
    app.unmount();
    app.cleanup();
    if (oldHome === undefined) delete process.env.LUBAN_HOME;
    else process.env.LUBAN_HOME = oldHome;
  }
}, 15000);
