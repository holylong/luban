import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactSignature, releasePlan, resolveArtifacts, versionProblem, writeChecksums } from "./release.mjs";
import { releaseEnvironment } from "./lib/release-network.mjs";

test("version scheme counts patches 1-20 and rolls the minor over", () => {
  assert.equal(versionProblem("2.2.3"), null);
  assert.equal(versionProblem("2.3.1"), null);
  assert.match(versionProblem("2.2.0"), /patch must be 1-20/);
  assert.match(versionProblem("2.2.21"), /patch must be 1-20/);
  assert.match(versionProblem("v2.2.3"), /MAJOR\.MINOR\.PATCH/);
});

test("domestic Electron mirror defaults preserve explicit overrides", () => {
  assert.equal(releaseEnvironment({}).ELECTRON_MIRROR, "https://npmmirror.com/mirrors/electron/");
  assert.equal(releaseEnvironment({ ELECTRON_MIRROR: "https://example.org/" }).ELECTRON_MIRROR, "https://example.org/");
  assert.deepEqual(planned(["--kind", "exe"], "win32", "x64", "2.0.1").artifacts, ["luban-2.0.1-win-x64.exe"]);
});

/** @param {string[]} args @param {string} host @param {string} arch @param {string} version
 * @returns {import("./release.mjs").ReleasePlan} */
function planned(args, host, arch, version) {
  const result = releasePlan(args, host, arch, version);
  if ("help" in result) throw new Error(`expected a release plan for ${args.join(" ")}`);
  return result;
}

test("native platform and architecture artifact matrix", () => {
  /** @type {[string, string, string[]][]} */
  const matrix = [["linux", "linux", ["x64", "arm64"]], ["win32", "windows", ["x64"]], ["darwin", "macos", ["x64", "arm64"]]];
  for (const [host, platform, arches] of matrix) {
    for (const arch of arches) {
      const plan = planned([], host, arch, "2.0.1");
      assert.equal(plan.platform, platform);
      assert.equal(plan.artifacts.length, 2);
      assert.equal(plan.script, `package-${platform}.mjs`);
      assert.ok(plan.artifacts.every(name => name.includes("2.0.1")));
    }
  }
  assert.deepEqual(planned(["--kind", "desktop"], "linux", "x64", "2.0.1").artifacts, ["luban-desktop_2.0.1_amd64.deb"]);
  assert.deepEqual(planned(["--kind", "cli"], "win32", "x64", "2.0.1").artifacts, ["luban-cli-2.0.1-win-x64.zip"]);
  assert.deepEqual(planned(["--kind", "setup"], "win32", "x64", "2.0.1").artifacts, ["luban-2.0.1-win-x64-setup.exe"]);
  // macOS desktop ships a disk image; every other target keeps a single archive.
  assert.deepEqual(planned(["--platform", "mac", "--dry-run"], "darwin", "arm64", "2.0.1").artifacts, ["luban-cli-2.0.1-mac-arm64.zip", "luban-desktop-2.0.1-mac-arm64.dmg"]);
  assert.deepEqual(planned(["--platform", "mac"], "darwin", "x64", "2.0.1").fallbacks, [null, "luban-desktop-2.0.1-mac-x64.zip"]);
  assert.deepEqual(planned(["--kind", "desktop"], "linux", "x64", "2.0.1").fallbacks, [null]);
});

test("rejects invalid options and cross compilation before starting builds", () => {
  for (const args of [["--platform", "windows"], ["--kind", "bad"], ["--platform"], ["--bogus"], ["--platform", "other"]]) {
    assert.throws(() => releasePlan(args, "linux", "x64"));
  }
  // The installer wraps the Windows single-file build only.
  assert.throws(() => releasePlan(["--kind", "setup"], "linux", "x64"));
  assert.throws(() => releasePlan([], "win32", "arm64"));
  assert.throws(() => releasePlan([], "freebsd", "x64"));
  assert.equal(planned(["--dry-run"], "linux", "arm64", "2.0.1").dryRun, true);
  assert.deepEqual(releasePlan(["--help"]), { help: true });
});

test("macOS desktop prefers the dmg and falls back to the zip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luban-release-dmg-"));
  try {
    const plan = planned(["--kind", "desktop"], "darwin", "arm64", "2.0.1");
    const dmgName = plan.artifacts[0];
    const fallback = plan.fallbacks[0];
    assert.ok(fallback);
    const dmg = join(dir, dmgName);
    const zip = join(dir, fallback);
    await writeFile(dmg, "image");
    await writeFile(zip, "archive");
    // The image wins while both survive in release/.
    assert.deepEqual(await resolveArtifacts(dir, plan.artifacts, plan.fallbacks), [dmgName]);
    await rm(dmg);
    assert.deepEqual(await resolveArtifacts(dir, plan.artifacts, plan.fallbacks), [fallback]);
    // A zip left from an earlier run does not count as this run's output.
    const stale = new Map([[fallback, await artifactSignature(dir, fallback)]]);
    await assert.rejects(resolveArtifacts(dir, plan.artifacts, plan.fallbacks, stale), /No fresh package/);
    await rm(zip);
    await assert.rejects(resolveArtifacts(dir, plan.artifacts, plan.fallbacks), /No fresh package/);
  } finally { await rm(dir, { recursive: true, force: true }); }
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
