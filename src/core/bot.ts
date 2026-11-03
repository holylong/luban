import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface BotTask {
  id: string;
  prompt: string;
  workspace: string;
  model?: string;
  at: number;
  every?: number;
  timeout: number;
}
export interface BotState {
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  nextAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: string;
  /** Tokens this execution spent, summed over every model round-trip. */
  usage?: { input: number; output: number; calls: number };
}
export type BotExecute = (task: BotTask, signal: AbortSignal) => Promise<{ ok: boolean; text: string; usage?: BotState["usage"] }>;

async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, path);
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
    if (!input.prompt.trim()) throw new Error("Task prompt cannot be empty");
    if (!Number.isFinite(input.at) || !Number.isFinite(input.timeout) || input.timeout < 1000
      || (input.every !== undefined && (!Number.isFinite(input.every) || input.every < 60_000))) {
      throw new Error("Invalid schedule: timeout >= 1s, repeat interval >= 60s required");
    }
    const task = { ...input, workspace: resolve(input.workspace), id: randomUUID() };
    await mkdir(join(this.directory, task.id), { recursive: true, mode: 0o700 });
    await atomicJson(this.path(task.id, "request.json"), task);
    return task;
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

  /** Interrupted work is never automatically replayed: it may already have side effects. */
  async recover() {
    for (const { task, state } of await this.list()) {
      if (state.status === "running") await this.save(task.id, { ...state, status: "interrupted", finishedAt: Date.now(), result: "Worker stopped during execution; submit a new task after checking side effects." });
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
      try {
        const result = await execute(task, controller.signal);
        const cancelled = await this.cancelled(task.id);
        const interrupted = shutdown.aborted;
        await this.save(task.id, {
          status: cancelled ? "cancelled" : interrupted ? "interrupted" : controller.signal.aborted ? "failed" : result.ok && task.every ? "queued" : result.ok ? "completed" : "failed",
          nextAt: Date.now() + (task.every ?? 0), startedAt: now, finishedAt: Date.now(),
          result: controller.signal.aborted ? String(controller.signal.reason) : result.text,
          ...(result.usage ? { usage: result.usage } : {}),
        });
      } catch (error) {
        await this.save(task.id, { ...state, status: await this.cancelled(task.id) ? "cancelled" : shutdown.aborted ? "interrupted" : "failed", finishedAt: Date.now(), result: String(error) });
      } finally {
        clearTimeout(timer); clearInterval(cancelTimer);
        shutdown.removeEventListener("abort", abort);
      }
    }
  }
}
