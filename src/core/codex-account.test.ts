import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeCodexReset, formatCodexRateLimits, formatCodexUsage, readCodexRateLimits, readCodexUsage } from "./codex-account.js";

const originalBin = process.env.LUBAN_CODEX_BIN;
const originalLog = process.env.LUBAN_CODEX_ACCOUNT_TEST_LOG;
afterEach(() => {
  if (originalBin === undefined) delete process.env.LUBAN_CODEX_BIN;
  else process.env.LUBAN_CODEX_BIN = originalBin;
  if (originalLog === undefined) delete process.env.LUBAN_CODEX_ACCOUNT_TEST_LOG;
  else process.env.LUBAN_CODEX_ACCOUNT_TEST_LOG = originalLog;
});

it("reads Codex account limits and usage, then redeems a selected reset with an idempotency key", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-account-test-"));
  const fake = join(home, "codex");
  const log = join(home, "requests.jsonl");
  await writeFile(fake, `#!/usr/bin/env node
const fs = require('fs');
let buffer = '';
process.stdin.on('data', part => {
  buffer += part;
  let newline = buffer.indexOf('\\n');
  while (newline >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.id === 0) process.stdout.write(JSON.stringify({ id: 0, result: {} }) + '\\n');
    if (request.id === 1) {
      fs.appendFileSync(process.env.LUBAN_CODEX_ACCOUNT_TEST_LOG, JSON.stringify(request) + '\\n');
      const result = request.method === 'account/rateLimits/read' ? {
        rateLimits: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1780000000 } },
        rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'card-1', status: 'available', title: 'Full reset' }] },
      } : request.method === 'account/usage/read' ? {
        summary: { lifetimeTokens: 1234 }, dailyUsageBuckets: [{ startDate: '2026-09-28', tokens: 100 }],
      } : { outcome: 'reset' };
      process.stdout.write(JSON.stringify({ id: 1, result }) + '\\n');
    }
    newline = buffer.indexOf('\\n');
  }
});
`, { mode: 0o755 });
  process.env.LUBAN_CODEX_BIN = fake;
  process.env.LUBAN_CODEX_ACCOUNT_TEST_LOG = log;

  const limits = await readCodexRateLimits();
  expect(formatCodexRateLimits(limits)).toContain("剩余 75.0%");
  expect(formatCodexRateLimits(limits)).toContain("可用重置卡：1 张");
  const usage = await readCodexUsage();
  expect(formatCodexUsage(usage, "daily")).toContain("2026-09-28  100 token");
  expect((await consumeCodexReset("card-1")).outcome).toBe("reset");
  const requests = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(requests.map((request) => request.method)).toEqual([
    "account/rateLimits/read", "account/usage/read", "account/rateLimitResetCredit/consume",
  ]);
  expect(requests[2].params.creditId).toBe("card-1");
  expect(requests[2].params.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
});
