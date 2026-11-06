import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releasePlan, writeChecksums } from "./release.mjs";

test("native platform and architecture artifact matrix", () => {
  for (const [host, platform, arches] of [["linux", "linux", ["x64", "arm64"]], ["win32", "windows", ["x64"]], ["darwin", "macos", ["x64", "arm64"]]]) {
    for (const arch of arches) {
      const plan = releasePlan([], host, arch, "2.0.1");
      assert.equal(plan.platform, platform);
      assert.equal(plan.artifacts.length, 2);
      assert.equal(plan.script, `package-${platform}.mjs`);
      assert.ok(plan.artifacts.every(name => name.includes("2.0.1")));
    }
  }
  assert.deepEqual(releasePlan(["--kind", "desktop"], "linux", "x64", "2.0.1").artifacts, ["luban-desktop_2.0.1_amd64.deb"]);
  assert.deepEqual(releasePlan(["--kind", "cli"], "win32", "x64", "2.0.1").artifacts, ["luban-cli-2.0.1-win-x64.zip"]);
  assert.deepEqual(releasePlan(["--platform", "mac", "--dry-run"], "darwin", "arm64", "2.0.1").artifacts, ["luban-cli-2.0.1-mac-arm64.zip", "luban-desktop-2.0.1-mac-arm64.zip"]);
});

test("rejects invalid options and cross compilation before starting builds", () => {
  for (const args of [["--platform", "windows"], ["--kind", "bad"], ["--platform"], ["--bogus"], ["--platform", "other"]]) {
    assert.throws(() => releasePlan(args, "linux", "x64"));
  }
  assert.throws(() => releasePlan([], "win32", "arm64"));
  assert.throws(() => releasePlan([], "freebsd", "x64"));
  assert.equal(releasePlan(["--dry-run"], "linux", "arm64").dryRun, true);
  assert.deepEqual(releasePlan(["--help"]), { help: true });
});

test("checksums cover exactly selected nonempty artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luban-release-test-"));
  try {
    await writeFile(join(dir, "app.zip"), "abc");
    await writeFile(join(dir, "old.zip"), "not part of this release");
    await writeChecksums(dir, ["app.zip"], "SHA256SUMS.txt");
    assert.equal(await readFile(join(dir, "SHA256SUMS.txt"), "utf8"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  app.zip\n");
    await assert.rejects(writeChecksums(dir, ["missing.zip"], "bad.txt"));
    await writeFile(join(dir, "empty.zip"), "");
    await assert.rejects(writeChecksums(dir, ["empty.zip"], "bad.txt"), /empty artifact/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
