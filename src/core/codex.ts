import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, LubanConfig, ToolCall } from "./types.js";
import type { CompletionResult, DeltaHandler, NoticeHandler, ModelRequestOptions } from "./openai.js";

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
  return messages.map(({ role, content, name, tool_call_id, tool_calls }) =>
    JSON.stringify({ role, content, name, tool_call_id, tool_calls }));
}

function promptFor(messages: string[], tools: string, incremental = false): string {
  if (incremental) return [
    "Continue as the model for luban using the existing output schema and tools. Do not use your own tools.",
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

/** Uses the official Codex CLI and its ChatGPT login cache, never an API key. */
export class CodexClient {
  // Array identity isolates conversations and auxiliary compaction/handoff calls.
  // Snapshots detect in-place edits and compaction before reusing a thread.
  private readonly threads = new WeakMap<ChatMessage[], { id: string; messages: string[]; tools: string; model: string }>();
  constructor(private readonly config: LubanConfig) {}

  async complete(messages: ChatMessage[], tools: Array<Record<string, unknown>>, signal: AbortSignal,
    onDelta?: DeltaHandler, onNotice?: NoticeHandler, options?: ModelRequestOptions): Promise<CompletionResult> {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    if (messages.some((message) => message.images?.length)) {
      throw new Error("Codex CLI model backend does not yet support image attachments");
    }
    const dir = await mkdtemp(join(tmpdir(), "luban-codex-"));
    const schema = join(dir, "response.schema.json");
    const output = join(dir, "response.json");
    const snapshot = wireMessages(messages);
    const toolSchema = JSON.stringify(tools);
    const prior = this.threads.get(messages);
    const resume = prior && prior.tools === toolSchema && prior.model === this.config.model.model
      && snapshot.length > prior.messages.length
      && prior.messages.every((message, index) => snapshot[index] === message) ? prior : undefined;
    // Failed or cancelled turns must never be reused: Codex may have accepted
    // the input even when no valid completion reached luban.
    this.threads.delete(messages);
    let threadId: string | undefined;
    let usage: CompletionResult["usage"] = { input: 0, output: 0 };
    let reportedUsage = false;
    try {
      await writeFile(schema, JSON.stringify(OUTPUT_SCHEMA), { mode: 0o600 });
      const args = ["exec", "--sandbox", "read-only", "-C", this.config.workspace,
        ...(resume ? ["resume", resume.id] : []), "--json", "--skip-git-repo-check",
        "--output-schema", schema, "--output-last-message", output,
        "-c", 'forced_login_method="chatgpt"'];
      if (this.config.model.model !== "default") args.push("--model", this.config.model.model);
      // An absent override leaves Codex's own config.toml effort intact.
      const effort = options?.reasoningEffort ?? this.config.model.reasoningEffort;
      if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
      args.push("-");
      const command = process.env.LUBAN_CODEX_BIN || "codex";
      const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
        let stderr = "";
        let pending = "";
        let timedOut = false;
        const eventLine = (line: string) => {
          let event: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(line);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
            event = parsed as Record<string, unknown>;
          } catch { return; }
          if (event.type === "thread.started" && typeof event.thread_id === "string") threadId = event.thread_id;
          if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
            const values = event.usage as Record<string, unknown>;
            const tokens = (key: string): number => typeof values[key] === "number" && Number.isFinite(values[key])
              ? Math.max(0, values[key] as number) : 0;
            usage = { input: usage.input + tokens("input_tokens"), output: usage.output + tokens("output_tokens"),
              cached: (usage.cached ?? 0) + tokens("cached_input_tokens"),
              reasoning: (usage.reasoning ?? 0) + tokens("reasoning_output_tokens") };
            reportedUsage = true;
          }
          if (event.type === "turn.failed" || event.type === "error") {
            stderr = (stderr + JSON.stringify(event)).slice(-4000);
          }
        };
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (part: string) => {
          pending += part;
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            eventLine(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
          }
          // Agent message events can include large patches. Do not retain an
          // unbounded incomplete event from a broken CLI.
          if (pending.length > 8_000_000) { pending = ""; child.kill("SIGTERM"); }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (part: string) => { stderr = (stderr + part).slice(-4000); });
        child.on("error", reject);
        child.on("close", (code) => {
          if (pending.trim()) eventLine(pending);
          resolve({ code, stderr: timedOut ? `timed out after ${timeoutMs} ms. ${stderr}` : stderr });
        });
        const abort = () => child.kill("SIGTERM");
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        child.on("close", () => signal.removeEventListener("abort", abort));
        const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs;
        const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
        child.on("close", () => clearTimeout(timer));
        child.stdin.on("error", () => {});
        child.stdin.end(promptFor(resume ? snapshot.slice(resume.messages.length) : snapshot, toolSchema, Boolean(resume)));
      });
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      if (result.code !== 0) throw new Error(`Codex CLI failed: ${result.stderr.trim() || `exit ${result.code}`}. Run codex login with your ChatGPT Plus account.`);
      const raw = JSON.parse(await readFile(output, "utf8")) as { content?: unknown; tool_calls?: unknown };
      if (typeof raw.content !== "string" || !Array.isArray(raw.tool_calls)) throw new Error("Codex CLI returned an invalid response");
      const toolCalls: ToolCall[] = raw.tool_calls.map((item: unknown) => {
        const call = item as { name?: unknown; arguments?: unknown };
        if (typeof call.name !== "string" || typeof call.arguments !== "string") throw new Error("Codex CLI returned an invalid tool call");
        // Leave argument validation to AgentRunner. It reports malformed JSON as a
        // tool result so the model can correct the call instead of ending the task.
        return { id: `codex_${randomUUID()}`, type: "function", function: { name: call.name, arguments: call.arguments } };
      });
      const completedThread = threadId ?? resume?.id;
      if (completedThread) this.threads.set(messages, { id: completedThread, messages: snapshot, tools: toolSchema, model: this.config.model.model });
      if (!reportedUsage) onNotice?.("Codex CLI 未返回 token 用量；请更新 Codex CLI，当前统计不完整。");
      if (raw.content) onDelta?.(raw.content, "content");
      return { content: raw.content, reasoning: "", toolCalls, usage };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
