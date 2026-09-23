import { AgentInbox } from "./inbox.js";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { arch, release, type } from "node:os";
import { dirname, join, resolve } from "node:path";
import { OpenAiClient, type ModelRequestOptions } from "./openai.js";
import { AnthropicClient } from "./anthropic.js";
import { ResponsesClient } from "./responses.js";
import { enforceAgentIdentity, extractFinalAnswer } from "./reasoning.js";
import { clipContextText, compactMessages, estimateMessagesTokens } from "./context.js";
import { isContextOverflowError } from "./model-errors.js";
import { repairToolHistory } from "./history.js";
import { planTools, planVerificationStatus } from "./plan.js";
import { attachImageTools } from "./vision.js";
import { autoMergeWorktree, checkDiffApplies, createWorktree, disposeWorktree, isGitRepo, worktreeDiff } from "./worktree.js";
import { attachInstructions, instructionSnapshot, scopedInstructions, toolPaths } from "./instructions.js";
import { ToolOutputStore } from "./tool-output.js";
import { McpManager } from "./mcp.js";
import type { MeshRuntime } from "./mesh/runtime.js";
import { createTools, openAiToolSchemas } from "./tools.js";
import type {
  AgentEvent,
  AgentMode,
  ChatMessage,
  LubanConfig,
  PendingInput,
  RunResult,
  ToolDefinition,
} from "./types.js";

export type Approval = "once" | "tool" | "always" | "deny";
export type ApproveTool = (tool: ToolDefinition, args: Record<string, unknown>) => Promise<Approval>;

function wildcard(pattern: string, value: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`, "i").test(value);
}

function permissionRuleMatches(rule: string, tool: ToolDefinition, args: Record<string, unknown>): boolean {
  const colon = rule.indexOf(":");
  const toolPattern = colon < 0 ? rule : rule.slice(0, colon);
  if (!wildcard(toolPattern.trim() || "*", tool.name)) return false;
  if (colon < 0) return true;
  const value = tool.name === "bash" ? String(args.command ?? "")
    : String(args.path ?? args.peer ?? args.server ?? JSON.stringify(args));
  return wildcard(rule.slice(colon + 1).trim() || "*", value);
}

/**
 * How much planning instrumentation the run should ask for.
 *
 * `always` costs one extra model round-trip per task, because the plan call is
 * required before any other tool. That round-trip is worth it on long work and
 * pure overhead on "commit my code", so the default only plans when the work
 * actually spans several steps.
 */
export type PlanningMode = "off" | "auto" | "always";

const PROMPT_HEADER = `You are luban, a production coding agent working directly in the user's workspace.

Work rules:
1. Inspect relevant files before editing. For TypeScript/JavaScript use code_intelligence to resolve definitions/references and check diagnostics after changes. Other languages use code_intelligence text fallback plus the project's own toolchain. Follow AGENTS.md or CLAUDE.md instructions when present.
2. Use tools to perform requested work; do not merely describe what you would do.
3. Keep changes scoped. Never commit, publish, or contact people unless explicitly requested.
3a. When the user explicitly asks to commit and push code to the configured Git remote, call git_publish directly with a concise commit message. It checks the repository, commits changes if needed, and pushes in one tool call. Do not create a plan or split this routine request into separate status/add/commit/push calls. If the user asked for additional code changes or checks, complete those first.`;

const PLANNING_RULES: Record<PlanningMode, string> = {
  always: `4. For every non-trivial task, make update_plan your first tool call before inspecting or changing files. Break the work into concrete steps, keep the plan current, and include a verification step. Simple questions that need no tools do not need a plan. Verify changes with focused tests or commands before claiming success. A completed plan is not proof that tests passed.
5. Record every test/check with record_verification (command, passed/failed, key output). If verification failed or is missing, say so explicitly; never claim unverified success.`,
  // The plan call is one full model round-trip. Ask for it only when the work
  // really is multi-step, and say outright that a single-step task must not
  // call it just to satisfy the rule.
  auto: `4. Plan only when the work genuinely spans several steps: then call update_plan once before you start, keep it current, and include a verification step. For a single-step task or a question, skip the plan and go straight to the work - do not call update_plan just to satisfy this rule. Verify changes with focused tests or commands before claiming success. A completed plan is not proof that tests passed.
5. When you run a test or check, record it with record_verification (command, passed/failed, key output) in the same turn. If verification failed or is missing, say so explicitly; never claim unverified success.`,
  off: `4. Go straight to the work; do not call update_plan. Verify changes with focused tests or commands before claiming success.
5. State the command and result of any check you run in your final answer. If verification failed or is missing, say so explicitly; never claim unverified success.`,
};

const PROMPT_FOOTER = `6. If a tool fails, diagnose it and change strategy. Do not repeat identical calls indefinitely. A bash result ending in [exit code: N] is not a tool failure: many commands exit non-zero by design (grep with no match, git diff --quiet, test -f, command -v). Read the code and the output, and only treat it as an error when the command was supposed to succeed. Builds, test suites and installs often exceed the bash timeout: give them a larger timeout when you know they are slow, or start them with background: true and poll with get_background_task instead of retrying a killed command.
7. End with a concise outcome: what changed, verification, and any real blocker.
8. Paths are workspace-relative. Do not attempt to escape the workspace. The bash tool is soft-sandboxed: destructive host commands, writes outside the workspace, and denied patterns are rejected before execution. This is not an OS container; do not run untrusted payloads to probe it. Screenshots arrive as native vision parts when the user @-attaches them; describe what you see and cite the file name.
9. Never expose chain-of-thought, policy analysis, system reminders, or other internal reasoning in assistant content. Return only the user-facing result. Use a separate reasoning channel when the runtime supports one.
10. Create a checkpoint before broad or risky multi-file edits when the workspace is a Git repository.
11. Identity: your product name is luban. If the user asks your name or who you are, say you are luban, the coding agent working in their workspace. Never claim to be the underlying model (for example Qwen or Claude). If the user asks which model or LLM powers you, answer honestly with the configured model name.

 The user can choose ASK for conversational help, AGENT for autonomous execution, or AUTO to let the app decide.`;

/** The full system prompt for a planning mode. */
export function systemPrompt(planning: PlanningMode = "auto"): string {
  return `${PROMPT_HEADER}\n${PLANNING_RULES[planning]}\n${PROMPT_FOOTER}`;
}

/** Default prompt, kept for callers that only need the stable first line. */
export const SYSTEM_PROMPT = systemPrompt("auto");

function workspaceInstructions(workspace: string): string {
  const sections: string[] = [];
  let directory = resolve(workspace);
  for (;;) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const path = join(directory, name);
      if (!existsSync(path)) continue;
      try {
        const content = readFileSync(path, "utf8").trim();
        if (content) sections.push(`<instructions file="${path}">\n${content.slice(0, 20_000)}\n</instructions>`);
      } catch {
        // An unreadable optional instructions file must not prevent startup.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return sections.reverse().join("\n\n");
}

// The bash tool runs cmd.exe on Windows and a login shell elsewhere, so the
// model needs to know the host platform to write commands that actually work.
function platformContext(): string {
  const windows = process.platform === "win32";
  const shell = windows
    ? `${process.env.ComSpec || "cmd.exe"} — the bash tool executes commands through cmd.exe, not bash; use cmd syntax (NUL instead of /dev/null, %VAR% instead of $VAR, no head/tail/grep/ls)`
    : (process.env.SHELL || "/bin/bash");
  return `Platform: ${process.platform} (${type()} ${release()}, ${arch()})\nShell: ${shell}`;
}

export function initialMessages(workspace: string, modelName?: string, planning: PlanningMode = "auto"): ChatMessage[] {
  const instructions = workspaceInstructions(workspace);
  return [{
    role: "system",
    content: `${systemPrompt(planning)}\n\nWorkspace: ${workspace}\n${platformContext()}${modelName ? `\nModel: ${modelName}` : ""}${instructions ? `\n\n${instructions}` : ""}`,
  }];
}

function lastUserQuestion(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && message.name !== TRUNCATION_MARKER && message.content) return String(message.content);
  }
  return "";
}

function currentTurnHasToolError(messages: ChatMessage[]): boolean {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === "user" && messages[index]!.name !== TRUNCATION_MARKER) { lastUser = index; break; }
  }
  return messages.slice(lastUser + 1).some((message) => message.role === "tool" && String(message.content).startsWith("TOOL ERROR:"));
}

/** Conservative fast path: any request that also asks for coding work keeps full thinking. */
export function isRoutineGitPublishRequest(text: string): boolean {
  const request = text.replace(/不(?:要|用|必)(?:修改文件|创建计划|运行测试)/gu, "").trim();
  return request.length <= 240
    && /提交|推送|commit|push/iu.test(request)
    && /服务器|上游|远端|remote|推送|push/iu.test(request)
    && !/修复|开发|实现|修改|重构|调试|测试|分析|检查|部署|fix|implement|refactor|test|debug|deploy/iu.test(request);
}

/** A local, zero-round-trip decision. Unknown work keeps thinking enabled. */
export function shouldThink(text: string): boolean {
  const request = text.trim();
  if (isRoutineGitPublishRequest(request)) return false;
  if (request.length > 180 || /修复|开发|实现|重构|调试|测试|分析|设计|架构|优化|排查|为什么|如何|比较|对比|证明|推导|部署|fix|implement|refactor|debug|test|analy[sz]e|design|architect|optimi[sz]e|why|how|compare|deploy/iu.test(request)) return true;
  if (/^(?:你好|您好|早上好|晚上好|你叫什么名字|你是谁)[？?!！。\s]*$/u.test(request)) return false;
  if (/^(?:请)?(?:查看|显示|列出|读取|查询)(?:一下)?(?:当前|这个|仓库的)?(?:\s*git\s*status|\s*git状态|\s*仓库状态|\s*文件列表|\s*目录列表)[？?!！。\s]*$/iu.test(request)) return false;
  if (/^(?:请)?(?:把|将)\s*[\w./-]+\s*(?:中的?|的)?\s*[^，。；;]{1,60}\s*(?:改成|改为|替换为)\s*[^，。；;]{1,60}[。\s]*$/u.test(request)
      && !/同时|顺便|然后|并且/u.test(request)) return false;
  return true;
}

interface ModelClient {
  complete(
    messages: ChatMessage[],
    tools: Array<Record<string, unknown>>,
    signal: AbortSignal,
    onDelta?: (text: string, kind: "content" | "reasoning") => void,
    /** Retry/timeout progress for the wait between requests. */
    onNotice?: (text: string) => void,
    options?: ModelRequestOptions,
  ): Promise<{ content: string; reasoning?: string; toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>; usage: { input: number; output: number }; truncated?: boolean }>;
}

/**
 * How many times one run asks the model to continue past a provider's output cap
 * before reporting it. Three covers a long answer split by a small cap without
 * letting a model that only reasons loop forever.
 */
const MAX_TRUNCATION_CONTINUES = 3;
/** Marks the nudge that asks for the rest of a truncated answer. */
const TRUNCATION_MARKER = "output-limit";

export class AgentRunner {
  readonly tools: Map<string, ToolDefinition>;
  private readonly client: ModelClient;
  private readonly mcp: McpManager;
  private readonly outputs: ToolOutputStore;
  private mcpDiscovered = false;
  private trustSession = false;
  private running = false;
  private inbox?: AgentInbox;
  private activeController?: AbortController;
  private readonly trustedTools = new Set<string>();
  private budgetUsed = 0;

  constructor(readonly config: LubanConfig, client?: ModelClient, mesh?: MeshRuntime, private readonly depth = 0) {
    this.tools = createTools(config, mesh);
    this.outputs = new ToolOutputStore(config.home);
    const outputTool = this.outputs.tool();
    this.tools.set(outputTool.name, outputTool);
    this.mcp = new McpManager(config);
    // The Responses API shares the Chat Completions transport here; provider
    // gateways that require native /responses payloads should set a dedicated
    // baseUrl and file an issue with a recorded request/response pair.
    this.client = client ?? (config.model.api === "anthropic"
      ? new AnthropicClient(config)
      : config.model.api === "responses" ? new ResponsesClient(config) : new OpenAiClient(config));
    if (depth < 2) {
      const runChild = async (instruction: string, maxSteps: number, signal: AbortSignal, readOnly: boolean, useWorktree: boolean, autoMerge: boolean, parentBudget: () => number): Promise<string> => {
        const capped = Math.max(1, Math.min(maxSteps, parentBudget()));
        if (capped < 1) throw new Error("parent step budget exhausted; cannot delegate further subtasks");
        const childConfig: LubanConfig = {
          ...config,
          maxSteps: capped,
          ...(readOnly ? { permissionMode: "ask" as const, permissions: { ...(config.permissions ?? { allow: [], deny: [] }), allow: [] } } : {}),
        };
        let worktree: string | undefined;
        try {
          if (useWorktree && !readOnly) {
            if (await isGitRepo(config.workspace, signal)) {
              worktree = await createWorktree(config.workspace, signal);
              childConfig.workspace = worktree;
            }
          }
          const child = new AgentRunner(childConfig, undefined, mesh, depth + 1);
          const childMessages: ChatMessage[] = [
            ...initialMessages(childConfig.workspace, config.model.name, childConfig.planning),
            { role: "user", content: `Work as a focused subagent. Return a concise report to the parent agent.\n\n${instruction}` },
          ];
          try {
            const result = await child.run(
              childMessages, "agent", signal, () => undefined,
              async () => childConfig.permissionMode === "allow" ? "always" : "deny",
            );
            let suffix = "";
            if (worktree) {
              if (autoMerge) {
                const merged = await autoMergeWorktree(config.workspace, worktree, signal)
                  .catch((error) => `merge failed: ${error instanceof Error ? error.message : String(error)}`);
                suffix = `\n\n[worktree: ${worktree}]\n${merged.slice(0, 4000)}`;
              } else {
                const diff = await worktreeDiff(worktree, signal).catch((error) => `diff unavailable: ${error instanceof Error ? error.message : String(error)}`);
                const applies = await checkDiffApplies(config.workspace, worktree, signal)
                  .then((text) => text)
                  .catch((error) => error instanceof Error ? error.message : String(error));
                suffix = `\n\n[worktree: ${worktree}]\n${diff.slice(0, 8000)}\nMerge check: ${applies}`;
              }
            }
            return `Subagent ${result.ok ? "completed" : "stopped"} after ${result.steps} steps (budget ${capped}):\n${result.text}${suffix}`;
          } finally {
            child.close();
          }
        } finally {
          if (worktree) await disposeWorktree(config.workspace, worktree, signal).catch(() => undefined);
        }
      };
      this.tools.set("delegate_task", {
        name: "delegate_task",
        description: "Run a focused task in an independent child-agent context. Set use_worktree true for write tasks in a git repo to isolate edits; the result includes a diff and merge check for the parent to apply. In ask mode the child is read-only; after session trust it may edit.",
        risk: "execute",
        parameters: {
          type: "object",
          properties: {
            instruction: { type: "string" },
            max_steps: { type: "integer", minimum: 1, maximum: 30 },
            use_worktree: { type: "boolean", description: "Isolate file edits in a temporary git worktree (write tasks only)" },
            auto_merge: { type: "boolean", description: "Apply the worktree diff into the workspace after completion; conflicts are saved under .luban/conflicts/" },
          },
          required: ["instruction"],
          additionalProperties: false,
        },
        execute: async (args, signal) => {
          const instruction = typeof args.instruction === "string" ? args.instruction.trim() : "";
          if (!instruction) throw new Error("missing string argument: instruction");
          const requestedSteps = Number(args.max_steps ?? 15);
          return runChild(instruction, Math.max(1, Math.min(30, Number.isFinite(requestedSteps) ? Math.trunc(requestedSteps) : 15)), signal, false, args.use_worktree === true, args.auto_merge === true, () => Math.max(0, this.config.maxSteps - this.budgetUsed));
        },
      });
      this.tools.set("delegate_tasks", {
        name: "delegate_tasks",
        description: "Run 2-4 independent read-only research or review tasks concurrently in separate child-agent contexts.",
        risk: "execute",
        parameters: {
          type: "object",
          properties: {
            instructions: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } },
            max_steps: { type: "integer", minimum: 1, maximum: 20 },
          },
          required: ["instructions"], additionalProperties: false,
        },
        execute: async (args, signal) => {
          const instructions = Array.isArray(args.instructions) ? args.instructions.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 4) : [];
          if (instructions.length < 2) throw new Error("delegate_tasks requires 2-4 instructions");
          const requested = Number(args.max_steps ?? 12);
          const steps = Math.max(1, Math.min(20, Number.isFinite(requested) ? Math.trunc(requested) : 12));
          const results = await Promise.all(instructions.map((instruction) => runChild(instruction, steps, signal, true, false, false, () => Math.max(0, this.config.maxSteps - this.budgetUsed))));
          return results.map((result, index) => `## Subagent ${index + 1}\n${result}`).join("\n\n");
        },
      });
    }
  }

  allowAllForSession(): void {
    this.trustSession = true;
  }

  close(): void {
    this.activeController?.abort(new Error("Agent runner closed"));
    for (const tool of this.tools.values()) tool.close?.();
    this.mcp.close();
  }

  enqueueInput(text: string, delivery: "steer" | "queue" = "steer", images: PendingInput["images"] = []): Promise<string> {
    if (!this.running || !this.inbox) return Promise.reject(new Error("No agent run is accepting input"));
    return this.inbox.enqueue(text, delivery, images);
  }

  async run(
    messages: ChatMessage[],
    mode: AgentMode,
    signal: AbortSignal,
    onEvent: (event: AgentEvent) => void,
    approve: ApproveTool,
    persist: () => Promise<void> = async () => undefined,
    inbox?: AgentInbox,
  ): Promise<RunResult> {
    if (this.running) throw new Error("AgentRunner already has an active run");
    this.running = true;
    this.inbox = inbox;
    const controller = new AbortController();
    this.activeController = controller;
    const abort = () => controller.abort(signal.reason ?? new Error("aborted"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    try {
      repairToolHistory(messages);
      await persist();
      return await this.runLoop(messages, mode, controller.signal, onEvent, approve, persist);
    } finally {
      try {
        await this.inbox?.close();
        repairToolHistory(messages);
        await persist();
      } finally {
        signal.removeEventListener("abort", abort);
        this.activeController = undefined;
        this.running = false;
        this.inbox = undefined;
      }
    }
  }

  private async runLoop(
    messages: ChatMessage[],
    mode: AgentMode,
    signal: AbortSignal,
    onEvent: (event: AgentEvent) => void,
    approve: ApproveTool,
    persist: () => Promise<void>,
  ): Promise<RunResult> {
    signal.throwIfAborted();
    for (const tool of planTools(messages)) this.tools.set(tool.name, tool);
    for (const tool of attachImageTools(messages, this.config.workspace)) this.tools.set(tool.name, tool);
    if (!this.mcpDiscovered) {
      this.mcpDiscovered = true;
      const discovered = await this.mcp.discoverNativeTools(signal);
      for (const tool of discovered.tools) this.tools.set(tool.name, tool);
      if (discovered.tools.length) onEvent({ type: "status", text: `Connected ${discovered.tools.length} MCP tools` });
      if (discovered.errors.length) onEvent({ type: "error", text: `MCP startup: ${discovered.errors.join("; ")}` });
    }
    const available = mode === "ask" ? new Map([...this.tools].filter(([, tool]) => tool.risk === "read")) : this.tools;
    const schemas = openAiToolSchemas(available);
    const schemaTokens = Math.ceil(JSON.stringify(schemas).length / 3.5);
    let totalSteps = 0;
    this.budgetUsed = 0;
    // Accounting for the run: every model call is counted, including the
    // compaction summary and the step-budget handoff, because those are time
    // the user waits for just the same.
    const runStartedAt = Date.now();
    let modelCalls = 0;
    const callModel: typeof this.client.complete = (callMessages, callTools, callSignal, onDelta) => {
      modelCalls += 1;
      // Announce the round trip before it starts, and relay retry/idle-timeout
      // notices while it runs: a provider that never answers is otherwise
      // indistinguishable from one that is merely slow.
      onEvent({ type: "model-call", index: modelCalls });
      const mainRequest = callMessages === messages;
      const automatic = this.config.enableThinking === undefined;
      const thinking = automatic ? shouldThink(lastUserQuestion(messages)) || currentTurnHasToolError(messages) : this.config.enableThinking;
      const options: ModelRequestOptions | undefined = mainRequest
        ? { enableThinking: thinking, ...(automatic && !thinking ? {
          maxTokens: Math.min(this.config.maxTokens, 16_384),
          timeoutMs: Math.min(this.config.timeoutMs, 45_000),
          thinkingTimeoutMs: Math.min(this.config.thinkingTimeoutMs ?? 600_000, 45_000),
          maxRetries: Math.min(this.config.maxRetries ?? 3, 1),
        } : {}) }
        : undefined;
      return this.client.complete(callMessages, callTools, callSignal, onDelta, (text) => onEvent({ type: "status", text }), options);
    };
    const promote = async (idle = false) => {
      const inputs = await this.inbox?.promote(messages, idle) ?? [];
      for (const input of inputs) onEvent({ type: "input", id: input.id, text: input.content });
      return inputs.length > 0;
    };
    let lastText = "";
    let lastToolSignature = "";
    let repeatCount = 0;
    // Text kept from responses the provider cut off, and where in the transcript
    // those pieces live, so the continuation can replace them with one answer.
    let truncatedText = "";
    let truncationContinues = 0;
    let truncatedSpanStart = -1;
    let truncatedSpanCount = 0;
    /** Messages dropped by compaction in this run, cumulatively. */
    let compactedMessages = 0;
    let compactionAnnounced = false;
    // ASK remains intentionally bounded because it is a read-only conversation;
    // AGENT/AUTO use the configured long-task budget (200 by default).
    const maxSteps = mode === "ask" ? Math.min(12, this.config.maxSteps) : this.config.maxSteps;
    onEvent({ type: "status", text: mode === "agent" ? "Planning and executing" : "Thinking", progress: true });

    modelLoop: for (let step = 0; step < maxSteps; step += 1) {
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      if (await promote()) { step = 0; lastText = ""; lastToolSignature = ""; repeatCount = 0; }
      // Refresh startup rules for resumed sessions and edits to root instructions.
      if (String(messages[0]?.content).startsWith(SYSTEM_PROMPT.split("\n")[0]!)) messages[0] = initialMessages(this.config.workspace, this.config.model.name, this.config.planning ?? "auto")[0]!;
      const inputBudget = (this.config.contextWindow ?? 128_000)
        - Math.max(this.config.contextReserve ?? 16_384, this.config.maxTokens) - schemaTokens;
      const compacted = compactMessages(messages, inputBudget, this.config.maxHistoryMessages ?? 80);
      if (compacted.messages !== messages) {
        if (this.config.semanticCompaction !== false && estimateMessagesTokens(compacted.messages) <= inputBudget) {
          const summary = compacted.messages.find((message) => message.role === "system" && String(message.content).startsWith("[luban context summary]"));
          if (summary?.content) {
            try {
              const semantic = await callModel([
                { role: "system", content: "Compress prior coding-agent history. Preserve concrete requirements, decisions, file paths, code changes, command results, archived output UUIDs, errors, and unfinished work. Omit chatter. Do not continue the task." },
                { role: "user", content: String(summary.content) },
              ], [], signal);
              onEvent({ type: "usage", input: semantic.usage.input, output: semantic.usage.output });
              if (semantic.content.trim()) summary.content = `[luban context summary]\n${clipContextText(semantic.content.trim(), Math.max(0, String(summary.content).length - 25))}`;
            } catch (error) {
              if (signal.aborted) throw signal.reason ?? error;
              onEvent({ type: "status", text: `Semantic compaction unavailable; using local summary (${error instanceof Error ? error.message : String(error)})` });
            }
          }
        }
        messages.splice(0, messages.length, ...compacted.messages);
        // Once a run reaches its context ceiling it tends to stay there: every
        // new tool result pushes the oldest exchange out again, so announcing
        // each drop stacked one identical "Compacted 2 older messages" line per
        // step. The first drop is the notice - it tells the reader history is
        // being summarized. Later drops only move the working line, which is
        // what a figure that grows every step is for.
        compactedMessages += compacted.removed;
        onEvent({
          type: "status",
          text: `Compacted ${compactedMessages} older messages`,
          ...(compactionAnnounced ? { progress: true } : {}),
        });
        compactionAnnounced = true;
      }
      if (estimateMessagesTokens(messages) > inputBudget) {
        const text = "Context budget exceeded by instructions, current request, plan, or tool schemas. Use a larger context_window, reduce enabled MCP tools, or shorten the request/instructions.";
        onEvent({ type: "error", text });
        return { ok: false, text, steps: step, messages, stopReason: "context", modelCalls, elapsedMs: Date.now() - runStartedAt };
      }
      const knownInstructions = instructionSnapshot(messages);
      let completion: Awaited<ReturnType<ModelClient["complete"]>>;
      try {
        completion = await callModel(messages, schemas, signal, (text, kind) => {
          onEvent({ type: kind === "reasoning" ? "thinking-delta" : "delta", text });
        });
      } catch (error) {
        // Context overflow is recoverable: force one aggressive compaction and
        // retry once. Tool side effects are untouched because no tool ran yet.
        if (!isContextOverflowError(error) || signal.aborted) throw error;
        onEvent({ type: "status", text: "Context overflow from the model; compacting aggressively and retrying once" });
        const aggressive = compactMessages(messages, Math.floor(inputBudget * 0.6), Math.min(40, this.config.maxHistoryMessages ?? 80));
        messages.splice(0, messages.length, ...aggressive.messages);
        await persist();
        try {
          completion = await callModel(messages, schemas, signal, (text, kind) => {
            onEvent({ type: kind === "reasoning" ? "thinking-delta" : "delta", text });
          });
        } catch (retryError) {
          const text = `Model context overflow persists after compaction: ${retryError instanceof Error ? retryError.message : String(retryError)}. Increase context_window, reduce MCP tools, or shorten the request.`;
          onEvent({ type: "error", text });
          return { ok: false, text, steps: totalSteps, messages, stopReason: "context" as const, modelCalls, elapsedMs: Date.now() - runStartedAt };
        }
      }
      totalSteps += 1;
      this.budgetUsed = totalSteps;
      onEvent({ type: "usage", input: completion.usage.input, output: completion.usage.output });
      // Running out of output budget is a property of the provider's cap, not a
      // broken request, so the run keeps going instead of dying with the partial
      // text thrown away: keep what arrived and ask the model to continue.
      // Repeating the same request cannot help when the cap is the provider's.
      if (completion.truncated) {
        const partial = completion.content.trim();
        const reasoningChars = (completion.reasoning ?? "").length;
        const consumed = `推理 ${reasoningChars} 字 / 正文 ${partial.length} 字`;
        truncationContinues += 1;
        // Reasoning that consumed the whole budget will consume it again; only
        // say so after a retry proved that it repeats.
        const starvedByReasoning = !partial && reasoningChars > 0;
        if (truncationContinues > MAX_TRUNCATION_CONTINUES || (starvedByReasoning && truncationContinues > 1)) {
          const text = starvedByReasoning
            ? `模型的推理占满了输出上限（${consumed}），没有留下正文，继续重试只会重复截断。请降低 reasoning_effort/thinking，或提高 max_tokens。`
            : `模型输出连续 ${truncationContinues} 次被输出上限截断（${consumed}）。请提高 max_tokens，或把任务拆小后继续。`;
          onEvent({ type: "error", text });
          return { ok: false, text, steps: totalSteps, messages, stopReason: "truncated", modelCalls, elapsedMs: Date.now() - runStartedAt };
        }
        if (partial) {
          if (truncatedSpanStart < 0) truncatedSpanStart = messages.length;
          truncatedText += partial;
          messages.push({ role: "assistant", content: partial });
          // Without its own text the model restarts instead of continuing.
          messages.push({ role: "user", name: TRUNCATION_MARKER, content: "上一条回复在输出长度上限处被截断。请从中断处继续，不要重复已写内容；需要调用工具时直接调用。" });
          truncatedSpanCount += 2;
          lastText = truncatedText;
          await persist();
        }
        onEvent({ type: "status", text: `模型输出被输出上限截断（${consumed}），已保留并继续` });
        continue;
      }
      signal.throwIfAborted();
      const ids = new Set<string>();
      const toolCalls = completion.toolCalls.map((call) => {
        const id = call.id && !ids.has(call.id) ? call.id : `call-${randomUUID()}`;
        ids.add(id);
        return { ...call, id };
      });
      const rawAnswer = toolCalls.length
        ? completion.content
        : enforceAgentIdentity(lastUserQuestion(messages), extractFinalAnswer(completion.content));
      // A continuation completes the answer that was cut off, so the kept pieces
      // and the new text become one message — provided nothing else was appended
      // in between (a tool run means the pieces are no longer one answer).
      const stitches = Boolean(truncatedText) && !toolCalls.length && truncatedSpanStart >= 0
        && truncatedSpanStart + truncatedSpanCount === messages.length;
      const answer = stitches ? `${truncatedText}${rawAnswer}` : rawAnswer;
      const assistant: ChatMessage = {
        role: "assistant",
        content: answer,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      };
      if (stitches) { messages.splice(truncatedSpanStart, truncatedSpanCount, assistant); truncatedSpanCount = 0; truncatedSpanStart = -1; }
      else messages.push(assistant);
      await persist();
      lastText = answer || lastText;
      if (!toolCalls.length) {
        if (await promote(true)) { step = -1; lastText = ""; lastToolSignature = ""; repeatCount = 0; continue; }
        while (this.inbox && !(await this.inbox.finish())) {
          if (await promote(true)) { step = -1; lastText = ""; lastToolSignature = ""; repeatCount = 0; continue modelLoop; }
        }
        const verification = planVerificationStatus(messages);
        const finalText = verification.plan && !verification.verified
          ? `${answer}\n\n[verification: ${verification.detail}]`
          : answer;
        if (finalText !== answer) {
          messages.at(-1)!.content = finalText;
          await persist();
        }
        return { ok: true, text: finalText, steps: totalSteps, messages, modelCalls, elapsedMs: Date.now() - runStartedAt };
      }
      const thought = completion.reasoning || completion.content;
      if (thought.trim()) onEvent({ type: "thought", text: thought.trim() });

      const signature = toolCalls.map((call) => `${call.function.name}:${call.function.arguments}`).join("|");
      repeatCount = signature === lastToolSignature ? repeatCount + 1 : 0;
      lastToolSignature = signature;
      if (repeatCount >= 5) {
        for (const call of toolCalls) messages.push({ role: "tool", name: call.function.name, tool_call_id: call.id, content: "TOOL ERROR: not executed; repeated tool-call loop stopped." });
        onEvent({ type: "error", text: "Stopped a repeated tool-call loop" });
        return { ok: false, text: lastText || "Repeated tool-call loop", steps: totalSteps, messages, stopReason: "loop", modelCalls, elapsedMs: Date.now() - runStartedAt };
      }

      // A tool call is prepared, dispatched, then settled. Only dispatch is
      // parallel: preparation mutates the transcript (scoped instructions,
      // approval trust) and settling emits ordered events and archives output,
      // so both must stay sequential. Concurrent reads used to be serialized
      // here purely because they shared one function.
      interface PreparedCall {
        id: string;
        name: string;
        ok: boolean;
        output: string;
        parallel: boolean;
        started: number;
        run?: () => Promise<string>;
      }
      const prepared: PreparedCall[] = [];
      const prepareCall = async (call: (typeof toolCalls)[number]): Promise<void> => {
        const id = call.id;
        const name = call.function.name;
        let args: Record<string, unknown> = {};
        let output = "";
        let ok = true;
        let run: (() => Promise<string>) | undefined;
        try {
          const parsed = JSON.parse(call.function.arguments || "{}");
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("arguments must be an object");
          args = parsed as Record<string, unknown>;
        } catch (error) {
          ok = false;
          output = `TOOL ERROR: invalid JSON arguments: ${error instanceof Error ? error.message : String(error)}`;
        }
        const tool = this.tools.get(name);
        if (!tool) {
          ok = false;
          output = `TOOL ERROR: unknown tool ${name}`;
        }
        onEvent({ type: "tool-start", id, name, args });
        const started = Date.now();
        if (ok && tool) {
          try {
            signal.throwIfAborted();
            if (await this.inbox?.hasSteering()) throw new Error("Not executed: a new user instruction is pending; reconsider this call after reading it");
            if (mode === "ask" && tool.risk !== "read") throw new Error("ASK mode is read-only; switch to AGENT to execute this tool");
            let decision: Approval = "once";
            const rules = this.config.permissions ?? { allow: [], deny: [] };
            if (rules.deny.some((rule) => permissionRuleMatches(rule, tool, args))) {
              throw new Error(`blocked by permission rule for ${tool.name}`);
            }
            const configuredAllow = rules.allow.some((rule) => permissionRuleMatches(rule, tool, args));
            // Reads never ask; in edits mode file edits never ask either. Only
            // shell/network-style tools keep prompting unless explicitly trusted.
            const autoAllowed = tool.risk === "read" || (tool.risk === "write" && this.config.permissionMode === "edits");
            if (!autoAllowed && !configuredAllow && this.config.permissionMode !== "allow" && !this.trustSession && !this.trustedTools.has(tool.name)) {
              // An unanswered prompt used to park the whole run indefinitely:
              // only Esc released it, so a task left alone looked like it was
              // "working" while it was really waiting for a keypress.
              const timeoutSeconds = this.config.approvalTimeoutSeconds ?? 600;
              decision = await new Promise<Approval>((resolveApproval, reject) => {
                const abort = () => reject(signal.reason ?? new Error("aborted"));
                signal.addEventListener("abort", abort, { once: true });
                const timer = timeoutSeconds > 0
                  ? setTimeout(() => {
                    reject(new Error(`permission prompt for ${tool.name} timed out after ${timeoutSeconds}s with no answer; the tool was not executed`));
                  }, timeoutSeconds * 1000)
                  : undefined;
                timer?.unref?.();
                Promise.resolve().then(() => {
                  signal.throwIfAborted();
                  return approve(tool, args);
                }).then(resolveApproval, reject).finally(() => {
                  if (timer) clearTimeout(timer);
                  signal.removeEventListener("abort", abort);
                });
              });
            }
            signal.throwIfAborted();
            if (decision === "deny") throw new Error("permission denied by user");
            if (decision === "tool") this.trustedTools.add(tool.name);
            if (decision === "always") {
              this.trustSession = true;
              // Keep the trust decision when the UI rebuilds the runner after
              // a model switch; the config object lives only for this process.
              this.config.permissionMode = "allow";
            }
            signal.throwIfAborted();
            if (await this.inbox?.hasSteering()) throw new Error("Not executed: a new user instruction is pending; reconsider this call after reading it");
            const scoped = await scopedInstructions(this.config.workspace, toolPaths(name, args), messages);
            attachInstructions(messages, scoped);
            if (tool.risk === "write" && scoped.some((instruction) => !knownInstructions.has(`${instruction.name}:${instruction.content}`))) {
              throw new Error("Not executed: new or changed subdirectory instructions have been loaded. Read the scoped instructions, then revise or retry this edit.");
            }
            if (await this.inbox?.hasSteering()) throw new Error("Not executed: a new user instruction is pending; reconsider this call after reading it");
            run = () => tool.execute(args, signal);
          } catch (error) {
            ok = false;
            output = `TOOL ERROR: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        prepared.push({
          id, name, ok, output, started,
          // Only read-only tools run concurrently: they never prompt, so there
          // is at most one approval on screen, and they cannot observe each
          // other's writes.
          parallel: Boolean(run) && tool?.parallelSafe === true && tool.risk === "read",
          ...(run ? { run } : {}),
        });
      };

      const settleCall = async (item: PreparedCall): Promise<ChatMessage> => {
        const { id, name, ok } = item;
        let { output } = item;
        const editPreview = ok && ["write_file", "edit_file", "apply_patch"].includes(name) && output.startsWith("Edited ") ? output : undefined;
        try {
          // Retries never re-execute tools: only this single capture runs, and a
          // failed archive preserves the original output for compaction.
          if (name !== "read_tool_output") output = await this.outputs.capture(output, this.config.toolOutputRetentionDays ?? 7, this.config.toolOutputMaxBytes ?? 500 * 1024 * 1024);
        } catch (error) {
          // Tool effects already happened. Preserve the result if archiving fails.
          onEvent({ type: "status", text: `Could not archive tool output: ${error instanceof Error ? error.message : String(error)}` });
        }
        onEvent({
          type: "tool-end",
          id,
          name,
          ok,
          elapsedMs: Date.now() - item.started,
          preview: output.slice(0, 4000),
          editPreview,
        });
        return { role: "tool", name, tool_call_id: id, content: output, ...(editPreview ? { editPreview } : {}) };
      };

      // Prepare sequentially (gates, approval, scoped instructions), then run
      // consecutive read-only calls together, then settle in call order.
      for (const call of toolCalls) await prepareCall(call);
      const dispatch = async (item: PreparedCall): Promise<void> => {
        if (!item.run) return;
        try {
          item.output = await item.run();
        } catch (error) {
          item.ok = false;
          item.output = `TOOL ERROR: ${error instanceof Error ? error.message : String(error)}`;
        }
      };
      for (let index = 0; index < prepared.length;) {
        const item = prepared[index]!;
        if (!item.parallel) {
          // Steering is re-checked at dispatch time. Preparation now happens
          // for the whole batch before anything runs, so without this a message
          // that arrived while an earlier tool was executing would no longer
          // stop the remaining sequential calls.
          if (await this.inbox?.hasSteering()) {
            item.ok = false;
            item.output = "TOOL ERROR: Not executed: a new user instruction is pending; reconsider this call after reading it";
            index += 1;
            continue;
          }
          await dispatch(item);
          index += 1;
          continue;
        }
        let end = index;
        while (end < prepared.length && prepared[end]!.parallel) end += 1;
        await Promise.all(prepared.slice(index, end).map(dispatch));
        index = end;
      }
      for (const item of prepared) {
        messages.push(await settleCall(item));
        await persist();
      }
      signal.throwIfAborted();
      if (repeatCount >= 3) {
        const lastResult = messages.at(-1)!;
        lastResult.content = `${lastResult.content ?? ""}\n[luban runtime] You repeated the identical tool call. Change strategy or give the final answer now.`;
      }
      if (await promote()) { step = -1; lastText = ""; lastToolSignature = ""; repeatCount = 0; }
      // A phase label, not an event: the run is still working, and this fires
      // once per step, so recording it once per step is pure noise.
      onEvent({ type: "status", text: "Reviewing tool results", progress: true });
    }
    // A productive task can legitimately need more than the interactive step
    // budget. Ask the model for a tools-free handoff so the transcript ends in
    // a useful state and a later “continue” can resume from it.
    onEvent({ type: "status", text: `Step budget reached (${maxSteps}); preparing a continuation summary` });
    let text = `已达到步骤上限（${maxSteps}），任务已暂停。请检查已执行的工具结果后继续。`;
    try {
      const final = await callModel([
        ...messages,
        { role: "system", content: "The runtime step budget is exhausted. Do not call tools. Give a concise user-facing handoff: what was completed, what was verified, what remains unfinished, and the exact next action to continue. Do not claim unverified success." },
      ], [], signal);
      signal.throwIfAborted();
      onEvent({ type: "usage", input: final.usage.input, output: final.usage.output });
      const summary = enforceAgentIdentity(lastUserQuestion(messages), extractFinalAnswer(final.content));
      if (summary.trim()) {
        text = summary;
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      onEvent({ type: "status", text: `Could not prepare continuation summary: ${error instanceof Error ? error.message : String(error)}` });
    }
    messages.push({ role: "assistant", content: text });
    await persist();
    onEvent({ type: "status", text: `Paused after ${maxSteps} steps; send “继续” to resume` });
    return { ok: false, text, steps: totalSteps, messages, stopReason: "max_steps", modelCalls, elapsedMs: Date.now() - runStartedAt };
  }
}
