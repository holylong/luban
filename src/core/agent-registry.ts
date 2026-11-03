import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";

/** A runner that is executing right now. Subagents are in-process, so this is
 * the only list of them: they have no PID of their own. */
export interface ActiveAgent {
  id: string;
  depth: number;
  task: string;
  workspace: string;
  mode: string;
  startedAt: number;
  /** Tokens this run has spent so far, summed over every model round-trip. */
  inputTokens: number;
  outputTokens: number;
}

const active = new Map<string, ActiveAgent>();
let publishedHome: string | undefined;
let exitHooked = false;
let lastPublish = 0;
/** Live token counts update often; the file only needs to be roughly current. */
const PUBLISH_INTERVAL_MS = 1_500;

function brief(value: string): string {
  const oneLine = value.replace(/\s+/gu, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
}

/**
 * Every luban process (worker, desktop backend) keeps `~/.luban/agents/<pid>.json`
 * current, so an observer in another process can list live agents and their PID.
 * Writes are fire-and-forget: introspection must never fail a run.
 */
function publish(force = false): void {
  const home = publishedHome;
  if (!home) return;
  const now = Date.now();
  if (!force && now - lastPublish < PUBLISH_INTERVAL_MS) return;
  lastPublish = now;
  const directory = join(home, "agents");
  const path = join(directory, `${process.pid}.json`);
  const body = JSON.stringify({ pid: process.pid, updatedAt: Date.now(), agents: activeAgents() });
  void (async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, path);
  })().catch(() => undefined);
  if (exitHooked) return;
  exitHooked = true;
  process.once("exit", () => {
    const target = publishedHome;
    if (!target) return;
    try { rmSync(join(target, "agents", `${process.pid}.json`), { force: true }); } catch { /* leftover files are ignored by readers */ }
  });
}

export function registerAgent(input: Omit<ActiveAgent, "id" | "startedAt" | "inputTokens" | "outputTokens"> & { id?: string; home?: string }): string {
  if (input.home) publishedHome = input.home;
  const id = input.id ?? randomUUID();
  active.set(id, {
    id, depth: input.depth, task: brief(input.task), workspace: input.workspace,
    mode: input.mode, startedAt: Date.now(), inputTokens: 0, outputTokens: 0,
  });
  publish(true);
  return id;
}

export function finishAgent(id: string): void {
  if (active.delete(id)) publish(true);
}

/** Accumulate one model round-trip's usage onto the running agent. */
export function updateAgentUsage(id: string | undefined, usage: { input?: number; output?: number }): void {
  if (!id) return;
  const agent = active.get(id);
  if (!agent) return;
  agent.inputTokens += Math.max(0, Number(usage.input) || 0);
  agent.outputTokens += Math.max(0, Number(usage.output) || 0);
  publish();
}

/** Oldest first so a parent always appears before the subagents it started. */
export function activeAgents(): ActiveAgent[] {
  return [...active.values()].sort((a, b) => a.startedAt - b.startedAt || a.depth - b.depth);
}
