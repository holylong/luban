import { expect, it, vi } from "vitest";
import { codexResetRequest, createCodexQuotaReader, quotaSnapshot } from "./codex-quota.js";

it("converts account windows to bounded remaining percentages", () => {
  const result = quotaSnapshot({ rateLimits: { primary: { usedPercent: 85, windowDurationMins: 300, resetsAt: 123 }, secondary: { usedPercent: 120 } } }, 42);
  expect(result).toMatchObject({ updatedAt: 42, windows: [{ remaining: 15, durationMins: 300, resetsAt: 123 }, { remaining: 0 }] });
  expect(quotaSnapshot({ rateLimits: { primary: { usedPercent: NaN } } }).windows).toEqual([]);
  expect(quotaSnapshot({ rateLimitsByLimitId: { special: { primary: { usedPercent: -10 } } } }).windows[0]?.remaining).toBe(100);
});

it("exposes only usable reset cards and keeps their expiry", () => {
  const snap = quotaSnapshot({ rateLimitResetCredits: { availableCount: 2, credits: [
    { id: "card-1", status: "available", title: "额度重置", expiresAt: 1_800_000_000 },
    { id: "card-2", status: "available" },
    { id: "card-3", status: "redeemed" },
    { status: "available" },
  ] } });
  expect(snap.availableResetCredits).toBe(2);
  expect(snap.credits).toEqual([{ id: "card-1", title: "额度重置", expiresAt: 1_800_000_000 }, { id: "card-2", title: "额度重置" }]);
  // Without a declared count the usable cards are the fallback count.
  expect(quotaSnapshot({ rateLimitResetCredits: { credits: [{ id: "only", status: "available" }] } }).availableResetCredits).toBe(1);
  expect(quotaSnapshot({ rateLimits: { primary: { usedPercent: 1 } } })).toMatchObject({ credits: [], availableResetCredits: 0 });
});

it("coalesces concurrent reads, caches for one minute and honours invalidate", async () => {
  let now = 0;
  const read = vi.fn(async () => ({ rateLimits: { primary: { usedPercent: 25 } } }));
  const quota = createCodexQuotaReader(read, () => now);
  await Promise.all([quota.read(), quota.read()]);
  await quota.read();
  expect(read).toHaveBeenCalledTimes(1);
  now = 60_000;
  expect((await quota.read()).windows[0]?.remaining).toBe(75);
  expect(read).toHaveBeenCalledTimes(2);
  quota.invalidate();
  await quota.read();
  expect(read).toHaveBeenCalledTimes(3);
});

it("caches failures without exposing raw errors and labels old data stale", async () => {
  let now = 0;
  const read = vi.fn().mockResolvedValueOnce({ rateLimits: { primary: { usedPercent: 90 } }, rateLimitResetCredits: { availableCount: 1 } })
    .mockRejectedValue(new Error("secret token"));
  const quota = createCodexQuotaReader(read, () => now);
  await quota.read();
  now = 60_000;
  const failed = await quota.read();
  expect(failed.windows[0]?.remaining).toBe(10);
  expect(failed.availableResetCredits).toBe(1);
  expect(failed.updatedAt).toBe(0);
  expect(failed.error).toContain("无法查询");
  expect(JSON.stringify(failed)).not.toContain("secret");
  await quota.read();
  expect(read).toHaveBeenCalledTimes(2);
});

it("validates reset requests before they reach Codex", () => {
  expect(codexResetRequest({ credit_id: " card-1 ", request_id: "req-1" })).toEqual({ creditId: "card-1", requestId: "req-1" });
  expect(codexResetRequest({})).toEqual({});
  expect(codexResetRequest({ credit_id: 7, request_id: 9 })).toEqual({});
  expect(codexResetRequest({ credit_id: "a\u0000b" }).error).toBe("重置卡标识无效");
  expect(codexResetRequest({ credit_id: "x".repeat(201) }).error).toBe("重置卡标识无效");
  expect(codexResetRequest({ request_id: "bad key!" }).error).toBe("请求标识无效");
  expect(codexResetRequest({ request_id: "a".repeat(129) }).error).toBe("请求标识无效");
});
