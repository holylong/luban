import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectArtifacts, describeArtifact, githubArtifacts, main, parseArgs } from "./publish-release.mjs";

/** A CHANGELOG the publishing tests can point at without touching the real file. */
const CHANGELOG = [
  "# CHANGELOG",
  "",
  "## 2.7.12 — 2026-01-01",
  "",
  "- 用户可见的变化一",
  "- 用户可见的变化二",
  "",
  "## 9.9.9 — 2025-01-01",
  "",
  "- 旧版本",
  "",
].join("\n");
const VERSION = "2.7.12";
const NAME = `luban-cli-${VERSION}-mac-x64.zip`;

/** A release server that only records what the publisher sent. */
async function fakeServer({ token = "secret", rejectUpload = false } = {}) {
  const seen = { uploads: [], releases: [], auth: [] };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      seen.auth.push(req.headers.authorization);
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (req.method === "PUT" && req.url.startsWith("/api/admin/artifact")) {
        const file = new URL(req.url, "http://x").searchParams.get("file");
        const bytes = Buffer.concat(chunks);
        if (rejectUpload) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "sha256 mismatch" }));
          return;
        }
        seen.uploads.push({ file, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, file, size: bytes.length }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/admin/release") {
        seen.releases.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, version: seen.releases[0].version, artifacts: seen.releases[0].artifacts.length }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, seen, close: () => new Promise(resolve => server.close(resolve)) };
}

async function buildDir(files) {
  const dir = await mkdtemp(join(tmpdir(), "luban-publish-"));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

test("names map to the triple the catalog stores", () => {
  assert.deepEqual(
    { ...describeArtifact(NAME), path: undefined },
    { file: NAME, kind: "cli", version: VERSION, platform: "darwin", arch: "x64", extension: "zip", path: undefined },
  );
  assert.equal(describeArtifact(`luban-desktop-${VERSION}-windows-x64.exe`).platform, "win32");
  assert.equal(describeArtifact(`luban-creator-${VERSION}-mac-arm64.dmg`).arch, "arm64");
  for (const [file, platform, extension] of [
    [`luban-creator_${VERSION}_amd64.deb`, "linux", "deb"],
    [`luban-creator-${VERSION}-win-x64.zip`, "win32", "zip"],
  ]) {
    assert.deepEqual(describeArtifact(file), { file, kind: "creator", version: VERSION, platform, arch: "x64", extension });
  }
  assert.equal(describeArtifact("SHA256SUMS-2.7.12.txt"), undefined);
  assert.equal(describeArtifact("luban-cli-2.7.12-mac-x64.zip.sig"), undefined);
});

test("args require a version and reject unknown flags", () => {
  assert.throws(() => parseArgs([]), /--version/u);
  assert.throws(() => parseArgs(["--version", VERSION, "--bogus", "x"]), /unknown option/u);
  assert.throws(() => parseArgs(["--version"]), /needs a value/u);
  const options = parseArgs(["--version", VERSION, "--kind", "cli,desktop", "--dry-run"]);
  assert.deepEqual(options.kinds, ["cli", "desktop"]);
  assert.equal(options.dryRun, true);
});

test("only this version's built files are collected", async () => {
  const dir = await buildDir({ [NAME]: "zip", "luban-cli-2.7.11-mac-x64.zip": "old", "notes.md": "x" });
  const found = await collectArtifacts(dir, VERSION);
  assert.deepEqual(found.map(item => item.file), [NAME]);
  const cli = await collectArtifacts(dir, VERSION, ["cli"]);
  const desktop = await collectArtifacts(dir, VERSION, ["desktop"]);
  assert.equal(cli.length, 1);
  assert.equal(desktop.length, 0);
});

test("upload sends the bytes with a sha256 the manifest repeats", async () => {
  const dir = await buildDir({ [NAME]: "payload-bytes" });
  const server = await fakeServer();
  try {
    const code = await main(["--version", VERSION, "--dir", dir, "--url", server.url, "--notes", "测试升级"], { token: "secret" });
    assert.equal(code, 0);
    const [upload] = server.seen.uploads;
    assert.equal(upload.file, NAME);
    assert.equal(upload.size, "payload-bytes".length);
    assert.equal(upload.sha256, createHash("sha256").update("payload-bytes").digest("hex"));
    const [release] = server.seen.releases;
    assert.equal(release.version, VERSION);
    assert.equal(release.notes, "测试升级");
    assert.deepEqual(release.artifacts.map(item => [item.file, item.kind, item.platform, item.arch, item.sha256, item.size]),
      [[NAME, "cli", "darwin", "x64", upload.sha256, upload.size]]);
  } finally {
    await server.close();
  }
});

/** The GitHub release listener: one tag with the assets the workflow uploads. */
function githubRelease(tag, assets) {
  return async (input) => {
    const url = String(input);
    if (!url.startsWith("https://api.github.com/repos/holylong/luban/releases/tags/")) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify({ tag_name: tag, assets }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

const githubAsset = (name, body, { digest = true } = {}) => ({
  name,
  size: body.length,
  ...(digest ? { digest: `sha256:${createHash("sha256").update(body).digest("hex")}` } : {}),
  browser_download_url: `https://github.com/holylong/luban/releases/download/v${VERSION}/${name}`,
});

test("linux debs map to the linux-x64 row", () => {
  const deb = describeArtifact(`luban-desktop_${VERSION}_amd64.deb`);
  assert.deepEqual({ ...deb, path: undefined }, {
    file: `luban-desktop_${VERSION}_amd64.deb`, kind: "desktop", version: VERSION, platform: "linux", arch: "x64", extension: "deb", path: undefined,
  });
});

test("mirroring a GitHub release uploads nothing and points every row at GitHub", async () => {
  const server = await fakeServer();
  try {
    const fetchImpl = githubRelease(`v${VERSION}`, [
      githubAsset(`luban-cli-${VERSION}-mac-x64.zip`, Buffer.from("cli bytes")),
      githubAsset(`luban-desktop-${VERSION}-mac-x64.zip`, Buffer.from("zip fallback")),
      githubAsset(`luban-desktop-${VERSION}-mac-x64.dmg`, Buffer.from("dmg bytes")),
      githubAsset(`luban-cli_${VERSION}_amd64.deb`, Buffer.from("deb bytes")),
      githubAsset(`luban-cli-${VERSION}-mac-arm64.zip`, Buffer.from("arm")),
    ]);
    const code = await main(["--version", VERSION, "--url", server.url, "--github", `v${VERSION}`, "--notes", "GitHub"], { token: "secret", githubFetch: fetchImpl });
    assert.equal(code, 0);
    assert.equal(server.seen.uploads.length, 0);
    const [release] = server.seen.releases;
    const rows = release.artifacts.map(item => [item.platform, item.arch, item.kind, item.file]);
    assert.deepEqual(rows, [
      ["darwin", "x64", "desktop", `luban-desktop-${VERSION}-mac-x64.dmg`],
      ["darwin", "x64", "cli", `luban-cli-${VERSION}-mac-x64.zip`],
      ["darwin", "arm64", "cli", `luban-cli-${VERSION}-mac-arm64.zip`],
      ["linux", "x64", "cli", `luban-cli_${VERSION}_amd64.deb`],
    ]);
    // The zip fallback lost to the dmg, so the desktop row is unique per arch.
    assert.equal(release.artifacts.filter(item => item.kind === "desktop").length, 1);
    const desktop = release.artifacts.find(item => item.kind === "desktop");
    assert.equal(desktop.url, `https://github.com/holylong/luban/releases/download/v${VERSION}/luban-desktop-${VERSION}-mac-x64.dmg`);
    assert.equal(desktop.sha256, createHash("sha256").update("dmg bytes").digest("hex"));
    assert.equal(desktop.size, "dmg bytes".length);
    assert.equal(release.artifacts.every(item => String(item.url).startsWith("https://github.com/")), true);
  } finally {
    await server.close();
  }
});

test("a GitHub asset without a digest is refused instead of published unverifiable", async () => {
  const fetchImpl = githubRelease(`v${VERSION}`, [githubAsset(`luban-cli-${VERSION}-mac-x64.zip`, Buffer.from("x"), { digest: false })]);
  await assert.rejects(() => githubArtifacts("holylong/luban", `v${VERSION}`, VERSION, { githubFetch: fetchImpl }), /sha256 digest/u);
});

test("--github must name the tag of --version", () => {
  assert.throws(() => parseArgs(["--version", VERSION, "--github", "v9.9.9"]), /does not match/u);
  const options = parseArgs(["--version", VERSION, "--github", `v${VERSION}`, "--github-repo", "someone/fork"]);
  assert.equal(options.github, `v${VERSION}`);
  assert.equal(options.githubRepo, "someone/fork");
});

test("a missing token fails before any request is sent", async () => {
  const dir = await buildDir({ [NAME]: "x" });
  const server = await fakeServer();
  try {
    await assert.rejects(() => main(["--version", VERSION, "--dir", dir, "--url", server.url], { token: undefined, changelog: CHANGELOG }), /releases-token/u);
    assert.equal(server.seen.auth.length, 0);
  } finally {
    await server.close();
  }
});

test("a rejected upload stops before the manifest is announced", async () => {
  const dir = await buildDir({ [NAME]: "x" });
  const server = await fakeServer({ rejectUpload: true });
  try {
    await assert.rejects(() => main(["--version", VERSION, "--dir", dir, "--url", server.url], { token: "secret", changelog: CHANGELOG }), /upload .* failed: HTTP 409/u);
    assert.equal(server.seen.releases.length, 0);
  } finally {
    await server.close();
  }
});

test("an empty release directory is explained instead of published", async () => {
  const dir = await buildDir({ "notes.md": "nothing built" });
  await assert.rejects(() => main(["--version", VERSION, "--dir", dir, "--url", "http://127.0.0.1:1"], { token: "secret", changelog: CHANGELOG }), /run npm run release first/u);
});

test("dry run lists the files without touching the network", async () => {
  const dir = await buildDir({ [NAME]: "x" });
  const code = await main(["--version", VERSION, "--dir", dir, "--url", "http://127.0.0.1:1", "--dry-run"], { token: "secret", changelog: CHANGELOG });
  assert.equal(code, 0);
});

test("release notes default to this version's CHANGELOG section", async () => {
  const dir = await buildDir({ [NAME]: "x" });
  const server = await fakeServer();
  try {
    await main(["--version", VERSION, "--dir", dir, "--url", server.url], { token: "secret", changelog: CHANGELOG });
    const [release] = server.seen.releases;
    assert.equal(release.notes, "- 用户可见的变化一\n- 用户可见的变化二");
  } finally {
    await server.close();
  }
});

test("a version without a CHANGELOG entry is refused before anything is sent", async () => {
  const dir = await buildDir({ [NAME]: "x" });
  const server = await fakeServer();
  try {
    await assert.rejects(
      () => main(["--version", VERSION, "--dir", dir, "--url", server.url], { token: "secret", changelog: "## 9.9.9 — 2025-01-01\n\n- 旧版本" }),
      /no release notes for 2\.7\.12/u,
    );
    assert.equal(server.seen.uploads.length, 0);
    assert.equal(server.seen.releases.length, 0);
  } finally {
    await server.close();
  }
});
