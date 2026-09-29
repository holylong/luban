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

function promptFor(messages: ChatMessage[], tools: Array<Record<string, unknown>>): string {
  return [
    "You are the model for luban. Return only the JSON response specified by the output schema.",
    "Do not use your own tools or modify files. Luban executes the tool calls you return after checking permissions.",
    "If a tool is needed, return its exact name and JSON-stringified arguments in tool_calls. Otherwise put the answer in content.",
    "Available luban tools:", JSON.stringify(tools),
    "Conversation (JSON):", JSON.stringify(messages.map(({ role, content, name, tool_call_id, tool_calls }) =>
      ({ role, content, name, tool_call_id, tool_calls }))),
  ].join("\n\n");
}

/** Uses the official Codex CLI and its ChatGPT login cache, never an API key. */
export class CodexClient {
  constructor(private readonly config: LubanConfig) {}

  async complete(messages: ChatMessage[], tools: Array<Record<string, unknown>>, signal: AbortSignal,
    onDelta?: DeltaHandler, _onNotice?: NoticeHandler, options?: ModelRequestOptions): Promise<CompletionResult> {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    if (messages.some((message) => message.images?.length)) {
      throw new Error("Codex CLI model backend does not yet support image attachments");
    }
    const dir = await mkdtemp(join(tmpdir(), "luban-codex-"));
    const schema = join(dir, "response.schema.json");
    const output = join(dir, "response.json");
    try {
      await writeFile(schema, JSON.stringify(OUTPUT_SCHEMA), { mode: 0o600 });
      const args = ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check",
        "--output-schema", schema, "--output-last-message", output,
        "-c", 'forced_login_method="chatgpt"', "-C", this.config.workspace];
      if (this.config.model.model !== "default") args.push("--model", this.config.model.model);
      if (this.config.model.reasoningEffort) args.push("-c", `model_reasoning_effort="${this.config.model.reasoningEffort}"`);
      args.push("-");
      const command = process.env.LUBAN_CODEX_BIN || "codex";
      const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
        let stderr = "";
        let timedOut = false;
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (part: string) => { stderr = (stderr + part).slice(-4000); });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stderr: timedOut ? `timed out after ${timeoutMs} ms. ${stderr}` : stderr }));
        const abort = () => child.kill("SIGTERM");
        signal.addEventListener("abort", abort, { once: true });
        child.on("close", () => signal.removeEventListener("abort", abort));
        const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs;
        const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
        child.on("close", () => clearTimeout(timer));
        child.stdin.on("error", () => {});
        child.stdin.end(promptFor(messages, tools));
      });
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      if (result.code !== 0) throw new Error(`Codex CLI failed: ${result.stderr.trim() || `exit ${result.code}`}. Run codex login with your ChatGPT Plus account.`);
      const raw = JSON.parse(await readFile(output, "utf8")) as { content?: unknown; tool_calls?: unknown };
      if (typeof raw.content !== "string" || !Array.isArray(raw.tool_calls)) throw new Error("Codex CLI returned an invalid response");
      const toolCalls: ToolCall[] = raw.tool_calls.map((item: unknown) => {
        const call = item as { name?: unknown; arguments?: unknown };
        if (typeof call.name !== "string" || typeof call.arguments !== "string") throw new Error("Codex CLI returned an invalid tool call");
        JSON.parse(call.arguments);
        return { id: `codex_${randomUUID()}`, type: "function", function: { name: call.name, arguments: call.arguments } };
      });
      if (raw.content) onDelta?.(raw.content, "content");
      return { content: raw.content, reasoning: "", toolCalls, usage: { input: 0, output: 0 } };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
