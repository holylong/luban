import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MeshRuntime } from "../core/mesh/runtime.js";
import type { LubanConfig } from "../core/types.js";
import { LubanWebServer } from "./server.js";

/**
 * 极简模式 is toggled from three places — `/concise` in the terminal, the button
 * in the desktop app, the browser — so the setting lives in `config.json` and
 * the node reports it back. This covers the two halves the UI depends on: the
 * value in `/api/node` and the write performed by `POST /api/concise`.
 */
function testConfig(root: string): LubanConfig {
  const workspace = join(root, "workspace");
  const model = { id: "test/model", provider: "test", model: "model", name: "Test Model", baseUrl: "http://127.0.0.1", apiKey: "" };
  return {
    home: join(root, "home"), workspace, project: "web-project", model, models: [model],
    maxTokens: 1000, temperature: 0, timeoutMs: 5_000, maxSteps: 5,
    backendUrl: "", permissionMode: "allow", concise: false,
    history: { enabled: false, directory: "", maxMessagesPerSession: 0 },
    mesh: {
      enabled: true, nodeName: "web-node", host: "127.0.0.1", port: 0, udpPort: 0,
      capabilities: ["agent", "nodejs"], contacts: [], token: "", syncMode: "chunk",
      chunkSize: 1024, syncIgnore: [".luban", ".git", "node_modules"], conflictPolicy: "auto",
      jobsDir: join(root, "home", "jobs"), workspacesDir: join(root, "home", "workspaces"),
      projects: {}, maxWorkers: 1, jobTimeoutSeconds: 30, queueTimeoutSeconds: 30,
    },
  } as unknown as LubanConfig;
}

let server: LubanWebServer;
let base: string;
let home: string;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "luban-concise-web-"));
  const config = testConfig(root);
  home = config.home;
  await writeFile(join(root, "placeholder"), "");
  server = new LubanWebServer(config, new MeshRuntime(config), { host: "127.0.0.1", port: 0 });
  base = (await server.start()).replace(/\/$/u, "");
});

afterEach(async () => { await server.stop(); });

const call = async (path: string, body?: Record<string, unknown>) => {
  const response = await fetch(`${base}${path}`, body
    ? { method: "POST", headers: { "content-type": "application/json", "x-luban-web": "1" }, body: JSON.stringify(body) }
    : undefined);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

/** The home directory only appears once `/api/node` has provisioned it. */
async function savedConcise(): Promise<boolean | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as { concise?: boolean };
    return raw.concise;
  } catch { return undefined; }
}

describe("极简模式 endpoint", { timeout: 20_000 }, () => {
  it("reports off by default so the desktop button starts in the right state", async () => {
    const node = await call("/api/node");
    expect(node.status).toBe(200);
    expect(node.body.concise).toBe(false);
  });

  it("saves the switch to config.json and reports it back", async () => {
    const on = await call("/api/concise", { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ ok: true, concise: true });
    expect(await savedConcise()).toBe(true);
    expect((await call("/api/node")).body.concise).toBe(true);

    const off = await call("/api/concise", { enabled: false });
    expect(off.body).toMatchObject({ ok: true, concise: false });
    expect(await savedConcise()).toBe(false);
    expect((await call("/api/node")).body.concise).toBe(false);
  });

  it("rejects a body that is not a boolean instead of silently coercing it", async () => {
    const bad = await call("/api/concise", { enabled: "on" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("enabled");
  });
});
