import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { afterEach, expect, it, vi } from "vitest";
import { RelayLoginDialog } from "./relay-login-dialog.js";

const mocks = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock("../web/relay-login.js", () => ({ loginRelayAccount: mocks.login }));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.clearAllMocks();
});

function setup(relayUrl?: string) {
  const saved = vi.fn();
  const closed = vi.fn();
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: true });
  let frame = "";
  let output = "";
  stdout.on("data", data => { frame = stripVTControlCharacters(String(data)); output += String(data); });
  const app = render(<RelayLoginDialog home="/tmp/luban-test" relayUrl={relayUrl} onSaved={saved} onClose={closed} />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  cleanups.push(() => { app.unmount(); app.cleanup(); });
  return { stdin, saved, closed, frame: () => frame, output: () => output };
}

it("shows the email confirmation before asking for the password and never echoes it", async () => {
  mocks.login.mockResolvedValue({
    relayUrl: "https://relay.example.com",
    email: "owner@example.com",
    envKey: "LUBAN_RELAY_DEVICE_TOKEN",
    envPath: "/home/me/.config/luban/relay.env",
    configPath: "/home/me/.luban/config.json",
    wroteConfig: true,
  });
  const ui = setup("https://relay.example.com");
  await expect.poll(ui.frame).toContain("邮箱：");
  ui.stdin.write("owner@example.com");
  await expect.poll(ui.frame).toContain("owner@example.com");
  await new Promise(resolve => setTimeout(resolve, 20));
  ui.stdin.write("\r");
  await expect.poll(ui.frame).toContain("邮箱已记录：owner@example.com");
  expect(ui.frame()).toContain("密码：");
  ui.stdin.write("password-1");
  await expect.poll(ui.frame).toContain("•".repeat(10));
  expect(ui.output()).not.toContain("password-1");
  ui.stdin.write("\r");
  await expect.poll(() => mocks.login.mock.calls).toEqual([[
    { home: "/tmp/luban-test", relayUrl: "https://relay.example.com", email: "owner@example.com", password: "password-1", writeConfig: true },
  ]]);
  await expect.poll(ui.frame).toContain("✓ 已登录 owner@example.com");
  expect(ui.saved).toHaveBeenCalledWith(expect.objectContaining({ email: "owner@example.com" }));
});

it("asks for a relay URL when none is configured", async () => {
  const ui = setup();
  await expect.poll(ui.frame).toContain("中继：");
  ui.stdin.write("https://relay.example.com");
  await expect.poll(ui.frame).toContain("https://relay.example.com");
  await new Promise(resolve => setTimeout(resolve, 20));
  ui.stdin.write("\r");
  await expect.poll(ui.frame).toContain("中继已记录");
  expect(ui.frame()).toContain("邮箱：");
});

it("keeps the dialog open on an invalid email and closes on Escape", async () => {
  const ui = setup("https://relay.example.com");
  ui.stdin.write("not-an-email");
  await expect.poll(ui.frame).toContain("not-an-email");
  await new Promise(resolve => setTimeout(resolve, 20));
  ui.stdin.write("\r");
  await expect.poll(ui.frame).toContain("邮箱格式不正确");
  expect(ui.frame()).toContain("邮箱：");
  ui.stdin.write("\u001b");
  await expect.poll(() => ui.closed.mock.calls.length).toBe(1);
});
