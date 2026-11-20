import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface BotTask {
  id: string;
  prompt: string;
  workspace: string;
  model?: string;
  at: number;
  every?: number;
  timeout: number;
  /**
   * What fires at that time. `agent` runs the usual model task; `notify` only
   * shows a desktop notification, which is what a reminder actually is — a
   * 5-minute alarm should never spend a model call to say "下班了".
   */
  kind?: "agent" | "notify";
}
export interface BotState {
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  nextAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: string;
  /** Tokens this execution spent, summed over every model round-trip. */
  usage?: { input: number; output: number; calls: number };
  /**
   * The transcript this execution wrote (a SessionStore id). Without it the only
   * way back into a finished run's context is the `Session: <id>` line buried in
   * `result`, which a human reads as prose and a reworded answer would erase.
   */
  session?: string;
}
export type BotExecute = (task: BotTask, signal: AbortSignal) => Promise<{ ok: boolean; text: string; usage?: BotState["usage"]; session?: string }>;

/**
 * One execution, kept after the task moves on.
 *
 * `state.json` only remembers the newest run, which is useless for a repeating
 * task — "did the 6:00 scan actually run, and what did it find?" needs the whole
 * series. Every finished execution is therefore appended to `runs.jsonl`.
 */
export interface BotRun {
  /** When the execution started. */
  from: number;
  /** When it finished. */
  to: number;
  status: BotState["status"];
  /** Deadline of the next execution (`every` tasks) or the end of the series. */
  nextAt: number;
  usage?: BotState["usage"];
  result?: string;
  /** Transcript written by this run; the way back into its context. */
  session?: string;
}

async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}

/** The mutable half of a task: everything but its id and creation stamp. */
export type BotTaskPatch = Partial<Pick<BotTask, "prompt" | "workspace" | "model" | "at" | "timeout" | "kind">> & {
  /** `null` turns a repeating task back into a one-off; `undefined` leaves it. */
  every?: number | null;
};

function validateTask(task: Pick<BotTask, "prompt" | "at" | "timeout" | "every" | "kind">): void {
  if (!task.prompt.trim()) throw new Error("Task prompt cannot be empty");
  if (task.kind !== undefined && task.kind !== "agent" && task.kind !== "notify") throw new Error("Invalid task kind");
  if (!Number.isFinite(task.at) || !Number.isFinite(task.timeout) || task.timeout < 1000
    || (task.every !== undefined && (!Number.isFinite(task.every) || task.every < 60_000))) {
    throw new Error("Invalid schedule: timeout >= 1s, repeat interval >= 60s required");
  }
}

/** Immutable requests and separate state avoid lost updates between submitters and worker. */
export class BotQueue {
  readonly directory: string;
  constructor(home: string) { this.directory = join(home, "bot", "tasks"); }
  path(id: string, file: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid bot task id");
    return join(this.directory, id, file);
  }
  async add(input: Omit<BotTask, "id">): Promise<BotTask> {
    validateTask(input);
    const task = { ...input, workspace: resolve(input.workspace), id: randomUUID() };
    await mkdir(join(this.directory, task.id), { recursive: true, mode: 0o700 });
    await atomicJson(this.path(task.id, "request.json"), task);
    return task;
  }

  /**
   * Rewrite what a task asks for, and put it back in the queue.
   *
   * Editing is the difference between "this job is wrong" and "book another job
   * beside it": a nightly scan whose wording drifted should keep its history, so
   * `request.json` is replaced in place and only the pending state is reset. A
   * running execution is refused rather than raced — its work is already under
   * way, and the worker captured the old prompt when it started.
   */
  async edit(id: string, patch: BotTaskPatch): Promise<BotTask> {
    const requestPath = this.path(id, "request.json");
    const current = JSON.parse(await readFile(requestPath, "utf8")) as BotTask;
    let state: BotState = { status: "queued", nextAt: current.at };
    try { state = JSON.parse(await readFile(this.path(id, "state.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (state.status === "running") throw new Error("Task is running; cancel it or wait for this execution to finish before editing");
    const next: BotTask = { ...current };
    if (patch.prompt !== undefined) next.prompt = patch.prompt;
    if (patch.workspace !== undefined) next.workspace = resolve(patch.workspace);
    if (patch.model !== undefined) next.model = patch.model ?? undefined;
    if (patch.at !== undefined) next.at = patch.at;
    if (patch.timeout !== undefined) next.timeout = patch.timeout;
    if (patch.kind !== undefined) next.kind = patch.kind;
    if (patch.every !== undefined) {
      if (patch.every === null) delete next.every;
      else next.every = patch.every;
    }
    validateTask(next);
    await atomicJson(requestPath, next);
    // A cancelled task that is edited is being brought back, so the marker goes.
    await rm(this.path(id, "cancel"), { force: true });
    const nextAt = patch.at ?? (state.status === "completed" || state.status === "failed" ? next.at : state.nextAt);
    await this.save(id, { status: "queued", nextAt });
    return next;
  }
  async list(): Promise<Array<{ task: BotTask; state: BotState }>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const rows = [];
    for (const id of await readdir(this.directory)) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      let task: BotTask;
      try { task = JSON.parse(await readFile(this.path(id, "request.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      let state: BotState = { status: "queued", nextAt: task.at };
      try { state = JSON.parse(await readFile(this.path(id, "state.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (await this.cancelled(id)) state = { ...state, status: "cancelled" };
      rows.push({ task, state });
    }
    return rows.sort((a, b) => a.task.at - b.task.at);
  }
  async cancelled(id: string): Promise<boolean> {
    try { await readFile(this.path(id, "cancel")); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async cancel(id: string) {
    await readFile(this.path(id, "request.json"));
    await writeFile(this.path(id, "cancel"), "cancelled", { mode: 0o600 });
  }
  async save(id: string, state: BotState) { await atomicJson(this.path(id, "state.json"), state); }

  /** Append one finished execution. Rotated at 1 MB so a long-lived task cannot grow forever. */
  async appendRun(id: string, state: BotState): Promise<void> {
    const path = this.path(id, "runs.jsonl");
    try { if ((await stat(path)).size > 1_000_000) await rename(path, this.path(id, "runs.1.jsonl")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const run: BotRun = {
      from: state.startedAt ?? state.finishedAt ?? Date.now(),
      to: state.finishedAt ?? Date.now(),
      status: state.status,
      nextAt: state.nextAt,
      ...(state.usage ? { usage: state.usage } : {}),
      ...(state.result ? { result: state.result } : {}),
      ...(state.session ? { session: state.session } : {}),
    };
    await appendFile(path, `${JSON.stringify(run)}\n`, { mode: 0o600 });
  }

  /** Newest run last; unreadable lines are skipped rather than failing the whole view. */
  async history(id: string, limit = 50): Promise<BotRun[]> {
    let text: string;
    try { text = await readFile(this.path(id, "runs.jsonl"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const runs: BotRun[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { runs.push(JSON.parse(line)); } catch { /* a half-written tail line is not fatal */ }
    }
    return runs.slice(-limit);
  }

  /** Interrupted work is never automatically replayed: it may already have side effects. */
  async recover() {
    for (const { task, state } of await this.list()) {
      if (state.status !== "running") continue;
      const interrupted: BotState = { ...state, status: "interrupted", finishedAt: Date.now(), result: "Worker stopped during execution; submit a new task after checking side effects." };
      await this.save(task.id, interrupted);
      await this.appendRun(task.id, interrupted);
    }
  }
  async tick(execute: BotExecute, shutdown: AbortSignal, now = Date.now()) {
    for (const { task, state } of await this.list()) {
      if (shutdown.aborted) break;
      if (state.status !== "queued" || state.nextAt > now) continue;
      const controller = new AbortController();
      const abort = () => controller.abort(new Error("Bot stopping"));
      shutdown.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error("Task timeout")), task.timeout);
      const cancelTimer = setInterval(() => {
        void this.cancelled(task.id).then(cancelled => { if (cancelled) controller.abort(new Error("Task cancelled")); }).catch(() => controller.abort());
      }, 250);
      await this.save(task.id, { ...state, status: "running", startedAt: Date.now() });
      let finished: BotState;
      try {
        const result = await execute(task, controller.signal);
        const cancelled = await this.cancelled(task.id);
        const interrupted = shutdown.aborted;
        finished = {
          status: cancelled ? "cancelled" : interrupted ? "interrupted" : controller.signal.aborted ? "failed" : result.ok && task.every ? "queued" : result.ok ? "completed" : "failed",
          nextAt: Date.now() + (task.every ?? 0), startedAt: now, finishedAt: Date.now(),
          result: controller.signal.aborted ? String(controller.signal.reason) : result.text,
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.session ? { session: result.session } : {}),
        };
      } catch (error) {
        finished = { ...state, status: await this.cancelled(task.id) ? "cancelled" : shutdown.aborted ? "interrupted" : "failed", finishedAt: Date.now(), result: String(error) };
      } finally {
        clearTimeout(timer); clearInterval(cancelTimer);
        shutdown.removeEventListener("abort", abort);
      }
      // State first, history second: a crash between them loses one line, never state.
      await this.save(task.id, finished);
      await this.appendRun(task.id, finished);
    }
  }
}
