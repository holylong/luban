import React from "react";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { afterEach, expect, it, vi } from "vitest";
import { readProviderKeys } from "../core/provider-auth.js";
import { ProviderAuthDialog } from "./provider-auth-dialog.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), readAuth: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../core/codex-auth.js", () => ({ readCodexAuth: mocks.readAuth }));
vi.mock("./links.js", () => ({ openExternal: vi.fn() }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.clearAllMocks();
});

async function setup(provider = "custom-gateway") {
  const home = await mkdtemp(join(tmpdir(), "luban-auth-dialog-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  mocks.readAuth.mockResolvedValue(undefined);
  const changed = vi.fn();
  const closed = vi.fn();
  const mount = () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    const stdout = Object.assign(new PassThrough(), { columns: 140, rows: 40, isTTY: true });
    let frame = "";
    let output = "";
    stdout.on("data", data => { frame = stripVTControlCharacters(String(data)); output += String(data); });
    const app = render(<ProviderAuthDialog home={home} provider={provider} configured={false} onChanged={changed} onClose={closed} />, {
      stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    let disposed = false;
    const dispose = () => { if (!disposed) { disposed = true; app.unmount(); app.cleanup(); } };
    cleanups.push(async () => dispose());
    return { stdin, frame: () => frame, output: () => output, dispose };
  };
  const ui = mount();
  await expect.poll(ui.frame).toContain(`Provider 鉴权 · ${provider}`);
  return { home, changed, closed, mount, ...ui };
}

function fakeChild() {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
}

it("masks pasted keys, persists across reopen, and requires confirmation for deletion", async () => {
  const ui = await setup();
  const secret = "sk-regression-paste-secret-123456";
  ui.stdin.write("k");
  await expect.poll(ui.frame).toContain("API Key:");
  ui.stdin.write(secret);
  await expect.poll(ui.frame).toContain("•".repeat(secret.length));
  expect(ui.output()).not.toContain(secret);
  ui.stdin.write("\r");
  await expect.poll(() => ui.changed.mock.calls).toEqual([[secret]]);
  expect(readProviderKeys(ui.home)).toEqual({ "custom-gateway": secret });
  expect(ui.output()).not.toContain(secret);
  ui.dispose();

  const reopened = ui.mount();
  await expect.poll(reopened.frame).toContain("状态：已保存 luban API Key");
  reopened.stdin.write("d");
  await expect.poll(reopened.frame).toContain("Y 确认 / N 取消");
  reopened.stdin.write("n");
  await expect.poll(reopened.frame).not.toContain("Y 确认 / N 取消");
  expect(readProviderKeys(ui.home)["custom-gateway"]).toBe(secret);
  expect(ui.changed).toHaveBeenCalledTimes(1);
  reopened.stdin.write("d");
  await expect.poll(reopened.frame).toContain("Y 确认 / N 取消");
  reopened.stdin.write("y");
  await expect.poll(() => ui.changed.mock.calls).toEqual([[secret], [null]]);
  expect(readProviderKeys(ui.home)).toEqual({});
  expect(reopened.output()).not.toContain(secret);
});

it("discards an unsaved pasted key on Escape without closing the menu", async () => {
  const ui = await setup();
  ui.stdin.write("k");
  await expect.poll(ui.frame).toContain("API Key:");
  ui.stdin.write("unsaved-secret");
  await expect.poll(ui.frame).toContain("•".repeat(14));
  ui.stdin.write("\u001b");
  await expect.poll(ui.frame).not.toContain("API Key:");
  expect(ui.changed).not.toHaveBeenCalled();
  expect(ui.closed).not.toHaveBeenCalled();
  expect(readProviderKeys(ui.home)).toEqual({});
  ui.stdin.write("k");
  await expect.poll(ui.frame).toContain("API Key: ▏");
  expect(ui.output()).not.toContain("unsaved-secret");
});

it.each([0, 1])("handles Codex device login exit code %s without real processes", async code => {
  const child = fakeChild();
  mocks.spawn.mockReturnValue(child);
  const ui = await setup("codex");
  ui.stdin.write("l");
  await expect.poll(() => mocks.spawn.mock.calls.length).toBe(1);
  expect(mocks.spawn.mock.calls[0]?.[1]).toEqual(["login", "--device-auth"]);
  expect(mocks.spawn.mock.calls[0]?.[2]).toEqual({ stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.write("https://auth.openai.com/device\nABCD-1234\n");
  child.stderr.write("Waiting for authorization\n");
  await expect.poll(ui.frame).toContain("ABCD-1234");
  child.emit("close", code);
  await expect.poll(ui.frame).toContain(code === 0 ? "ChatGPT 登录完成。" : "登录未完成");
  if (code === 0) expect(ui.changed.mock.calls).toEqual([[undefined]]);
  else expect(ui.changed).not.toHaveBeenCalled();
});

it("reports Codex spawn errors and permits retry", async () => {
  const child = fakeChild();
  mocks.spawn.mockReturnValue(child);
  const ui = await setup("codex");
  ui.stdin.write("l");
  await expect.poll(() => mocks.spawn.mock.calls.length).toBe(1);
  child.emit("error", new Error("ENOENT"));
  await expect.poll(ui.frame).toContain("无法启动 Codex CLI");
  ui.stdin.write("l");
  await expect.poll(() => mocks.spawn.mock.calls.length).toBe(2);
  expect(ui.changed).not.toHaveBeenCalled();
});

it("kills a cancelled Codex login and ignores its late success", async () => {
  const child = fakeChild();
  mocks.spawn.mockReturnValue(child);
  const ui = await setup("codex");
  ui.stdin.write("l");
  await expect.poll(() => mocks.spawn.mock.calls.length).toBe(1);
  ui.stdin.write("\u001b");
  await expect.poll(() => child.kill.mock.calls.length).toBe(1);
  await expect.poll(ui.frame).toContain("L 登录 / 重新登录");
  child.emit("close", 0);
  expect(ui.changed).not.toHaveBeenCalled();
  ui.stdin.write("l");
  await expect.poll(() => mocks.spawn.mock.calls.length).toBe(2);
  ui.dispose();
  expect(child.kill).toHaveBeenCalledTimes(2);
  child.emit("close", 0);
  expect(ui.changed).not.toHaveBeenCalled();
});
