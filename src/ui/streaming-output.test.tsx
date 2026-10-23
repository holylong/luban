import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { expect, it, vi } from "vitest";
import { AgentRunner } from "../core/agent.js";
import { loadConfig } from "../core/config.js";
import type { AgentEvent } from "../core/types.js";
import { App } from "./app.js";
import { mascotOutput } from "./mascot-background.js";
import { terminalOutput } from "./terminal-output.js";

it.each([60, 100, 160])("does not erase the frame while streaming reasoning at %s columns", async columns => {
  const home = await mkdtemp(join(tmpdir(), "luban-reasoning-output-"));
  const previousHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  let emit: ((event: AgentEvent) => void) | undefined;
  let finish: (() => void) | undefined;
  const run = vi.spyOn(AgentRunner.prototype, "run").mockImplementation(async (messages, _mode, _signal, onEvent) => {
    emit = onEvent;
    onEvent({ type: "model-call", index: 1 });
    await new Promise<void>(resolve => { finish = resolve; });
    return { ok: true, text: "done", steps: 1, modelCalls: 1, elapsedMs: 1, messages };
  });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns, rows: 24, isTTY: true });
  let raw = "";
  stdout.on("data", data => { raw += String(data); });
  const app = render(<App config={loadConfig({ workspace })} />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: mascotOutput(terminalOutput(stdout as unknown as NodeJS.WriteStream)),
    incrementalRendering: false, patchConsole: false, exitOnCtrlC: false,
  });
  try {
    await expect.poll(() => stripVTControlCharacters(raw)).toContain("Message luban");
    stdin.write("reasoning test");
    await expect.poll(() => stripVTControlCharacters(raw)).toContain("reasoning test");
    stdin.write("\r");
    await expect.poll(() => Boolean(emit)).toBe(true);
    emit!({ type: "thinking-delta", text: "先检查流式输出" });
    await expect.poll(() => stripVTControlCharacters(raw)).toContain("推理中");
    await new Promise(resolve => setTimeout(resolve, 180));
    if (columns >= 100) expect(stripVTControlCharacters(raw)).toContain("先检查流式输出");
    const start = raw.length;
    for (const text of ["\n继续检查布局", "。很长的中文思考内容".repeat(40), "\n新的思考行 👩‍💻", "\n结束检查"]) {
      emit!({ type: "thinking-delta", text });
      await new Promise(resolve => setTimeout(resolve, 180));
    }
    const updates = raw.slice(start);
    if (columns >= 100) expect(stripVTControlCharacters(updates)).toContain("结束检查");
    expect(updates.length).toBeGreaterThan(0);
    expect(updates).not.toContain("\u001b[2K");
    expect(updates).not.toContain("\u001b[2J");
    expect(updates).not.toContain("Message luban");
    expect(updates).not.toContain("reasoning test");
  } finally {
    try {
      finish?.();
      if (finish) {
        // Completion paints before its final save resolves. Exit through the
        // real command path so queued writes finish before removing the home.
        await expect.poll(() => stripVTControlCharacters(raw)).toContain("任务已完成");
        stdin.write("/exit");
        await expect.poll(() => stripVTControlCharacters(raw)).toContain("/exit");
        stdin.write("\r");
        await app.waitUntilExit();
      }
    } finally {
      app.unmount();
      app.cleanup();
      run.mockRestore();
      if (previousHome === undefined) delete process.env.LUBAN_HOME;
      else process.env.LUBAN_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  }
}, 10000);
