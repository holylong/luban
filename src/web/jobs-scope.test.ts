import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MeshRuntime } from "../core/mesh/runtime.js";
import type { LubanConfig } from "../core/types.js";
import { LubanWebServer } from "./server.js";

function testConfig(root: string): LubanConfig {
  const workspace = join(root, "workspace");
  const model = {
    id: "test/model", provider: "test", model: "model", name: "Test Model",
    baseUrl: "http://127.0.0.1", apiKey: "", api: "openai" as const,
    capabilities: { vision: false, thinking: false, tools: true, responses: false },
  };
  return {
    home: join(root, "home"), workspace, project: "conductor", model, models: [model],
    maxTokens: 1000, temperature: 0, timeoutMs: 5_000, maxSteps: 5,
    backendUrl: "", permissionMode: "allow",
    mesh: {
      enabled: true, nodeName: "web-node", host: "127.0.0.1", port: 0, udpPort: 0,
      capabilities: ["agent", "nodejs"], contacts: [], token: "", syncMode: "chunk",
      chunkSize: 1024, syncIgnore: [".luban", ".git", "node_modules"], conflictPolicy: "auto",
      jobsDir: join(root, "home", "jobs"), workspacesDir: join(root, "home", "workspaces"),
      projects: {}, maxWorkers: 1, jobTimeoutSeconds: 30, queueTimeoutSeconds: 30,
    },
  };
}

async function ids(url: string): Promise<string[]> {
  const reply = await fetch(url);
  expect(reply.status).toBe(200);
  const body = await reply.json() as Array<{ id: string }>;
  return body.map(job => job.id).sort();
}

/**
 * The job directory is one folder per machine, so every console on this
 * computer saw every workspace's turns. A phone pinned to the `/tmp/luban-phone`
 * test node therefore listed a Conductor conversation as if it were its own.
 */
describe("job list scope", () => {
  it("answers one workspace at a time, with an explicit whole-machine escape hatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-jobs-scope-"));
    const config = testConfig(root);
    await mkdir(config.workspace, { recursive: true });
    const mesh = new MeshRuntime(config);
    await mesh.start();
    const web = new LubanWebServer(config, mesh, { port: 0 });
    const base = await web.start();
    try {
      await mesh.store.create({ id: "job-here", source: "a", target: "a", instruction: "本地工作区", project_id: "conductor" });
      await mesh.store.create({ id: "job-other", source: "a", target: "a", instruction: "别的项目", project_id: "luban-phone" });
      // A job written before the field existed stays visible everywhere.
      await mesh.store.create({ id: "job-legacy", source: "a", target: "a", instruction: "老任务" });

      // No project named: the desktop console still sees the whole machine.
      expect(await ids(`${base}api/jobs`)).toEqual(["job-here", "job-legacy", "job-other"]);
      expect(await ids(`${base}api/jobs?project=conductor`)).toEqual(["job-here", "job-legacy"]);
      expect(await ids(`${base}api/jobs?project=luban-phone`)).toEqual(["job-legacy", "job-other"]);
    } finally {
      await web.stop();
      await mesh.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  }, 20_000);
});
