import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_USAGE_STATS_URL } from "./service-defaults.js";
import { flushUsageStats, flushUsageStatsOnExit, readUsageLedger, recordRunUsage, runUsage, usageLedgerPath } from "./usage-stats.js";

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

it("uploads to the shipped stats address when the config leaves the url empty", async () => {
  const home = makeHome();
  const urls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    urls.push(String(url));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  expect(await flushUsageStats({ home, settings: { ...settings, url: "" }, fetchImpl, now: () => 10 * HOUR })).toBe("sent");
  expect(urls).toEqual([DEFAULT_USAGE_STATS_URL]);
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

it("honours a sub-hour interval so the dashboard stays fresh", async () => {
  const home = makeHome();
  const { bodies, fetchImpl } = recorder();
  const quick = { ...settings, intervalHours: 0.25 };
  let clock = HOUR;
  recordRunUsage(home, { input: 10, output: 1, runs: 1 }, clock);
  expect(await flushUsageStats({ home, settings: quick, fetchImpl, now: () => clock })).toBe("sent");
  recordRunUsage(home, { input: 20, output: 2, runs: 1 }, clock + 60_000);
  clock += 14 * 60_000;
  expect(await flushUsageStats({ home, settings: quick, fetchImpl, now: () => clock })).toBe("skipped");
  clock += 60_000;
  expect(await flushUsageStats({ home, settings: quick, fetchImpl, now: () => clock })).toBe("sent");
  expect(bodies.at(-1)).toMatchObject({ input: 20, output: 2 });
});

it("force uploads immediately and explains a failure", async () => {
  const home = makeHome();
  const { bodies, fetchImpl } = recorder();
  recordRunUsage(home, { input: 5, output: 1, runs: 1 }, HOUR);
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => HOUR })).toBe("sent");
  recordRunUsage(home, { input: 7, output: 2, runs: 1 }, HOUR + 1000);
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => HOUR + 1000 })).toBe("skipped");
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => HOUR + 1000, force: true })).toBe("sent");
  expect(bodies.at(-1)).toMatchObject({ input: 7, output: 2 });

  let reason = "";
  recordRunUsage(home, { input: 1, output: 1, runs: 1 }, HOUR + 2000);
  const broken = (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;
  expect(await flushUsageStats({
    home, settings, fetchImpl: broken, now: () => HOUR + 2000, force: true,
    onError: (error) => { reason = error instanceof Error ? error.message : String(error); },
  })).toBe("failed");
  expect(reason).toMatch(/ECONNREFUSED/);
});

it("uploads on exit even when the interval has not elapsed", async () => {
  const home = makeHome();
  const { bodies, fetchImpl } = recorder();
  recordRunUsage(home, { input: 10, output: 2, runs: 1 }, HOUR);
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => HOUR })).toBe("sent");
  // A run that ends seconds before the terminal closes is still inside the
  // 6 hour interval; the exit path must not drop it.
  recordRunUsage(home, { input: 40, output: 5, runs: 1 }, HOUR + 5_000);
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => HOUR + 5_000 })).toBe("skipped");
  expect(await flushUsageStatsOnExit({ home, settings, guardTests: false, fetchImpl, now: () => HOUR + 5_000 })).toBe("sent");
  expect(bodies.at(-1)).toMatchObject({ input: 40, output: 5, runs: 1 });
  const ledger = readUsageLedger(home);
  expect(ledger.pending).toEqual({ input: 0, output: 0, runs: 0 });
  expect(ledger.reported).toEqual({ input: 50, output: 7, runs: 2 });
  // Nothing left to send: a second exit costs no request at all.
  expect(await flushUsageStatsOnExit({ home, settings, guardTests: false, fetchImpl, now: () => HOUR + 6_000 })).toBe("skipped");
});

it("never uploads the same bucket twice, even with concurrent callers", async () => {
  const home = makeHome();
  const { bodies, fetchImpl } = recorder();
  recordRunUsage(home, { input: 1, output: 1, runs: 1 }, HOUR);
  await flushUsageStats({ home, settings, fetchImpl, now: () => HOUR });
  recordRunUsage(home, { input: 900, output: 90, runs: 3 }, HOUR + 1000);
  const before = bodies.length;
  const results = await Promise.all([
    flushUsageStats({ home, settings, fetchImpl, now: () => HOUR + 1000, force: true }),
    flushUsageStats({ home, settings, fetchImpl, now: () => HOUR + 1000, force: true }),
    flushUsageStatsOnExit({ home, settings, guardTests: false, fetchImpl, now: () => HOUR + 1000 }),
  ]);
  expect(results[0]).toBe("sent");
  expect(bodies.length - before).toBe(1);
  expect(readUsageLedger(home).pending).toEqual({ input: 0, output: 0, runs: 0 });
});

it("keeps a run recorded while the upload is in flight", async () => {
  const home = makeHome();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    // A second run ends while the request is on the wire.
    recordRunUsage(home, { input: 7, output: 1, runs: 1 }, HOUR + 1500);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  recordRunUsage(home, { input: 100, output: 10, runs: 1 }, HOUR);
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => HOUR })).toBe("sent");
  const ledger = readUsageLedger(home);
  expect(ledger.reported).toEqual({ input: 100, output: 10, runs: 1 });
  expect(ledger.pending).toEqual({ input: 7, output: 1, runs: 1 });
  expect(calls).toBe(1);
});

it("skips while another process holds the ledger lock, and recovers a stale one", async () => {
  const home = makeHome();
  const { bodies, fetchImpl } = recorder();
  const lock = `${usageLedgerPath(home)}.lock`;
  recordRunUsage(home, { input: 12, output: 3, runs: 1 }, HOUR);
  // A live uploader elsewhere: skip rather than double-count on the server.
  writeFileSync(lock, "999999");
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => HOUR, force: true })).toBe("skipped");
  expect(bodies).toHaveLength(0);
  expect(readUsageLedger(home).pending).toEqual({ input: 12, output: 3, runs: 1 });
  // A crashed uploader leaves the file behind; its age is the only signal.
  utimesSync(lock, new Date(HOUR - 120_000), new Date(HOUR - 120_000));
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => HOUR, force: true })).toBe("sent");
  expect(bodies.at(-1)).toMatchObject({ input: 12, output: 3 });
  expect(readUsageLedger(home).pending).toEqual({ input: 0, output: 0, runs: 0 });
});

it("splits one run's tokens per model, counting the run once per model used", () => {
  const usage = runUsage({ requests: [
    { index: 1, purpose: "task", elapsedMs: 10, ok: true, model: "alpha/one", usage: { input: 100, output: 10 } },
    { index: 2, purpose: "task", elapsedMs: 10, ok: false, model: "alpha/one", usage: { input: 50, output: 0 } },
    { index: 3, purpose: "compaction", elapsedMs: 10, ok: true, model: "beta/two", usage: { input: 20, output: 5 } },
    { index: 4, purpose: "task", elapsedMs: 10, ok: true },
  ] });
  expect(usage).toEqual({
    input: 170, output: 15, runs: 1,
    models: {
      "alpha/one": { input: 150, output: 10, runs: 1 },
      "beta/two": { input: 20, output: 5, runs: 1 },
    },
  });
});

it("keeps model rows in the ledger and uploads them with the totals", async () => {
  const home = makeHome();
  const { bodies, fetchImpl } = recorder();
  const clock = 100 * HOUR;
  recordRunUsage(home, runUsage({ requests: [{ index: 1, purpose: "task", elapsedMs: 1, ok: true, model: "alpha/one", usage: { input: 30, output: 3 } }] }), clock);
  recordRunUsage(home, runUsage({ requests: [{ index: 1, purpose: "task", elapsedMs: 1, ok: true, model: "beta/two", usage: { input: 7, output: 1 } }] }), clock);
  expect(readUsageLedger(home).pending).toEqual({
    input: 37, output: 4, runs: 2,
    models: {
      "alpha/one": { input: 30, output: 3, runs: 1 },
      "beta/two": { input: 7, output: 1, runs: 1 },
    },
  });
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => clock })).toBe("sent");
  expect(bodies.at(-1)).toMatchObject({
    input: 37, output: 4, runs: 2,
    models: [
      { model: "alpha/one", input: 30, output: 3, runs: 1 },
      { model: "beta/two", input: 7, output: 1, runs: 1 },
    ],
  });
  // Acknowledged model rows leave the pending bucket rather than being resent.
  expect(readUsageLedger(home).pending).toEqual({ input: 0, output: 0, runs: 0 });
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => clock + 1000, force: true })).toBe("skipped");
});

it("keeps a model row recorded while the upload is in flight", async () => {
  const home = makeHome();
  const fetchImpl = (async () => {
    recordRunUsage(home, runUsage({ requests: [{ index: 1, purpose: "task", elapsedMs: 1, ok: true, model: "beta/two", usage: { input: 9, output: 1 } }] }), HOUR + 1500);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  recordRunUsage(home, runUsage({ requests: [{ index: 1, purpose: "task", elapsedMs: 1, ok: true, model: "alpha/one", usage: { input: 4, output: 2 } }] }), HOUR);
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => HOUR })).toBe("sent");
  expect(readUsageLedger(home).pending).toEqual({
    input: 9, output: 1, runs: 1,
    models: { "beta/two": { input: 9, output: 1, runs: 1 } },
  });
});

it("uploads totals without a model split for ledgers written before it existed", async () => {
  const home = makeHome();
  const { bodies, fetchImpl } = recorder();
  const clock = 100 * HOUR;
  writeFileSync(usageLedgerPath(home), JSON.stringify({
    installId: "legacy-install", createdAt: HOUR, lastAttemptAt: 0, lastSuccessAt: clock - HOUR,
    lastSuccess: undefined, failures: 0,
    pending: { input: 11, output: 2, runs: 1 }, reported: { input: 0, output: 0, runs: 0 },
  }));
  expect(await flushUsageStats({ home, settings, fetchImpl, now: () => clock })).toBe("sent");
  expect(bodies.at(-1)).toMatchObject({ input: 11, output: 2, runs: 1 });
  expect(bodies.at(-1)).not.toHaveProperty("models");
  expect(readUsageLedger(home).pending).toEqual({ input: 0, output: 0, runs: 0 });
});
