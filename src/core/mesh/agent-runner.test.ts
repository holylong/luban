import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../agent.js";
import { SessionStore } from "../session-store.js";
import { liveSessions } from "../live-session.js";
import type { ChatMessage, AgentEvent } from "../types.js";
import { sharedHistory } from "../session-history.js";
import type { LubanConfig } from "../types.js";
import { configureRemoteJobs, toJobStreamEvent } from "./agent-runner.js";
import type { MeshJob } from "./job-store.js";
import type { MeshRuntime } from "./runtime.js";

describe("toJobStreamEvent", () => {
  it("carries the progress mark so a remote surface does not record a phase label", () => {
    // The tool loop re-announces this once per step. Without the mark crossing
    // the transport, the remote terminal and the browser console rebuilt the
    // same wall of duplicate rows a local run used to show.
    expect(toJobStreamEvent({ type: "status", text: "Reviewing tool results", progress: true }))
      .toEqual({ kind: "status", text: "Reviewing tool results", progress: true });
  });

  it("leaves a real notice unmarked so it stays in the record", () => {
    expect(toJobStreamEvent({ type: "status", text: "Compacted 12 older messages" }))
      .toEqual({ kind: "status", text: "Compacted 12 older messages" });
  });
});

function titleConfig(root: string): LubanConfig {
  const workspace = join(root, "workspace");
  const model = { id: "test/model", provider: "test", model: "model", name: "Test Model", baseUrl: "http://127.0.0.1", apiKey: "" };
  return {
    home: join(root, "home"), workspace, project: "p", model, models: [model],
    maxTokens: 1000, temperature: 0, timeoutMs: 5_000, maxSteps: 5,
    backendUrl: "", permissionMode: "allow",
    mesh: {
      enabled: false, nodeName: "n", host: "127.0.0.1", port: 0, udpPort: 0,
      capabilities: [], contacts: [], token: "", syncMode: "chunk", chunkSize: 1024,
      syncIgnore: [], conflictPolicy: "auto",
      jobsDir: join(root, "home", "jobs"), workspacesDir: join(root, "home", "workspaces"),
      projects: {}, maxWorkers: 1, jobTimeoutSeconds: 30, queueTimeoutSeconds: 30,
    },
  };
}

/** Runs one job through the shared job runner and returns the saved session id. */
async function runJob(root: string, instruction: string, suggestTitle: () => Promise<{ title?: string; input: number; output: number } | undefined>) {
  const config = titleConfig(root);
  mkdirSync(config.workspace, { recursive: true });
  let handler: ((job: MeshJob, signal: AbortSignal, onLog: (...args: never[]) => void, onEvent: (...args: never[]) => void) => Promise<unknown>) | undefined;
  let sessionId = "";
  const mesh = {
    setJobRunner: (fn: typeof handler) => { handler = fn; },
    store: { update: async (_id: string, patch: { session_id?: string }) => { if (patch.session_id) sessionId = patch.session_id; } },
  } as unknown as MeshRuntime;
  const close = vi.fn();
  configureRemoteJobs(mesh, config, () => ({
    run: async () => ({ ok: true, text: "done", metrics: {} }),
    suggestTitle,
    close,
  }) as unknown as AgentRunner);
  const job = {
    id: "job-1", project_id: "p", workspace: config.workspace, instruction, title: "",
    status: "working", created_at: 1, updated_at: 1, logs: [],
  } as unknown as MeshJob;
  await handler!(job, new AbortController().signal, () => {}, () => {});
  const store = new SessionStore(config.home, sharedHistory(config.history, config.home));
  return { store, sessionId, close, config };
}

async function waitForTitle(load: () => Promise<{ title: string; titleSource?: string } | undefined>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const record = await load();
    if (record?.titleSource === "model") return record;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("Timed out waiting for a model title");
}

describe("remote session execution", () => {
  it("publishes checkpoints and preserves failed continuation history on retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "luban-remote-history-"));
    const config = titleConfig(root);
    mkdirSync(config.workspace, { recursive: true });
    const store = new SessionStore(config.home, sharedHistory(config.history, config.home));
    const session = store.create(config.project, config.workspace, "agent", config.model.id, [{ role: "user", content: "original" }]);
    await store.save(session);
    let handler: Parameters<MeshRuntime["setJobRunner"]>[0] | undefined;
    const mesh = { setJobRunner: (fn: typeof handler) => { handler = fn; }, store: { update: vi.fn() } } as unknown as MeshRuntime;
    let attempt = 0;
    configureRemoteJobs(mesh, config, () => ({
      run: async (messages: ChatMessage[], _mode: string, _signal: AbortSignal, emit: (event: AgentEvent) => void) => {
        expect(messages.filter(message => message.content === "continuation")).toHaveLength(1);
        expect(liveSessions.get(config.home, session.project, session.id)).toMatchObject({ running: true, jobId: "same-job" });
        emit({ type: "delta", text: "streaming" });
        expect(liveSessions.get(config.home, session.project, session.id)?.events).toHaveLength(1);
        messages.push({ role: "assistant", content: `saved-${attempt}` });
        emit({ type: "model-call", index: 2 });
        const snapshot = liveSessions.get(config.home, session.project, session.id)!;
        expect(snapshot.session.messages).toEqual(messages);
        expect(snapshot.events).toHaveLength(1);
        if (attempt++ === 0) throw new Error("upstream failed");
        return { ok: true, text: "done", metrics: {} };
      },
      suggestTitle: async () => undefined, close: vi.fn(),
    }) as unknown as AgentRunner);
    const job = { id: "same-job", project_id: config.project, workspace: config.workspace, instruction: "continuation", session_id: session.id, continues_session: true } as MeshJob;
    try {
      await expect(handler!(job, new AbortController().signal, () => {})).rejects.toThrow("upstream failed");
      expect(liveSessions.get(config.home, session.project, session.id)?.running).toBe(false);
      expect((await store.load(session.id, config.project, config.workspace))?.messages.at(-1)?.content).toBe("saved-0");
      await handler!({ ...job, resume_count: 1 }, new AbortController().signal, () => {});
      const saved = await store.load(session.id, config.project, config.workspace);
      expect(saved?.messages.filter(message => message.name === "resume-1")).toHaveLength(1);
      expect(saved?.messages.some(message => message.content === "saved-0")).toBe(true);
      expect(saved?.messages.at(-1)?.content).toBe("saved-1");
    } finally {
      liveSessions.remove(config.home, session.project, session.id);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("job session titles", () => {
  it("replaces the first-line placeholder with the model's topic title", async () => {
    const root = mkdtempSync(join(tmpdir(), "luban-title-"));
    try {
      const { store, sessionId, config } = await runJob(root, "继续", async () => ({ title: "修复登录跳转", input: 5, output: 2 }));
      const record = await waitForTitle(() => store.load(sessionId, config.project, config.workspace));
      expect(record.title).toBe("修复登录跳转");
      expect(record.titleSource).toBe("model");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps the placeholder and closes the naming runner when the model cannot name", async () => {
    const root = mkdtempSync(join(tmpdir(), "luban-title-"));
    try {
      const { store, sessionId, close, config } = await runJob(root, "把登录页的跳转修好", async () => undefined);
      await new Promise((resolveWait) => setTimeout(resolveWait, 120));
      const record = await store.load(sessionId, config.project, config.workspace);
      expect(record?.title).toBe("把登录页的跳转修好");
      expect(record?.titleSource).toBe("auto");
      expect(close).toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
