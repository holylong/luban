import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

type JsonObject = Record<string, unknown>;

export interface CodexRateWindow {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface CodexRateBucket {
  limitId?: string;
  limitName?: string | null;
  primary?: CodexRateWindow | null;
  secondary?: CodexRateWindow | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
}

export interface CodexRateLimits {
  rateLimits?: CodexRateBucket | null;
  rateLimitsByLimitId?: Record<string, CodexRateBucket> | null;
  rateLimitResetCredits?: {
    availableCount?: number;
    credits?: Array<{ id?: string; status?: string; title?: string | null; expiresAt?: number | null }> | null;
  } | null;
}

export interface CodexUsage {
  summary?: {
    lifetimeTokens?: number | null;
    peakDailyTokens?: number | null;
    currentStreakDays?: number | null;
  } | null;
  dailyUsageBuckets?: Array<{ startDate?: string; tokens?: number }> | null;
}

/** One local app-server request; Codex owns and refreshes the user's login. */
export async function codexAccountRequest<T>(method: string, params?: JsonObject, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw signal.reason ?? new Error("cancelled");
  return await new Promise<T>((resolve, reject) => {
    const child = spawn(process.env.LUBAN_CODEX_BIN || "codex", ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value as T);
    };
    const abort = () => finish(new Error("Codex account request cancelled"));
    const timer = setTimeout(() => finish(new Error("Codex account request timed out")), 20_000);
    signal?.addEventListener("abort", abort, { once: true });
    const send = (value: JsonObject) => child.stdin.write(`${JSON.stringify(value)}\n`);
    child.on("error", (error) => finish(new Error(`Cannot start Codex CLI: ${error.message}`)));
    child.stdin.on("error", (error) => finish(new Error(`Codex app-server input failed: ${error.message}`)));
    child.on("close", (code) => {
      if (!settled) finish(new Error(`Codex app-server exited (${code ?? "unknown"}): ${stderr.trim().slice(-500)}`));
    });
    child.stderr.on("data", (part: string) => { stderr = (stderr + part).slice(-1000); });
    child.stdout.on("data", (part: string) => {
      stdout += part;
      if (stdout.length > 2_000_000) return finish(new Error("Codex account response too large"));
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line) {
          let message: JsonObject;
          try { message = JSON.parse(line) as JsonObject; }
          catch { return finish(new Error("Codex app-server returned invalid JSON")); }
          if (message.id === 0) {
            if (message.error) return finish(new Error(`Codex initialization failed: ${JSON.stringify(message.error)}`));
            send({ method: "initialized", params: {} });
            send({ method, id: 1, ...(params ? { params } : {}) });
          } else if (message.id === 1) {
            if (message.error) {
              const detail = message.error as JsonObject;
              return finish(new Error(`Codex ${method}: ${String(detail.message ?? "request failed")}`));
            }
            return finish(undefined, message.result as T);
          }
        }
        newline = stdout.indexOf("\n");
      }
    });
    send({ method: "initialize", id: 0, params: { clientInfo: { name: "luban", title: "Luban", version: "1" } } });
  });
}

export const readCodexRateLimits = (signal?: AbortSignal) =>
  codexAccountRequest<CodexRateLimits>("account/rateLimits/read", undefined, signal);

export const readCodexUsage = (signal?: AbortSignal) =>
  codexAccountRequest<CodexUsage>("account/usage/read", undefined, signal);

export function consumeCodexReset(creditId?: string, signal?: AbortSignal) {
  return codexAccountRequest<{ outcome: "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit" }>(
    "account/rateLimitResetCredit/consume",
    { idempotencyKey: randomUUID(), ...(creditId ? { creditId } : {}) },
    signal,
  );
}

function windowText(label: string, window: CodexRateWindow | null | undefined): string | undefined {
  if (!window || typeof window.usedPercent !== "number") return undefined;
  const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
  const duration = typeof window.windowDurationMins === "number" ? ` · ${window.windowDurationMins}分钟窗口` : "";
  const reset = typeof window.resetsAt === "number" ? ` · ${new Date(window.resetsAt * 1000).toLocaleString("zh-CN")} 重置` : "";
  return `${label}：剩余 ${remaining.toFixed(1)}%${duration}${reset}`;
}

export function formatCodexRateLimits(result: CodexRateLimits): string {
  const buckets = result.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
    ? Object.entries(result.rateLimitsByLimitId)
    : result.rateLimits ? [[result.rateLimits.limitId || "codex", result.rateLimits] as const] : [];
  const lines: string[] = [];
  for (const [id, bucket] of buckets) {
    lines.push(`${bucket.limitName || id}${bucket.planType ? ` · ${bucket.planType}` : ""}`);
    const primary = windowText("主要额度", bucket.primary);
    const secondary = windowText("次要额度", bucket.secondary);
    if (primary) lines.push(primary);
    if (secondary) lines.push(secondary);
    if (bucket.rateLimitReachedType) lines.push(`已触及限制：${bucket.rateLimitReachedType}`);
  }
  if (!lines.length) lines.push("Codex 未返回额度窗口；请确认已使用 ChatGPT 账号登录。");
  const resets = result.rateLimitResetCredits;
  if (resets && typeof resets.availableCount === "number") {
    lines.push(`可用重置卡：${resets.availableCount} 张`);
    for (const credit of resets.credits ?? []) {
      if (credit.status !== "available") continue;
      lines.push(`  ${credit.title || "额度重置"}${typeof credit.expiresAt === "number" ? ` · ${new Date(credit.expiresAt * 1000).toLocaleString("zh-CN")} 到期` : ""}`);
    }
  }
  return lines.join("\n");
}

export function formatCodexUsage(result: CodexUsage, view: "daily" | "weekly" | "cumulative"): string {
  const buckets = (result.dailyUsageBuckets ?? []).filter((item) => item.startDate && typeof item.tokens === "number")
    .sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)));
  const lines = [`累计 token：${typeof result.summary?.lifetimeTokens === "number" ? result.summary.lifetimeTokens.toLocaleString("zh-CN") : "暂无数据"}`];
  if (view === "cumulative") {
    if (typeof result.summary?.peakDailyTokens === "number") lines.push(`单日峰值：${result.summary.peakDailyTokens.toLocaleString("zh-CN")}`);
    if (typeof result.summary?.currentStreakDays === "number") lines.push(`连续使用：${result.summary.currentStreakDays} 天`);
  } else if (view === "daily") {
    lines.push("最近每日用量：");
    lines.push(...buckets.slice(0, 14).map((item) => `${item.startDate}  ${item.tokens!.toLocaleString("zh-CN")} token`));
  } else {
    const weeks = new Map<string, number>();
    for (const item of buckets) {
      const date = new Date(`${item.startDate}T00:00:00Z`);
      if (Number.isNaN(date.getTime())) continue;
      date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
      const week = date.toISOString().slice(0, 10);
      weeks.set(week, (weeks.get(week) ?? 0) + item.tokens!);
    }
    lines.push("每周用量（周一起）：");
    lines.push(...[...weeks].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 8).map(([week, tokens]) => `${week}  ${tokens.toLocaleString("zh-CN")} token`));
  }
  if (lines.at(-1)?.endsWith("：")) lines.push("暂无数据");
  return lines.join("\n");
}
