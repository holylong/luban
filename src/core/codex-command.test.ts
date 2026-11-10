import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { codexInvocation, codexSpawn, resolveCodexExecutable } from "./codex-command.js";

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

it("finds codex for a GUI launch that starts without the login PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "luban-resolve-"));
  homes.push(root);
  const home = join(root, "home");
  const pathDir = join(root, "path-bin");
  const localDir = join(home, ".local", "bin");
  mkdirSync(pathDir, { recursive: true });
  mkdirSync(localDir, { recursive: true });
  writeFileSync(join(pathDir, "codex"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(localDir, "codex"), "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(join(localDir, "codex"), 0o755);

  const env = { PATH: pathDir, HOME: home };
  expect(resolveCodexExecutable("codex", { env, loginShellProbe: false })).toBe(join(pathDir, "codex"));
  // A launched app may have almost no PATH, but the usual install dir still answers.
  expect(resolveCodexExecutable("codex", { env: { PATH: "/usr/bin", HOME: home }, loginShellProbe: false }))
    .toBe(join(localDir, "codex"));
  // Nothing anywhere: keep the bare name so the spawn error names the real problem.
  expect(resolveCodexExecutable("codex", { env: { PATH: "/usr/bin", HOME: join(root, "empty") }, loginShellProbe: false }))
    .toBe("codex");
  // Explicit paths and Windows shims are left to the caller.
  expect(resolveCodexExecutable("/opt/custom/codex", { env })).toBe("/opt/custom/codex");
  expect(resolveCodexExecutable("codex", { platform: "win32", env })).toBe("codex");
});

it("starts the npm codex shim with our own node, like a packaged app must", () => {
  const root = mkdtempSync(join(tmpdir(), "luban-shebang-"));
  homes.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "codex");
  writeFileSync(shim, "#!/usr/bin/env node\nconsole.log('ok')\n", { mode: 0o755 });
  chmodSync(shim, 0o755);
  const native = join(bin, "codex-native");
  writeFileSync(native, "#!/bin/sh\necho ok\n", { mode: 0o755 });
  chmodSync(native, 0o755);
  process.env.LUBAN_CODEX_BIN = shim;
  try {
    // A Finder-launched app has no node on PATH, so the shebang cannot work.
    expect(codexSpawn(["app-server"])).toEqual([process.execPath, [shim, "app-server"]]);
    process.env.LUBAN_CODEX_BIN = native;
    expect(codexSpawn(["app-server"])).toEqual([native, ["app-server"]]);
  } finally {
    delete process.env.LUBAN_CODEX_BIN;
  }
});
