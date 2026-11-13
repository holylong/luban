import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MeshRuntime } from "../core/mesh/runtime.js";
import { resetComputerControlForTests } from "../core/computer.js";
import type { LubanConfig } from "../core/types.js";
import { LubanWebServer } from "./server.js";

const FAKE = `#!/usr/bin/env node
let data = "";
process.stdin.on("data", chunk => { data += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(data.trim() || "{}");
  if (request.action === "check") return console.log(JSON.stringify({ ok: true, accessibility: true, postEvent: true, screenRecording: false, displayScale: 2 }));
  if (request.action === "screenshot") return console.log(JSON.stringify({ ok: true, path: request.path, bytes: 3 }));
  console.log(JSON.stringify({ ok: true }));
});
`;

function testConfig(root: string): LubanConfig {
  const workspace = join(root, "workspace");
  const model = { id: "test/model", provider: "test", model: "model", name: "Test Model", baseUrl: "http://127.0.0.1", apiKey: "" };
  return {
    home: join(root, "home"), workspace, project: "web-project", model, models: [model],
    maxTokens: 1000, temperature: 0, timeoutMs: 5_000, maxSteps: 5,
    backendUrl: "", permissionMode: "allow",
    history: { enabled: false, directory: "", maxMessagesPerSession: 0 },
    mesh: {
      enabled: true, nodeName: "web-node", host: "127.0.0.1", port: 0, udpPort: 0,
      capabilities: ["agent", "nodejs"], contacts: [], token: "", syncMode: "chunk",
      chunkSize: 1024, syncIgnore: [".luban", ".git", "node_modules"], conflictPolicy: "auto",
      jobsDir: join(root, "home", "jobs"), workspacesDir: join(root, "home", "workspaces"),
      projects: {}, maxWorkers: 1, jobTimeoutSeconds: 30, queueTimeoutSeconds: 30,
    },
  };
}

let server: LubanWebServer;
let base: string;
let original: string | undefined;

beforeEach(async () => {
  original = process.env.LUBAN_COMPUTER_HELPER;
  const root = await mkdtemp(join(tmpdir(), "luban-computer-web-"));
  const helper = join(root, "fake-computer");
  await writeFile(helper, FAKE, { mode: 0o755 });
  process.env.LUBAN_COMPUTER_HELPER = helper;
  resetComputerControlForTests();
  const config = testConfig(root);
  server = new LubanWebServer(config, new MeshRuntime(config), { host: "127.0.0.1", port: 0 });
  base = (await server.start()).replace(/\/$/u, "");
});

afterEach(async () => {
  await server.stop();
  if (original === undefined) delete process.env.LUBAN_COMPUTER_HELPER;
  else process.env.LUBAN_COMPUTER_HELPER = original;
  resetComputerControlForTests();
});

const call = async (path: string, body?: Record<string, unknown>) => {
  const response = await fetch(`${base}${path}`, body
    ? { method: "POST", headers: { "content-type": "application/json", "x-luban-web": "1" }, body: JSON.stringify(body) }
    : undefined);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

describe("computer control endpoint", { timeout: 30_000 }, () => {
  it("reports the switch off, with the permission state the OS actually has", async () => {
    const reply = await call("/api/computer");
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ enabled: false, accessibility: true, screenRecording: false, displayScale: 2 });
  });

  it("opens and closes the session, and ⌘. stops it", async () => {
    expect((await call("/api/computer", { enabled: true })).body).toMatchObject({ ok: true, enabled: true });
    expect((await call("/api/computer")).body.enabled).toBe(true);
    expect((await call("/api/computer", { stop: true })).body).toMatchObject({ enabled: false, stopped: true });
    expect((await call("/api/computer")).body.enabled).toBe(false);
    // Turning the switch back on is allowed; the stop flag is cleared with it.
    await call("/api/computer", { enabled: true });
    expect((await call("/api/computer")).body.enabled).toBe(true);
    await call("/api/computer", {});
    expect((await call("/api/computer")).body.enabled).toBe(false);
  });
});
