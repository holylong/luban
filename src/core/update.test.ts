import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  artifactUrl, checkForUpdate, cliInstallRoot, compareVersions, currentKind, downloadUpdate,
  githubAssetNames, installUpdate, isNewer, parseVersionText, releaseEndpoint, type UpdateArtifact,
} from "./update.js";

const digest = (body: Uint8Array | string) => createHash("sha256").update(body).digest("hex");

// Two install cases build a real archive with the `zip` CLI. Minimal containers and
// Windows developer machines do not ship it; skip rather than fail on a missing tool.
const hasZip = spawnSync("zip", ["-v"], { stdio: "ignore" }).status === 0;

function artifactFrom(body: string, overrides: Partial<UpdateArtifact> = {}): UpdateArtifact {
  return {
    version: "2.7.12",
    publishedAt: "2026-11-20T09:00:00.000Z",
    notes: "升级提示与服务器",
    file: "luban-cli-2.7.12-mac-x64.zip",
    url: "/downloads/luban-cli-2.7.12-mac-x64.zip",
    sha256: digest(body),
    size: Buffer.byteLength(body),
    kind: "cli",
    platform: "darwin",
    arch: "x64",
    ...overrides,
  };
}

/** A fetch that answers with one canned JSON body and records the URL it saw. */
function jsonFetch(payload: unknown) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("versions", () => {
  it("compares numerically, not as strings", () => {
    expect(compareVersions("2.7.12", "2.7.9")).toBe(1);
    expect(compareVersions("2.7.9", "2.7.12")).toBe(-1);
    expect(compareVersions("2.8.1", "2.7.20")).toBe(1);
    expect(compareVersions("2.7.12", "2.7.12")).toBe(0);
    expect(isNewer("2.7.12", "2.7.11")).toBe(true);
    expect(isNewer("2.7.11", "2.7.11")).toBe(false);
  });

  it("treats junk as older than everything and ignores build suffixes", () => {
    expect(parseVersionText("2.7.12")).toEqual([2, 7, 12]);
    expect(parseVersionText("2.7")).toBeUndefined();
    expect(compareVersions("", "1.0.1")).toBe(-1);
    expect(compareVersions("nonsense", "1.0.1")).toBe(-1);
  });
});

describe("endpoints", () => {
  it("accepts a host or a full endpoint and keeps the base for downloads", () => {
    expect(releaseEndpoint("https://example.com")).toBe("https://example.com/api/update");
    expect(releaseEndpoint("https://example.com/")).toBe("https://example.com/api/update");
    expect(releaseEndpoint("https://example.com/api/update")).toBe("https://example.com/api/update");
    expect(artifactUrl("https://example.com", { url: "/downloads/a.zip" })).toBe("https://example.com/downloads/a.zip");
    expect(artifactUrl("https://example.com/api/update", { url: "/downloads/a.zip" })).toBe("https://example.com/downloads/a.zip");
    const mirrored = "https://github.com/holylong/luban/releases/download/v2.7.19/luban-cli-2.7.19-mac-x64.zip";
    expect(artifactUrl("https://example.com", { url: mirrored })).toBe(mirrored);
  });

  it("reads the product from the environment", () => {
    expect(currentKind({})).toBe("cli");
    expect(currentKind({ LUBAN_UPDATE_KIND: "desktop" })).toBe("desktop");
    expect(currentKind({ LUBAN_UPDATE_KIND: "creator" })).toBe("creator");
    expect(currentKind({ LUBAN_UPDATE_KIND: "whatever" })).toBe("cli");
  });
});

describe("checkForUpdate", () => {
  const base = { currentVersion: "2.7.11", kind: "cli" as const, platform: "darwin", arch: "x64" };

  it("asks for this platform and reports the artifact", async () => {
    const artifact = artifactFrom("zip bytes");
    const { impl, calls } = jsonFetch({ ok: true, latest: { version: "2.7.12" }, artifact });
    const check = await checkForUpdate({ ...base, url: "https://example.com", fetchImpl: impl });
    expect(check.status).toBe("available");
    expect(check.latest).toBe("2.7.12");
    expect(check.artifact?.file).toBe(artifact.file);
    expect(calls[0]).toBe("https://example.com/api/update?platform=darwin&arch=x64&kind=cli");
  });

  it("says up to date when the artifact is not newer, even if the catalog is", async () => {
    const keep = jsonFetch({ ok: true, latest: { version: "2.7.11" }, artifact: artifactFrom("x", { version: "2.7.11" }) });
    expect((await checkForUpdate({ ...base, fetchImpl: keep.impl })).status).toBe("current");

    const ahead = jsonFetch({ ok: true, latest: { version: "2.7.9" }, artifact: null });
    expect((await checkForUpdate({ ...base, fetchImpl: ahead.impl })).status).toBe("current");
  });

  it("honours a skipped version but still reports it", async () => {
    const artifact = artifactFrom("x");
    const { impl } = jsonFetch({ ok: true, latest: { version: "2.7.12" }, artifact });
    const check = await checkForUpdate({ ...base, skippedVersion: "2.7.12", fetchImpl: impl });
    expect(check.status).toBe("skipped");
    expect(check.artifact?.version).toBe("2.7.12");
  });

  it("distinguishes 'newer exists but nothing for me' from 'unreachable'", async () => {
    const { impl } = jsonFetch({ ok: true, latest: { version: "2.7.13" }, artifact: null });
    const check = await checkForUpdate({ ...base, fetchImpl: impl });
    expect(check.status).toBe("no-build");
    expect(check.latest).toBe("2.7.13");
    expect(check.reason).toContain("darwin-x64");
  });

  it("never throws when the network or the answer is broken", async () => {
    const offline = (async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch;
    expect((await checkForUpdate({ ...base, fetchImpl: offline })).status).toBe("unreachable");

    const failing = (async () => new Response("boom", { status: 502 })) as unknown as typeof fetch;
    const failed = await checkForUpdate({ ...base, fetchImpl: failing });
    expect(failed.status).toBe("unreachable");
    expect(failed.reason).toContain("502");

    const junk = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    expect((await checkForUpdate({ ...base, fetchImpl: junk })).status).toBe("unreachable");

    const noOk = jsonFetch({ latest: { version: "9.9.9" } });
    expect((await checkForUpdate({ ...base, fetchImpl: noOk.impl })).status).toBe("unreachable");
  });

  it("ignores an artifact whose checksum the server mangled", async () => {
    const artifact = { ...artifactFrom("x"), sha256: "not-a-digest" };
    const { impl } = jsonFetch({ ok: true, latest: { version: "2.7.12" }, artifact });
    const check = await checkForUpdate({ ...base, fetchImpl: impl });
    expect(check.artifact).toBeUndefined();
    expect(check.status).toBe("no-build");
  });
});

describe("github mirror", () => {
  const base = { currentVersion: "2.7.18", kind: "cli" as const, platform: "darwin", arch: "x64" };
  const release = (assets: Record<string, unknown>[], tag = "v2.7.19") => ({
    tag_name: tag,
    body: "GitHub Releases 上的说明",
    published_at: "2026-11-20T12:05:00Z",
    assets,
  });
  const asset = (name: string, body = "zip bytes") => ({
    name,
    size: Buffer.byteLength(body),
    digest: `sha256:${digest(body)}`,
    browser_download_url: `https://github.com/holylong/luban/releases/download/v2.7.19/${name}`,
  });

  /** Serves the release server and GitHub from one stub, recording both hits. */
  function routedFetch(server: unknown, github: unknown) {
    const calls: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://api.github.com/")) {
        return github === undefined
          ? new Response("offline", { status: 503 })
          : new Response(JSON.stringify(github), { status: 200, headers: { "content-type": "application/json" } });
      }
      return server === undefined
        ? Promise.reject(new Error("ENOTFOUND"))
        : new Response(JSON.stringify(server), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it("uses the GitHub release when the release server is unreachable", async () => {
    const { impl, calls } = routedFetch(undefined, release([asset("luban-cli-2.7.19-mac-x64.zip")]));
    const check = await checkForUpdate({ ...base, fetchImpl: impl });
    expect(check.status).toBe("available");
    expect(check.source).toBe("github");
    expect(check.latest).toBe("2.7.19");
    expect(check.artifact).toMatchObject({
      file: "luban-cli-2.7.19-mac-x64.zip",
      url: "https://github.com/holylong/luban/releases/download/v2.7.19/luban-cli-2.7.19-mac-x64.zip",
      size: Buffer.byteLength("zip bytes"),
      sha256: digest("zip bytes"),
    });
    expect(calls[1]).toBe("https://api.github.com/repos/holylong/luban/releases/latest");
  });

  it("downloads a mirror artifact from the absolute URL it advertises", async () => {
    const body = "installer bytes";
    const directory = await mkdtemp(join(tmpdir(), "luban-dl-"));
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const artifact = artifactFrom(body, {
      url: "https://github.com/holylong/luban/releases/download/v2.7.19/luban-cli-2.7.19-mac-x64.zip",
    });
    await downloadUpdate(artifact, { baseUrl: "https://example.com", directory, fetchImpl });
    expect(seen).toEqual([artifact.url]);
  });

  it("keeps the server answer when the server actually answered", async () => {
    const artifact = artifactFrom("x", { version: "2.7.19" });
    const { impl, calls } = routedFetch({ ok: true, latest: { version: "2.7.19" }, artifact }, release([asset("luban-cli-2.7.19-mac-x64.zip")]));
    const check = await checkForUpdate({ ...base, fetchImpl: impl });
    expect(check.status).toBe("available");
    expect(check.source).toBe("server");
    expect(calls).toHaveLength(1);
  });

  it("reports no-build when the mirror ships nothing for this triple", async () => {
    const { impl } = routedFetch(undefined, release([asset("luban-cli-2.7.19-win-x64.zip")]));
    const check = await checkForUpdate({ ...base, fetchImpl: impl });
    expect(check.status).toBe("no-build");
    expect(check.latest).toBe("2.7.19");
    expect(check.reason).toContain("darwin-x64");
  });

  it("ignores a mirror asset without a sha256 digest", async () => {
    const broken = { ...asset("luban-cli-2.7.19-mac-x64.zip"), digest: undefined };
    const { impl } = routedFetch(undefined, release([broken]));
    expect((await checkForUpdate({ ...base, fetchImpl: impl })).status).toBe("no-build");
  });

  it("falls back to unreachable when neither host answers", async () => {
    const { impl } = routedFetch(undefined, undefined);
    const check = await checkForUpdate({ ...base, fetchImpl: impl });
    expect(check.status).toBe("unreachable");
    expect(check.source).toBeUndefined();
  });

  it("names the asset each platform actually ships", () => {
    expect(githubAssetNames("desktop", "darwin", "arm64", "2.7.19"))
      .toEqual(["luban-desktop-2.7.19-mac-arm64.dmg", "luban-desktop-2.7.19-mac-arm64.zip"]);
    expect(githubAssetNames("cli", "win32", "x64", "2.7.19")).toEqual(["luban-cli-2.7.19-win-x64.zip"]);
    expect(githubAssetNames("desktop", "linux", "x64", "2.7.19")).toEqual(["luban-desktop_2.7.19_amd64.deb"]);
    expect(githubAssetNames("cli", "freebsd", "x64", "2.7.19")).toEqual([]);
  });
});

describe("downloadUpdate", () => {
  it("writes the file and reports progress", async () => {
    const body = "installer bytes";
    const artifact = artifactFrom(body);
    const directory = await mkdtemp(join(tmpdir(), "luban-dl-"));
    const progress: number[] = [];
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const path = await downloadUpdate(artifact, {
      baseUrl: "https://example.com",
      directory,
      fetchImpl,
      onProgress: (received) => progress.push(received),
    });
    expect(readFileSync(path, "utf8")).toBe(body);
    expect(path.endsWith(artifact.file)).toBe(true);
    expect(progress.at(-1)).toBe(artifact.size);
    expect(existsSync(`${path}.part`)).toBe(false);
  });

  it("refuses bytes that do not match the advertised checksum", async () => {
    const artifact = artifactFrom("the real file");
    const directory = await mkdtemp(join(tmpdir(), "luban-dl-"));
    // Same length, different bytes: this must fail on the digest, not on size.
    const fetchImpl = (async () => new Response("the real filf", { status: 200 })) as unknown as typeof fetch;
    await expect(downloadUpdate(artifact, { directory, fetchImpl })).rejects.toThrow(/校验失败/u);
    expect(await readdir(directory)).toEqual([]);
  });

  it("refuses a short body and a missing file", async () => {
    const artifact = artifactFrom("0123456789");
    const directory = await mkdtemp(join(tmpdir(), "luban-dl-"));
    const truncated = (async () => new Response("0123", { status: 200 })) as unknown as typeof fetch;
    await expect(downloadUpdate(artifact, { directory, fetchImpl: truncated })).rejects.toThrow(/不完整/u);
    expect(await readdir(directory)).toEqual([]);

    const missing = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await expect(downloadUpdate(artifact, { directory, fetchImpl: missing })).rejects.toThrow(/HTTP 404/u);
  });
});

describe("cli install", () => {
  it("finds an unpacked bundle but never a source checkout", async () => {
    expect(cliInstallRoot()).toBeUndefined();
    const root = await mkdtemp(join(tmpdir(), "luban-root-"));
    writeFileSync(join(root, "luban"), "#!/bin/sh\n");
    writeFileSync(join(root, "node"), "binary");
    mkdirSync(join(root, "app"));
    writeFileSync(join(root, "app", "package.json"), "{}");
    expect(cliInstallRoot(join(root, "app", "package.json"))).toBe(realpathSync(root));
  });

  it.skipIf(!hasZip)("swaps the folder in once the old process is gone", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-install-"));
    const home = join(workspace, "home");
    const root = join(workspace, "luban-cli-2.7.11-mac-x64");
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(join(root, "luban"), "old launcher\n");
    writeFileSync(join(root, "node"), "old node");
    writeFileSync(join(root, "app", "package.json"), '{"version":"2.7.11"}');

    const payload = join(workspace, "payload", "luban-cli-2.7.12-mac-x64");
    mkdirSync(join(payload, "app"), { recursive: true });
    writeFileSync(join(payload, "luban"), "new launcher\n");
    writeFileSync(join(payload, "node"), "new node");
    writeFileSync(join(payload, "app", "package.json"), '{"version":"2.7.12"}');
    const archive = join(workspace, "update.zip");
    const zipped = spawn("zip", ["-qr", archive, "luban-cli-2.7.12-mac-x64"], { cwd: join(workspace, "payload") });
    await new Promise((resolve) => zipped.on("close", resolve));
    expect(existsSync(archive)).toBe(true);

    // Stand in for "the running luban": a process that exits quickly.
    const victim = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600)"], { stdio: "ignore" });
    const result = await installUpdate(artifactFrom("ignored"), archive, { kind: "cli", root, home, waitForPid: victim.pid });
    expect(result).toMatchObject({ ok: true, target: root, restart: "manual" });
    // The swap must not happen while the old process is alive.
    expect(readFileSync(join(root, "luban"), "utf8")).toBe("old launcher\n");

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && readFileSync(join(root, "luban"), "utf8") !== "new launcher\n") {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(readFileSync(join(root, "luban"), "utf8")).toBe("new launcher\n");
    expect(JSON.parse(readFileSync(join(root, "app", "package.json"), "utf8")).version).toBe("2.7.12");
    // The backup is removed by the same script a moment later.
    while (Date.now() < deadline && existsSync(`${root}.old`)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(existsSync(`${root}.old`)).toBe(false);
  }, 40_000);

  it("refuses a source checkout instead of rewriting it", async () => {
    const archive = join(await mkdtemp(join(tmpdir(), "luban-install-")), "nothing.zip");
    await writeFile(archive, "not a zip");
    await expect(installUpdate(artifactFrom("x"), archive, { kind: "cli", root: undefined })).rejects.toThrow(/源码目录/u);
  });

  it.skipIf(!hasZip)("refuses an archive without a launcher", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-install-"));
    const root = join(workspace, "root");
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(join(root, "luban"), "#!/bin/sh\n");
    writeFileSync(join(root, "node"), "node");
    mkdirSync(join(workspace, "payload", "luban-cli-9.9.9-mac-x64", "app"), { recursive: true });
    await writeFile(join(workspace, "payload", "luban-cli-9.9.9-mac-x64", "README"), "no launcher");
    const archive = join(workspace, "bad.zip");
    const zipped = spawn("zip", ["-qr", archive, "luban-cli-9.9.9-mac-x64"], { cwd: join(workspace, "payload") });
    await new Promise((resolve) => zipped.on("close", resolve));
    await expect(installUpdate(artifactFrom("x"), archive, { kind: "cli", root, home: join(workspace, "home") }))
      .rejects.toThrow(/没有 luban 启动脚本/u);
  }, 30_000);
});
