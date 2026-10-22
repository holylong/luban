import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, LubanConfig, ToolCall } from "./types.js";
import type { CompletionResult, DeltaHandler, NoticeHandler, ModelRequestOptions } from "./openai.js";
import { codexInvocation } from "./codex-command.js";
import { PLAN_MARKER, VERIFICATION_MARKER } from "./plan.js";
import { resolveImageParts } from "./vision.js";

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    content: { type: "string" },
    tool_calls: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, arguments: { type: "string" } },
        required: ["name", "arguments"],
        additionalProperties: false,
      },
    },
  },
  required: ["content", "tool_calls"],
  additionalProperties: false,
} as const;

function wireMessages(messages: ChatMessage[]): string[] {
  return messages.map(({ role, content, name, tool_call_id, tool_calls, images }) =>
    JSON.stringify({ role, content, name, tool_call_id, tool_calls, ...(images?.length ? { images } : {}) }));
}

function promptFor(messages: string[], tools: string, incremental = false, state?: string[]): string {
  if (incremental) return [
    "Continue as the model for luban using the existing output schema and tools. Do not use your own tools.",
    ...(state ? [
      "Current authoritative luban plan/verification state (JSON). This replaces the previous plan/verification state, including when empty:",
      `[${state.join(",")}]`,
    ] : []),
    "New authoritative luban messages (JSON); tool call IDs and execution results come from luban:",
    `[${messages.join(",")}]`,
  ].join("\n\n");
  return [
    "You are the model for luban. Return only the JSON response specified by the output schema.",
    "Do not use your own tools or modify files. Luban executes the tool calls you return after checking permissions.",
    "If a tool is needed, return its exact name and valid JSON-stringified arguments in tool_calls. Escape backslashes inside JSON string values. Otherwise put the answer in content.",
    "Available luban tools:", tools,
    "Conversation (JSON):", `[${messages.join(",")}]`,
  ].join("\n\n");
}

interface CodexThread {
  id: string;
  messages: string[];
  state: string[];
  tools: string;
  model: string;
  usage: CompletionResult["usage"];
}

function runtimeState(message: ChatMessage): boolean {
  return message.role === "system" && [PLAN_MARKER, VERIFICATION_MARKER]
    .some(marker => String(message.content).startsWith(marker));
}

class CodexOutputError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

function parseResponse(text: string): { content: string; tool_calls: Array<{ name: string; arguments: string }> } {
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== "object") throw new Error("invalid response object");
  const value = raw as { content?: unknown; tool_calls?: unknown };
  if (typeof value.content !== "string" || !Array.isArray(value.tool_calls)
    || (!value.content.trim() && !value.tool_calls.length)
    || value.tool_calls.some(call => !call || typeof call.name !== "string" || typeof call.arguments !== "string")) {
    throw new Error("invalid structured response");
  }
  return value as ReturnType<typeof parseResponse>;
}

/** Uses the official Codex CLI and its ChatGPT login cache, never an API key. */
export class CodexClient {
  // AgentRunner supplies a stable identity across TUI transcript copies. Direct
  // and auxiliary callers retain array isolation. Real history edits, changed
  // instructions, tool schemas and compaction still invalidate a thread.
  private readonly threads = new WeakMap<ChatMessage[], CodexThread>();
  private readonly conversations = new Map<string, CodexThread>();
  constructor(private readonly config: LubanConfig) {}

  async complete(messages: ChatMessage[], tools: Array<Record<string, unknown>>, signal: AbortSignal,
    onDelta?: DeltaHandler, onNotice?: NoticeHandler, options?: ModelRequestOptions): Promise<CompletionResult> {
    const retries = Math.min(2, Math.max(0, options?.maxRetries ?? this.config.maxRetries ?? 2));
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted();
      try {
        return await this.completeAttempt(messages, tools, signal, onDelta, onNotice, options);
      } catch (error) {
        if (signal.aborted || !(error instanceof CodexOutputError) || attempt >= retries) throw error;
        onNotice?.(`Codex CLI 未返回有效结果，正在自动恢复（${attempt + 1}/${retries}）；已完成的工具操作保留`);
      }
    }
  }

  private async completeAttempt(messages: ChatMessage[], tools: Array<Record<string, unknown>>, signal: AbortSignal,
    onDelta?: DeltaHandler, onNotice?: NoticeHandler, options?: ModelRequestOptions): Promise<CompletionResult> {
    signal.throwIfAborted();
    const dir = await mkdtemp(join(tmpdir(), "luban-codex-"));
    const schema = join(dir, "response.schema.json");
    const output = join(dir, "response.json");
    const snapshot = wireMessages(messages.filter(message => !runtimeState(message)));
    const state = wireMessages(messages.filter(runtimeState));
    const toolSchema = JSON.stringify(tools);
    const conversationId = options?.conversationId;
    const prior = conversationId ? this.conversations.get(conversationId) : this.threads.get(messages);
    const resume = prior && prior.tools === toolSchema && prior.model === this.config.model.model
      && snapshot.length > prior.messages.length
      && prior.messages.every((message, index) => snapshot[index] === message) ? prior : undefined;
    // Failed or cancelled turns must never be reused: Codex may have accepted
    // the input even when no valid completion reached luban.
    if (conversationId) this.conversations.delete(conversationId);
    else this.threads.delete(messages);
    let threadId: string | undefined;
    let usage: CompletionResult["usage"] = { input: 0, output: 0 };
    // exec resume reports cumulative thread totals, not just the resumed call.
    let totalUsage: CompletionResult["usage"] = resume?.usage ?? { input: 0, output: 0 };
    let reportedUsage = false;
    let eventOutput: string | undefined;
    let turnCompleted = false;
    let turnFailed = false;
    try {
      await writeFile(schema, JSON.stringify(OUTPUT_SCHEMA), { mode: 0o600 });
      const sentMessages = resume
        ? messages.filter(message => !runtimeState(message)).slice(resume.messages.length)
        : messages;
      const imageArgs: string[] = [];
      const imageManifest: Array<{ image: number; message: number; path: string }> = [];
      for (const [index, message] of sentMessages.entries()) {
        const images = await resolveImageParts(this.config.workspace, message.images);
        if (images.length < (message.images?.length ?? 0)) {
          onNotice?.("部分图片附件无法读取或超出限制，已跳过；文字请求继续处理。");
        }
        for (const image of images) {
          const number = imageManifest.length + 1;
          const extension = image.mime.split("/")[1]!.replace(/[^a-z0-9]/gi, "");
          const path = join(dir, `image-${number}.${extension}`);
          await writeFile(path, Buffer.from(image.base64, "base64"), { mode: 0o600 });
          imageArgs.push("--image", path);
          imageManifest.push({ image: number, message: index + 1, path: image.path });
        }
      }
      signal.throwIfAborted();
      const args = ["exec", "--sandbox", "read-only", "-C", this.config.workspace,
        ...(resume ? ["resume", resume.id] : []), "--json", "--skip-git-repo-check",
        "--output-schema", schema, "--output-last-message", output,
        "-c", 'forced_login_method="chatgpt"', ...imageArgs];
      if (this.config.model.model !== "default") args.push("--model", this.config.model.model);
      // An absent override leaves Codex's own config.toml effort intact.
      const effort = options?.reasoningEffort ?? this.config.model.reasoningEffort;
      if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
      args.push("-");
      const result = await new Promise<{ code: number | null; stderr: string; timedOut: boolean }>((resolve, reject) => {
        const child = spawn(...codexInvocation(args), { stdio: ["pipe", "pipe", "pipe"] });
        let stderr = "";
        let pending = "";
        let timedOut = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const terminate = () => {
          child.kill("SIGTERM");
          killTimer ??= setTimeout(() => child.kill("SIGKILL"), 5000);
        };
        const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs;
        const idleAbort = () => { timedOut = true; terminate(); };
        // CLI event activity extends the wait; long productive turns have no
        // absolute deadline. Reconnection starts only after this child closes.
        let timer = setTimeout(idleAbort, timeoutMs);
        const eventLine = (line: string) => {
          let event: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(line);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
            event = parsed as Record<string, unknown>;
          } catch { return; }
          if (event.type === "thread.started" && typeof event.thread_id === "string") threadId = event.thread_id;
          if (event.type === "turn.started") { eventOutput = undefined; turnCompleted = false; turnFailed = false; }
          if (event.type === "item.completed") {
            const item = event.item as { type?: unknown; text?: unknown } | undefined;
            if (item?.type === "agent_message" && typeof item.text === "string") eventOutput = item.text;
          }
          if (event.type === "turn.completed") turnCompleted = true;
          if (event.type === "turn.failed") turnFailed = true;
          if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
            const values = event.usage as Record<string, unknown>;
            const tokens = (key: string): number => typeof values[key] === "number" && Number.isFinite(values[key])
              ? Math.max(0, values[key] as number) : 0;
            const next = { input: tokens("input_tokens"), output: tokens("output_tokens"),
              cached: tokens("cached_input_tokens"), reasoning: tokens("reasoning_output_tokens") };
            usage = { input: usage.input + Math.max(0, next.input - totalUsage.input),
              output: usage.output + Math.max(0, next.output - totalUsage.output),
              cached: (usage.cached ?? 0) + Math.max(0, next.cached - (totalUsage.cached ?? 0)),
              reasoning: (usage.reasoning ?? 0) + Math.max(0, next.reasoning - (totalUsage.reasoning ?? 0)) };
            totalUsage = next;
            reportedUsage = true;
          }
          if (event.type === "turn.failed" || event.type === "error") {
            stderr = (stderr + JSON.stringify(event)).slice(-4000);
          }
        };
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (part: string) => {
          if (!timedOut) { clearTimeout(timer); timer = setTimeout(idleAbort, timeoutMs); }
          pending += part;
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            eventLine(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
          }
          // Agent message events can include large patches. Do not retain an
          // unbounded incomplete event from a broken CLI.
          if (pending.length > 8_000_000) { pending = ""; terminate(); }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (part: string) => { stderr = (stderr + part).slice(-4000); });
        child.on("error", reject);
        child.on("close", (code) => {
          if (pending.trim()) eventLine(pending);
          resolve({ code, stderr: timedOut ? `idle timeout: timed out after ${timeoutMs} ms without CLI events. ${stderr}` : stderr, timedOut });
        });
        const abort = terminate;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        child.on("close", () => signal.removeEventListener("abort", abort));
        child.on("close", () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); });
        child.stdin.on("error", () => {});
        const changedState = resume && JSON.stringify(state) !== JSON.stringify(resume.state) ? state : undefined;
        const prompt = promptFor(resume ? snapshot.slice(resume.messages.length) : wireMessages(messages), toolSchema, Boolean(resume), changedState);
        child.stdin.end(prompt + (imageManifest.length
          ? `\n\nNative image attachments, in order (message numbers refer to the messages in this request):\n${JSON.stringify(imageManifest)}\nThese images are attached natively; inspect them directly. If an attachment is unavailable, say so instead of guessing its contents.`
          : ""));
      });
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      if (result.timedOut || result.code !== 0 || turnFailed) throw new Error(`Codex CLI failed: ${result.stderr.trim() || `exit ${result.code}`}`);
      let raw: ReturnType<typeof parseResponse>;
      try {
        raw = parseResponse(await readFile(output, "utf8"));
      } catch (error) {
        // Recover only the completed turn's final agent message, never partial text.
        try {
          if (!turnCompleted || eventOutput === undefined) throw error;
          raw = parseResponse(eventOutput);
        } catch {
          const reason = error instanceof Error ? error.message : String(error);
          throw new CodexOutputError(`Codex CLI 未生成有效结构化结果（${/ENOENT/.test(reason) ? "输出文件缺失" : "输出为空或格式无效"}）${result.stderr.trim() ? `：${result.stderr.trim()}` : ""}；已完成的工具操作保留。`, /ENOENT/.test(reason) ? "CODEX_OUTPUT_MISSING" : undefined);
        }
        onNotice?.("Codex 输出文件不可用，已从完整事件流恢复结果。");
      }
      const toolCalls: ToolCall[] = raw.tool_calls.map((item: unknown) => {
        const call = item as { name?: unknown; arguments?: unknown };
        if (typeof call.name !== "string" || typeof call.arguments !== "string") throw new Error("Codex CLI returned an invalid tool call");
        // Leave argument validation to AgentRunner. It reports malformed JSON as a
        // tool result so the model can correct the call instead of ending the task.
        return { id: `codex_${randomUUID()}`, type: "function", function: { name: call.name, arguments: call.arguments } };
      });
      const completedThread = threadId ?? resume?.id;
      if (completedThread) {
        const thread: CodexThread = { id: completedThread, messages: snapshot, state, tools: toolSchema,
          model: this.config.model.model, usage: totalUsage };
        if (conversationId) {
          this.conversations.set(conversationId, thread);
          if (this.conversations.size > 8) this.conversations.delete(this.conversations.keys().next().value!);
        } else this.threads.set(messages, thread);
      }
      if (!reportedUsage) onNotice?.("Codex CLI 未返回 token 用量；请更新 Codex CLI，当前统计不完整。");
      if (raw.content) onDelta?.(raw.content, "content");
      return { content: raw.content, reasoning: "", toolCalls, usage };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
