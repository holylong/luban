import { basename } from "node:path";
import { AgentRunner, initialMessages } from "../agent.js";
import { SessionStore } from "../session-store.js";
import { sharedHistory } from "../session-history.js";
import { summarizeToolArgs } from "../tools.js";
import type { AgentEvent, LubanConfig, ToolDefinition } from "../types.js";
import type { JobStreamEvent, MeshRuntime } from "./runtime.js";

/** Translate a raw agent event into the transport shape used by every remote UI. */
export function toJobStreamEvent(event: AgentEvent): JobStreamEvent | null {
  switch (event.type) {
    case "status": return { kind: "status", text: event.text, ...(event.progress ? { progress: true } : {}) };
    case "model-call": return { kind: "model-call", index: event.index };
    case "delta": return { kind: "delta", text: event.text };
    case "thinking-delta": return { kind: "thinking", text: event.text };
    case "thought": return { kind: "thinking", text: event.text };
    case "tool-start": return {
      kind: "tool-start", callId: event.id, name: event.name, args: event.args,
      summary: summarizeToolArgs(event.name, event.args),
    };
    case "tool-end": return {
      kind: "tool-end", callId: event.id, name: event.name, ok: event.ok,
      elapsedMs: event.elapsedMs, preview: event.preview,
      ...(event.editPreview ? { editPreview: event.editPreview } : {}),
    };
    case "usage": return { kind: "usage", input: event.input, output: event.output };
    case "error": return { kind: "error", text: event.text };
    default: return null;
  }
}

export interface RemoteJobOptions {
  /** Resolve interactive approval for a web-driven job. Omitting it keeps always-allow. */
  approve?: (tool: ToolDefinition, args: Record<string, unknown>, jobId: string) => Promise<"once" | "tool" | "always" | "deny">;
  /**
   * Whether a live client is waiting to answer prompts for this job. When it
   * returns false the job runs unattended and never blocks on approval.
   */
  isInteractive?: (jobId: string) => boolean;
  /** Permission mode requested by the client that submitted the job. */
  modeFor?: (jobId: string) => "edits" | "agent" | "read";
}

/** Persist remote turns independently of public job logs and result summaries. */
export function configureRemoteJobs(mesh: MeshRuntime, config: LubanConfig,
  createRunner = (settings: LubanConfig) => new AgentRunner(settings, undefined, mesh),
  options: RemoteJobOptions = {}): void {
  mesh.setJobRunner(async (job, signal, onLog, onEvent) => {
    const settings: LubanConfig = { ...config, workspace: job.workspace,
      project: job.project_id || basename(job.workspace) };
    const store = new SessionStore(config.home, sharedHistory(config.history, config.home));
    let session = job.session_id ? await store.load(job.session_id, settings.project, settings.workspace) : undefined;
    if ((job.resume_count || 0) > 0 && !session) throw new Error("Cannot resume: saved task history is missing; inspect the workspace before starting a new task.");
    if (!session) {
      session = store.create(settings.project, settings.workspace, "agent", settings.model.id,
        [...initialMessages(settings.workspace, settings.model.name, settings.planning), { role: "user", content: job.instruction }]);
      await store.save(session);
      await mesh.store.update(job.id, { session_id: session.id });
    }
    if (job.resume_count) {
      const marker = `resume-${job.resume_count}`;
      if (!session.messages.some(message => message.role === "user" && message.name === marker)) {
        session.messages.push({ role: "user", name: marker, content: "继续完成原任务。根据已保存的工具结果接着执行，先检查不确定的状态，不要重复已完成的操作。" });
      }
    }
    // Options are static for a runtime, but interactivity is per job: in the
    // daemon the CLI answers `approve` for every job yet only registers a job
    // as interactive when a browser asked for it. `approve` is only consulted
    // for tools that are not auto-allowed, so a job nobody is watching must
    // keep the historical always-allow behaviour instead of blocking forever.
    const interactive = Boolean(options.isInteractive?.(job.id)) && Boolean(options.approve);
    // An interactive job starts in `edits` so file writes flow and only shell
    // or network tools prompt the browser. An explicit "agent" mode asks before
    // every write. "read" selects ASK, whose read-only rule the runtime itself
    // enforces regardless of what the approval handler answers.
    const requested = options.modeFor?.(job.id) ?? "edits";
    const runnerConfig: LubanConfig = requested === "read"
      ? { ...settings, permissionMode: "ask", permissions: { ...(config.permissions ?? { allow: [], deny: [] }), allow: [] } }
      : { ...settings, permissionMode: interactive && requested === "agent" ? "ask" : settings.permissionMode };
    const runner = createRunner(runnerConfig);
    try {
      await store.save(session);
      const result = await runner.run(session.messages, "agent", signal, event => {
        // Progress labels belong to the live indicator, not the bounded job log
        // or the event stream's history: once per step they displaced the
        // tool/error lines the log exists to keep.
        if (event.type === "status" && !event.progress) onLog("info", event.text);
        if (event.type === "tool-start") onLog("tool", `${event.name}: ${JSON.stringify(event.args).slice(0, 600)}`);
        if (event.type === "tool-end") onLog(event.ok ? "tool" : "error", `${event.name} ${event.ok ? "done" : "failed"}`);
        if (event.type === "error") onLog("error", event.text);
        const structured = toJobStreamEvent(event);
        if (structured) onEvent?.(structured);
      }, async (tool, args) => {
        if (!options.approve) return "always";
        return options.approve(tool, args, job.id);
      }, () => store.save(session));
      return { ok: result.ok, text: result.text, stopReason: result.stopReason };
    } finally { runner.close(); }
  });
}
