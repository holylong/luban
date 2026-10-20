import React from "react";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { expect, it, vi } from "vitest";
import { loadConfig } from "../core/config.js";
import { readCodexRateLimits, type CodexRateLimits } from "../core/codex-account.js";
import { App } from "./app.js";

vi.mock("../core/codex-account.js", async importOriginal => ({
  ...await importOriginal<typeof import("../core/codex-account.js")>(),
  readCodexRateLimits: vi.fn(),
}));

it.each(["success", "failure", "escape", "return"] as const)("/status loading handles %s without trapping the user", async outcome => {
  const home = await mkdtemp(join(tmpdir(), "luban-status-loading-"));
  const originalHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  let resolve!: (value: CodexRateLimits) => void;
  let reject!: (reason: Error) => void;
  const request = new Promise<CodexRateLimits>((yes, no) => { resolve = yes; reject = no; });
  vi.mocked(readCodexRateLimits).mockReset().mockReturnValue(request);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 110, rows: 40 });
  let frame = "";
  const spinnerFrames = new Set<string>();
  stdout.on("data", data => {
    frame = stripVTControlCharacters(String(data));
    const spinner = frame.match(/[⬒⬔⬓⬕](?= 正在读取 Codex 额度)/u)?.[0];
    if (spinner) spinnerFrames.add(spinner);
  });
  const app = render(<App config={loadConfig({ workspace: home, model: "codex/default" })} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const submitStatus = async () => {
    stdin.write("/status");
    await expect.poll(() => frame).toContain("❯ /status");
    stdin.write("\r");
    await expect.poll(() => frame).toContain("正在读取 Codex 额度");
  };
  try {
    await expect.poll(() => frame).toContain("Auto");
    await submitStatus();
    expect(frame).toContain("工作区：");
    expect(frame).toContain("Esc/Enter 返回");
    await expect.poll(() => spinnerFrames.size).toBeGreaterThan(1);
    const signal = vi.mocked(readCodexRateLimits).mock.calls[0]![0]!;
    if (outcome === "escape" || outcome === "return") {
      stdin.write(outcome === "escape" ? "\u001b" : "\r");
      await expect.poll(() => frame).not.toContain("状态与 Codex 额度");
      expect(signal.aborted).toBe(true);
      // A new query must not be replaced by the old query's late result.
      let resolveNew!: (value: CodexRateLimits) => void;
      vi.mocked(readCodexRateLimits).mockReturnValue(new Promise(yes => { resolveNew = yes; }));
      await submitStatus();
      resolve({ rateLimits: { primary: { usedPercent: 99 } } });
      await request;
      await new Promise(yes => setTimeout(yes, 150));
      expect(frame).toContain("正在读取 Codex 额度");
      expect(frame).not.toContain("剩余 1.0%");
      resolveNew({ rateLimits: { primary: { usedPercent: 25 } } });
      await expect.poll(() => frame).toContain("剩余 75.0%");
    } else if (outcome === "failure") {
      reject(new Error("test quota unavailable"));
      await expect.poll(() => frame).toContain("Codex 额度读取失败：test quota unavailable");
      expect(frame).toContain("工作区：");
    } else {
      resolve({ rateLimits: { primary: { usedPercent: 25 } } });
      await expect.poll(() => frame).toContain("剩余 75.0%");
    }
    expect(frame).not.toContain("正在读取 Codex 额度");
    stdin.write("\r");
    await expect.poll(() => frame).toContain("Message luban");
  } finally {
    app.unmount();
    app.cleanup();
    vi.mocked(readCodexRateLimits).mockReset();
    if (originalHome === undefined) delete process.env.LUBAN_HOME;
    else process.env.LUBAN_HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  }
});
