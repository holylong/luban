import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushUsageStats, readUsageLedger, recordRunUsage, runUsage } from "./usage-stats.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "luban usage stats "));
  homes.push(home);
  return home;
}

const HOUR = 3_600_000;
const settings = { enabled: true, url: "https://stats.test/api/report", intervalHours: 6 };

function recorder() {
  const bodies: Array<Record<string, unknown>> = [];
  let status = 200;
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl, setStatus: (next: number) => { status = next; } };
}

it("keeps one install id and accumulates pending tokens across runs", () => {
  const home = makeHome();
  recordRunUsage(home, { input: 100, output: 40, runs: 1 }, HOUR);
  recordRunUsage(home, { input: 50, output: 10, runs: 1 }, HOUR);
  const ledger = readUsageLedger(home, HOUR);
  expect(ledger.installId).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
  expect(ledger.pending).toEqual({ input: 150, output: 50, runs: 2 });
  expect(ledger.reported).toEqual({ input: 0, output: 0, runs: 0 });
  // A later read reuses the id instead of minting a new installation.
  expect(readUsageLedger(home, HOUR).installId).toBe(ledger.installId);
});

it("sums every model call of a run, including a failed one that still reported usage", () => {
  const usage = runUsage({ requests: [
    { index: 1, purpose: "task", elapsedMs: 10, ok: true, usage: { input: 1200, output: 300 } },
    { index: 2, purpose: "task", elapsedMs: 10, ok: false, usage: { input: 800, output: 0 } },
    { index: 3, purpose: "compaction", elapsedMs: 10, ok: true },
  ] });
  expect(usage).toEqual({ input: 2000, output: 300, runs: 1 });
});

it("sends one zero-token heartbeat on a fresh install, then only real deltas", async () => {
  const home = makeHome();
  const { bodies, fetchImpl } = recorder();
  let clock = 10 * HOUR;
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => clock })).toBe("sent");
  expect(bodies[0]).toMatchObject({ input: 0, output: 0, runs: 0 });
  expect(bodies[0]!.version).toMatch(/^\d+\.\d+\.\d+/);

  // Nothing pending: no traffic at all, even long after the interval.
  clock += 24 * HOUR;
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => clock })).toBe("skipped");
  expect(bodies).toHaveLength(1);
});

it("moves acknowledged tokens from pending to reported", async () => {
  const home = makeHome();
  const { bodies, fetchImpl } = recorder();
  const clock = 100 * HOUR;
  recordRunUsage(home, { input: 900, output: 100, runs: 1 }, clock);
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => clock })).toBe("sent");
  expect(bodies.at(-1)).toMatchObject({ input: 900, output: 100, runs: 1 });
  const ledger = readUsageLedger(home, clock);
  expect(ledger.pending).toEqual({ input: 0, output: 0, runs: 0 });
  expect(ledger.reported).toEqual({ input: 900, output: 100, runs: 1 });
  expect(ledger.lastSuccessAt).toBe(clock);
});

it("waits out the interval between uploads", async () => {
  const home = makeHome();
  const { bodies, fetchImpl } = recorder();
  let clock = 50 * HOUR;
  recordRunUsage(home, { input: 10, output: 5, runs: 1 }, clock);
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => clock })).toBe("sent");
  clock += HOUR;
  recordRunUsage(home, { input: 10, output: 5, runs: 1 }, clock);
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => clock })).toBe("skipped");
  expect(bodies).toHaveLength(1);
  clock += 6 * HOUR;
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => clock })).toBe("sent");
  expect(bodies.at(-1)).toMatchObject({ input: 10, output: 5 });
});

it("keeps the delta when the server fails and backs off before retrying", async () => {
  const home = makeHome();
  const { bodies, fetchImpl, setStatus } = recorder();
  let clock = 20 * HOUR;
  recordRunUsage(home, { input: 700, output: 30, runs: 1 }, clock);
  setStatus(500);
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => clock })).toBe("failed");
  expect(readUsageLedger(home, clock).pending).toEqual({ input: 700, output: 30, runs: 1 });
  // One failure doubles the wait: the next hourly attempt stays local.
  clock += 7 * HOUR;
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => clock })).toBe("skipped");
  expect(bodies).toHaveLength(1);
  // Once the server is back, the whole undelivered delta goes through once.
  setStatus(200);
  clock += 6 * HOUR;
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => clock })).toBe("sent");
  expect(bodies.at(-1)).toMatchObject({ input: 700, output: 30 });
  expect(readUsageLedger(home, clock).failures).toBe(0);
});

it("stays completely silent when reporting is disabled", async () => {
  const home = makeHome();
  const { bodies, fetchImpl } = recorder();
  recordRunUsage(home, { input: 500, output: 500, runs: 1 }, HOUR);
  expect(await flushUsageStats({ home, settings: { ...settings, enabled: false }, fetchImpl, now: () => HOUR })).toBe("skipped");
  expect(bodies).toHaveLength(0);
  expect(readUsageLedger(home, HOUR).pending).toEqual({ input: 500, output: 500, runs: 1 });
});

it("recovers from a corrupt ledger file instead of throwing", () => {
  const home = makeHome();
  writeFileSync(join(home, "usage-stats.json"), "{ this is not json");
  expect(readUsageLedger(home, HOUR).pending).toEqual({ input: 0, output: 0, runs: 0 });
  recordRunUsage(home, { input: 1, output: 1, runs: 1 }, HOUR);
  expect(readUsageLedger(home, HOUR).pending).toEqual({ input: 1, output: 1, runs: 1 });
});

it("gives up on a hung stats server instead of stalling the run", async () => {
  const home = makeHome();
  recordRunUsage(home, { input: 10, output: 2, runs: 1 }, HOUR);
  let sawSignal = false;
  // The service accepts the connection and then never answers: the worst case
  // for a fire-and-forget upload, because only our own timeout can end it.
  const fetchImpl = ((_url: unknown, init?: { signal?: AbortSignal }) => {
    sawSignal = Boolean(init?.signal);
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as unknown as typeof fetch;
  const started = Date.now();
  const result = await flushUsageStats({ home, settings, fetchImpl, now: () => HOUR, timeoutMs: 40 });
  expect(result).toBe("failed");
  expect(sawSignal).toBe(true);
  expect(Date.now() - started).toBeLessThan(2000);
  // Nothing was lost, and the failure is on the record for the backoff.
  const ledger = readUsageLedger(home, HOUR);
  expect(ledger.pending).toEqual({ input: 10, output: 2, runs: 1 });
  expect(ledger.reported).toEqual({ input: 0, output: 0, runs: 0 });
  expect(ledger.failures).toBe(1);
});
