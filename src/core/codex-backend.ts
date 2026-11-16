import { randomUUID } from "node:crypto";
import type { ChatMessage, LubanConfig } from "./types.js";
import type { CompletionResult, DeltaHandler, ModelRequestOptions, NoticeHandler } from "./openai.js";
import { CodexClient } from "./codex.js";
import { ResponsesClient } from "./responses.js";
import { codexAuthExpired, readCodexAuth, refreshCodexAuth, type CodexAuth } from "./codex-auth.js";

/**
 * Codex CLI's own ChatGPT backend. Calling it directly avoids the CLI's base
 * instructions and tool schemas (~15k input tokens) and the extra process hop,
 * while still spending the ChatGPT subscription instead of an API key.
 */
export const CODEX_BACKEND_BASE = "https://chatgpt.com/backend-api/codex";
const ORIGINATOR = "codex_cli_rs";
// The backend rejects sessions whose originator/UA do not look like the CLI.
const USER_AGENT = "codex_cli_rs/0.164.0";

export interface CompletionClient {
  complete(
    messages: ChatMessage[],
    tools: Array<Record<string, unknown>>,
    signal: AbortSignal,
    onDelta?: DeltaHandler,
    onNotice?: NoticeHandler,
    options?: ModelRequestOptions,
  ): Promise<CompletionResult>;
}

/** Direct backend by default, including legacy auto; CLI requires explicit opt-in. */
export type CodexTransport = "native" | "cli";

export function codexTransport(configured?: string): CodexTransport {
  const raw = String(configured ?? process.env.LUBAN_CODEX_MODE ?? "").trim().toLowerCase();
  return raw === "cli" ? "cli" : "native";
}

export interface CodexBackendDeps {
  loadAuth?: () => Promise<CodexAuth | undefined>;
  refresh?: (auth: CodexAuth) => Promise<CodexAuth | undefined>;
  /** The official CLI, used only when explicitly selected. */
  fallback?: CompletionClient;
  mode?: string;
}

function unauthorized(error: unknown): boolean {
  return error instanceof Error && /model HTTP 401\b/.test(error.message);
}

export class CodexBackendClient implements CompletionClient {
  private readonly sessionId = randomUUID();
  private readonly fallback: CompletionClient;
  private readonly loadAuth: () => Promise<CodexAuth | undefined>;
  private readonly refresh: (auth: CodexAuth) => Promise<CodexAuth | undefined>;
  private auth: CodexAuth | undefined;
  private loaded = false;

  constructor(private readonly config: LubanConfig, private readonly deps: CodexBackendDeps = {}) {
    this.fallback = deps.fallback ?? new CodexClient(config);
    this.loadAuth = deps.loadAuth ?? (() => readCodexAuth());
    this.refresh = deps.refresh ?? ((auth) => refreshCodexAuth(auth));
  }

  async complete(
    messages: ChatMessage[],
    tools: Array<Record<string, unknown>>,
    signal: AbortSignal,
    onDelta?: DeltaHandler,
    onNotice?: NoticeHandler,
    options?: ModelRequestOptions,
  ): Promise<CompletionResult> {
    const mode = codexTransport(this.deps.mode);
    if (mode === "cli") return this.fallback.complete(messages, tools, signal, onDelta, onNotice, options);
    return this.native(messages, tools, signal, onDelta, onNotice, options);
  }

  private async native(
    messages: ChatMessage[],
    tools: Array<Record<string, unknown>>,
    signal: AbortSignal,
    onDelta: DeltaHandler | undefined,
    onNotice: NoticeHandler | undefined,
    options: ModelRequestOptions | undefined,
  ): Promise<CompletionResult> {
    let auth = await this.currentAuth();
    if (!auth) throw new Error("没有找到 ChatGPT 登录（~/.codex/auth.json）；请先运行 codex login");
    if (codexAuthExpired(auth) && auth.refreshToken) {
      const refreshed = await this.refresh(auth);
      if (refreshed) { auth = refreshed; this.auth = refreshed; }
    }
    const request = { maxRetries: 0, ...options };
    try {
      return await new ResponsesClient(this.nativeConfig(auth)).complete(messages, tools, signal, onDelta, onNotice, request);
    } catch (error) {
      if (!unauthorized(error) || signal.aborted) throw error;
      const refreshed = await this.refresh(auth);
      if (!refreshed) throw error;
      this.auth = refreshed;
      onNotice?.("ChatGPT 登录已刷新，正在重试");
      return new ResponsesClient(this.nativeConfig(refreshed)).complete(messages, tools, signal, onDelta, onNotice, request);
    }
  }

  private async currentAuth(): Promise<CodexAuth | undefined> {
    if (!this.loaded || (this.auth && codexAuthExpired(this.auth))) {
      this.auth = await this.loadAuth();
      this.loaded = true;
    }
    return this.auth;
  }

  /** One Responses request shaped for the ChatGPT backend, with luban's own tools. */
  nativeConfig(auth: CodexAuth): LubanConfig {
    const model = this.config.model;
    return {
      ...this.config,
      model: {
        ...model,
        api: "responses",
        baseUrl: CODEX_BACKEND_BASE,
        apiKey: auth.accessToken,
        headers: {
          originator: ORIGINATOR,
          "OpenAI-Beta": "responses=experimental",
          "user-agent": USER_AGENT,
          session_id: this.sessionId,
          ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
        },
        // Reasoning models behind this endpoint reject an explicit temperature.
        capabilities: { ...model.capabilities, responses: true, temperature: false },
      },
    };
  }
}
