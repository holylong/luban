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
import { readFileSync, renameSync, writeFileSync } from "node:fs";
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
}

// 443 is the relay's own TLS listener, so the stats service lives on its own
// plain-HTTP port; the payload is an anonymous id plus three counters.
const DEFAULT_URL = "http://203.0.113.7:18080/api/report";
const MAX_HOURS = 24 * 7;
const MAX_BACKOFF_STEPS = 4;

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

function effectiveIntervalMs(hours: number, failures: number): number {
  const base = Math.max(1, Math.min(MAX_HOURS, hours || 6)) * 3_600_000;
  return base * 2 ** Math.min(MAX_BACKOFF_STEPS, failures);
}

/**
 * Upload the pending delta when the configured interval has elapsed.
 *
 * A brand-new install sends one zero-token report so the service can count an
 * installation even if every model call fails; after that, empty deltas are
 * skipped entirely so an idle installation stays silent.
 */
export async function flushUsageStats(options: UsageFlushOptions): Promise<"sent" | "skipped" | "failed"> {
  const now = options.now ?? (() => Date.now());
  if (!options.settings.enabled) return "skipped";
  const at = now();
  const ledger = readUsageLedger(options.home, at);
  const firstReport = ledger.lastSuccessAt === 0;
  const pending = ledger.pending;
  if (!firstReport && pending.input <= 0 && pending.output <= 0) return "skipped";
  if (ledger.lastAttemptAt > 0 && at - ledger.lastAttemptAt < effectiveIntervalMs(options.settings.intervalHours, ledger.failures)) {
    return "skipped";
  }
  ledger.lastAttemptAt = at;
  writeUsageLedger(options.home, ledger);
  const url = options.settings.url || DEFAULT_URL;
  try {
    const doFetch = options.fetchImpl ?? fetch;
    const response = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `luban/${VERSION}` },
      body: JSON.stringify({
        installId: ledger.installId,
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
    ledger.pending = zero();
    ledger.reported.input += pending.input;
    ledger.reported.output += pending.output;
    ledger.reported.runs += pending.runs;
    ledger.lastSuccessAt = at;
    ledger.failures = 0;
    writeUsageLedger(options.home, ledger);
    return "sent";
  } catch {
    ledger.failures = Math.min(64, ledger.failures + 1);
    writeUsageLedger(options.home, ledger);
    return "failed";
  }
}

/** Fire-and-forget wrapper for hot paths (end of an agent run). */
export function scheduleUsageFlush(home: string, settings: UsageStatsSettings): void {
  // Test suites construct runs constantly; they must not reach the real
  // collection endpoint or leave ledgers in the developer's home directory.
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  void flushUsageStats({ home, settings }).catch(() => {});
}
