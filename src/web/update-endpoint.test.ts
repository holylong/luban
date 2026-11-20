import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MeshRuntime } from "../core/mesh/runtime.js";
import type { LubanConfig } from "../core/types.js";
import { VERSION } from "../version.js";
import { LubanWebServer } from "./server.js";

/**
 * The browser workbench reaches the release server through the local backend,
 * so this covers the wiring a user actually touches: the sidebar checks, the
 * switch persists, and an install is refused rather than half-done when there
 * is nothing to install.
 */
function testConfig(root: string, releaseUrl: string): LubanConfig {
  const workspace = join(root, "workspace");
  const model = { id: "test/model", provider: "test", model: "model", name: "Test Model", baseUrl: "http://127.0.0.1", apiKey: "" };
  return {
    home: join(root, "home"), workspace, project: "web-project", model, models: [model],
    maxTokens: 1000, temperature: 0, timeoutMs: 5_000, maxSteps: 5,
    backendUrl: "", permissionMode: "allow",
    history: { enabled: false, directory: "", maxMessagesPerSession: 0 },
    updates: { check: true, url: releaseUrl, skippedVersion: "" },
    mesh: {
      enabled: true, nodeName: "web-node", host: "127.0.0.1", port: 0, udpPort: 0,
      capabilities: ["agent", "nodejs"], contacts: [], token: "", syncMode: "chunk",
      chunkSize: 1024, syncIgnore: [".luban", ".git", "node_modules"], conflictPolicy: "auto",
      jobsDir: join(root, "home", "jobs"), workspacesDir: join(root, "home", "workspaces"),
      projects: {}, maxWorkers: 1, jobTimeoutSeconds: 30, queueTimeoutSeconds: 30,
    },
  } as unknown as LubanConfig;
}

/** Stand-in for the release server: one artifact, and a log of what was asked. */
async function fakeRelease(version: string): Promise<{ url: string; queries: string[]; close: () => Promise<void> }> {
  const queries: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    queries.push(url.pathname + url.search);
    if (url.pathname !== "/api/update") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      latest: { version },
      artifact: {
        version, publishedAt: "2026-11-20T09:00:00.000Z", notes: "升级提示与服务器",
        file: "luban-cli-9.9.9-mac-x64.zip", url: "/downloads/luban-cli-9.9.9-mac-x64.zip",
        sha256: "b".repeat(64), size: 2048, kind: "cli", platform: "darwin", arch: "x64",
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    queries,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let server: LubanWebServer;
let base: string;
let release: Awaited<ReturnType<typeof fakeRelease>>;

const call = async (path: string, body?: Record<string, unknown>) => {
  const response = await fetch(`${base}${path}`, body
    ? { method: "POST", headers: { "content-type": "application/json", "x-luban-web": "1" }, body: JSON.stringify(body) }
    : undefined);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "luban-update-web-"));
  await mkdir(join(root, "workspace"), { recursive: true });
  release = await fakeRelease("9.9.9");
  const config = testConfig(root, release.url);
  server = new LubanWebServer(config, new MeshRuntime(config), { host: "127.0.0.1", port: 0 });
  base = (await server.start()).replace(/\/$/u, "");
});

afterEach(async () => {
  await server.stop();
  await release.close();
});

describe("update endpoint", { timeout: 30_000 }, () => {
  it("reports the newer version and asks for this platform once", async () => {
    const first = await call("/api/update");
    expect(first.status).toBe(200);
    const check = first.body.check as Record<string, unknown>;
    expect(check.status).toBe("available");
    expect(check.latest).toBe("9.9.9");
    expect((first.body.settings as Record<string, unknown>).check).toBe(true);
    expect(release.queries).toHaveLength(1);
    expect(release.queries[0]).toContain("platform=");
    expect(release.queries[0]).toContain("kind=cli");

    // A second tab must not spend a second release-server request.
    await call("/api/update");
    expect(release.queries).toHaveLength(1);

    // The explicit "check now" button does.
    await call("/api/update?refresh=1");
    expect(release.queries).toHaveLength(2);
  });

  it("persists the switch and stops asking upstream", async () => {
    await call("/api/update");
    const off = await call("/api/update/settings", { check: false });
    expect(off.status).toBe(200);
    expect((off.body.settings as Record<string, unknown>).check).toBe(false);

    const after = await call("/api/update?refresh=1");
    expect((after.body.check as Record<string, unknown>).status).toBe("disabled");
    expect(release.queries).toHaveLength(1);

    const saved = JSON.parse(await readFile(join(server.config.home, "config.json"), "utf8"));
    expect(saved.updates.check).toBe(false);

    await call("/api/update/settings", { check: true });
    const back = await call("/api/update");
    expect((back.body.check as Record<string, unknown>).status).toBe("available");
  });

  it("turns 不再提醒 into a skipped status that survives a re-read", async () => {
    const skipped = await call("/api/update/settings", { skippedVersion: "9.9.9" });
    expect(skipped.status).toBe(200);
    expect((skipped.body.settings as Record<string, unknown>).skippedVersion).toBe("9.9.9");

    const check = (await call("/api/update?refresh=1")).body.check as Record<string, unknown>;
    expect(check.status).toBe("skipped");
    expect(check.latest).toBe("9.9.9");

    const saved = JSON.parse(await readFile(join(server.config.home, "config.json"), "utf8"));
    expect(saved.updates.skipped_version).toBe("9.9.9");
    expect(saved.updates.check).toBe(true);
  });

  it("rejects a settings payload it cannot store", async () => {
    expect((await call("/api/update/settings", { check: "yes" })).status).toBe(400);
    expect((await call("/api/update/settings", { skippedVersion: 7 })).status).toBe(400);
  });

  it("refuses to install when there is nothing newer", async () => {
    await release.close();
    release = await fakeRelease(VERSION);
    const root = await mkdtemp(join(tmpdir(), "luban-update-web-"));
    await mkdir(join(root, "workspace"), { recursive: true });
    await server.stop();
    const config = testConfig(root, release.url);
    server = new LubanWebServer(config, new MeshRuntime(config), { host: "127.0.0.1", port: 0 });
    base = (await server.start()).replace(/\/$/u, "");

    const install = await call("/api/update/install", {});
    expect(install.status).toBe(409);
    expect(String(install.body.error)).toContain("没有可安装的新版本");
  });

  it("writes a config file whose skipped version the CLI and the app can read", async () => {
    await call("/api/update/settings", { skippedVersion: "9.9.9" });
    await writeFile(join(server.config.home, "marker"), "x");
    const saved = JSON.parse(await readFile(join(server.config.home, "config.json"), "utf8"));
    expect(Object.keys(saved.updates).sort()).toEqual(["check", "skipped_version", "url"]);
  });
});
