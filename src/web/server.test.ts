import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MeshRuntime } from "../core/mesh/runtime.js";
import { AgentRunner } from "../core/agent.js";
import { configureRemoteJobs } from "../core/mesh/agent-runner.js";
import { SessionStore } from "../core/session-store.js";
import type { LubanConfig } from "../core/types.js";
import { LubanWebServer } from "./server.js";

function testConfig(root: string): LubanConfig {
  const workspace = join(root, "workspace");
  const model = { id: "test/model", provider: "test", model: "model", name: "Test Model", baseUrl: "http://127.0.0.1", apiKey: "" };
  return {
    home: join(root, "home"), workspace, project: "web-project", model, models: [model],
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

async function jsonRequest(url: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function waitForJob(base: string, id: string, status: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const reply = await jsonRequest(`${base}api/jobs/${id}`);
    if (reply.body.status === status) return reply.body;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`job ${id} did not reach ${status}`);
}

describe("LubanWebServer", () => {
  it("resumes saved agent history after restart and rejects duplicate resume requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-web-resume-"));
    const config = testConfig(root);
    config.maxSteps = 1;
    await mkdir(config.workspace, { recursive: true });
    let executions = 0;
    let calls = 0;
    const configure = (mesh: MeshRuntime) => configureRemoteJobs(mesh, config, settings => {
      const runner = new AgentRunner(settings, { async complete(messages) {
        calls++;
        if (calls === 1) return { content: "", toolCalls: [{ id: "effect", type: "function" as const, function: { name: "once", arguments: "{}" } }], usage: { input: 1, output: 1 } };
        if (calls === 2) return { content: "Work saved; verification remains.", toolCalls: [], usage: { input: 1, output: 1 } };
        expect(messages.some(m => m.role === "tool" && m.content === "effect already performed")).toBe(true);
        expect(messages.at(-1)?.content).toContain("继续");
        return { content: "Verified and finished.", toolCalls: [], usage: { input: 1, output: 1 } };
      } });
      runner.tools.set("once", { name: "once", description: "effect", risk: "read", parameters: {}, async execute() { executions++; return "effect already performed"; } });
      return runner;
    });
    let mesh = new MeshRuntime(config);
    configure(mesh);
    let web = new LubanWebServer(config, mesh);
    try {
      await mesh.start();
      let base = await web.start();
      const job = await mesh.submitLocalJob({ instruction: "perform and verify" });
      const paused = await waitForJob(base, job.id, "paused");
      expect(paused.session_id).toBeTruthy();
      await web.stop();
      await mesh.stop();
      mesh = new MeshRuntime(config);
      configure(mesh);
      web = new LubanWebServer(config, mesh);
      await mesh.start();
      base = await web.start();
      const replies = await Promise.all([1, 2].map(() => jsonRequest(`${base}api/jobs/${job.id}/resume`, { method: "POST" })));
      expect(replies.map(r => r.status).sort()).toEqual([200, 409]);
      const done = await waitForJob(base, job.id, "done");
      expect(done.result).toBe("Verified and finished.");
      expect(done.resume_count).toBe(1);
      expect(done.created_at).toBe(job.created_at);
      expect(executions).toBe(1);
      const saved = await new SessionStore(config.home).load(String(done.session_id), config.project, config.workspace);
      expect(saved?.messages.at(-1)?.content).toBe("Verified and finished.");
      expect((await jsonRequest(`${base}api/jobs/${job.id}/resume`, { method: "POST" })).status).toBe(409);
      await mesh.store.update(job.id, { status: "paused", session_id: "missing-history" });
      await jsonRequest(`${base}api/jobs/${job.id}/resume`, { method: "POST" });
      const failed = await waitForJob(base, job.id, "failed");
      expect(failed.error).toContain("saved task history is missing");
      expect(calls).toBe(3);
    } finally {
      await web.stop();
      await mesh.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  });

  it("serves the dashboard and the Python-compatible API from Node", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-web-"));
    const config = testConfig(root);
    await mkdir(config.workspace, { recursive: true });
    await writeFile(join(config.workspace, "README.md"), "web context\n", "utf8");
    const mesh = new MeshRuntime(config);
    mesh.setJobRunner(async (job, _signal, log) => {
      log("tool", "read_file: README.md");
      return { ok: true, text: `${job.instruction}: ${await readFile(join(job.workspace, "README.md"), "utf8")}` };
    });
    const web = new LubanWebServer(config, mesh, { host: "127.0.0.1", port: 0 });
    await mesh.start();
    const base = await web.start();
    try {
      const page = await fetch(base);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("luban");
      const diff = await fetch(`${base}diff?project=web-project`);
      expect(diff.status).toBe(200);
      expect(await diff.text()).toContain("代码变更");

      const node = await jsonRequest(`${base}api/node`);
      expect(node.body).toMatchObject({ name: "web-node", runtime: "nodejs", serving: true });
      expect(node.body.projects).toMatchObject({ "web-project": config.workspace });

      await mkdir(config.mesh.jobsDir, { recursive: true });
      await writeFile(join(config.mesh.jobsDir, "chat-inbox.jsonl"), `${JSON.stringify({ id: "msg-test", from: "peer", to: "web-node", text: "hello", received_at: 1 })}\n`);
      const inbox = await fetch(`${base}api/inbox`);
      expect(await inbox.json()).toEqual([{ id: "msg-test", from: "peer", to: "web-node", text: "hello", received_at: 1 }]);

      const workspace = await jsonRequest(`${base}api/workspace?project=web-project`);
      expect(workspace.body.tree).toEqual([{ name: "README.md", path: "README.md", type: "file", size: 12 }]);
      const escaped = await jsonRequest(`${base}api/workspace?project=web-project&sub=..`);
      expect(escaped.status).toBe(400);

      const contact = await jsonRequest(`${base}api/contacts`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "peer-one", host: "127.0.0.1", port: 9999, udp_port: 9998 }),
      });
      expect(contact.body.ok).toBe(true);
      const peers = await jsonRequest(`${base}api/peers`);
      expect(peers.body).toEqual(expect.arrayContaining([expect.objectContaining({ name: "peer-one", port: 9999, online: false })]));

      const submitted = await jsonRequest(`${base}api/jobs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: "summarize", project_id: "web-project" }),
      });
      expect(submitted.body.ok).toBe(true);
      const finished = await waitForJob(base, String(submitted.body.job_id), "done");
      expect(finished.result).toContain("summarize: web context");
      expect(finished.logs).toEqual(expect.arrayContaining([expect.objectContaining({ level: "tool" })]));
    } finally {
      await web.stop();
      await mesh.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  }, 15_000);

  it("cancels an active Node worker through the Web API", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-web-cancel-"));
    const config = testConfig(root);
    await mkdir(config.workspace, { recursive: true });
    const mesh = new MeshRuntime(config);
    mesh.setJobRunner(async (_job, signal) => await new Promise((resolveJob, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const web = new LubanWebServer(config, mesh, { port: 0 });
    await mesh.start();
    const base = await web.start();
    try {
      const submitted = await jsonRequest(`${base}api/jobs`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction: "wait" }),
      });
      const id = String(submitted.body.job_id);
      await waitForJob(base, id, "working");
      const cancelled = await jsonRequest(`${base}api/jobs/${id}/cancel`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      expect(cancelled.body).toMatchObject({ ok: true, status: "cancelled" });
      await waitForJob(base, id, "cancelled");
    } finally {
      await web.stop();
      await mesh.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  }, 15_000);
});
