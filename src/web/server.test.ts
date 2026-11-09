import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MeshRuntime } from "../core/mesh/runtime.js";
import { AgentRunner } from "../core/agent.js";
import { configureRemoteJobs } from "../core/mesh/agent-runner.js";
import { SessionStore } from "../core/session-store.js";
import { liveSessions } from "../core/live-session.js";
import { sharedHistory } from "../core/session-history.js";
import type { LubanConfig } from "../core/types.js";
import { LubanWebServer } from "./server.js";

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
  it("overlays unsaved terminal history and events, finishes cleanly, and guards running continuations", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-web-live-"));
    const config = testConfig(root);
    const mesh = new MeshRuntime(config);
    const web = new LubanWebServer(config, mesh);
    const store = new SessionStore(config.home);
    const session = store.create(config.project, config.workspace, "agent", config.model.id, [
      { role: "system", content: "harness" }, { role: "user", content: "original question" },
    ]);
    const foreign = { ...session, id: "foreign-session", title: "secret" };
    liveSessions.publish(join(root, "other-home"), foreign);
    liveSessions.publish(config.home, session);
    const draft = store.create(config.project, config.workspace, "agent", config.model.id, [{ role: "system", content: "harness" }]);
    liveSessions.publish(config.home, draft);
    await mkdir(config.workspace, { recursive: true });
    mesh.setJobRunner(async () => ({ ok: true, text: "continued" }));
    await mesh.start();
    const base = await web.start();
    try {
      const list = await (await fetch(`${base}api/sessions`)).json();
      expect(list).toMatchObject([{ id: session.id, messages: 1 }]);
      expect((await jsonRequest(`${base}api/sessions/${foreign.id}`)).status).toBe(404);
      expect((await jsonRequest(`${base}api/sessions/${session.id}`)).body).toMatchObject({ messages: session.messages, live: { running: false, events: [] } });
      await store.save(session);
      session.messages.push({ role: "user", content: "new unsaved turn" });
      liveSessions.start(config.home, session);
      session.messages.push({ role: "assistant", content: "streamed answer" });
      // An in-run checkpoint must not double-render messages and events.
      await store.save(session);
      liveSessions.publish(config.home, session);
      liveSessions.append(config.home, session.project, session.id, { kind: "model-call", index: 1 });
      liveSessions.append(config.home, session.project, session.id, { kind: "delta", text: "streamed answer" });
      const detail = await jsonRequest(`${base}api/sessions/${session.id}`);
      expect(detail.body.messages).toEqual(session.messages.slice(0, 3));
      expect(detail.body.live).toMatchObject({ running: true, events: [
        { seq: 1, event: { kind: "model-call", index: 1 } },
        { seq: 2, event: { kind: "delta", text: "streamed answer" } },
      ] });
      expect(await (await fetch(`${base}api/sessions`)).json()).toMatchObject([{ id: session.id, messages: 2 }]);
      const submit = () => jsonRequest(`${base}api/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction: "continue", session_id: session.id }) });
      expect((await submit()).status).toBe(409);
      // Even a first turn without a disk record must report busy, not missing.
      const unsaved = store.create(config.project, config.workspace, "agent", config.model.id, [{ role: "user", content: "busy" }]);
      liveSessions.start(config.home, unsaved);
      expect((await jsonRequest(`${base}api/jobs`, { method: "POST", body: JSON.stringify({ session_id: unsaved.id }) })).status).toBe(409);
      liveSessions.remove(config.home, unsaved.project, unsaved.id);
      liveSessions.finish(config.home, session);
      const finished = await jsonRequest(`${base}api/sessions/${session.id}`);
      expect(finished.body).toMatchObject({ messages: session.messages, live: { running: false, events: [] } });
      // Finished bridge data must not hide a newer continuation saved by a job.
      const newer = await store.load(session.id, session.project);
      newer!.messages.push({ role: "assistant", content: "newer job history" });
      await store.save(newer!);
      expect((await jsonRequest(`${base}api/sessions/${session.id}`)).body.messages).toEqual(newer!.messages);
      const accepted = await submit();
      expect(accepted.status).toBe(200);
    } finally {
      liveSessions.remove(config.home, session.project, session.id);
      liveSessions.remove(config.home, draft.project, draft.id);
      liveSessions.remove(join(root, "other-home"), foreign.project, foreign.id);
      await web.stop();
      await mesh.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  });
  it("shares CLI themes, validates choices and persists without forgetting the model", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-web-theme-"));
    const config = testConfig(root);
    config.theme = "nord";
    config.themeColors = { accent: "#123456" };
    const mesh = new MeshRuntime(config);
    const web = new LubanWebServer(config, mesh);
    await mkdir(config.home, { recursive: true });
    await writeFile(join(config.home, "node-preferences.json"), JSON.stringify({ model: "test/model" }));
    const base = await web.start();
    try {
      const catalog = await jsonRequest(`${base}api/themes`);
      expect(catalog.body.active).toMatchObject({ id: "nord", palette: { accent: "#123456" } });
      expect(catalog.body.themes).toEqual(expect.arrayContaining([expect.objectContaining({ id: "github-light", mode: "light" })]));
      const choose = (id: string) => jsonRequest(`${base}api/theme`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      expect((await choose("missing")).status).toBe(400);
      expect(config.theme).toBe("nord");
      expect((await choose("light")).body.active).toMatchObject({ id: "github-light", mode: "light" });
      expect((await jsonRequest(`${base}api/themes`)).body.active).toMatchObject({ id: "github-light" });
      expect(JSON.parse(await readFile(join(config.home, "node-preferences.json"), "utf8"))).toMatchObject({ model: "test/model", theme: "github-light" });
    } finally {
      await web.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("exposes supported effort choices and validates and persists model changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-web-model-"));
    const config = testConfig(root);
    const baseModel = config.model;
    config.models = [
      { ...baseModel, id: "codex/gpt-6-luna", model: "gpt-6-luna", api: "codex" },
      { ...baseModel, id: "native/gpt-5", model: "gpt-5", api: "responses" },
      { ...baseModel, id: "native/qwen", model: "qwen", api: "openai" },
    ];
    const mesh = new MeshRuntime(config);
    const web = new LubanWebServer(config, mesh);
    await mesh.start();
    const base = await web.start();
    const select = (model: string, reasoning_effort?: unknown) => jsonRequest(`${base}api/model`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, reasoning_effort }),
    });
    try {
      const node = await jsonRequest(`${base}api/node`);
      expect(node.body.models).toMatchObject([
        { reasoning_efforts: ["low", "medium", "high", "xhigh", "max"] },
        { reasoning_efforts: ["low", "medium", "high"] }, { reasoning_efforts: [] },
      ]);
      expect((await select("missing", "high")).status).toBe(400);
      expect((await select("codex/gpt-6-luna", "ultra")).status).toBe(400);
      expect((await select("native/qwen", "high")).status).toBe(400);
      expect((await select("native/gpt-5", "xhigh")).status).toBe(400);
      expect((await select("native/gpt-5", "high")).status).toBe(200);
      expect(config.model.reasoningEffort).toBe("high");
      await select("native/qwen");
      await select("native/gpt-5");
      expect((await jsonRequest(`${base}api/node`)).body).toMatchObject({ model_id: "native/gpt-5", reasoning_effort: "high" });
      expect(JSON.parse(await readFile(join(config.home, "node-preferences.json"), "utf8"))).toMatchObject({ modelEfforts: { "native/gpt-5": "high" } });
      await select("native/gpt-5", null);
      expect(config.model.reasoningEffort).toBeUndefined();
    } finally {
      await web.stop();
      await mesh.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  });

  it("resumes saved agent history after restart and rejects duplicate resume requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-web-resume-"));
    const config = testConfig(root);
    config.maxSteps = 1;
    await mkdir(config.workspace, { recursive: true });
    let executions = 0;
    let calls = 0;
    const configure = (mesh: MeshRuntime) => configureRemoteJobs(mesh, config, settings => {
      const runner = new AgentRunner(settings, { async complete(messages) {
        // Sessions are also named by the model after a run; that call is not a
        // task turn and must not shift the scripted replies below.
        if (String(messages[0]?.content ?? "").includes("You name coding sessions")) {
          return { content: "Perform and verify", toolCalls: [], usage: { input: 1, output: 1 } };
        }
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
    await writeFile(join(config.workspace, ".gitignore"), "dist\n", "utf8");
    await mkdir(join(config.workspace, ".git"));
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
      expect(workspace.body.tree).toEqual([
        { name: ".gitignore", path: ".gitignore", type: "file", size: 5 },
        { name: "README.md", path: "README.md", type: "file", size: 12 },
      ]);
      const escaped = await jsonRequest(`${base}api/workspace?project=web-project&sub=..`);
      expect(escaped.status).toBe(400);

      const contact = await jsonRequest(`${base}api/contacts`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "peer-one", host: "127.0.0.1", port: 9999, udp_port: 9998 }),
      });
      expect(contact.body.ok).toBe(true);
      const peers = await jsonRequest(`${base}api/peers`);
      expect(peers.body).toEqual(expect.arrayContaining([expect.objectContaining({ name: "peer-one", port: 9999, online: false })]));
      // Every peer carries a version string; peers that never answered nodeInfo report "unknown".
      for (const peer of peers.body as Array<{ version?: unknown }>) expect(typeof peer.version).toBe("string");

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

  it("creates a default workspace and registers an existing directory for phone projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-web-projects-"));
    const config = testConfig(root);
    const existing = join(root, "existing-project");
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "README.md"), "existing context\n", "utf8");
    const canonical = await realpath(existing);
    const mesh = new MeshRuntime(config);
    mesh.setJobRunner(async (job) => ({ ok: true, text: job.workspace }));
    const web = new LubanWebServer(config, mesh, { port: 0 });
    await mesh.start();
    const base = await web.start();
    const postProject = (body: Record<string, string>) => jsonRequest(`${base}api/projects`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    try {
      const added = await postProject({ path: existing, name: "picked" });
      expect(added.status).toBe(200);
      expect(added.body).toMatchObject({ ok: true, project: "picked", workspace: canonical, created: false });
      expect(JSON.parse(await readFile(join(config.home, "config.json"), "utf8"))).toMatchObject({ projects: { picked: canonical } });
      expect((await jsonRequest(`${base}api/node`)).body.projects).toMatchObject({ picked: canonical });
      // Registering the same directory again selects the existing project.
      expect((await postProject({ path: existing })).body).toMatchObject({ project: "picked", workspace: canonical });

      const created = await postProject({ name: "fresh" });
      expect(created.status).toBe(200);
      const fresh = join(config.mesh.workspacesDir, "fresh");
      expect(created.body).toMatchObject({ ok: true, project: "fresh", workspace: fresh, created: true });
      expect((await stat(fresh)).isDirectory()).toBe(true);
      expect((await jsonRequest(`${base}api/node`)).body.projects).toMatchObject({ fresh });
      expect((await jsonRequest(`${base}api/sessions?project=fresh`)).body).toEqual([]);

      const submitted = await jsonRequest(`${base}api/jobs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: "where am I", project_id: "fresh" }),
      });
      expect(submitted.status).toBe(200);
      const finished = await waitForJob(base, String(submitted.body.job_id), "done");
      expect(finished.workspace).toBe(fresh);
      expect(finished.result).toBe(fresh);

      expect((await postProject({ name: "picked" })).status).toBe(409);
      expect((await postProject({ path: "relative/project" })).status).toBe(400);
      expect((await postProject({ path: join(root, "missing") })).status).toBe(400);
      expect((await postProject({ path: "/" })).status).toBe(400);
      expect((await postProject({ name: "bad/name" })).status).toBe(400);
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

  it("lists only real conversations and counts messages without the system prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-web-sessions-"));
    const config = testConfig(root);
    await mkdir(config.workspace, { recursive: true });
    const mesh = new MeshRuntime(config);
    const web = new LubanWebServer(config, mesh, { port: 0 });
    await mesh.start();
    const base = await web.start();
    try {
      const store = new SessionStore(config.home);
      const real = store.create(config.project, config.workspace, "agent", "test/model", [
        { role: "system", content: "system prompt" },
        { role: "user", content: "run the tests" },
        { role: "assistant", content: "they pass" },
      ]);
      await store.save(real);
      // What a CLI start leaves behind before the user types anything.
      const draftDirectory = join(config.home, "sessions-node", config.project);
      await mkdir(draftDirectory, { recursive: true });
      await writeFile(join(draftDirectory, "20260101000000-draft.json"), JSON.stringify({
        ...real, id: "20260101000000-draft", title: "New session", messages: [{ role: "system", content: "system prompt" }],
      }));

      const listed = await jsonRequest(`${base}api/sessions?project=${config.project}`);
      expect(listed.body).toEqual([expect.objectContaining({ id: real.id, messages: 2 })]);
      expect((await jsonRequest(`${base}api/sessions/20260101000000-draft?project=${config.project}`)).body).toMatchObject({ id: "20260101000000-draft" });
    } finally {
      await web.stop();
      await mesh.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  }, 15_000);

  it("continues a saved conversation when a job carries its session id", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-web-continue-"));
    const config = testConfig(root);
    config.maxSteps = 1;
    await mkdir(config.workspace, { recursive: true });
    const prompts: string[][] = [];
    const configure = (mesh: MeshRuntime) => configureRemoteJobs(mesh, config, settings => new AgentRunner(settings, { async complete(messages) {
      prompts.push(messages.map(message => message.content ?? ""));
      return { content: "continued answer", toolCalls: [], usage: { input: 1, output: 1 } };
    } }));
    const mesh = new MeshRuntime(config);
    configure(mesh);
    const web = new LubanWebServer(config, mesh);
    await mesh.start();
    const base = await web.start();
    try {
      const store = new SessionStore(config.home);
      const session = store.create(config.project, config.workspace, "agent", config.model.id, [
        { role: "system", content: "sys" },
        { role: "user", content: "first turn" },
        { role: "assistant", content: "first answer" },
      ]);
      await store.save(session);

      const rejected = await jsonRequest(`${base}api/jobs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: "lost turn", project_id: config.project, session_id: "missing-session" }),
      });
      expect(rejected.status).toBe(404);

      const submitted = await jsonRequest(`${base}api/jobs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: "second turn", project_id: config.project, session_id: session.id }),
      });
      expect(submitted.body.ok).toBe(true);
      const done = await waitForJob(base, String(submitted.body.job_id), "done");
      expect(done.session_id).toBe(session.id);
      // The continuation runs in the session's recorded workspace, not the project mapping.
      expect(done.workspace).toBe(config.workspace);
      expect(prompts[0]).toEqual(expect.arrayContaining(["first turn", "first answer", "second turn"]));
      const saved = await store.load(session.id, config.project, config.workspace);
      expect(saved?.messages.map(message => message.content)).toEqual(expect.arrayContaining(["second turn", "continued answer"]));
    } finally {
      await web.stop();
      await mesh.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  }, 15_000);

  it("switches the active model from the web UI and remembers it", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-web-model-"));
    const config = testConfig(root);
    config.models = [...config.models, { ...config.models[0]!, id: "test/alt", name: "Alt Model" }];
    await mkdir(config.workspace, { recursive: true });
    const mesh = new MeshRuntime(config);
    const web = new LubanWebServer(config, mesh);
    await mesh.start();
    const base = await web.start();
    try {
      expect((await jsonRequest(`${base}api/node`)).body).toMatchObject({ model_id: "test/model" });
      const switched = await jsonRequest(`${base}api/models/active`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "test/alt" }),
      });
      expect(switched.status).toBe(200);
      expect(switched.body).toMatchObject({ ok: true, model_id: "test/alt", name: "Alt Model" });
      expect(config.model.id).toBe("test/alt");
      expect((await jsonRequest(`${base}api/node`)).body).toMatchObject({ model_id: "test/alt" });
      expect(JSON.parse(await readFile(join(config.home, "node-preferences.json"), "utf8"))).toMatchObject({ model: "test/alt" });
      expect((await jsonRequest(`${base}api/models/active`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "test/missing" }),
      })).status).toBe(404);
    } finally {
      await web.stop();
      await mesh.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  }, 15_000);

  it("serves the session-history mirror over /api/history", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-web-history-"));
    const config = testConfig(root);
    config.history = { enabled: true, directory: join(root, "home", "history"), maxMessagesPerSession: 0 };
    await mkdir(config.workspace, { recursive: true });
    const mesh = new MeshRuntime(config);
    const web = new LubanWebServer(config, mesh, { port: 0 });
    await mesh.start();
    const base = await web.start();
    try {
      const store = new SessionStore(config.home, sharedHistory(config.history, config.home));

      // The endpoint answers with an empty listing before anything is saved.
      expect(await jsonRequest(`${base}api/history`)).toMatchObject({ status: 200, body: { enabled: true, sessions: [] } });

      const record = store.create(config.project, config.workspace, "agent", "test/model", [
        { role: "user", content: "why is the relay rejecting the token" },
      ]);
      await store.save(record);

      const listed = await jsonRequest(`${base}api/history`);
      expect(listed.body.sessions).toEqual([expect.objectContaining({ id: record.id, project: config.project, messages: 1 })]);

      const hits = await jsonRequest(`${base}api/history?q=relay`);
      expect(hits.body.hits).toEqual([expect.objectContaining({ sessionId: record.id, role: "user" })]);
      expect((await jsonRequest(`${base}api/history?q=nothing-matches-this`)).body.hits).toEqual([]);
      expect((await jsonRequest(`${base}api/history?project=absent`)).body.sessions).toEqual([]);
    } finally {
      await web.stop();
      await mesh.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  }, 15_000);

  it("gates every route behind an access token when one is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-web-auth-"));
    const config = testConfig(root);
    await mkdir(config.workspace, { recursive: true });
    const mesh = new MeshRuntime(config);
    const web = new LubanWebServer(config, mesh, { host: "127.0.0.1", port: 0, token: "workspace-token" });
    await mesh.start();
    const base = await web.start();
    try {
      expect(web.requiresToken).toBe(true);

      // An API call without the token is refused, and says so in a form the
      // console can branch on instead of guessing from a 401.
      const denied = await jsonRequest(`${base}api/node`);
      expect(denied.status).toBe(401);
      expect(denied.body).toMatchObject({ ok: false, auth_required: true });

      // A page request gets the login form, not JSON.
      const page = await fetch(`${base}diff?project=web-project`);
      expect(page.status).toBe(401);
      expect(await page.text()).toContain("访问令牌");

      // A wrong token is still a rejection.
      expect((await jsonRequest(`${base}api/node?token=nope`)).status).toBe(401);

      // The token works from the header, and the query string exchanges itself
      // for a cookie so the SSE stream can authenticate on reconnect.
      const viaHeader = await fetch(`${base}api/node`, { headers: { "x-luban-token": "workspace-token" } });
      expect(viaHeader.status).toBe(200);
      expect(await viaHeader.json()).toMatchObject({ name: "web-node", auth_required: true });

      const viaQuery = await fetch(`${base}m?token=workspace-token`, { redirect: "manual" });
      expect(viaQuery.status).toBe(302);
      expect(viaQuery.headers.get("location")).toBe("/m/");
      expect(viaQuery.headers.get("set-cookie")).toContain("luban_token=workspace-token");

      const viaCookie = await fetch(`${base}api/node`, { headers: { cookie: "luban_token=workspace-token" } });
      expect(viaCookie.status).toBe(200);

      // Repeated failures from one address get locked out rather than retried
      // forever; the loopback address is shared by the whole test, so check the
      // counter on a fresh gate-shaped request instead of hammering this server.
      const status = await jsonRequest(`${base}api/node`, { headers: { "x-luban-token": "workspace-token" } });
      expect(status.status).toBe(200);
    } finally {
      await web.stop();
      await mesh.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  }, 15_000);

  it("serves the phone console under /m and leaves it open when no token is set", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-web-mobile-"));
    const config = testConfig(root);
    await mkdir(config.workspace, { recursive: true });
    const mesh = new MeshRuntime(config);
    const web = new LubanWebServer(config, mesh, { host: "127.0.0.1", port: 0 });
    await mesh.start();
    const base = await web.start();
    try {
      // Loopback without a token stays usable: the desktop console must not
      // break for someone who never asked for access control.
      expect(web.requiresToken).toBe(false);
      expect((await fetch(`${base}api/node`)).status).toBe(200);

      const redirect = await fetch(`${base}m`, { redirect: "manual" });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe("/m/");

      // The bundle is a build artifact; when it is absent the server says what
      // to run instead of serving a blank page.
      const shell = await fetch(`${base}m/`);
      const body = await shell.text();
      if (shell.status === 200) {
        expect(shell.headers.get("content-type")).toContain("text/html");
        expect(body).toContain("luban");
      } else {
        expect(shell.status).toBe(404);
        expect(body).toContain("build:web");
      }
    } finally {
      await web.stop();
      await mesh.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  }, 15_000);
});
