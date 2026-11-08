import React from "react";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

it("opens custom-provider auth with Ctrl+A, persists the key, and preserves model navigation", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-model-auth-"));
  const oldHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  await writeFile(join(home, "config.json"), JSON.stringify({
    model: { active: "custom-gateway/two" },
    providers: {
      "custom-gateway": { api: "openai", base_url: "https://gateway.invalid/v1", models: { one: { name: "Gateway One" }, two: { name: "Gateway Two" } } },
    },
  }));
  const config = loadConfig({ workspace });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 140, rows: 40, isTTY: true });
  let frame = "";
  let output = "";
  stdout.on("data", data => { frame = stripVTControlCharacters(String(data)); output += String(data); });
  const app = render(<App config={config} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  try {
    await expect.poll(() => frame, { timeout: 5000 }).toContain("Auto");
    stdin.write("/models");
    await new Promise(resolve => setTimeout(resolve, 80));
    stdin.write("\r");
    await expect.poll(() => frame).toContain("Model providers");
    for (const character of "custom-gateway") {
      stdin.write(character);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await expect.poll(() => frame).toContain("Model providers · 1 条 · filter: custom-gateway");
    stdin.write("\r");
    await expect.poll(() => frame).toContain("Models · custom-gateway · 2 条");
    expect(frame).toContain("› Gateway Two");
    for (const character of "two") {
      stdin.write(character);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await expect.poll(() => frame).toContain("Models · custom-gateway · 1 条 · filter: two");
    stdin.write("\u0001");
    await expect.poll(() => frame).toContain("Provider 鉴权 · custom-gateway");
    stdin.write("k");
    await expect.poll(() => frame).toContain("API Key:");
    const secret = "sk-custom-provider-integration-secret";
    stdin.write(secret);
    await expect.poll(() => frame).toContain("•".repeat(secret.length));
    stdin.write("\r");
    await expect.poll(() => frame).toContain("API Key 已保存并生效");
    const reloaded = loadConfig({ workspace });
    expect(reloaded.models.filter(model => model.provider === "custom-gateway").map(model => model.apiKey)).toEqual([secret, secret]);
    expect(reloaded.model.id).toBe("custom-gateway/two");
    expect(output).not.toContain(secret);
    expect(await readFile(join(home, "node-preferences.json"), "utf8").catch(() => "")).toBe("");
    stdin.write("\u001b");
    await expect.poll(() => frame).toContain("Models · custom-gateway · 1 条 · filter: two");
    expect(frame).toContain("› Gateway Two");
    stdin.write("\u001b[D");
    await expect.poll(() => frame).toContain("Model providers · 1 条 · filter: custom-gateway");
    expect(frame).toContain("› custom-gateway");
    // Opening auth directly from the provider list must preserve that list too.
    stdin.write("\u0001");
    await expect.poll(() => frame).toContain("Provider 鉴权 · custom-gateway");
    expect(frame).toContain("状态：已保存 luban API Key");
    stdin.write("\u001b");
    await expect.poll(() => frame).toContain("Model providers · 1 条 · filter: custom-gateway");
  } finally {
    app.unmount();
    app.cleanup();
    if (oldHome === undefined) delete process.env.LUBAN_HOME; else process.env.LUBAN_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
}, 20000);
