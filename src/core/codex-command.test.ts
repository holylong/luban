import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { codexInvocation } from "./codex-command.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function npmInstall() {
  const home = mkdtempSync(join(tmpdir(), "luban codex & test-"));
  homes.push(home);
  const entry = join(home, "node_modules", "@openai", "codex", "bin", "codex.js");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  writeFileSync(join(home, "codex.cmd"), "@echo off\r\n");
  writeFileSync(join(home, "codex"), "#!/bin/sh\n");
  return { home, entry };
}

it("runs Windows npm Codex without shell expansion, including paths with spaces", () => {
  const { home, entry } = npmInstall();
  const args = ["login", "--device-auth", "a & b", 'model_reasoning_effort="high"'];
  const invocation = codexInvocation(args, { platform: "win32", command: "codex", path: home });
  expect(invocation).toEqual([process.execPath, [entry, ...args]]);
  expect(JSON.parse(execFileSync(...invocation, { encoding: "utf8" }))).toEqual(args);
  expect(codexInvocation(["app-server"], { platform: "win32", command: join(home, "codex.cmd") }))
    .toEqual([process.execPath, [entry, "app-server"]]);
});

it("prefers a native executable and respects PATH order", () => {
  const first = npmInstall();
  const second = npmInstall();
  writeFileSync(join(second.home, "codex.exe"), "native");
  expect(codexInvocation(["exec"], { platform: "win32", command: "codex", path: `${first.home};${second.home}` }))
    .toEqual([process.execPath, [first.entry, "exec"]]);
  expect(codexInvocation(["exec"], { platform: "win32", command: "codex", path: second.home }))
    .toEqual([join(second.home, "codex.exe"), ["exec"]]);
});

it("supports explicit JS and Node shebang overrides and reports a missing Windows CLI", () => {
  const { home, entry } = npmInstall();
  const script = join(home, "custom-codex");
  writeFileSync(script, "#!/usr/bin/env node\n");
  expect(codexInvocation(["login"], { platform: "win32", command: entry }))
    .toEqual([process.execPath, [entry, "login"]]);
  expect(codexInvocation(["exec"], { platform: "win32", command: script }))
    .toEqual([process.execPath, [script, "exec"]]);
  expect(() => codexInvocation([], { platform: "win32", command: "missing-codex", path: home }))
    .toThrow("npm install -g @openai/codex");
  expect(codexInvocation(["login"], { platform: "linux", command: "custom-codex" }))
    .toEqual(["custom-codex", ["login"]]);
});
