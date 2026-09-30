import type { ChatMessage, LubanConfig, ToolCall } from "./types.js";
import { resolveImageParts } from "./vision.js";
import { parseModelEvent, sseData, validateCompletion, type CompletionCheck } from "./sse.js";
import { recoverTextToolCalls } from "./tool-call-text.js";
import { describeModelError } from "./model-errors.js";

/**
 * Ceiling for one response's output, matching OpenCode's default. A larger cap
 * lets a reasoning model think longer and makes a gateway reserve more KV cache
 * for the request, both of which slow every turn down.
 */
export const MAX_OUTPUT_TOKENS = 32_000;

export interface CompletionResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number };
  /**
   * The provider stopped at its output budget. The prose is kept so the run can
   * continue from it; the tool calls are never kept, because a response that ran
   * out of room may have been cut mid-call.
   */
  truncated?: boolean;
  /**
   * The stream stopped without a finish reason — the connection dropped or the
   * provider went silent mid-answer. The partial text is real output, so the
   * runner keeps it and asks the model to continue instead of failing the run.
   */
  streamEnded?: boolean;
}

/** Apply a validation verdict to one completion. */
export function finalizeCompletion(
  check: CompletionCheck,
  content: string,
  reasoning: string,
  toolCalls: ToolCall[],
  usage: { input: number; output: number },
): CompletionResult {
  return check.truncated
    ? { content, reasoning, toolCalls: [], usage, truncated: true }
    : { content, reasoning, toolCalls, usage };
}

export type DeltaKind = "content" | "reasoning";
export type DeltaHandler = (text: string, kind: DeltaKind) => void;
/**
 * Progress for things that happen *between* model output: a retry after a
 * failure, or a stream that went quiet long enough to be aborted. Without this
 * a stalled provider looks identical to a working one — the UI just shows a
 * spinner — which is precisely the state that reads as "hung".
 */
export type NoticeHandler = (text: string) => void;

/** Per-request speed controls. The configured thinking budget remains available to other tasks. */
export interface ModelRequestOptions {
  enableThinking?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
  thinkingTimeoutMs?: number;
  maxRetries?: number;
}

function endpoint(baseUrl: string): string {
  const value = baseUrl.replace(/\/$/, "");
  if (value.endsWith("/chat/completions")) return value;
  if (!value) return "https://api.openai.com/v1/chat/completions";
  return `${value}/chat/completions`;
}

function mergeToolCall(slots: Map<number, ToolCall>, fragment: Record<string, unknown>): void {
  const index = Number(fragment.index || 0);
  const current = slots.get(index) ?? {
    id: "",
    type: "function" as const,
    function: { name: "", arguments: "" },
  };
  if (typeof fragment.id === "string") current.id = fragment.id;
  const fn = fragment.function && typeof fragment.function === "object" ? fragment.function as Record<string, unknown> : {};
  if (typeof fn.name === "string") current.function.name += fn.name;
  if (typeof fn.arguments === "string") current.function.arguments += fn.arguments;
  slots.set(index, current);
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/** Merge internal system records at the transport boundary for strict
 * OpenAI-compatible chat templates that require one leading system message.
 * Image attachments become native vision parts; bytes are read from the
 * workspace at send time so saved sessions stay small. */
export async function openAiWireMessages(messages: ChatMessage[], workspace = ""): Promise<Array<Record<string, unknown>>> {
  const system = messages.filter((message) => message.role === "system")
    .map((message) => String(message.content ?? "").trim()).filter(Boolean).join("\n\n");
  const conversation: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const { editPreview: _localPreview, images: _localImages, ...rest } = message;
    if (!message.images?.length || message.role === "tool") {
      conversation.push({ ...rest });
      continue;
    }
    const parts: Array<Record<string, unknown>> = [];
    if (message.content?.trim()) parts.push({ type: "text", text: message.content });
    for (const image of await resolveImageParts(workspace, message.images)) {
      parts.push({ type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` } });
    }
    conversation.push({ ...rest, content: parts.length ? parts : (message.content ?? "") });
  }
  return system ? [{ role: "system", content: system }, ...conversation] : conversation;
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const header = response?.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1_000));
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(30_000, Math.max(0, date - Date.now()));
  }
  return Math.min(8_000, 400 * (2 ** attempt)) + Math.floor(Math.random() * 200);
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export class OpenAiClient {
  constructor(private readonly config: LubanConfig) {}

  async complete(
    messages: ChatMessage[],
    tools: Array<Record<string, unknown>>,
    signal: AbortSignal,
    onDelta?: DeltaHandler,
    onNotice?: NoticeHandler,
    options?: ModelRequestOptions,
  ): Promise<CompletionResult> {
    const body = JSON.stringify({
      model: this.config.model.model,
      messages: await openAiWireMessages(messages, this.config.workspace),
      max_tokens: Math.min(options?.maxTokens ?? this.config.maxTokens, MAX_OUTPUT_TOKENS),
      ...(this.config.model.capabilities?.temperature === false ? {} : { temperature: this.config.temperature }),
      stream: true,
      // OpenAI-compatible servers (e.g. vLLM) omit usage from the stream
      // unless explicitly requested; the TUI token counters depend on it.
      stream_options: { include_usage: true },
      ...((options?.enableThinking ?? this.config.enableThinking) === undefined ? {} : { chat_template_kwargs: { enable_thinking: options?.enableThinking ?? this.config.enableThinking } }),
      ...(tools.length ? { tools, tool_choice: "auto" } : {}),
    });
    const retries = options?.maxRetries ?? this.config.maxRetries ?? 3;
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted();
      const controller = new AbortController();
      const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs;
      const timeout = setTimeout(() => controller.abort(new Error(`model timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      const abort = () => controller.abort(signal.reason ?? new Error("aborted"));
      signal.addEventListener("abort", abort, { once: true });
      let response: Response | undefined;
      try {
        response = await fetch(endpoint(this.config.model.baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream, application/json",
            ...(this.config.model.apiKey ? { authorization: `Bearer ${this.config.model.apiKey}` } : {}),
            ...this.config.model.headers,
          },
          body,
          signal: controller.signal,
        });
        if (!response.ok) {
          const responseBody = await response.text();
          const error = new Error(`model HTTP ${response.status}: ${responseBody.slice(0, 4000)}`);
          if (!retryableStatus(response.status) || attempt >= retries) throw error;
          onNotice?.(`模型返回 HTTP ${response.status}，${(retryDelay(response, attempt) / 1000).toFixed(1)}s 后重试（第 ${attempt + 2}/${retries + 1} 次）`);
        } else {
          const type = response.headers.get("content-type") || "";
          if (!type.includes("text/event-stream")) {
            const data = await response.json() as Record<string, unknown>;
            return this.fromJson(data, onDelta);
          }
          if (!response.body) throw new Error("model returned an empty stream");
          // Do not retry after streaming starts: callbacks may already have rendered output.
          clearTimeout(timeout);
          return await this.consumeStream(response.body, onDelta, controller, onNotice, options?.thinkingTimeoutMs, signal);
        }
      } catch (error) {
        if (signal.aborted || response?.ok || attempt >= retries) throw error;
        if (error instanceof Error && error.message.startsWith("model HTTP ")) throw error;
        // Reached for transport failures and idle timeouts — the two cases where
        // the user would otherwise watch a silent spinner for minutes.
        onNotice?.(`模型请求中断（${describeModelError(error)}），即将重试（第 ${attempt + 2}/${retries + 1} 次）`);
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
      }
      await wait(retryDelay(response, attempt), signal);
    }
  }

  private fromJson(data: Record<string, unknown>, onDelta?: DeltaHandler): CompletionResult {
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const choice = (choices[0] ?? {}) as Record<string, unknown>;
    const message = choice.message && typeof choice.message === "object" ? choice.message as Record<string, unknown> : {};
    const content = typeof message.content === "string" ? message.content : "";
    const reasoning = typeof message.reasoning_content === "string"
      ? message.reasoning_content
      : typeof message.reasoning === "string" ? message.reasoning : "";
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls as ToolCall[] : [];
    // A gateway that leaves DeepSeek's XML-style calls in the text would
    // otherwise print the markup as an answer and never run the tool.
    const recovered = recoverTextToolCalls(content);
    const calls = [...toolCalls, ...recovered.toolCalls];
    const check = validateCompletion(recovered.content, calls, choice.finish_reason);
    if (reasoning) onDelta?.(reasoning, "reasoning");
    if (recovered.content) onDelta?.(recovered.content, "content");
    const usage = data.usage && typeof data.usage === "object" ? data.usage as Record<string, unknown> : {};
    return finalizeCompletion(check, recovered.content, reasoning, calls,
      { input: Number(usage.prompt_tokens || 0), output: Number(usage.completion_tokens || 0) });
  }

  private async consumeStream(stream: ReadableStream<Uint8Array>, onDelta: DeltaHandler | undefined, controller: AbortController, onNotice?: NoticeHandler, idleOverrideMs?: number, signal?: AbortSignal): Promise<CompletionResult> {
    const toolSlots = new Map<number, ToolCall>();
    let finished = false;
    let finishReason: unknown;
    let content = "";
    let reasoning = "";
    let input = 0;
    let output = 0;

    const idleTimeout = idleOverrideMs ?? this.config.thinkingTimeoutMs ?? Math.max(this.config.timeoutMs, 600_000);
    // Announce the stall before aborting: a 10-minute silence is indistinguishable
    // from a hang, and the retry that follows starts the clock over again.
    const idleAbort = () => {
      onNotice?.(`模型已 ${idleTimeout / 1000}s 没有任何输出，已中断本次请求（服务端可能卡住或网络中断）`);
      controller.abort(new Error(`model stream idle timeout after ${idleTimeout / 1000}s`));
    };
    let timer = setTimeout(idleAbort, idleTimeout);
    let failure: unknown;
    try {
      for await (const raw of sseData(stream, controller.signal)) {
        clearTimeout(timer);
        timer = setTimeout(idleAbort, idleTimeout);
        if (raw.trim() === "[DONE]") { finished = true; break; }
        const data = parseModelEvent(raw);
        const usage = data.usage && typeof data.usage === "object" ? data.usage as Record<string, unknown> : {};
        input = Number(usage.prompt_tokens || input);
        output = Number(usage.completion_tokens || output);
        const choices = Array.isArray(data.choices) ? data.choices : [];
        const choice = (choices[0] ?? {}) as Record<string, unknown>;
        if (choice.finish_reason != null) { finishReason = choice.finish_reason; finished = true; }
        const delta = choice.delta && typeof choice.delta === "object" ? choice.delta as Record<string, unknown> : {};
        const reasoningFragment = typeof delta.reasoning_content === "string"
          ? delta.reasoning_content
          : typeof delta.reasoning === "string" ? delta.reasoning : "";
        if (reasoningFragment) {
          reasoning += reasoningFragment;
          onDelta?.(reasoningFragment, "reasoning");
        }
        if (typeof delta.content === "string") {
          content += delta.content;
          onDelta?.(delta.content, "content");
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const fragment of delta.tool_calls) mergeToolCall(toolSlots, fragment as Record<string, unknown>);
        }
      }
    } catch (error) {
      failure = error;
    } finally { clearTimeout(timer); }
    if (signal?.aborted) throw signal.reason ?? failure ?? new Error("aborted");
    const calls = [...toolSlots.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (!finished) {
      // A dropped connection or an idle stall after real output is recoverable:
      // keep the text and let the runner ask for the rest, rather than throwing
      // a long answer away. Provider-declared errors still surface as errors.
      const declared = failure instanceof Error
        && /model stream error|model returned malformed|model returned invalid|model SSE event exceeds/u.test(failure.message);
      if (declared) throw failure;
      if (content || reasoning || calls.length) {
        onNotice?.(failure
          ? `模型连接在输出中途中断（${describeModelError(failure)}），已保留已收到的内容并继续`
          : "模型连接在输出中途中断，已保留已收到的内容并继续");
        return { content, reasoning, toolCalls: [], usage: { input, output }, truncated: true, streamEnded: true };
      }
      throw failure ?? new Error("model stream ended before completion; partial response was not accepted");
    }
    const recovered = recoverTextToolCalls(content);
    const allCalls = [...calls, ...recovered.toolCalls];
    const check = validateCompletion(recovered.content, allCalls, finishReason);
    return finalizeCompletion(check, recovered.content, reasoning, allCalls, { input, output });
  }
}
