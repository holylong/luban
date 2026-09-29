import type { ChatMessage, LubanConfig, ToolCall } from "./types.js";
import { resolveImageParts } from "./vision.js";
import { finalizeCompletion } from "./openai.js";
import type { CompletionResult, DeltaHandler, NoticeHandler } from "./openai.js";

import { parseModelEvent, sseData, validateCompletion } from "./sse.js";
import { recoverTextToolCalls } from "./tool-call-text.js";

type JsonObject = Record<string, unknown>;

function endpoint(baseUrl: string): string {
  const value = baseUrl.replace(/\/$/, "") || "https://api.anthropic.com/v1";
  return value.endsWith("/messages") ? value : `${value}/messages`;
}

function parseArguments(value: string): JsonObject {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch { return {}; }
}

async function anthropicMessages(messages: ChatMessage[], workspace: string): Promise<{ system: string; messages: JsonObject[] }> {
  const system = messages.filter((message) => message.role === "system").map((message) => String(message.content || "")).join("\n\n");
  const output: JsonObject[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const block = { type: "tool_result", tool_use_id: message.tool_call_id, content: message.content || "" };
      const previous = output.at(-1);
      if (previous?.role === "user" && Array.isArray(previous.content) && (previous.content as JsonObject[]).every((item) => item.type === "tool_result")) {
        (previous.content as JsonObject[]).push(block);
      } else output.push({ role: "user", content: [block] });
      continue;
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      const content: JsonObject[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.tool_calls) content.push({
        type: "tool_use", id: call.id, name: call.function.name, input: parseArguments(call.function.arguments),
      });
      output.push({ role: "assistant", content });
    } else if (message.images?.length && (message.role === "user" || message.role === "assistant")) {
      const content: JsonObject[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const image of await resolveImageParts(workspace, message.images)) {
        content.push({ type: "image", source: { type: "base64", media_type: image.mime, data: image.base64 } });
      }
      output.push({ role: message.role, content });
    } else output.push({ role: message.role, content: message.content || "" });
  }
  return { system, messages: output };
}

function transient(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class AnthropicClient {
  constructor(private readonly config: LubanConfig) {}

  async complete(messages: ChatMessage[], tools: Array<Record<string, unknown>>, signal: AbortSignal, onDelta?: DeltaHandler, onNotice?: NoticeHandler): Promise<CompletionResult> {
    const converted = await anthropicMessages(messages, this.config.workspace);
    const anthropicTools = tools.map((entry) => {
      const fn = entry.function as JsonObject;
      return { name: fn.name, description: fn.description, input_schema: fn.parameters };
    });
    const retries = this.config.maxRetries ?? 3;
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted();
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason ?? new Error("aborted"));
      const timer = setTimeout(() => controller.abort(new Error(`model timed out after ${this.config.timeoutMs / 1_000}s`)), this.config.timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      try {
        const response = await fetch(endpoint(this.config.model.baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            ...(this.config.model.apiKey ? { "x-api-key": this.config.model.apiKey } : {}),
            ...this.config.model.headers,
          },
          body: JSON.stringify({
            model: this.config.model.model,
            system: converted.system,
            messages: converted.messages,
            max_tokens: this.config.maxTokens,
            ...(this.config.model.capabilities?.temperature === false ? {} : { temperature: this.config.temperature }),
            stream: true,
            ...(anthropicTools.length ? { tools: anthropicTools } : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.text();
          if (transient(response.status) && attempt < retries) {
            onNotice?.(`模型返回 HTTP ${response.status}，${(Math.min(8_000, 400 * (2 ** attempt)) / 1000).toFixed(1)}s 后重试（第 ${attempt + 2}/${retries + 1} 次）`);
            await delay(Math.min(8_000, 400 * (2 ** attempt)), signal);
            continue;
          }
          throw new Error(`model HTTP ${response.status}: ${body.slice(0, 600)}`);
        }
        if ((response.headers.get("content-type") || "").includes("text/event-stream")) {
          if (!response.body) throw new Error("model returned an empty stream");
          clearTimeout(timer);
          return await this.consumeStream(response.body, onDelta, controller, onNotice, signal);
        }
        const data = await response.json() as JsonObject;
        const blocks = Array.isArray(data.content) ? data.content as JsonObject[] : [];
        const content = blocks.filter((block) => block.type === "text").map((block) => String(block.text || "")).join("");
        const reasoning = blocks.filter((block) => block.type === "thinking").map((block) => String(block.thinking || "")).join("");
        const toolCalls: ToolCall[] = blocks.filter((block) => block.type === "tool_use").map((block) => ({
          id: String(block.id || ""), type: "function", function: { name: String(block.name || ""), arguments: JSON.stringify(block.input ?? {}) },
        }));
        const recovered = recoverTextToolCalls(content);
        const calls = [...toolCalls, ...recovered.toolCalls];
        const check = validateCompletion(recovered.content, calls, data.stop_reason);
        if (reasoning) onDelta?.(reasoning, "reasoning");
        if (recovered.content) onDelta?.(recovered.content, "content");
        const usage = data.usage && typeof data.usage === "object" ? data.usage as JsonObject : {};
        return finalizeCompletion(check, recovered.content, reasoning, calls,
          { input: Number(usage.input_tokens || 0), output: Number(usage.output_tokens || 0) });
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    }
  }

  private async consumeStream(stream: ReadableStream<Uint8Array>, onDelta: DeltaHandler | undefined, controller: AbortController, onNotice?: NoticeHandler, signal?: AbortSignal): Promise<CompletionResult> {
    const toolSlots = new Map<number, ToolCall>();
    let finished = false;
    let finishReason: unknown;
    let content = "";
    let reasoning = "";
    let input = 0;
    let output = 0;
    const idleTimeout = this.config.thinkingTimeoutMs ?? Math.max(this.config.timeoutMs, 600_000);
    const idleAbort = () => {
      onNotice?.(`模型已 ${idleTimeout / 1000}s 没有任何输出，中断本次请求`);
      controller.abort(new Error(`model stream idle timeout after ${idleTimeout / 1000}s`));
    };
    let timer = setTimeout(idleAbort, idleTimeout);
    let failure: unknown;
    try {
      for await (const raw of sseData(stream, controller.signal)) {
        clearTimeout(timer);
        timer = setTimeout(idleAbort, idleTimeout);
        const data = parseModelEvent(raw);
        if (data.type === "message_stop") { finished = true; break; }
        const message = data.message && typeof data.message === "object" ? data.message as JsonObject : {};
        const usage = (data.usage && typeof data.usage === "object" ? data.usage : message.usage) as JsonObject | undefined;
        input = Number(usage?.input_tokens ?? input);
        output = Number(usage?.output_tokens ?? output);
        const index = Number(data.index ?? 0);
        const block = data.content_block && typeof data.content_block === "object" ? data.content_block as JsonObject : {};
        if (block.type === "tool_use") {
          toolSlots.set(index, { id: String(block.id || ""), type: "function", function: { name: String(block.name || ""), arguments: "" } });
        }
        const delta = data.delta && typeof data.delta === "object" ? data.delta as JsonObject : {};
        if (delta.stop_reason != null) finishReason = delta.stop_reason;
        if (typeof delta.text === "string") { content += delta.text; onDelta?.(delta.text, "content"); }
        if (typeof delta.thinking === "string") { reasoning += delta.thinking; onDelta?.(delta.thinking, "reasoning"); }
        if (typeof delta.partial_json === "string") {
          const slot = toolSlots.get(index);
          if (slot) slot.function.arguments += delta.partial_json;
        }
      }
    } catch (error) {
      failure = error;
    } finally { clearTimeout(timer); }
    if (signal?.aborted) throw signal.reason ?? failure ?? new Error("aborted");
    if (!finished) {
      // Same recovery as the OpenAI client: a dropped or stalled stream keeps
      // the text it already produced and lets the runner ask for the rest.
      const declared = failure instanceof Error
        && /model stream error|model returned malformed|model returned invalid|model SSE event exceeds/u.test(failure.message);
      if (declared) throw failure;
      if (content || reasoning || toolSlots.size) {
        onNotice?.("模型连接在输出中途中断，已保留已收到的内容并继续");
        return { content, reasoning, toolCalls: [], usage: { input, output }, truncated: true, streamEnded: true };
      }
      throw failure ?? new Error("model stream ended before message_stop; partial response was not accepted");
    }
    for (const call of toolSlots.values()) if (!call.function.arguments) call.function.arguments = "{}";
    const recovered = recoverTextToolCalls(content);
    const calls = [...toolSlots.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    const allCalls = [...calls, ...recovered.toolCalls];
    const check = validateCompletion(recovered.content, allCalls, finishReason);
    return finalizeCompletion(check, recovered.content, reasoning, allCalls, { input, output });
  }
}
