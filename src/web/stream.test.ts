import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../core/agent.js";
import { MeshRuntime } from "../core/mesh/runtime.js";
import { configureRemoteJobs } from "../core/mesh/agent-runner.js";
import type { LubanConfig, ToolDefinition } from "../core/types.js";
import { ApprovalBroker } from "./approval.js";
import { QuestionBroker } from "./question.js";
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

async function jsonRequest(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

async function waitForJob(base: string, id: string, status: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const reply = await jsonRequest(`${base}api/jobs/${id}`);
    if (reply.body.status === status) return reply.body;
    await new Promise((resolveWait) => setTimeout(resolveWait, 15));
  }
  throw new Error(`job ${id} did not reach ${status}`);
}

const fakeTool: ToolDefinition = { name: "bash", description: "run a shell command", risk: "shell", parameters: {}, async execute() { return "ok"; } };

describe("unattended jobs", () => {
  it("never blocks on approval when no client is watching the job", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-unattended-"));
    const config = testConfig(root);
    await mkdir(config.workspace, { recursive: true });
    let writes = 0;
    let prompts = 0;
    const mesh = new MeshRuntime(config);
    // The handler is installed for the runtime, as the daemon CLI does, but the
    // job was not registered by a browser. Approval must not be consulted for a
    // job nobody can answer, otherwise the worker stalls until the timeout.
    configureRemoteJobs(mesh, config, settings => {
      const runner = new AgentRunner(settings, { async complete(messages) {
        const hasToolResult = messages.some(message => message.role === "tool");
        if (hasToolResult) return { content: "finished", toolCalls: [], usage: { input: 1, output: 1 } };
        return { content: "", toolCalls: [{ id: "w1", type: "function" as const, function: { name: "write_probe", arguments: "{}" } }], usage: { input: 1, output: 1 } };
      } });
      runner.tools.set("write_probe", { name: "write_probe", description: "write probe", risk: "write", parameters: {}, async execute() { writes += 1; return "written"; } });
      return runner;
    }, {
      approve: async () => { prompts += 1; return "deny"; },
      isInteractive: () => false,
      modeFor: () => "edits",
    });
    const web = new LubanWebServer(config, mesh, { port: 0 });
    await mesh.start();
    const base = await web.start();
    try {
      const submitted = await jsonRequest(`${base}api/jobs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: "write something", project_id: "web-project", mode: "edits" }),
      });
      expect(submitted.body.interactive).toBe(false);
      const finished = await waitForJob(base, String(submitted.body.job_id), "done");
      expect(finished.result).toBe("finished");
      expect(writes).toBe(1);
      expect(prompts).toBe(0);
      expect(await web.isInteractiveJob(String(submitted.body.job_id))).toBe(false);
    } finally {
      await web.stop();
      await mesh.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  }, 20_000);
});

describe("job stream and approvals", () => {
  it("exposes pending model questions and delivers a browser answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-web-question-"));
    const config = testConfig(root);
    await mkdir(config.workspace, { recursive: true });
    const mesh = new MeshRuntime(config);
    const questions = new QuestionBroker();
    mesh.setJobRunner(async (job, signal) => {
      const answer = await questions.request(job.id, { question: "Which database?", options: [{ label: "SQLite" }, { label: "Postgres" }] }, signal);
      return { ok: true, text: `Using ${answer}` };
    });
    const web = new LubanWebServer(config, mesh, { port: 0, approvals: new ApprovalBroker(), questions });
    await mesh.start();
    const base = await web.start();
    try {
      const submitted = await jsonRequest(`${base}api/jobs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: "choose database", interaction: "on" }),
      });
      const id = String(submitted.body.job_id);
      let pending: { id: string; question: string }[] = [];
      for (let i = 0; i < 100 && !pending.length; i++) {
        pending = (await jsonRequest(`${base}api/questions?job=${id}`)).body;
        if (!pending.length) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(pending[0]?.question).toBe("Which database?");
      const detail = await jsonRequest(`${base}api/jobs/${id}`);
      expect(detail.body.questions).toHaveLength(1);
      const answered = await jsonRequest(`${base}api/questions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: pending[0]!.id, answer: "Postgres" }),
      });
      expect(answered.body.ok).toBe(true);
      expect((await waitForJob(base, id, "done")).result).toBe("Using Postgres");
      expect((await jsonRequest(`${base}api/questions?job=${id}`)).body).toEqual([]);
    } finally {
      await web.stop();
      await mesh.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  }, 15_000);
  it("buffers structured job events with monotonic sequence numbers for replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-web-stream-"));
    const config = testConfig(root);
    await mkdir(config.workspace, { recursive: true });
    const mesh = new MeshRuntime(config);
    mesh.setJobRunner(async (_job, _signal, log, onEvent) => {
      log("tool", "edit_file: README.md");
      onEvent?.({ kind: "status", text: "reading workspace" });
      onEvent?.({ kind: "tool-start", callId: "c1", name: "edit_file", args: { path: "README.md" }, summary: "README.md" });
      onEvent?.({ kind: "tool-end", callId: "c1", name: "edit_file", ok: true, elapsedMs: 12, preview: "done", editPreview: "Edited README.md (+1 -1)" });
      return { ok: true, text: "streamed" };
    });
    const web = new LubanWebServer(config, mesh, { port: 0 });
    await mesh.start();
    const base = await web.start();
    try {
      const submitted = await jsonRequest(`${base}api/jobs`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction: "stream events" }),
      });
      const id = String(submitted.body.job_id);
      const finished = await waitForJob(base, id, "done");
      expect(finished.result).toBe("streamed");

      const all = await jsonRequest(`${base}api/jobs/${id}/stream?since=0`);
      expect(all.body.complete).toBe(true);
      expect(all.body.events.map((entry: any) => entry.seq)).toEqual([1, 2, 3]);
      expect(all.body.events[1].event).toMatchObject({ kind: "tool-start", callId: "c1", name: "edit_file" });
      expect(all.body.events[2].event).toMatchObject({ kind: "tool-end", editPreview: "Edited README.md (+1 -1)" });
      expect(all.body.next).toBe(3);

      const tail = await jsonRequest(`${base}api/jobs/${id}/stream?since=2`);
      expect(tail.body.events).toHaveLength(1);
      expect(tail.body.events[0].seq).toBe(3);

      const detail = await jsonRequest(`${base}api/jobs/${id}`);
      expect(detail.body.event_next).toBe(3);
      expect(detail.body.events).toHaveLength(3);

      const missing = await jsonRequest(`${base}api/jobs/does-not-exist/stream`);
      expect(missing.status).toBe(404);
    } finally {
      await web.stop();
      await mesh.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  }, 15_000);

  it("pauses a job on a browser approval prompt and honours the decision", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-web-approve-"));
    const config = testConfig(root);
    await mkdir(config.workspace, { recursive: true });
    const mesh = new MeshRuntime(config);
    const approvals = new ApprovalBroker(10_000);
    mesh.setJobRunner(async (_job, _signal, _log, onEvent) => {
      onEvent?.({ kind: "status", text: "awaiting approval" });
      return { ok: true, text: "approved" };
    });
    const web = new LubanWebServer(config, mesh, { port: 0, approvals });
    await mesh.start();
    const base = await web.start();
    try {
      // Simulate the runner asking for a decision while the job is interactive.
      const submitted = await jsonRequest(`${base}api/jobs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: "needs approval", interaction: "on", mode: "agent" }),
      });
      const id = String(submitted.body.job_id);
      expect(submitted.body).toMatchObject({ interactive: true, mode: "agent" });
      expect(web.isInteractiveJob(id)).toBe(true);
      expect(web.jobMode(id)).toBe("agent");
      expect(submitted.body.mode).toBe("agent");
      expect(web.jobMode("job-never-submitted")).toBe("edits");

      const decided = approvals.request(id, fakeTool, { command: "rm -rf /tmp/x" });
      const pending = await jsonRequest(`${base}api/approvals?job=${id}`);
      expect(pending.body).toHaveLength(1);
      expect(pending.body[0]).toMatchObject({ job_id: id, tool: "bash", risk: "shell" });

      await waitForJob(base, id, "done");
      const answered = await jsonRequest(`${base}api/approvals`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: pending.body[0].id, decision: "once" }),
      });
      expect(answered.body).toMatchObject({ ok: true, decision: "once" });
      await expect(decided).resolves.toBe("once");

      const unknown = await jsonRequest(`${base}api/approvals`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: pending.body[0].id, decision: "deny" }),
      });
      expect(unknown.status).toBe(404);
      const badDecision = await jsonRequest(`${base}api/approvals`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "ask-nope", decision: "maybe" }),
      });
      expect(badDecision.status).toBe(400);
    } finally {
      await web.stop();
      await mesh.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  }, 15_000);

  it("reports interactive as false and still resolves approvals when no broker is attached", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-web-nobroker-"));
    const config = testConfig(root);
    await mkdir(config.workspace, { recursive: true });
    const mesh = new MeshRuntime(config);
    mesh.setJobRunner(async () => ({ ok: true, text: "no prompts" }));
    const web = new LubanWebServer(config, mesh, { port: 0 });
    await mesh.start();
    const base = await web.start();
    try {
      const submitted = await jsonRequest(`${base}api/jobs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: "no prompts", interaction: "on" }),
      });
      expect(submitted.body.interactive).toBe(false);
      const approvals = await jsonRequest(`${base}api/approvals`);
      expect(approvals.body).toEqual([]);
      const answer = await jsonRequest(`${base}api/approvals`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "ask-x", decision: "once" }),
      });
      expect(answer.status).toBe(409);
    } finally {
      await web.stop();
      await mesh.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  }, 15_000);

  it("serves workspace files with traversal protection and lists saved sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-web-files-"));
    const config = testConfig(root);
    await mkdir(config.workspace, { recursive: true });
    await mkdir(join(config.workspace, "src"), { recursive: true });
    await writeFile(join(config.workspace, "src", "index.ts"), "export const answer = 42;\n", "utf8");
    await writeFile(join(config.workspace, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const mesh = new MeshRuntime(config);
    mesh.setJobRunner(async () => ({ ok: true, text: "noop" }));
    const web = new LubanWebServer(config, mesh, { port: 0 });
    await mesh.start();
    const base = await web.start();
    try {
      const file = await jsonRequest(`${base}api/file?project=web-project&path=src/index.ts`);
      expect(file.body).toMatchObject({ path: "src/index.ts", binary: false, truncated: false, lines: 1 });
      expect(file.body.content).toContain("answer = 42");

      const binary = await jsonRequest(`${base}api/file?project=web-project&path=logo.png`);
      expect(binary.body).toMatchObject({ binary: true, content: "" });

      const escaped = await jsonRequest(`${base}api/file?project=web-project&path=../../etc/passwd`);
      expect(escaped.status).toBe(400);

      const versions = await jsonRequest(`${base}api/file-versions?project=web-project&path=src/index.ts`);
      expect(versions.body.current).toContain("answer = 42");

      const sessions = await jsonRequest(`${base}api/sessions?project=web-project`);
      expect(Array.isArray(sessions.body)).toBe(true);

      const nested = await jsonRequest(`${base}api/workspace?project=web-project&sub=src`);
      expect(nested.body.tree).toEqual([{ name: "index.ts", path: "src/index.ts", type: "file", size: 26 }]);
    } finally {
      await web.stop();
      await mesh.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  }, 15_000);
});
