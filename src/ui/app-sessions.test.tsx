import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { expect, it } from "vitest";
import { loadConfig } from "../core/config.js";
import { SessionStore } from "../core/session-store.js";
import { App } from "./app.js";

it("lists only other nonempty sessions and resumes the displayed selection", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-session-picker-"));
  const oldHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const config = loadConfig({ workspace });
  const store = new SessionStore(home);
  const current = store.create(config.project, workspace, "auto", config.model.id, [{ role: "user", content: "Current parser task" }]);
  const target = store.create(config.project, workspace, "auto", config.model.id, [{ role: "user", content: "Historical robot task" }]);
  const empty = store.create(config.project, workspace, "auto", config.model.id, [{ role: "system", content: "instructions" }]);
  empty.inputHistory = ["/models", "/sessions"];
  await store.save(current);
  await store.save(target);
  await store.save(empty);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 32, isTTY: true });
  let frame = "";
  stdout.on("data", data => { frame = stripVTControlCharacters(String(data)); });
  const app = render(<App config={config} resume={current.id} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const command = async (text: string) => {
    stdin.write(text);
    await expect.poll(() => frame).toContain(text);
    stdin.write("\r");
  };
  try {
    await expect.poll(() => frame).toContain("Resumed Current parser task");
    await command("/sessions");
    await expect.poll(() => frame).toContain("Sessions · 1 条");
    expect(frame).toContain("Historical robot task");
    expect(frame).not.toContain("●当前");
    expect(frame).not.toContain("New session");
    let query = "";
    for (const character of target.updatedAt.slice(0, 4)) {
      query += character;
      stdin.write(character);
      await expect.poll(() => frame).toContain(`filter: ${query}`);
    }
    stdin.write("\r");
    await expect.poll(() => frame).toContain("Opened Historical robot task");
    await command("/sessions");
    await expect.poll(() => frame).toContain("Sessions · 1 条");
    expect(frame).toContain("› Current parser task");
    stdin.write("\u001b");
    await expect.poll(() => frame).not.toContain("Sessions · 1 条");
    await command("/new");
    await expect.poll(() => frame).toContain("New session");
    await command("/sessions");
    await expect.poll(() => frame).toContain("Sessions · 2 条");
    expect(frame).toContain("Current parser task");
    expect(frame).toContain("Historical robot task");
    expect((await store.load(empty.id, config.project))?.inputHistory).toEqual(empty.inputHistory);
  } finally {
    app.unmount();
    app.cleanup();
    if (oldHome === undefined) delete process.env.LUBAN_HOME; else process.env.LUBAN_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
}, 10000);
