import React from "react";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { afterEach, expect, it } from "vitest";
import { loadConfig } from "../core/config.js";
import { App } from "./app.js";

const originalHome = process.env.LUBAN_HOME;
const originalBin = process.env.LUBAN_CODEX_BIN;
const originalLog = process.env.LUBAN_CODEX_ACCOUNT_TEST_LOG;
afterEach(() => {
  if (originalHome === undefined) delete process.env.LUBAN_HOME;
  else process.env.LUBAN_HOME = originalHome;
  if (originalBin === undefined) delete process.env.LUBAN_CODEX_BIN;
  else process.env.LUBAN_CODEX_BIN = originalBin;
  if (originalLog === undefined) delete process.env.LUBAN_CODEX_ACCOUNT_TEST_LOG;
  else process.env.LUBAN_CODEX_ACCOUNT_TEST_LOG = originalLog;
});

it("shows Codex quota and usage without redeeming, then confirms a reset", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-codex-usage-ui-"));
  const workspace = join(home, "workspace");
  const fake = join(home, "codex");
  const log = join(home, "requests.jsonl");
  await mkdir(workspace);
  await writeFile(fake, `#!/usr/bin/env node
const fs = require('fs');
let buffer = '';
process.stdin.on('data', part => {
  buffer += part;
  let newline = buffer.indexOf('\\n');
  while (newline >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.id === 0) process.stdout.write(JSON.stringify({ id: 0, result: {} }) + '\\n');
    if (request.id === 1) {
      fs.appendFileSync(process.env.LUBAN_CODEX_ACCOUNT_TEST_LOG, request.method + '\\n');
      const result = request.method === 'account/rateLimits/read' ? {
        rateLimits: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300 } },
        rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'card-1', status: 'available' }] },
      } : request.method === 'account/usage/read' ? {
        summary: { lifetimeTokens: 1234 }, dailyUsageBuckets: [{ startDate: '2026-09-28', tokens: 100 }],
      } : { outcome: 'reset' };
      process.stdout.write(JSON.stringify({ id: 1, result }) + '\\n');
    }
    newline = buffer.indexOf('\\n');
  }
});
`, { mode: 0o755 });
  process.env.LUBAN_HOME = home;
  process.env.LUBAN_CODEX_BIN = fake;
  process.env.LUBAN_CODEX_ACCOUNT_TEST_LOG = log;
  const config = loadConfig({ workspace, model: "codex/default" });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 110, rows: 40, isTTY: true });
  let frame = "";
  stdout.on("data", (data) => { frame = stripVTControlCharacters(String(data)); });
  const app = render(<App config={config} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const type = async (value: string) => {
    stdin.write(value);
    await new Promise((resolve) => setTimeout(resolve, 80));
    stdin.write("\r");
  };
  const requests = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  try {
    await expect.poll(() => frame, { timeout: 5000 }).toContain("Auto");
    await type("/status");
    await expect.poll(() => frame).toContain("剩余 75.0%");
    stdin.write("\r");
    await expect.poll(() => frame).not.toContain("状态与 Codex 额度");
    await type("/usage");
    await expect.poll(() => frame).toContain("累计 token：1,234");
    expect(await requests()).not.toContain("account/rateLimitResetCredit/consume");
    stdin.write("\r");
    await expect.poll(() => frame).not.toContain("Codex 用量 · daily");
    await type("/usage reset");
    await expect.poll(() => frame).toContain("使用 Codex 重置卡？");
    stdin.write("\u001b");
    await expect.poll(() => frame).not.toContain("使用 Codex 重置卡？");
    expect(await requests()).not.toContain("account/rateLimitResetCredit/consume");
    await type("/usage reset");
    await expect.poll(() => frame).toContain("使用 Codex 重置卡？");
    stdin.write("\r");
    await expect.poll(() => frame).toContain("已使用一张重置卡");
    expect((await requests()).filter((method) => method === "account/rateLimitResetCredit/consume")).toHaveLength(1);
  } finally {
    app.unmount();
  }
});
