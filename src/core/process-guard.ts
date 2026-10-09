/**
 * Keeps one failed background task from killing a long-lived node.
 *
 * Node's default for an unhandled rejection is to terminate the process. luban
 * runs a mesh node and a web server inside one process, so a single background
 * promise that rejects — a workspace scan hitting an unreadable directory, an SSE
 * client that disconnects mid-write — takes down the whole node. Peers then see
 * the port change on every restart and report ECONNREFUSED.
 *
 * This installs a process-level handler that reports the failure and keeps
 * running. It deliberately does not swallow the error: the rejection is still
 * logged, and any caller that awaited its own promise still sees the throw. The
 * handler is only reached when nobody else claimed the rejection.
 */
import process from "node:process";

const INSTALLED = Symbol.for("luban.processGuard");

function describe(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  try {
    return `non-Error rejection: ${JSON.stringify(error)}`;
  } catch {
    return `non-Error rejection: ${String(error)}`;
  }
}

export interface ProcessGuardOptions {
  /** Label used in the diagnostic line, e.g. "mesh node" or "web server". */
  readonly label?: string;
  /** Sink for diagnostics. Defaults to stderr; tests inject a collector. */
  readonly report?: (message: string) => void;
  /** Cap on retained messages, so a rejection storm cannot grow without limit. */
  readonly history?: number;
}

export interface ProcessGuard {
  /** Messages seen so far, newest last. Bounded by `history`. */
  readonly messages: readonly string[];
  /**
   * Uninstall the guard. Idempotent, and reachable from any handle: this always
   * removes the live installation, so a caller that received a handle from a
   * second (already-installed) call can still tear the guard down. That matters
   * for tests and for teardown paths that must not strand a live handler.
   */
  restore(): void;
}

interface GuardState {
  installed: boolean;
  messages: string[];
  unhandled?: (error: unknown) => void;
  uncaught?: (error: unknown, origin?: string) => void;
}

function state(): GuardState {
  const holder = process as unknown as Record<symbol, GuardState | undefined>;
  return (holder[INSTALLED] ??= { installed: false, messages: [] });
}

function restore(): void {
  const active = state();
  if (!active.installed) return;
  if (active.unhandled) process.off("unhandledRejection", active.unhandled);
  if (active.uncaught) process.off("uncaughtException", active.uncaught);
  active.unhandled = undefined;
  active.uncaught = undefined;
  active.installed = false;
}

/**
 * Install the guard. Repeated calls return a handle over the same installation
 * rather than stacking duplicate listeners, so a process that builds several
 * subsystems cannot end up reporting every failure twice.
 */
export function installProcessGuard(options: ProcessGuardOptions = {}): ProcessGuard {
  const active = state();
  const handle: ProcessGuard = { messages: active.messages, restore };
  if (active.installed) return handle;

  const label = options.label ?? "luban";
  const report = options.report ?? ((message: string) => { process.stderr.write(message); });
  const limit = Math.max(1, options.history ?? 20);
  active.installed = true;
  // Clear in place: the handle handed to a second caller aliases this array, so
  // replacing it would leave that handle observing a stale, empty list.
  active.messages.length = 0;

  const note = (kind: string, error: unknown): void => {
    const text = `${kind}: ${describe(error)}`;
    active.messages.push(text);
    if (active.messages.length > limit) active.messages.splice(0, active.messages.length - limit);
    // Report without throwing: throwing inside an unhandled-rejection handler
    // would escalate straight back to process exit, which is what this guards.
    try { report(`[${label}] unhandled ${text}\n`); } catch { /* stderr is gone */ }
  };

  active.unhandled = (error: unknown): void => {
    note("rejection", error);
  };
  active.uncaught = (error: unknown, origin?: string): void => {
    note("exception", error);
  };
  process.on("unhandledRejection", active.unhandled);
  process.on("uncaughtException", active.uncaught);
  return handle;
}

/** Test and teardown helper: remove the guard if one is installed. */
export function restoreProcessGuard(): void {
  restore();
}

export function processGuardInstalled(): boolean {
  return state().installed;
}