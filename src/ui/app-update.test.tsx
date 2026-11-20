import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "../core/config.js";
import { App } from "./app.js";

/**
 * The startup offer is the only upgrade path a terminal user sees without
 * typing anything, so the three answers must each do exactly one thing:
 * install, postpone, or remember not to ask again.
 */
vi.mock("../core/update.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/update.js")>();
  return {
    ...actual,
    checkForUpdate: vi.fn(async () => ({
      status: "available",
      current: "2.7.11",
      latest: "2.7.12",
      artifact: {
        version: "2.7.12",
        publishedAt: "2026-11-20T09:00:00.000Z",
        notes: "升级提示与服务器",
        file: "luban-cli-2.7.12-mac-x64.zip",
        url: "/downloads/luban-cli-2.7.12-mac-x64.zip",
        sha256: "a".repeat(64),
        size: 1024,
        kind: "cli",
        platform: "darwin",
        arch: "x64",
      },
    })),
    downloadUpdate: vi.fn(async () => "/tmp/luban-cli-2.7.12-mac-x64.zip"),
    installUpdate: vi.fn(async () => ({ ok: true, target: "/tmp/luban-cli-2.7.11-mac-x64", restart: "manual" })),
  };
});

const update = await import("../core/update.js");

const harness = async (check = true) => {
  const home = await mkdtemp(join(tmpdir(), "luban-update-ui-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const base = loadConfig({ workspace });
  const config = { ...base, home, updates: { check, url: "https://example.com", skippedVersion: "" } };
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: true });
  let raw = "";
  stdout.on("data", (data) => { raw += String(data); });
  const app = render(<App config={config} />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    home,
    stdin,
    frame: () => stripVTControlCharacters(raw),
    unmount: () => { app.unmount(); app.cleanup(); },
    dispose: async () => { await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }); },
  };
};

afterEach(() => {
  delete process.env.LUBAN_UPDATE_CHECK;
  vi.mocked(update.checkForUpdate).mockClear();
  vi.mocked(update.downloadUpdate).mockClear();
  vi.mocked(update.installUpdate).mockClear();
});

it("offers a newer version at startup and installs it when chosen", async () => {
  process.env.LUBAN_UPDATE_CHECK = "1";
  const test = await harness();
  try {
    await expect.poll(() => test.frame()).toContain("2.7.12 可以升级");
    expect(test.frame()).toContain("1. 升级");
    expect(test.frame()).toContain("不再提醒");

    test.stdin.write("1");
    await expect.poll(() => test.frame()).toContain("已安装 luban 2.7.12");
    expect(update.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(update.installUpdate).toHaveBeenCalledTimes(1);
  } finally {
    test.unmount();
    await test.dispose();
  }
}, 30_000);

it("leaves the machine alone when the user picks 稍后", async () => {
  process.env.LUBAN_UPDATE_CHECK = "1";
  const test = await harness();
  try {
    await expect.poll(() => test.frame()).toContain("2.7.12 可以升级");
    test.stdin.write("2");
    // The panel is gone once typing reaches the composer again.
    await new Promise((resolve) => setTimeout(resolve, 300));
    test.stdin.write("hello");
    await expect.poll(() => test.frame()).toContain("hello");
    expect(update.downloadUpdate).not.toHaveBeenCalled();
    expect(update.installUpdate).not.toHaveBeenCalled();
  } finally {
    test.unmount();
    await test.dispose();
  }
}, 30_000);

it("remembers 不再提醒 in config", async () => {
  process.env.LUBAN_UPDATE_CHECK = "1";
  const test = await harness();
  try {
    await expect.poll(() => test.frame()).toContain("2.7.12 可以升级");
    test.stdin.write("3");
    await expect.poll(() => test.frame()).toContain("不再提醒 2.7.12");
    const config = JSON.parse(readFileSync(join(test.home, "config.json"), "utf8"));
    expect(config.updates.skipped_version).toBe("2.7.12");
    expect(update.downloadUpdate).not.toHaveBeenCalled();
  } finally {
    test.unmount();
    await test.dispose();
  }
}, 30_000);

it("stays silent when the check is switched off", async () => {
  process.env.LUBAN_UPDATE_CHECK = "1";
  const test = await harness(false);
  try {
    await expect.poll(() => test.frame()).toContain("Message luban");
    expect(update.checkForUpdate).not.toHaveBeenCalled();
  } finally {
    test.unmount();
    await test.dispose();
  }
}, 30_000);
