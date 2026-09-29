import React from "react";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { afterEach, expect, it } from "vitest";
import { loadConfig, savePreferredModel } from "../core/config.js";
import { App } from "./app.js";

const originalHome = process.env.LUBAN_HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.LUBAN_HOME;
  else process.env.LUBAN_HOME = originalHome;
});

it("opens reasoning effort after choosing a Codex model and saves it", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-codex-ui-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  process.env.LUBAN_HOME = home;
  await savePreferredModel(home, "codex/default");
  const config = loadConfig({ workspace });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 110, rows: 40, isTTY: true });
  let frame = "";
  stdout.on("data", (data) => { frame = stripVTControlCharacters(String(data)); });
  const app = render(<App config={config} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  try {
    await expect.poll(() => frame, { timeout: 5000 }).toContain("Auto");
    stdin.write("/models");
    await new Promise((resolve) => setTimeout(resolve, 80));
    stdin.write("\r");
    await expect.poll(() => frame).toContain("Models");
    stdin.write("\u001b[B");
    await expect.poll(() => frame).toContain("› gpt-6-astra");
    stdin.write("\u001b[B");
    await expect.poll(() => frame).toContain("› gpt-6-sol");
    stdin.write("\r");
    await expect.poll(() => frame).toContain("Reasoning · gpt-6-sol");
    expect(frame).toContain("Extra high");
    for (const title of ["Low", "Medium", "High", "Extra high"]) {
      stdin.write("\u001b[B");
      await expect.poll(() => frame).toContain(`› ${title}`);
    }
    stdin.write("\r");
    const saved = async () => await readFile(join(home, "node-preferences.json"), "utf8");
    await expect.poll(saved).toContain('"codex/gpt-6-sol": "xhigh"');
    expect(loadConfig({ workspace }).model.reasoningEffort).toBe("xhigh");
  } finally {
    app.unmount();
  }
});
