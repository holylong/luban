/**
 * Local token ledger plus the periodic upload to the standalone stats service.
 *
 * The ledger is deliberately boring: one JSON file in the luban home dir with
 * an anonymous install id, the tokens not yet acknowledged by the server, and
 * the totals already acknowledged. Reports are deltas, so a lost network, a
 * crash or a rejected upload costs at most one interval of numbers, never the
 * running total.
 */
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../version.js";
import type { RunMetrics, UsageStatsSettings } from "./types.js";

export interface UsageDelta {
  input: number;
  output: number;
  runs: number;
}

export interface UsageLedger {
  /** Anonymous per-installation id; never derived from hardware or identity. */
  installId: string;
  createdAt: number;
  pending: UsageDelta;
  reported: UsageDelta;
  /** Last upload attempt, successful or not, so a dead server is not hammered. */
  lastAttemptAt: number;
  lastSuccessAt: number;
  /** Consecutive failures, used to stretch the retry interval. */
  failures: number;
}

export interface UsageFlushOptions {
  home: string;
  settings: UsageStatsSettings;
  now?: () => number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Ignore the interval throttle and upload whatever is pending right now. */
  force?: boolean;
  /** Called with the reason when an upload fails, so `luban stats --push` can explain itself. */
  onError?: (error: unknown) => void;
}

// 443 is the relay's own TLS listener, so the stats service lives on its own
// plain-HTTP port; the payload is an anonymous id plus three counters.
const DEFAULT_URL = "http://203.0.113.7:18080/api/report";
const MAX_HOURS = 24 * 7;
const MAX_BACKOFF_STEPS = 4;
/** A crashed uploader leaves its lock behind; anything older is not a live one. */
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 250;

export function usageLedgerPath(home: string): string {
  return join(home, "usage-stats.json");
}

function zero(): UsageDelta {
  return { input: 0, output: 0, runs: 0 };
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function delta(raw: unknown): UsageDelta {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { input: count(value.input), output: count(value.output), runs: count(value.runs) };
}

export function readUsageLedger(home: string, now = Date.now()): UsageLedger {
  const path = usageLedgerPath(home);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const installId = typeof parsed.installId === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(parsed.installId)
      ? parsed.installId
      : randomUUID();
    return {
      installId,
      createdAt: count(parsed.createdAt) || now,
      pending: delta(parsed.pending),
      reported: delta(parsed.reported),
      lastAttemptAt: count(parsed.lastAttemptAt),
      lastSuccessAt: count(parsed.lastSuccessAt),
      failures: Math.min(64, count(parsed.failures)),
    };
  } catch {
    return { installId: randomUUID(), createdAt: now, pending: zero(), reported: zero(), lastAttemptAt: 0, lastSuccessAt: 0, failures: 0 };
  }
}

export function writeUsageLedger(home: string, ledger: UsageLedger): void {
  const path = usageLedgerPath(home);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

/** Sum the token usage of one completed run from its metrics. */
export function runUsage(metrics: Pick<RunMetrics, "requests"> | undefined): UsageDelta {
  const usage = zero();
  for (const request of metrics?.requests ?? []) {
    const item = request.usage;
    if (!item) continue;
    usage.input += count(item.input);
    usage.output += count(item.output);
  }
  usage.runs = 1;
  return usage;
}

/** Add one run's usage to the pending bucket. Never throws: callers run in `finally`. */
export function recordRunUsage(home: string, usage: UsageDelta, now = Date.now()): void {
  if (usage.input <= 0 && usage.output <= 0) return;
  try {
    const ledger = readUsageLedger(home, now);
    ledger.pending.input += count(usage.input);
    ledger.pending.output += count(usage.output);
    ledger.pending.runs += Math.max(1, count(usage.runs));
    writeUsageLedger(home, ledger);
  } catch {
    // A read-only or full disk must never break an agent run.
  }
}

/** Upload cadence when config says nothing: fast enough to feel live, cheap when idle. */
export const DEFAULT_INTERVAL_HOURS = 0.25;

function effectiveIntervalMs(hours: number, failures: number): number {
  const base = Math.max(1 / 60, Math.min(MAX_HOURS, hours || DEFAULT_INTERVAL_HOURS)) * 3_600_000;
  return base * 2 ** Math.min(MAX_BACKOFF_STEPS, failures);
}

type LedgerLock = { release: () => void } | "busy" | "unavailable";

/**
 * Exclusive claim on the ledger file, so a TUI and a `luban web` daemon sharing
 * one home cannot upload the same pending bucket twice: the second caller skips
 * instead of double-counting on a server that only accumulates deltas.
 */
function acquireLedgerLock(home: string, now: () => number): LedgerLock {
  const path = `${usageLedgerPath(home)}.lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return { release: () => { try { rmSync(path, { force: true }); } catch { /* already gone */ } } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return "unavailable";
      try {
        // Age is the only signal a leftover file gives us.
        if (now() - statSync(path).mtimeMs > LOCK_STALE_MS) { rmSync(path, { force: true }); continue; }
      } catch { continue; }
      return "busy";
    }
  }
  return "busy";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Upload the pending delta when the configured interval has elapsed.
 *
 * A brand-new install sends one zero-token report so the service can count an
 * installation even if every model call fails; after that, empty deltas are
 * skipped entirely so an idle installation stays silent.
 *
 * Calls in one process are serialised, and the ledger lock keeps other
 * processes out for the whole attempt, so a bucket is never uploaded twice.
 */
export function flushUsageStats(options: UsageFlushOptions): Promise<"sent" | "skipped" | "failed"> {
  const run = flushQueue.then(() => performFlush(options), () => performFlush(options));
  flushQueue = run.then(() => undefined, () => undefined);
  return run;
}

let flushQueue: Promise<unknown> = Promise.resolve();

async function performFlush(options: UsageFlushOptions): Promise<"sent" | "skipped" | "failed"> {
  const now = options.now ?? (() => Date.now());
  if (!options.settings.enabled) return "skipped";
  let at = now();
  let lock = acquireLedgerLock(options.home, now);
  for (let waited = 0; lock === "busy" && waited < LOCK_WAIT_MS; waited += 50) {
    // The holder is usually another process finishing a request; give it a
    // moment instead of dropping this process's last chance to report.
    await delay(50);
    at = now();
    lock = acquireLedgerLock(options.home, now);
  }
  if (lock === "busy") return "skipped";
  let pending: UsageDelta;
  let installId = "";
  try {
    const ledger = readUsageLedger(options.home, at);
    installId = ledger.installId;
    const firstReport = ledger.lastSuccessAt === 0;
    pending = ledger.pending;
    if (!firstReport && pending.input <= 0 && pending.output <= 0) return "skipped";
    if (!options.force && ledger.lastAttemptAt > 0 && at - ledger.lastAttemptAt < effectiveIntervalMs(options.settings.intervalHours, ledger.failures)) {
      return "skipped";
    }
    ledger.lastAttemptAt = at;
    writeUsageLedger(options.home, ledger);
  } finally {
    if (typeof lock === "object") lock.release();
  }
  const url = options.settings.url || DEFAULT_URL;
  // The acknowledgement subtracts what was actually sent instead of writing a
  // snapshot read before the request: a run that ends mid-upload is added to
  // the ledger by its own process and must survive this write.
  const settle = (delta: UsageDelta | null, at: number, update: (ledger: UsageLedger) => void): void => {
    const held = acquireLedgerLock(options.home, now);
    try {
      const ledger = readUsageLedger(options.home, at);
      // Only an acknowledged upload is subtracted; a failure leaves the bucket
      // exactly where it was (plus whatever other runs added meanwhile).
      if (delta) {
        ledger.pending = {
          input: Math.max(0, ledger.pending.input - delta.input),
          output: Math.max(0, ledger.pending.output - delta.output),
          runs: Math.max(0, ledger.pending.runs - delta.runs),
        };
      }
      update(ledger);
      writeUsageLedger(options.home, ledger);
    } finally {
      if (typeof held === "object") held.release();
    }
  };
  try {
    const doFetch = options.fetchImpl ?? fetch;
    const response = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `luban/${VERSION}` },
      body: JSON.stringify({
        installId,
        version: VERSION,
        platform: `${process.platform}-${process.arch}`,
        input: pending.input,
        output: pending.output,
        runs: pending.runs,
        reportedAt: at,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    if (!response.ok) throw new Error(`stats service returned ${response.status}`);
    settle(pending, now(), (ledger) => {
      ledger.reported.input += pending.input;
      ledger.reported.output += pending.output;
      ledger.reported.runs += pending.runs;
      ledger.lastSuccessAt = at;
      ledger.failures = 0;
    });
    return "sent";
  } catch (error) {
    options.onError?.(error);
    settle(null, now(), (ledger) => {
      ledger.failures = Math.min(64, ledger.failures + 1);
    });
    return "failed";
  }
}

/** Fire-and-forget wrapper for hot paths (end of an agent run). */
export function scheduleUsageFlush(home: string, settings: UsageStatsSettings): void {
  if (inTests()) return;
  void flushUsageStats({ home, settings }).catch(() => {});
}

function inTests(): boolean {
  // Test suites construct runs constantly; they must not reach the real
  // collection endpoint or leave ledgers in the developer's home directory.
  return Boolean(process.env.VITEST || process.env.NODE_ENV === "test");
}

/**
 * Last-chance upload on the way out.
 *
 * The interval throttles a *running* process; once the terminal or daemon is
 * about to disappear, anything still pending would be reported late (or, if the
 * next start never happens, never), which is exactly the skew a stats page
 * cannot explain. Forced, but bounded: a dead network may cost the numbers, it
 * may not hold the exit prompt hostage.
 *
 * @param options Home, settings, and the deadline for the whole attempt.
 * @returns What happened, so a caller can log it if it wants to.
 */
export async function flushUsageStatsOnExit(options: {
  home: string;
  settings: UsageStatsSettings;
  timeoutMs?: number;
  /** Tests drive this directly; the guard only protects real exits. */
  guardTests?: boolean;
  /** Injectable for tests: the real exit path uses global fetch and the clock. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<"sent" | "skipped" | "failed"> {
  if (options.guardTests !== false && inTests()) return "skipped";
  const timeoutMs = Math.max(200, options.timeoutMs ?? 2_000);
  const attempt = flushUsageStats({
    home: options.home,
    settings: options.settings,
    force: true,
    timeoutMs,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
    .catch(() => "failed" as const);
  // Belt and braces: the request already carries its own abort signal, but a
  // resolver that never settles must not keep a closed terminal alive. The
  // guard timer is unref'd, so it cannot be the reason node stays up either.
  const guard = new Promise<"failed">((resolve) => {
    const timer = setTimeout(() => resolve("failed"), timeoutMs + 250);
    timer.unref?.();
  });
  return Promise.race([attempt, guard]);
}
