import { readCodexRateLimits, type CodexRateLimits } from "../core/codex-account.js";
import type { CodexQuota, CodexResetCredit } from "./codex-quota-types.js";

function availableCredits(result: CodexRateLimits): CodexResetCredit[] {
  const credits: CodexResetCredit[] = [];
  for (const credit of result.rateLimitResetCredits?.credits ?? []) {
    if (credit?.status !== "available" || typeof credit.id !== "string" || !credit.id) continue;
    credits.push({ id: credit.id, title: credit.title || "额度重置",
      ...(typeof credit.expiresAt === "number" ? { expiresAt: credit.expiresAt } : {}) });
  }
  return credits;
}

/** Expose only quota facts, never account credentials or raw CLI diagnostics. */
export function quotaSnapshot(result: CodexRateLimits, now = Date.now()): CodexQuota {
  const buckets = result.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
    ? Object.entries(result.rateLimitsByLimitId) : result.rateLimits ? [[result.rateLimits.limitId || "codex", result.rateLimits] as const] : [];
  const windows: CodexQuota["windows"] = [];
  for (const [id, bucket] of buckets) {
    for (const key of ["primary", "secondary"] as const) {
      const window = bucket[key];
      if (typeof window?.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) continue;
      windows.push({ id: `${id}/${key}`, label: `${bucket.limitName || id} · ${key === "primary" ? "主要额度" : "次要额度"}`,
        remaining: Math.max(0, Math.min(100, 100 - window.usedPercent)),
        ...(typeof window.windowDurationMins === "number" ? { durationMins: window.windowDurationMins } : {}),
        ...(typeof window.resetsAt === "number" ? { resetsAt: window.resetsAt } : {}),
      });
    }
  }
  const credits = availableCredits(result);
  const declared = result.rateLimitResetCredits?.availableCount;
  return { updatedAt: now, windows, credits,
    availableResetCredits: typeof declared === "number" && Number.isFinite(declared) ? Math.max(0, declared) : credits.length };
}

/**
 * Coalesce requests and cache successes AND failures to avoid spawning a CLI
 * process per poll. `invalidate()` drops the cache after a reset consumes a card.
 */
export function createCodexQuotaReader(read = readCodexRateLimits, now = Date.now) {
  let cached: CodexQuota | undefined;
  let expires = 0;
  let pending: Promise<CodexQuota> | undefined;
  const load = (): Promise<CodexQuota> => {
    if (pending) return pending;
    if (cached && now() < expires) return Promise.resolve(cached);
    pending = Promise.resolve().then(() => read()).then(result => quotaSnapshot(result, now()))
      .catch((): CodexQuota => ({ ...cached, windows: cached?.windows ?? [], error: "无法查询 Codex 额度，请确认 Codex CLI 已安装并已登录。" }))
      .then(result => { cached = result; expires = now() + 60_000; return result; })
      .finally(() => { pending = undefined; });
    return pending;
  };
  return {
    read: load,
    /** Force the next read to hit Codex again, e.g. right after spending a card. */
    invalidate: () => { expires = 0; },
  };
}

export interface CodexResetRequest { creditId?: string; requestId?: string; error?: string }

/**
 * Validate a reset request before it reaches Codex. The request id becomes the
 * idempotency key, so an ambiguous failure can be retried safely: the client
 * keeps its id until the outcome is known.
 */
export function codexResetRequest(body: Record<string, unknown>): CodexResetRequest {
  const creditId = typeof body.credit_id === "string" ? body.credit_id.trim() : "";
  const requestId = typeof body.request_id === "string" ? body.request_id.trim() : "";
  if (creditId.length > 200 || /[\u0000-\u001f]/u.test(creditId)) return { error: "重置卡标识无效" };
  if (requestId && !/^[A-Za-z0-9._-]{1,128}$/u.test(requestId)) return { error: "请求标识无效" };
  return { ...(creditId ? { creditId } : {}), ...(requestId ? { requestId } : {}) };
}
