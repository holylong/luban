import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectArtifacts, describeArtifact, main, parseArgs } from "./publish-release.mjs";

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

test("a missing token fails before any request is sent", async () => {
  const dir = await buildDir({ [NAME]: "x" });
  const server = await fakeServer();
  try {
    await assert.rejects(() => main(["--version", VERSION, "--dir", dir, "--url", server.url], { token: undefined }), /releases-token/u);
    assert.equal(server.seen.auth.length, 0);
  } finally {
    await server.close();
  }
});

test("a rejected upload stops before the manifest is announced", async () => {
  const dir = await buildDir({ [NAME]: "x" });
  const server = await fakeServer({ rejectUpload: true });
  try {
    await assert.rejects(() => main(["--version", VERSION, "--dir", dir, "--url", server.url], { token: "secret" }), /upload .* failed: HTTP 409/u);
    assert.equal(server.seen.releases.length, 0);
  } finally {
    await server.close();
  }
});

test("an empty release directory is explained instead of published", async () => {
  const dir = await buildDir({ "notes.md": "nothing built" });
  await assert.rejects(() => main(["--version", VERSION, "--dir", dir, "--url", "http://127.0.0.1:1"], { token: "secret" }), /run npm run release first/u);
});

test("dry run lists the files without touching the network", async () => {
  const dir = await buildDir({ [NAME]: "x" });
  const code = await main(["--version", VERSION, "--dir", dir, "--url", "http://127.0.0.1:1", "--dry-run"], { token: "secret" });
  assert.equal(code, 0);
});
