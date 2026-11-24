import { test } from "node:test";
import assert from "node:assert/strict";
import { main, mergeWithBase, parseArgs, releaseBody } from "./release-notes.mjs";

const CHANGELOG = [
  "# CHANGELOG",
  "",
  "## 2.9.6 — 2026-11-23",
  "",
  "- 编辑器里能预览 Markdown 了。",
  "- 插件商店一起进这一版。",
  "",
  "## 2.9.5 — 2026-11-23",
  "",
  "- 旧的插件商店改动。",
  "",
  "## 2.9.60 — 2026-12-01",
  "",
  "- 未来版本。",
  "",
].join("\n");

test("the body leads with this version's changes, then the packages", () => {
  const body = releaseBody({ version: "2.9.6", changelog: CHANGELOG });
  assert.match(body, /^## 更新内容/u);
  assert.ok(body.includes("- 编辑器里能预览 Markdown 了。"));
  assert.ok(body.includes("- 插件商店一起进这一版。"));
  assert.ok(!body.includes("旧的插件商店改动"), "must not leak the previous version's section");
  assert.ok(!body.includes("未来版本"));
  assert.ok(body.indexOf("## 更新内容") < body.indexOf("## 安装包"));
  // Every platform whose artifacts are published has to be named with the version.
  for (const name of [
    "luban-cli_2.9.6_amd64.deb",
    "luban-desktop_2.9.6_amd64.deb",
    "luban-cli-2.9.6-win-x64.zip",
    "luban-desktop-2.9.6-win-x64.zip",
    "luban-cli-2.9.6-mac-x64.zip",
    "luban-desktop-2.9.6-mac-arm64.dmg",
    "luban-creator_2.9.6_amd64.deb",
    "luban-creator-2.9.6-win-x64.zip",
    "luban-creator-2.9.6-mac-x64.dmg",
    "luban-creator-2.9.6-mac-arm64.dmg",
  ]) {
    assert.ok(body.includes(name), `missing ${name}`);
  }
});

test("a version prefix does not match a longer version", () => {
  const body = releaseBody({ version: "2.9.6", changelog: CHANGELOG });
  assert.ok(!body.includes("未来版本"), "2.9.6 must not pick up the 2.9.60 section");
  assert.throws(() => releaseBody({ version: "2.9", changelog: CHANGELOG }), /no "## 2\.9 — <date>" section/u);
});

test("a version without a CHANGELOG section is refused", () => {
  assert.throws(() => releaseBody({ version: "3.0.1", changelog: CHANGELOG }), /CHANGELOG\.md has no "## 3\.0\.1/u);
  assert.throws(() => releaseBody({ version: "2.9.6", changelog: "# CHANGELOG\n" }), /no "## 2\.9\.6/u);
});

test("a platform note only lists its own packages", () => {
  const linux = releaseBody({ version: "2.9.6", changelog: CHANGELOG, platform: "linux" });
  assert.ok(linux.includes("luban-cli_2.9.6_amd64.deb"));
  assert.ok(!linux.includes("win-x64"), "linux notes must not promise Windows ZIPs");
  assert.ok(!linux.includes("mac-arm64"));

  const windows = releaseBody({ version: "2.9.6", changelog: CHANGELOG, platform: "windows" });
  assert.ok(windows.includes("luban-desktop-2.9.6-win-x64.zip"));
  assert.ok(windows.includes("luban-desktop-2.9.6-win-x64-setup.exe"));
  assert.ok(windows.includes("覆盖升级"));
  assert.ok(!windows.includes("amd64.deb"));

  const macos = releaseBody({ version: "2.9.6", changelog: CHANGELOG, platform: "macos" });
  assert.ok(macos.includes("luban-cli-2.9.6-mac-arm64.zip"));
  assert.ok(!macos.includes("amd64.deb"));
  assert.throws(() => releaseBody({ version: "2.9.6", changelog: CHANGELOG, platform: "solaris" }), /unknown platform solaris/u);
});

test("main writes the composed body and reports the size", async () => {
  const written = [];
  const lines = [];
  const code = await main(["--version", "2.9.6", "--platform", "linux", "--out", "notes.md"], {
    changelog: CHANGELOG,
    write: async (path, text) => { written.push([path, text]); },
    stdout: text => lines.push(text),
  });
  assert.equal(code, 0);
  assert.equal(written.length, 1);
  assert.equal(written[0][0], "notes.md");
  assert.match(written[0][1], /## 更新内容/u);
  assert.match(lines[0], /notes written: notes\.md \(\d+ chars\)/u);
});

test("main refuses a missing section instead of writing an install-only body", async () => {
  let wrote = false;
  await assert.rejects(
    () => main(["--version", "3.0.1", "--out", "notes.md"], { changelog: CHANGELOG, write: async () => { wrote = true; } }),
    /no "## 3\.0\.1 — <date>" section/u,
  );
  assert.equal(wrote, false);
});

test("arguments are validated rather than guessed", () => {
  assert.throws(() => parseArgs(["--version", "2.9"]), /MAJOR\.MINOR\.PATCH/u);
  assert.throws(() => parseArgs(["--version", "2.9.6", "--platform", "solaris"]), /unknown platform solaris/u);
  assert.throws(() => parseArgs(["--version"]), /needs a value/u);
  assert.throws(() => parseArgs(["--version", "2.9.6", "--frobnicate", "1"]), /unknown option --frobnicate/u);
  assert.deepEqual(parseArgs(["--version", "2.9.6"]).platform, "all");
  assert.equal(parseArgs(["--help"]).help, true);
});

test("an already published body keeps its own install text and gains 更新内容", () => {
  const base = ["Linux amd64 安装包：", "", "- luban-cli_2.9.6_amd64.deb", "- luban-2.9.6-win-x64.exe（旧的命名，不得被改写）"].join("\n");
  const merged = mergeWithBase({ version: "2.9.6", changelog: CHANGELOG, base });
  assert.match(merged, /^## 更新内容\n\n- 编辑器里能预览 Markdown 了。/u);
  assert.ok(merged.includes("luban-2.9.6-win-x64.exe（旧的命名，不得被改写）"), "original body must survive verbatim");
  assert.ok(!merged.includes("luban-desktop-2.9.6-win-x64.zip"), "must not invent file names for past releases");
  assert.ok(merged.indexOf("## 更新内容") < merged.indexOf("Linux amd64 安装包"));
});

test("repairing an already repaired body is a no-op", () => {
  const once = mergeWithBase({ version: "2.9.6", changelog: CHANGELOG, base: "Linux 安装包：" });
  assert.equal(mergeWithBase({ version: "2.9.6", changelog: CHANGELOG, base: once }), "");
  let wrote = false;
  const lines = [];
  return main(["--version", "2.9.6", "--base", "body.md", "--out", "notes.md"], {
    changelog: CHANGELOG,
    read: async () => once,
    write: async () => { wrote = true; },
    stdout: text => lines.push(text),
  }).then(code => {
    assert.equal(code, 0);
    assert.equal(wrote, false);
    assert.match(lines[0], /notes unchanged: 2\.9\.6/u);
  });
});

test("a body with no CHANGELOG section cannot be repaired", () => {
  assert.throws(() => mergeWithBase({ version: "3.0.1", changelog: CHANGELOG, base: "Linux 安装包：" }), /no "## 3\.0\.1/u);
  // An empty body falls back to the full generated body, install table included.
  const empty = mergeWithBase({ version: "2.9.6", changelog: CHANGELOG, base: "  \n" });
  assert.ok(empty.includes("## 安装包"));
  assert.ok(empty.includes("luban-cli_2.9.6_amd64.deb"));
});
