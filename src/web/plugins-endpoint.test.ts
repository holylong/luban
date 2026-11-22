import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MeshRuntime } from "../core/mesh/runtime.js";
import type { LubanConfig } from "../core/types.js";
import { LubanWebServer } from "./server.js";

/**
 * The storefront is only real if the panel's three buttons work against a live
 * server: search narrows the list, install writes skills and records them, and
 * uninstall takes back exactly what that install owned. A dead catalog must
 * still leave the installed list manageable.
 */
function testConfig(root: string, registry: string): LubanConfig {
  const workspace = join(root, "workspace");
  const model = { id: "test/model", provider: "test", model: "model", name: "Test Model", baseUrl: "http://127.0.0.1", apiKey: "" };
  return {
    home: join(root, "home"), workspace, project: "web-project", model, models: [model],
    maxTokens: 1000, temperature: 0, timeoutMs: 5_000, maxSteps: 5,
    backendUrl: "", permissionMode: "allow",
    history: { enabled: false, directory: "", maxMessagesPerSession: 0 },
    updates: { check: false, url: "", skippedVersion: "" },
    plugins: { registry },
    mesh: {
      enabled: true, nodeName: "web-node", host: "127.0.0.1", port: 0, udpPort: 0,
      capabilities: ["agent", "nodejs"], contacts: [], token: "", syncMode: "chunk",
      chunkSize: 1024, syncIgnore: [".luban", ".git", "node_modules"], conflictPolicy: "auto",
      jobsDir: join(root, "home", "jobs"), workspacesDir: join(root, "home", "workspaces"),
      projects: {}, maxWorkers: 1, jobTimeoutSeconds: 30, queueTimeoutSeconds: 30,
    },
  } as unknown as LubanConfig;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const FILES: Record<string, string> = {
  "/plugins/commit-zh/skills/commit-zh/SKILL.md": "---\nname: commit-zh\ndescription: 中文提交信息\n---\n\n标题一行。\n",
  "/plugins/sql-review/skills/sql-review/SKILL.md": "---\nname: sql-review\ndescription: SQL 审阅\n---\n\n先看执行计划。\n",
};

/** Stand-in for raw.githubusercontent: the catalog plus the bytes it lists. */
async function fakeRegistry(version = "1.0.0"): Promise<{ url: string; close: () => Promise<void> }> {
  let base = "";
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/plugins.json") {
      const entry = (id: string, name: string, description: string, tags: string[], skill: string, file: string) => ({
        id, name, version, description, author: "luban", license: "MIT", tags, skills: [skill],
        files: [{
          path: `skills/${skill}/SKILL.md`, url: `${base}${file}`,
          sha256: sha(FILES[file]), bytes: Buffer.byteLength(FILES[file]),
        }],
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        schemaVersion: 1, updatedAt: "2026-11-23T08:00:00.000Z",
        plugins: [
          entry("commit-zh", "中文提交信息", "提交信息写中文。", ["git", "中文"], "commit-zh",
            "/plugins/commit-zh/skills/commit-zh/SKILL.md"),
          entry("sql-review", "SQL 审阅", "慢查询先看执行计划。", ["sql", "性能"], "sql-review",
            "/plugins/sql-review/skills/sql-review/SKILL.md"),
        ],
      }));
      return;
    }
    const body = FILES[path];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/markdown" });
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  return { url: `${base}/plugins.json`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

let server: LubanWebServer;
let base: string;
let registry: Awaited<ReturnType<typeof fakeRegistry>>;
let home: string;

const call = async (path: string, body?: Record<string, unknown>) => {
  const response = await fetch(`${base}${path}`, body
    ? { method: "POST", headers: { "content-type": "application/json", "x-luban-web": "1" }, body: JSON.stringify(body) }
    : undefined);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

async function start(registryUrl: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "luban-plugins-web-"));
  await mkdir(join(root, "workspace"), { recursive: true });
  home = join(root, "home");
  const config = testConfig(root, registryUrl);
  server = new LubanWebServer(config, new MeshRuntime(config), { host: "127.0.0.1", port: 0 });
  base = (await server.start()).replace(/\/$/u, "");
}

beforeEach(async () => {
  registry = await fakeRegistry();
  await start(registry.url);
});

afterEach(async () => {
  await server.stop();
  await registry.close();
});

describe("plugin endpoint", { timeout: 30_000 }, () => {
  it("lists the catalog and narrows it with q", async () => {
    const all = await call("/api/plugins");
    expect(all.status).toBe(200);
    expect((all.body.plugins as unknown[]).length).toBe(2);
    expect(all.body.installed).toEqual([]);
    expect(all.body.registry).toBe(registry.url);

    const typed = await call(`/api/plugins?q=${encodeURIComponent("中文")}`);
    const plugins = typed.body.plugins as Array<Record<string, unknown>>;
    expect(plugins.map(plugin => plugin.id)).toEqual(["commit-zh"]);

    // A tag matches too, and the empty query returns everything again.
    const byTag = await call("/api/plugins?q=sql");
    expect((byTag.body.plugins as Array<Record<string, unknown>>).map(plugin => plugin.id)).toEqual(["sql-review"]);
  });

  it("installs into skills/, records it, and reports it as installed", async () => {
    const install = await call("/api/plugins/install", { id: "commit-zh" });
    expect(install.status).toBe(200);
    const installed = install.body.installed as Record<string, unknown>;
    expect(installed.version).toBe("1.0.0");
    expect(installed.skills).toEqual(["commit-zh"]);

    const onDisk = await readFile(join(home, "skills", "commit-zh", "SKILL.md"), "utf8");
    expect(onDisk).toContain("中文提交信息");
    expect(await readdir(join(home, "skills"))).toEqual(["commit-zh"]);

    const after = await call("/api/plugins");
    const entry = (after.body.plugins as Array<Record<string, unknown>>).find(plugin => plugin.id === "commit-zh");
    expect((entry?.installed as Record<string, unknown>).version).toBe("1.0.0");
    expect(entry?.update).toBe(false);
  });

  it("uninstalls only what that plugin owned", async () => {
    await call("/api/plugins/install", { id: "commit-zh" });
    await call("/api/plugins/install", { id: "sql-review" });
    const removed = await call("/api/plugins/uninstall", { id: "commit-zh" });
    expect(removed.status).toBe(200);
    expect(removed.body.skills).toEqual(["commit-zh"]);
    expect(await readdir(join(home, "skills"))).toEqual(["sql-review"]);
  });

  it("refuses an id the catalog does not have", async () => {
    const reply = await call("/api/plugins/install", { id: "not-there" });
    expect(reply.status).toBe(404);
    expect(String(reply.body.error)).toContain("not-there");
    expect(await readdir(join(home, "skills")).catch(() => [])).toEqual([]);
  });

  it("keeps installed packs manageable when the catalog is down", async () => {
    await call("/api/plugins/install", { id: "sql-review" });
    await registry.close();
    registry = await fakeRegistry(); // a new one so afterEach has something to close
    const reply = await call("/api/plugins?refresh=1");
    expect(reply.status).toBe(200);
    expect(reply.body.plugins).toEqual([]);
    expect(String(reply.body.error)).toBeTruthy();
    const installed = reply.body.installed as Array<Record<string, unknown>>;
    expect(installed.map(item => item.id)).toEqual(["sql-review"]);
  });
});
