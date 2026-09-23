import type { ChatMessage, LubanConfig, ToolCall } from "./types.js";
import { resolveImageParts } from "./vision.js";
import { finalizeCompletion } from "./openai.js";
import type { CompletionResult, DeltaHandler, NoticeHandler } from "./openai.js";
import { parseModelEvent, sseData } from "./sse.js";

type JsonObject = Record<string, unknown>;

export function responsesEndpoint(baseUrl: string): string {
  const value = baseUrl.replace(/\/$/, "");
  if (value.endsWith("/responses")) return value;
  if (value.endsWith("/chat/completions")) return value.slice(0, -"/chat/completions".length) + "/responses";
  if (!value) return "https://api.openai.com/v1/responses";
  return `${value}/responses`;
}

/** Convert a chat transcript into Responses API input items. */
export async function responsesInput(messages: ChatMessage[], workspace = ""): Promise<{ instructions: string; input: JsonObject[] }> {
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => String(message.content ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
  const input: JsonObject[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id || "",
        output: String(message.content ?? ""),
      });
      continue;
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      if (message.content?.trim()) {
        input.push({ role: "assistant", content: [{ type: "output_text", text: message.content }] });
      }
      for (const call of message.tool_calls) {
        input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments || "{}" });
      }
      continue;
    }
    const parts: JsonObject[] = [{ type: message.role === "assistant" ? "output_text" : "input_text", text: String(message.content ?? "") }];
    if (message.images?.length && (message.role === "user" || message.role === "assistant")) {
      for (const image of await resolveImageParts(workspace, message.images)) {
        parts.push({ type: "input_image", image_url: `data:${image.mime};base64,${image.base64}` });
      }
    }
    input.push({ role: message.role, content: parts });
  }
  return { instructions, input };
}

export function responsesTools(tools: Array<Record<string, unknown>>): JsonObject[] {
  return tools.map((entry) => {
    const fn = entry.function as JsonObject;
    return { type: "function", name: fn.name, description: fn.description, parameters: fn.parameters ?? { type: "object" } };
  });
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
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

/**
 * The Responses API reports output-budget exhaustion as an incomplete response.
 * `content_filter` is the one incomplete reason that is a real stop.
 */
function incompleteReason(value: JsonObject | undefined): string | undefined {
  if (!value || String(value.status || "") !== "incomplete") return undefined;
  const details = (value.incomplete_details ?? {}) as JsonObject;
  const reason = String(details.reason || "incomplete");
  return reason === "content_filter" ? undefined : reason;
}

function outputItemsToResult(output: unknown, onDelta?: DeltaHandler): { content: string; toolCalls: ToolCall[] } {
  const items = Array.isArray(output) ? output as JsonObject[] : [];
  let content = "";
  const toolCalls: ToolCall[] = [];
  for (const item of items) {
    if (item.type === "message") {
      const parts = Array.isArray(item.content) ? item.content as JsonObject[] : [];
      for (const part of parts) {
        if ((part.type === "output_text" || part.type === "input_text") && typeof part.text === "string") content += part.text;
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: String(item.call_id || item.id || ""),
        type: "function",
        function: { name: String(item.name || ""), arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}) },
      });
    }
  }
  if (content) onDelta?.(content, "content");
  return { content, toolCalls };
}

/** Native OpenAI Responses API client (streaming SSE + JSON fallback). */
export class ResponsesClient {
  constructor(private readonly config: LubanConfig) {}

  async complete(
    messages: ChatMessage[],
    tools: Array<Record<string, unknown>>,
    signal: AbortSignal,
    onDelta?: DeltaHandler,
    onNotice?: NoticeHandler,
  ): Promise<CompletionResult> {
    const converted = await responsesInput(messages, this.config.workspace);
    const body = JSON.stringify({
      model: this.config.model.model,
      ...(converted.instructions ? { instructions: converted.instructions } : {}),
      input: converted.input,
      max_output_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: true,
      store: false,
      ...(tools.length ? { tools: responsesTools(tools), tool_choice: "auto" } : {}),
    });
    const retries = this.config.maxRetries ?? 3;
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error(`model timed out after ${this.config.timeoutMs / 1000}s`)), this.config.timeoutMs);
      const abort = () => controller.abort(signal.reason ?? new Error("aborted"));
      signal.addEventListener("abort", abort, { once: true });
      let response: Response | undefined;
      try {
        response = await fetch(responsesEndpoint(this.config.model.baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream, application/json",
            ...(this.config.model.apiKey ? { authorization: `Bearer ${this.config.model.apiKey}` } : {}),
          },
          body,
          signal: controller.signal,
        });
        if (!response.ok) {
          const responseBody = await response.text();
          if (response.status === 404) {
            throw new Error(`model HTTP 404: this gateway has no Responses endpoint (${responsesEndpoint(this.config.model.baseUrl)}). Use api "openai" for Chat Completions. ${responseBody.slice(0, 500)}`);
          }
          const error = new Error(`model HTTP ${response.status}: ${responseBody.slice(0, 4000)}`);
          if (!retryableStatus(response.status) || attempt >= retries) throw error;
        } else {
          const type = response.headers.get("content-type") || "";
          if (!type.includes("text/event-stream")) {
            const data = await response.json() as JsonObject;
            return this.fromJson(data, onDelta);
          }
          if (!response.body) throw new Error("model returned an empty stream");
          // Do not retry after streaming starts: callbacks may already have rendered output.
          clearTimeout(timeout);
          return await this.consumeStream(response.body, onDelta, controller, onNotice);
        }
      } catch (error) {
        if (signal.aborted || response?.ok || attempt >= retries) throw error;
        if (error instanceof Error && error.message.startsWith("model HTTP ")) throw error;
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
      }
      const backoff = Math.min(8_000, 400 * (2 ** attempt)) + Math.floor(Math.random() * 200);
      onNotice?.(`模型请求失败，${(backoff / 1000).toFixed(1)}s 后重试（第 ${attempt + 2}/${retries + 1} 次）`);
      await wait(backoff, signal);
    }
  }

  private fromJson(data: JsonObject, onDelta?: DeltaHandler): CompletionResult {
    if (data.error && typeof data.error === "object") {
      const error = data.error as JsonObject;
      throw new Error(`model stream error: ${String(error.message ?? error.type ?? "unknown provider error").slice(0, 600)}`);
    }
    const { content, toolCalls } = outputItemsToResult(data.output, onDelta);
    if (data.status === "failed") {
      throw new Error(`model response failed: ${JSON.stringify(data.error ?? "").slice(0, 400)}`);
    }
    const truncated = incompleteReason(data) !== undefined;
    const usage = data.usage && typeof data.usage === "object" ? data.usage as JsonObject : {};
    return finalizeCompletion({ truncated }, content, "", toolCalls,
      { input: Number(usage.input_tokens || 0), output: Number(usage.output_tokens || 0) });
  }

  private async consumeStream(stream: ReadableStream<Uint8Array>, onDelta: DeltaHandler | undefined, controller: AbortController, onNotice?: NoticeHandler): Promise<CompletionResult> {
    let content = "";
    const argBuffers = new Map<string, { name: string; arguments: string; order: number }>();
    let order = 0;
    let input = 0;
    let output = 0;
    let finished = false;
    let incomplete = false;

    const idleTimeout = this.config.thinkingTimeoutMs ?? Math.max(this.config.timeoutMs, 600_000);
    const idleAbort = () => {
      onNotice?.(`模型已 ${idleTimeout / 1000}s 没有任何输出，中断本次请求`);
      controller.abort(new Error(`model stream idle timeout after ${idleTimeout / 1000}s`));
    };
    let timer = setTimeout(idleAbort, idleTimeout);
    try {
      for await (const raw of sseData(stream, controller.signal)) {
        clearTimeout(timer);
        timer = setTimeout(idleAbort, idleTimeout);
        const data = parseModelEvent(raw);
        const type = String(data.type || "");
        if (type === "response.completed" || type === "response.complete") {
          const response = data.response as JsonObject | undefined;
          if (response) {
            const usage = response.usage as JsonObject | undefined;
            input = Number(usage?.input_tokens ?? input);
            output = Number(usage?.output_tokens ?? output);
            if (Array.isArray(response.output) && (response.output as unknown[]).length) {
              const parsed = outputItemsToResult(response.output, undefined);
              // Deltas already streamed; only adopt tool calls + missing text here.
              if (!content) content = parsed.content;
              for (const call of parsed.toolCalls) {
                if (![...argBuffers.values()].some((slot) => slot.name === call.function.name && slot.arguments === call.function.arguments)) {
                  argBuffers.set(call.id || `call-${order}`, { name: call.function.name, arguments: call.function.arguments, order: order++ });
                }
              }
            }
          }
          finished = true;
          break;
        }
        if (type === "response.incomplete" && incompleteReason(data.response as JsonObject | undefined) !== undefined) {
          // The provider ran out of output budget. Keep what streamed and let the
          // caller continue; only a content filter is a real stop.
          incomplete = true;
          finished = true;
          break;
        }
        if (type === "response.failed" || type === "response.incomplete" || type === "error") {
          throw new Error(`model stream error: ${JSON.stringify(data.response ?? data.error ?? data).slice(0, 600)}`);
        }
        if (type === "response.output_text.delta") {
          const delta = data.delta;
          if (typeof delta === "string") {
            content += delta;
            onDelta?.(delta, "content");
          }
        } else if (type === "response.function_call_arguments.delta") {
          const itemId = String(data.item_id || "");
          const delta = typeof data.delta === "string" ? data.delta : "";
          const slot = argBuffers.get(itemId) ?? { name: "", arguments: "", order: order++ };
          slot.arguments += delta;
          argBuffers.set(itemId, slot);
        } else if (type === "response.output_item.added") {
          const item = data.item as JsonObject | undefined;
          if (item?.type === "function_call") {
            const itemId = String((item as JsonObject).id || "");
            argBuffers.set(itemId, { name: String((item as JsonObject).name || ""), arguments: "", order: order++ });
          }
        } else if (type === "response.output_item.done") {
          const item = data.item as JsonObject | undefined;
          if (item?.type === "function_call") {
            const itemId = String((item as JsonObject).id || "");
            const slot = argBuffers.get(itemId);
            if (slot) {
              slot.name = String((item as JsonObject).name || slot.name);
              if (typeof (item as JsonObject).arguments === "string") slot.arguments = String((item as JsonObject).arguments);
            }
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (!finished) throw new Error("model stream ended before response.completed; partial response was not accepted");
    const toolCalls: ToolCall[] = [...argBuffers.entries()]
      .sort(([, a], [, b]) => a.order - b.order)
      .filter(([, slot]) => slot.name)
      .map(([id, slot]) => ({ id, type: "function" as const, function: { name: slot.name, arguments: slot.arguments || "{}" } }));
    const check = { truncated: incomplete };
    if (!incomplete && !content.trim() && !toolCalls.length) throw new Error("model returned an empty response");
    return finalizeCompletion(check, content, "", toolCalls, { input, output });
  }
}
