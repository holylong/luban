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
 * Turn a CLI failure into something the user can act on. The raw message is
 * kept (redacted and truncated) because "无法查询额度" alone hides whether the
 * binary is missing, the account is logged out, or the CLI is too old.
 */
export function describeCodexError(error: unknown, home = process.env.HOME ?? ""): { error: string; hint?: string; detail: string } {
  const raw = error instanceof Error ? error.message : String(error);
  let detail = raw.replace(/\s+/gu, " ").trim();
  detail = detail.replace(/sk-[A-Za-z0-9_-]{8,}/gu, "sk-[已隐藏]")
    .replace(/\b(api[_-]?key|token|access_token|authorization|bearer)\b\s*[:=]?\s*[A-Za-z0-9._~+/=-]{12,}/giu, "$1: [已隐藏]");
  if (home) detail = detail.split(home).join("~");
  detail = detail.slice(0, 280);
  const lower = detail.toLowerCase();
  let hint: string | undefined;
  if (/method not found|unknown method|not supported|unsupported/u.test(lower)) {
    hint = "当前 Codex CLI 版本不支持额度查询接口，请升级：npm install -g @openai/codex。";
  } else if (/not logged in|login required|unauthorized|401|please run .*login|no credentials/u.test(lower)) {
    hint = "Codex 账号未登录或已过期：在终端执行 codex login，完成后点击刷新。";
  } else if (/env: node: no such file|node: (?:command )?not found/u.test(lower)) {
    hint = "启动 codex 需要 node，但桌面应用的环境里没有 node；luban 已尝试用自带 node 启动，仍失败请把 Codex 可执行文件路径写进 LUBAN_CODEX_BIN。";
  } else if (/enoent|cannot start codex|cannot find a runnable codex|command not found/u.test(lower)) {
    hint = "找不到 codex 命令：确认已安装 @openai/codex，或把 Codex 可执行文件路径写进环境变量 LUBAN_CODEX_BIN 后重启 luban。";
  } else if (/exited \(/u.test(lower)) {
    hint = "codex app-server 启动后退出，通常是未登录或版本过旧；可在终端运行 codex login 或升级 CLI。";
  }
  return { error: "无法查询 Codex 额度。", ...(hint ? { hint } : {}), detail };
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
      .catch((error: unknown): CodexQuota => ({ ...cached, windows: cached?.windows ?? [], credits: cached?.credits ?? [],
        ...describeCodexError(error) }))
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
