/* The always-on backend: one per machine, started by whatever luban runs first.
 *
 * A terminal TUI and a desktop window both die with their process, so a phone
 * that opens luban an hour later finds nothing listening. The daemon is the
 * answer to "is there a luban running on this machine": a detached
 * `luban web … --daemon-child` that owns the relay slot, keeps serving every
 * registered project, and outlives whichever window or terminal started it.
 *
 * State lives in `~/.luban/daemon/state.json` (0600) so a second luban — and
 * the desktop app — can find the port and token instead of guessing. The lock
 * is directory creation, which is atomic on every platform this ships on.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { compiledCliEntry } from "../core/cli-entry.js";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DaemonState {
  /** Process that serves the HTTP API; useless once it is gone. */
  pid: number;
  /** Loopback port actually bound (never 0). */
  port: number;
  /** Bearer token every caller has to present. */
  token: string;
  /** The workspace the daemon was born in; others are registered projects. */
  workspace: string;
  /** Interface it bound: 0.0.0.0 means the phone can dial this machine by IP. */
  host: string;
  startedAt: number;
  version: string;
}

export interface DaemonPaths {
  dir: string;
  state: string;
  log: string;
  lock: string;
}

export function daemonPaths(home: string): DaemonPaths {
  const dir = join(home, "daemon");
  return { dir, state: join(dir, "state.json"), log: join(dir, "daemon.log"), lock: join(dir, "ensure.lock") };
}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The state file is the only hand-off between processes, so it is validated. */
export function readDaemonState(home: string): DaemonState | undefined {
  try {
    const raw = JSON.parse(readFileSync(daemonPaths(home).state, "utf8")) as Partial<DaemonState>;
    if (!Number.isInteger(raw.pid) || !raw.pid || raw.pid <= 0) return undefined;
    if (!Number.isInteger(raw.port) || !raw.port || raw.port <= 0) return undefined;
    if (typeof raw.token !== "string" || raw.token.length < 8) return undefined;
    return {
      pid: raw.pid,
      port: raw.port,
      token: raw.token,
      workspace: typeof raw.workspace === "string" ? raw.workspace : "",
      host: typeof raw.host === "string" ? raw.host : "127.0.0.1",
      startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
      version: typeof raw.version === "string" ? raw.version : "",
    };
  } catch {
    return undefined;
  }
}

/** Written by the child, read by everybody else: never world-readable. */
export function writeDaemonState(home: string, state: DaemonState): void {
  const paths = daemonPaths(home);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const temporary = `${paths.state}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temporary, paths.state);
}

export function clearDaemonState(home: string): void {
  try { rmSync(daemonPaths(home).state, { force: true }); } catch { /* already gone */ }
}

/**
 * Remove the state file only if it still describes this process.
 *
 * A daemon that is shutting down must not delete the state file of the daemon
 * that replaced it, or the phone loses the working address of a live server.
 */
export function clearDaemonStateIfOwner(home: string, pid: number): boolean {
  const state = readDaemonState(home);
  if (!state || state.pid !== pid) return false;
  clearDaemonState(home);
  return true;
}

export function daemonUrl(state: Pick<DaemonState, "port">): string {
  return `http://127.0.0.1:${state.port}/`;
}

/** A live pid is not the same as a working server: ask it, with the token. */
export async function probeDaemon(
  state: DaemonState,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  if (!processAlive(state.pid)) return false;
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${daemonUrl(state)}healthz`, {
      headers: { authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 1500),
    });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: boolean };
    return body?.ok === true;
  } catch {
    return false;
  }
}

/** The command a detached child has to be: the compiled CLI, never a dev loader. */
export function daemonEntry(argv1: string | undefined = process.argv[1]): string {
  // `luban` is normally a symlink to dist/cli.js, so the resolver follows the
  // link before judging the name: `…/bin/luban` is the CLI, not a dev loader.
  const entry = compiledCliEntry(argv1);
  if (entry) return entry;
  throw new Error("常驻服务需要编译后的 CLI（dist/cli.js）：先 npm run build，或运行 luban daemon --help");
}

export interface DaemonInfo {
  version?: string;
  workspace?: string;
  project?: string;
  model?: string;
  projects: Record<string, string>;
}

/** What the daemon says about itself: used by `luban daemon status`. */
export async function daemonInfo(
  state: DaemonState,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<DaemonInfo | undefined> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${daemonUrl(state)}api/node`, {
      headers: { authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as Partial<DaemonInfo>;
    return {
      version: typeof body.version === "string" ? body.version : undefined,
      workspace: typeof body.workspace === "string" ? body.workspace : undefined,
      project: typeof body.project === "string" ? body.project : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      projects: body.projects && typeof body.projects === "object" ? body.projects : {},
    };
  } catch {
    return undefined;
  }
}

/** Register a directory as a project so the phone can list and open it. */
export async function registerDaemonProject(
  state: DaemonState,
  workspace: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${daemonUrl(state)}api/projects`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: workspace }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 4000),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { project?: string };
    return body.project;
  } catch {
    return undefined;
  }
}

export interface EnsureDaemonOptions {
  /** Directory the daemon is born in; later callers add theirs as projects. */
  workspace: string;
  version: string;
  /** Injected by tests; the real call uses process.execPath + daemonEntry(). */
  execPath?: string;
  entry?: string;
  token?: string;
  /** Default 0.0.0.0: this backend exists so a phone can dial the machine. */
  host?: string;
  /** Default 8642: the phone keeps one address, so the port cannot be random. */
  port?: number;
  timeoutMs?: number;
  spawnImpl?: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;
  probe?: (state: DaemonState) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  /** Told when this call spawned the daemon, for one startup line. */
  log?: (message: string) => void;
}

export interface EnsureDaemonResult {
  state: DaemonState;
  /** True when this call is the one that started it. */
  started: boolean;
}

async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs: number, intervalMs = 150): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) return undefined;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/**
 * Make sure one backend is listening, starting it detached if not.
 *
 * Reuses a healthy daemon even when it was born in another directory (that is
 * the point: one machine, one entry), and registers the caller's workspace so
 * the phone lists it.
 */
export async function ensureDaemon(home: string, options: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
  const paths = daemonPaths(home);
  const probe = options.probe ?? ((state: DaemonState) => probeDaemon(state, { fetchImpl: options.fetchImpl }));
  const reuse = async (state: DaemonState): Promise<EnsureDaemonResult> => {
    if (options.workspace && state.workspace !== options.workspace) {
      await registerDaemonProject(state, options.workspace, { fetchImpl: options.fetchImpl });
    }
    return { state, started: false };
  };
  const existing = readDaemonState(home);
  if (existing && await probe(existing)) return reuse(existing);
  if (existing) clearDaemonState(home);

  // Another process may be starting one right now; mkdir is the mutex.
  let ownsLock = false;
  try {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.lock);
    ownsLock = true;
  } catch {
    // A stale lock (crash between mkdir and rmdir) must not block forever.
    try {
      if (Date.now() - statSync(paths.lock).mtimeMs > 30_000) { rmSync(paths.lock, { recursive: true, force: true }); mkdirSync(paths.lock); ownsLock = true; }
    } catch { /* somebody else won the lock */ }
  }
  if (!ownsLock) {
    const state = await waitFor(async () => {
      const candidate = readDaemonState(home);
      return candidate && await probe(candidate) ? candidate : undefined;
    }, options.timeoutMs ?? 20_000);
    if (!state) throw new Error("另一个进程正在启动常驻服务，但没有在预期时间内就绪");
    return reuse(state);
  }

  try {
    const token = options.token ?? (await import("node:crypto")).randomBytes(32).toString("base64url");
    const command = options.execPath ?? process.execPath;
    const spawnImpl = options.spawnImpl ?? spawn;
    const logFd = openSync(paths.log, "a");
    let child: ChildProcess;
    try {
      child = spawnImpl(command, [
        options.entry ?? daemonEntry(), "web", options.workspace,
        "--host", options.host ?? process.env.LUBAN_DAEMON_HOST ?? "0.0.0.0",
        "--port", String(options.port ?? (process.env.LUBAN_DAEMON_PORT ? Number(process.env.LUBAN_DAEMON_PORT) : 8642)),
        "--no-mesh", "--daemon-child", "--remote",
      ], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        cwd: options.workspace,
        env: { ...process.env, LUBAN_HOME: home, LUBAN_WEB_TOKEN: token },
      });
    } finally {
      closeSync(logFd);
    }
    child.unref?.();
    options.log?.(`常驻服务已启动（pid ${child.pid ?? "?"}），日志 ${paths.log}`);
    const state = await waitFor(async () => {
      const candidate = readDaemonState(home);
      if (!candidate) return undefined;
      return await probe(candidate) ? candidate : undefined;
    }, options.timeoutMs ?? 20_000);
    if (!state) {
      try { child.kill("SIGTERM"); } catch { /* it may never have started */ }
      throw new Error(`常驻服务没有在预期时间内就绪，看日志：${paths.log}`);
    }
    return { state, started: true };
  } finally {
    rmSync(paths.lock, { recursive: true, force: true });
  }
}

/** Stop the daemon and forget its state; safe when nothing is running. */
export async function stopDaemon(home: string, options: { timeoutMs?: number } = {}): Promise<boolean> {
  const state = readDaemonState(home);
  if (!state) { clearDaemonState(home); return false; }
  if (!processAlive(state.pid)) { clearDaemonState(home); return false; }
  try { process.kill(state.pid, "SIGTERM"); } catch { /* raced with exit */ }
  const gone = await waitFor(async () => (processAlive(state.pid) ? undefined : true), options.timeoutMs ?? 5_000, 100);
  if (!gone) {
    try { process.kill(state.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  clearDaemonState(home);
  return true;
}

/** The last lines of the daemon log, for `luban daemon logs`. */
export function daemonLogTail(home: string, lines = 60): string {
  try {
    const text = readFileSync(daemonPaths(home).log, "utf8");
    return text.trimEnd().split("\n").slice(-Math.max(1, lines)).join("\n");
  } catch {
    return "";
  }
}
