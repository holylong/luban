import React from "react";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { expect, it } from "vitest";
import { loadConfig } from "../core/config.js";
import type { ModelRef } from "../core/types.js";
import { App } from "./app.js";

it("groups models by provider, keeps submenu navigation, and saves only a selected model", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-model-providers-"));
  const oldHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const config = loadConfig({ workspace });
  const model = (provider: string, id: string, name: string): ModelRef => ({
    ...config.model, provider, id: `${provider}/${id}`, model: id, name, api: "openai",
  });
  config.models = [
    model("alpha", "one", "Alpha One"), model("alpha", "two", "Alpha Two"),
    ...Array.from({ length: 16 }, (_, i) => model("beta", String(i), `Beta ${i}`)),
    model("custom-gateway", "two", "Gateway Two"),
  ];
  config.model = config.models[14]!;
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: true });
  let frame = "";
  stdout.on("data", data => { frame = stripVTControlCharacters(String(data)); });
  const app = render(<App config={config} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const saved = () => readFile(join(home, "node-preferences.json"), "utf8").catch(() => "");
  const filter = async (text: string) => {
    let query = "";
    for (const character of text) {
      query += character;
      stdin.write(character);
      await expect.poll(() => frame).toContain(`filter: ${query}`);
    }
  };
  try {
    await expect.poll(() => frame, { timeout: 5000 }).toContain("Auto");
    stdin.write("/models");
    await new Promise(resolve => setTimeout(resolve, 80));
    stdin.write("\r");
    await expect.poll(() => frame).toContain("Model providers · 3 条");
    expect(frame).toContain("› beta");
    expect(frame).toContain("16 个模型");
    expect(frame).toContain("custom-gateway");
    expect(frame).not.toContain("Alpha One");
    stdin.write("\r");
    await expect.poll(() => frame).toContain("Models · beta · 16 条");
    expect(frame).toContain("› Beta 12");
    expect(frame).toContain("↑ 还有");
    expect(frame).not.toContain("Alpha One");
    stdin.write("\u001b");
    await expect.poll(() => frame).toContain("Model providers · 3 条");
    expect(frame).toContain("› beta");
    await filter("alpha");
    stdin.write("\r");
    await expect.poll(() => frame).toContain("Models · alpha · 2 条");
    expect(frame).not.toContain("filter: alpha");
    await filter("two");
    expect(frame).toContain("Models · alpha · 1 条");
    expect(frame).toContain("› Alpha Two");
    expect(frame).not.toContain("Gateway Two");
    stdin.write("\u001b[D");
    await expect.poll(() => frame).toContain("Model providers · 1 条 · filter: alpha");
    expect(frame).toContain("› alpha");
    expect(await saved()).toBe("");
    stdin.write("\r");
    await expect.poll(() => frame).toContain("Models · alpha · 2 条");
    await filter("zzz");
    await expect.poll(() => frame).toContain("无匹配");
    stdin.write("\r");
    await expect.poll(() => frame).toContain("Models · alpha · 0 条");
    expect(await saved()).toBe("");
    stdin.write("\u001b");
    await expect.poll(() => frame).toContain("Model providers · 1 条");
    stdin.write("\u001b");
    await expect.poll(() => frame).not.toContain("Model providers");
    stdin.write("\u0010");
    await expect.poll(() => frame).toContain("Model providers · 3 条");
    expect(frame).toContain("› beta");
    await filter("alpha");
    stdin.write("\r");
    await expect.poll(() => frame).toContain("Models · alpha · 2 条");
    stdin.write("\u001b[B");
    await expect.poll(() => frame).toContain("› Alpha Two");
    stdin.write("\r");
    await expect.poll(saved).toContain('"model": "alpha/two"');
    await expect.poll(() => frame).not.toContain("Models · alpha");
    stdin.write("\u0010");
    await expect.poll(() => frame).toContain("Model providers · 3 条");
    expect(frame).toContain("› alpha");
    stdin.write("\r");
    await expect.poll(() => frame).toContain("Models · alpha · 2 条");
    expect(frame).toContain("› Alpha Two");
    expect(frame).toContain("●当前");
  } finally {
    app.unmount();
    app.cleanup();
    if (oldHome === undefined) delete process.env.LUBAN_HOME; else process.env.LUBAN_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
}, 20000);
