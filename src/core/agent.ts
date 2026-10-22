import { AgentInbox } from "./inbox.js";
import { parseUserQuestion, type AskUser } from "./question.js";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { arch, release, type } from "node:os";
import { dirname, join, resolve } from "node:path";
import { OpenAiClient, MAX_OUTPUT_TOKENS, type ModelRequestOptions } from "./openai.js";
import { AnthropicClient } from "./anthropic.js";
import { ResponsesClient } from "./responses.js";
import { CodexClient } from "./codex.js";
import { isZenFreeModel, OpenCodeZenClient } from "./opencode-zen.js";
import { modelRetryDelay, recoverableGoStreamError, waitForModelRetry } from "./opencode-go.js";
import { enforceAgentIdentity, extractFinalAnswer } from "./reasoning.js";
import { clipContextText, compactForRequest, compactMessages, estimateMessagesTokens } from "./context.js";
import { describeModelError, isContextOverflowError, isModelTimeoutError, recoverableModelConnectionError } from "./model-errors.js";
import { reasoningRecoveryOptions } from "./model-controls.js";
import { parseToolArguments } from "./json-args.js";
import { repairToolHistory } from "./history.js";
import { cleanTitle, hasNameableContent, titlePrompt } from "./session-title.js";
import { planTools, planVerificationStatus } from "./plan.js";
import { attachImageTools } from "./vision.js";
import { autoMergeWorktree, checkDiffApplies, createWorktree, disposeWorktree, isGitRepo, worktreeDiff } from "./worktree.js";
import { attachInstructions, instructionSnapshot, scopedInstructions, toolPaths } from "./instructions.js";
import { ToolOutputStore } from "./tool-output.js";
import { McpManager } from "./mcp.js";
import type { MeshRuntime } from "./mesh/runtime.js";
import { createTools, openAiToolSchemas } from "./tools.js";
import { validateToolArguments } from "./tool-validation.js";
import type {
  AgentEvent,
  AgentMode,
  ChatMessage,
  LubanConfig,
  PendingInput,
  RunResult,
  RunMetrics,
  ToolCall,
  ToolDefinition,
} from "./types.js";

export type Approval = "once" | "tool" | "always" | "deny";
export type ApproveTool = (tool: ToolDefinition, args: Record<string, unknown>) => Promise<Approval>;

/** Some providers return familiar tool aliases despite receiving our schemas. */
const TOOL_ALIASES: Record<string, string> = {
  glob: "glob_files", grep: "grep_files", read: "read_file",
  write: "write_file", edit: "edit_file", ls: "list_dir",
};

function normalizeToolCall(call: ToolCall, tools: Map<string, ToolDefinition>): ToolCall {
  const requested = call.function.name.trim();
  if (tools.has(requested)) return call;
  const folded = [...tools.keys()].filter((name) => name.toLowerCase() === requested.toLowerCase());
  const name = folded.length === 1 ? folded[0]! : TOOL_ALIASES[requested.toLowerCase()];
  if (!name || !tools.has(name)) return call;
  let args = call.function.arguments;
  if (["read_file", "write_file", "edit_file", "bash"].includes(name)) {
    try {
      const parsed = parseToolArguments(args || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const values = parsed as Record<string, unknown>;
        if (name === "bash" && typeof values.description === "string") delete values.description;
        if (values.path === undefined && values.file_path !== undefined) values.path = values.file_path;
        if (name === "edit_file") {
          if (values.old_text === undefined && values.old_string !== undefined) values.old_text = values.old_string;
          if (values.new_text === undefined && values.new_string !== undefined) values.new_text = values.new_string;
          delete values.old_string;
          delete values.new_string;
        }
        delete values.file_path;
        args = JSON.stringify(values);
      }
    } catch { /* Invalid JSON is reported by the normal tool-call validator. */ }
  }
  return { ...call, function: { ...call.function, name, arguments: args } };
}

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

/**
 * Which engine settles decisions. `model` is the original behaviour: the chat
 * model decides unaided. `kev` adds a rule that points consequential calls at
 * the local Kev/System One advisor, so the two halves of 房谋杜断 are explicit
 * in the prompt instead of relying on the model to discover the tool.
 */
export type DecisionEngine = "model" | "kev";

const PROMPT_HEADER = `You are luban, a production coding agent working directly in the user's workspace.

Work rules:
1. Inspect relevant files before editing. Use code_intelligence to resolve definitions/references when needed. File edit tools include TypeScript/JavaScript and configured LSP diagnostics in their results; do not call diagnostics again unless unavailable or another change requires it. Use the project's checks for broader verification. Follow AGENTS.md or CLAUDE.md instructions when present.
2. Use tools to perform requested work; do not merely describe what you would do. When independent files or inspections are ready, issue their tool calls together in one response; the runtime executes writes in order. Do not wait for one independent write before starting the next. After a check passes, run another check only for a concrete uncovered requirement or a change made since that check.
2a. Use read_files to inspect independent files in one response. Independent bash inspections/checks may set independent: true to run together; keep commands with shared writes or ordering dependencies sequential.
3. Keep changes scoped. Never commit, publish, or contact people unless explicitly requested.
3a. When the user explicitly asks to commit and push code to the configured Git remote, call git_publish directly with a concise commit message. It checks the repository, commits changes if needed, and pushes in one tool call. Do not create a plan or split this routine request into separate status/add/commit/push calls. If the user asked for additional code changes or checks, complete those first.`;

const PLANNING_RULES: Record<PlanningMode, string> = {
  always: `4. For every non-trivial task, make update_plan your first tool call before inspecting or changing files. Break the work into concrete steps, keep the plan current, and include a verification step. Batch every plan sync with real work in the SAME tool-call block; never spend a standalone round trip just to sync the plan. Simple questions that need no tools do not need a plan. Verify changes with focused tests or commands before claiming success. A completed plan is not proof that tests passed.
5. Record every test/check with record_verification (command, passed/failed, key output). If verification failed or is missing, say so explicitly; never claim unverified success.`,
  // The plan call is one full model round-trip. Ask for it only when the work
  // really is multi-step, and say outright that a single-step task must not
  // call it just to satisfy the rule.
  auto: `4. Plan when the work spans several steps: then call update_plan once BEFORE any file write/edit/bash, keep it current, and include a verification step. Mandatory triggers (do not skip): the request lists 3+ numbered requirements, names 3+ files to create/modify, or asks for code + tests + verification run. Batch every plan sync with real work in the SAME tool-call block (e.g. update_plan + bash test together); never spend a standalone round trip just to sync the plan. The final plan state and the record_verification call ride along with your last test/result turn. For a single-step task or a question, skip the plan and go straight to the work - do not call update_plan just to satisfy this rule. Verify changes with focused tests or commands before claiming success. A completed plan is not proof that tests passed.
5. When you run a test or check, record it with record_verification (command, passed/failed, key output) in the same turn. If verification failed or is missing, say so explicitly; never claim unverified success.`,
  off: `4. Go straight to the work; do not call update_plan. Verify changes with focused tests or commands before claiming success.
5. State the command and result of any check you run in your final answer. If verification failed or is missing, say so explicitly; never claim unverified success.`,
};

const PROMPT_FOOTER = `6. If a tool fails, diagnose it and change strategy. Do not repeat identical calls indefinitely. A bash result ending in [exit code: N] is not a tool failure: many commands exit non-zero by design (grep with no match, git diff --quiet, test -f, command -v). Read the code and the output, and only treat it as an error when the command was supposed to succeed. Builds, test suites and installs often exceed the bash timeout: give them a larger timeout when you know they are slow, or start them with background: true and poll with get_background_task instead of retrying a killed command.
6a. When a consequential choice or missing requirement cannot be inferred from the user's instructions or workspace, call ask_user with 2–4 concrete options, then continue with the answer. Do not interrupt for routine implementation choices; resolve those yourself. If ask_user is unavailable, state the unresolved choice in your final answer.
7. End with a concise outcome: what changed, verification, and any real blocker. Hard cap 8 lines, no code blocks; details live in files, not chat.
8. Paths are workspace-relative. Bash already starts in the workspace. If the workspace is a subdirectory of a Git repository, run Git commands from that directory (for example, git status --short or git add -- .); do not cd to the repository parent or prefix file paths with the parent directory. Use write_file, edit_file, or apply_patch with workspace-relative paths for file changes. The bash tool is soft-sandboxed: destructive host commands, writes outside the workspace, and denied patterns are rejected before execution. In soft mode, restart/shutdown warnings require explicit approval of the exact command, even with session trust; strict mode still blocks them. Submit the intended command for approval, never disguise it to evade checks. This is not an OS container; do not run untrusted payloads to probe it. Screenshots arrive as native vision parts when the user @-attaches them; describe what you see and cite the file name.
9. Never expose chain-of-thought, policy analysis, system reminders, or other internal reasoning in assistant content. Return only the user-facing result. Use a separate reasoning channel when the runtime supports one.
10. Create a checkpoint before broad or risky multi-file edits when the workspace is a Git repository.
11. Identity: your product name is luban. If the user asks your name or who you are, say you are luban, the coding agent working in their workspace. Never claim to be the underlying model (for example Qwen or Claude). If the user asks which model or LLM powers you, answer honestly with the configured model name.

 The user can choose ASK for conversational help, AGENT for autonomous execution, or AUTO to let the app decide.`;

// Only the Kev engine adds a rule; `model` keeps the historical prompt byte
// for byte so an upgrade with default config behaves exactly as before.
const DECISION_RULES: Record<DecisionEngine, string> = {
  model: "",
  kev: `\nDecision engine: Jev/Kev. The chat model proposes, the local Kev decision model decides. Before a consequential, hard-to-reverse or genuinely ambiguous call, call kev_decide with the relevant state and typed noul (yes/no), choice (pick one) or score (ordered level) questions, then act on the calibrated answer. Skip it for routine or obvious steps; Kev cannot use tools and reads only the state you pass it.`,
};

/** The full system prompt for a planning mode and decision engine. */
export function systemPrompt(planning: PlanningMode = "auto", decision: DecisionEngine = "model"): string {
  return `${PROMPT_HEADER}\n${PLANNING_RULES[planning]}\n${PROMPT_FOOTER}${DECISION_RULES[decision]}`;
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

export function initialMessages(workspace: string, modelName?: string, planning: PlanningMode = "auto", decision: DecisionEngine = "model"): ChatMessage[] {
  const instructions = workspaceInstructions(workspace);
  return [{
    role: "system",
    content: `${systemPrompt(planning, decision)}\n\nWorkspace: ${workspace}\n${platformContext()}${modelName ? `\nModel: ${modelName}` : ""}${instructions ? `\n\n${instructions}` : ""}`,
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
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" || message.role === "assistant") break;
    if (message.role === "tool" && String(message.content).startsWith("TOOL ERROR:")) return true;
  }
  return false;
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
  ): Promise<{ content: string; reasoning?: string; toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>; usage: { input: number; output: number; cached?: number; reasoning?: number }; truncated?: boolean; streamEnded?: boolean }>;
}

/**
 * How many times one run asks the model to continue past a provider's output cap
 * or a dropped connection before reporting it. Five covers a long answer split
 * by a small cap (SOTA reasoning models) without letting a model that only
 * reasons loop forever.
 */
const MAX_TRUNCATION_CONTINUES = 5;
/** Loop detection window: how many recent rounds to inspect, and how many
 * repeats of one call inside it count as stuck. */
const LOOP_WINDOW = 8;
const LOOP_LIMIT = 5;
/** Marks the nudge that asks for the rest of an answer cut short mid-stream. */
const TRUNCATION_MARKER = "output-limit";

/**
 * A session name written by the model, with the tokens it cost. `title` is
 * absent when the reply was not usable as a name.
 */
export interface TitleSuggestion {
  title?: string;
  input: number;
  output: number;
}

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
  private readonly modelConversationId = randomUUID();

  constructor(readonly config: LubanConfig, client?: ModelClient, mesh?: MeshRuntime, private readonly depth = 0) {
    this.tools = createTools(config, mesh);
    this.tools.set("read_files", {
      name: "read_files", risk: "read", description: "Read up to 8 independent text files in one request. Each file uses read_file and its normal path permissions and scoped instructions; results have separate execution records.",
      parameters: { type: "object", additionalProperties: false, required: ["files"], properties: {
        files: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", additionalProperties: false, required: ["path"], properties: {
          path: { type: "string" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 4000 },
        } } },
      } },
      async execute() { throw new Error("read_files requires 1-8 file entries with string paths and optional integer offset/limit"); },
    });
    this.outputs = new ToolOutputStore(config.home);
    const outputTool = this.outputs.tool();
    this.tools.set(outputTool.name, outputTool);
    this.mcp = new McpManager(config);
    this.client = client ?? (isZenFreeModel(config.model) ? new OpenCodeZenClient(config)
      : config.model.api === "codex" ? new CodexClient(config) : config.model.api === "anthropic"
      ? new AnthropicClient(config)
      : config.model.api === "responses" ? new ResponsesClient(config) : new OpenAiClient(config));
    if (depth < 2) {
      const runChild = async (instruction: string, maxSteps: number, signal: AbortSignal, readOnly: boolean, useWorktree: boolean, autoMerge: boolean, parentBudget: () => number): Promise<string> => {
        const capped = Math.min(maxSteps, parentBudget());
        if (capped < 1) throw new Error("parent step budget exhausted; cannot delegate further subtasks");
        const childConfig: LubanConfig = {
          ...config,
          maxSteps: capped,
          ...(readOnly ? { permissionMode: "ask" as const, permissions: { ...(config.permissions ?? { allow: [], deny: [] }), allow: [] } } : {}),
        };
        let worktree: string | undefined;
        let discardWorktree = false;
        try {
          if (useWorktree && !readOnly) {
            if (await isGitRepo(config.workspace, signal)) {
              worktree = await createWorktree(config.workspace, signal);
              childConfig.workspace = worktree;
            }
          }
          const child = new AgentRunner(childConfig, undefined, mesh, depth + 1);
          const childMessages: ChatMessage[] = [
            ...initialMessages(childConfig.workspace, config.model.name, childConfig.planning, childConfig.kev?.mode ?? "model"),
            { role: "user", content: `Work as a focused subagent. Return a concise report to the parent agent.\n\n${instruction}` },
          ];
          try {
            const result = await child.run(
              childMessages, "agent", signal, () => undefined,
              async () => childConfig.permissionMode === "allow" ? "always" : "deny",
            );
            let suffix = "";
            if (worktree) {
              if (autoMerge && result.ok) {
                const merged = await autoMergeWorktree(config.workspace, worktree, signal);
                discardWorktree = /^merge: \d+ applied, 0 conflicted/u.test(merged);
                suffix = `\n\n${merged}\n[worktree ${discardWorktree ? "merged; temporary directory will be removed" : `preserved for recovery: ${worktree}`}]`;
              } else {
                const diff = await worktreeDiff(worktree, signal).catch((error) => `diff unavailable: ${error instanceof Error ? error.message : String(error)}`);
                const applies = await checkDiffApplies(config.workspace, worktree, signal)
                  .then((text) => text)
                  .catch((error) => error instanceof Error ? error.message : String(error));
                suffix = `\n\n[worktree preserved: ${worktree}; full files and diff remain available]\n${diff.slice(0, 8000)}\nMerge check: ${applies}`;
              }
            }
            return `Subagent ${result.ok ? "completed" : "stopped"} after ${result.steps} steps (budget ${capped}):\n${result.text}${suffix}`;
          } finally {
            child.close();
          }
        } catch (error) {
          if (worktree) throw new Error(`${error instanceof Error ? error.message : String(error)}\nWorktree preserved for recovery: ${worktree}`, { cause: error });
          throw error;
        } finally {
          if (worktree && discardWorktree) await disposeWorktree(config.workspace, worktree, signal).catch(() => undefined);
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

  /**
   * One cheap round trip that names the session, the way a thread list names a
   * thread. Deliberately outside `run`: it is not part of the task, it carries
   * no tools and it does not touch the step budget. The caller folds the
   * returned usage into its own accounting, because these are tokens the user
   * waited for just the same.
   *
   * Returns `undefined` when there is nothing worth naming or the model cannot
   * be reached, and omits `title` when the reply was not a title, so callers
   * keep the derived title rather than writing a bad one.
   */
  async suggestTitle(messages: ChatMessage[], signal?: AbortSignal): Promise<TitleSuggestion | undefined> {
    // Keep the locally derived title for subscription-backed Codex. Starting
    // another full coding-agent session merely to name a chat wastes allowance.
    if (this.config.model.api === "codex") return undefined;
    // Zen's free tier requires coding tools; the title-only request has none.
    if (isZenFreeModel(this.config.model)) return undefined;
    if (!hasNameableContent(messages)) return undefined;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? new Error("aborted"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      const completion = await this.client.complete(titlePrompt(messages), [], controller.signal, undefined, undefined, {
        ...(this.config.model.provider === "opencode-go" ? { conversationId: this.modelConversationId } : {}),
        maxTokens: 64,
        timeoutMs: Math.min(this.config.timeoutMs, 20_000),
        maxRetries: 1,
      });
      return {
        title: cleanTitle(completion.content),
        input: completion.usage.input,
        output: completion.usage.output,
      };
    } catch {
      return undefined;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
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
    askUser?: AskUser,
  ): Promise<RunResult> {
    if (this.running) throw new Error("AgentRunner already has an active run");
    if (this.config.model.provider === "opencode-zen" && !this.config.model.apiKey && !isZenFreeModel(this.config.model)) {
      throw new Error("OpenCode Zen 尚未连接：在 OpenCode 里执行 opencode auth login（或设置 OPENCODE_ZEN_API_KEY），然后重启 luban。");
    }
    this.running = true;
    this.inbox = inbox;
    if (askUser) this.tools.set("ask_user", {
      name: "ask_user",
      description: "Ask the user to choose among concrete options when a consequential decision is unresolved. The run pauses until they answer. Free text is also accepted.",
      risk: "read",
      parameters: { type: "object", properties: {
        question: { type: "string", description: "A concise question stating the decision needed" },
        options: { type: "array", minItems: 2, maxItems: 4, items: { type: "object", properties: {
          label: { type: "string" }, description: { type: "string" },
        }, required: ["label"] } },
      }, required: ["question", "options"] },
      execute: async (args, toolSignal) => {
        const question = parseUserQuestion(args);
        const answer = await askUser(question, toolSignal);
        toolSignal.throwIfAborted();
        if (!answer.trim()) throw new Error("the user did not answer this question");
        return JSON.stringify({ question: question.question, answer: answer.trim() });
      },
    });
    else this.tools.delete("ask_user");
    const controller = new AbortController();
    this.activeController = controller;
    const abort = () => controller.abort(signal.reason ?? new Error("aborted"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    try {
      repairToolHistory(messages);
      await persist();
      const metrics: RunMetrics = { modelMs: 0, toolMs: 0, approvalMs: 0, compactions: 0, requests: [] };
      const result = await this.runLoop(messages, mode, controller.signal, onEvent, approve, persist, metrics);
      return { ...result, metrics };
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
        this.tools.delete("ask_user");
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
    metrics: RunMetrics,
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
    let reasoningRecovery: ModelRequestOptions | undefined;
    let lastMainOptions: ModelRequestOptions | undefined;
    const reconnect = mode !== "ask" && this.config.modelReconnect !== false && this.config.maxRetries !== 0;
    let connectionFailures = 0;
    const waitForConnection = async (error: unknown, callSignal: AbortSignal) => {
      callSignal.throwIfAborted();
      const ceiling = Math.max(2000, Math.min(300_000, this.config.modelReconnectMaxDelayMs ?? 60_000));
      const delay = Math.min(ceiling, 2000 * 2 ** Math.min(connectionFailures++, 8));
      await persist();
      onEvent({ type: "status", text: `模型连接暂不可用（${describeModelError(error).slice(0, 240)}），${delay / 1000}s 后自动重连（第 ${connectionFailures} 次）；进度已保存，可取消等待` });
      await waitForModelRetry(delay, callSignal);
    };
    const callModel: typeof this.client.complete = async (callMessages, callTools, callSignal, onDelta) => {
      const mainRequest = callMessages === messages;
      const go = this.config.model.provider === "opencode-go";
      const automatic = this.config.enableThinking === undefined;
      // Successful tools still need analysis. Keep the task's thinking policy
      // throughout execution instead of disabling it after the first call.
      const thinking = automatic
        ? shouldThink(lastUserQuestion(messages)) || currentTurnHasToolError(messages)
          || (mainRequest && callTools.length > 0 && /deepseek/iu.test(this.config.model.id + " " + this.config.model.model))
        : this.config.enableThinking;
      let options: ModelRequestOptions | undefined = mainRequest
        ? { enableThinking: thinking,
          ...(this.config.model.api === "codex" || go ? { conversationId: this.modelConversationId } : {}),
          ...(automatic && !thinking && this.config.model.api !== "codex" ? {
          maxTokens: Math.min(this.config.maxTokens, 8_192),
          ...(!go ? {
            timeoutMs: Math.min(this.config.timeoutMs, 45_000),
            thinkingTimeoutMs: Math.min(this.config.thinkingTimeoutMs ?? 600_000, 45_000),
          } : {}),
          maxRetries: go ? this.config.maxRetries ?? 3 : Math.min(this.config.maxRetries ?? 3, 1),
        } : {}) }
        : go ? { conversationId: this.modelConversationId } : undefined;
      if (mainRequest) {
        if (reasoningRecovery) options = { ...options, ...reasoningRecovery };
        lastMainOptions = options;
      }
      // Short client retries precede sustained task recovery. A rejected Codex
      // call has already closed its child; reconnect never overlaps live calls
      // and never replays tool.execute. Auxiliary/ASK calls remain bounded.
      const silentRetries = this.config.model.api === "codex" ? 0 : Math.min(2, Math.max(0, this.config.maxRetries ?? 3));
      for (let attempt = 0; ; attempt += 1) {
        modelCalls += 1;
        onEvent({ type: "model-call", index: modelCalls });
        let receivedOutput = false;
        let partialContent = "";
        let partialReasoning = "";
        const requestStarted = Date.now();
        let firstOutputMs: number | undefined;
        let requestOk = false;
        let requestUsage: RunMetrics["requests"][number]["usage"];
        try {
          const response = await this.client.complete(callMessages, callTools, callSignal, (text, kind) => {
            if (text) { receivedOutput = true; firstOutputMs ??= Date.now() - requestStarted; }
            if (kind === "content") partialContent += text;
            else partialReasoning += text;
            onDelta?.(text, kind);
          }, (text) => {
            if (!isModelTimeoutError(text) && !text.startsWith("模型连接在输出中途中断")) {
              onEvent({ type: "status", text });
            }
          }, options);
          requestOk = true;
          requestUsage = response.usage;
          if (mainRequest && !response.streamEnded && connectionFailures) {
            onEvent({ type: "status", text: "模型连接已恢复，继续处理当前任务" });
            connectionFailures = 0;
          }
          return response;
        } catch (error) {
          if (!callSignal.aborted && mainRequest && reconnect && recoverableModelConnectionError(error)) {
            if (receivedOutput) return { content: partialContent, reasoning: partialReasoning, toolCalls: [],
              usage: { input: 0, output: 0 }, truncated: true, streamEnded: true };
            await waitForConnection(error, callSignal);
            continue;
          }
          if (callSignal.aborted || receivedOutput || !(isModelTimeoutError(error) || go && recoverableGoStreamError(error)) || attempt >= silentRetries) throw error;
          if (go) {
            const backoff = modelRetryDelay(undefined, attempt, "opencode-go");
            onEvent({ type: "status", text: `Go 模型连接未返回完整输出，${(backoff / 1000).toFixed(1)}s 后重试模型请求；已完成的工具操作保留` });
            await waitForModelRetry(backoff, callSignal);
          }
        } finally {
          const elapsedMs = Date.now() - requestStarted;
          metrics.modelMs += elapsedMs;
          metrics.requests.push({ index: modelCalls, purpose: mainRequest ? "task" : String(callMessages[0]?.content).startsWith("Compress prior") ? "compaction" : "handoff", elapsedMs, firstOutputMs, ok: requestOk,
            ...(requestUsage ? { usage: requestUsage } : {}) });
        }
      }
    };
    const promote = async (idle = false) => {
      const inputs = await this.inbox?.promote(messages, idle) ?? [];
      for (const input of inputs) onEvent({ type: "input", id: input.id, text: input.content });
      return inputs.length > 0;
    };
    let lastText = "";
    let lastToolSignature = "";
    /** Result of the previous round, so a repeat means "same call, same answer". */
    let lastResultSignature = "";
    let repeatCount = 0;
    /** Recent rounds for loop detection that survives call rotation and noisy results. */
    const recentRounds: Array<{ signature: string; result: string }> = [];
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
      if (await promote()) { step = 0; lastText = ""; lastToolSignature = ""; repeatCount = 0; recentRounds.length = 0; }
      // Refresh startup rules for resumed sessions and edits to root instructions.
      if (String(messages[0]?.content).startsWith(SYSTEM_PROMPT.split("\n")[0]!)) messages[0] = initialMessages(this.config.workspace, this.config.model.name, this.config.planning ?? "auto", this.config.kev?.mode ?? "model")[0]!;
      // Codex CLI owns its output budget; luban never sends max_tokens to it.
      // Use contextReserve for Codex instead of reserving an unsent 64K budget,
      // which causes premature summaries and fresh threads with full history.
      // Network clients cap their actual output at MAX_OUTPUT_TOKENS.
      const outputReserve = this.config.model.api === "codex"
        ? 0 : Math.min(this.config.maxTokens, MAX_OUTPUT_TOKENS);
      const inputBudget = (this.config.contextWindow ?? 128_000)
        - Math.max(this.config.contextReserve ?? 16_384, outputReserve) - schemaTokens;
      const compacted = compactForRequest(messages, inputBudget, this.config.maxHistoryMessages ?? 80);
      if (compacted.messages !== messages) {
        metrics.compactions += 1;
        if (compacted.removed > 0 && this.config.semanticCompaction !== false && estimateMessagesTokens(compacted.messages) <= inputBudget) {
          const summary = compacted.messages.find((message) => message.role === "system" && String(message.content).startsWith("[luban context summary]"));
          if (summary?.content) {
            try {
              const semantic = await callModel([
                { role: "system", content: "Compress prior coding-agent history. Preserve concrete requirements, decisions, file paths, code changes, command results, archived output UUIDs, errors, and unfinished work. Omit chatter. Do not continue the task." },
                { role: "user", content: String(summary.content) },
              ], [], signal);
              onEvent({ type: "usage", ...semantic.usage });
              if (semantic.content.trim()) summary.content = `[luban context summary]\n${clipContextText(semantic.content.trim(), Math.max(0, String(summary.content).length - 25))}`;
            } catch (error) {
              if (signal.aborted) throw signal.reason ?? error;
              if (!isModelTimeoutError(error)) onEvent({ type: "status", text: `Semantic compaction unavailable; using local summary (${error instanceof Error ? error.message : String(error)})` });
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
        // `messages !== compacted.messages` also holds when the pass only
        // clipped a long tool result without dropping a single exchange.
        // Announcing "Compacted 0 older messages" there is noise, so the
        // notice waits until history was actually dropped.
        if (compacted.removed > 0) {
          compactedMessages += compacted.removed;
          onEvent({
            type: "status",
            text: `Compacted ${compactedMessages} older messages`,
            ...(compactionAnnounced ? { progress: true } : {}),
          });
          compactionAnnounced = true;
        }
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
      const reconnectingStream = reconnect && completion.truncated && completion.streamEnded === true;
      if (!reconnectingStream) totalSteps += 1;
      this.budgetUsed = totalSteps;
      onEvent({ type: "usage", ...completion.usage });
      // Running out of output budget is a property of the provider's cap, not a
      // broken request, so the run keeps going instead of dying with the partial
      // text thrown away: keep what arrived and ask the model to continue.
      // Repeating the same request cannot help when the cap is the provider's.
      if (completion.truncated) {
        const partial = completion.content.trim();
        const reasoningChars = (completion.reasoning ?? "").length;
        const consumed = `推理 ${reasoningChars} 字 / 正文 ${partial.length} 字`;
        // A dropped connection and a provider output cap both arrive as partial
        // output. Only a provider cap warrants changing reasoning/output
        // controls; dropped streams keep the separate network recovery path.
        const dropped = completion.streamEnded === true;
        if (!reconnectingStream) truncationContinues += 1;
        const starvedByReasoning = !dropped && !partial && reasoningChars > 0;
        if (starvedByReasoning && !reasoningRecovery) {
          const recovery = reasoningRecoveryOptions(this.config, lastMainOptions, Math.min(this.config.maxTokens, MAX_OUTPUT_TOKENS));
          if (recovery) {
            reasoningRecovery = recovery;
            onEvent({ type: "status", text: `模型推理耗尽本轮输出预算（${consumed}），本次任务临时降低可控推理并恢复输出预算至 ${recovery.maxTokens} token 后重试；已完成操作保留` });
            continue;
          }
        }
        if (!reconnectingStream && (truncationContinues > MAX_TRUNCATION_CONTINUES || starvedByReasoning)) {
          const text = starvedByReasoning
            ? `模型推理耗尽输出预算（${consumed}），尚未生成正文${reasoningRecovery ? "；调整预算/推理参数后仍被截断" : "；当前参数已无可自动调整空间"}。请检查该模型原生 reasoning_effort/thinking 控制和服务端输出上限；max_tokens 在 luban 中最高为 ${MAX_OUTPUT_TOKENS}。`
            : dropped
              ? `模型连接连续 ${truncationContinues} 次在输出中途中断（${consumed}）。请检查网络与模型服务稳定性，或换用更稳定的 provider 后重试。`
              : `模型输出连续 ${truncationContinues} 次被输出上限截断（${consumed}）。请提高 max_tokens，或把任务拆小后继续。`;
          onEvent({ type: "error", text });
          return { ok: false, text, steps: totalSteps, messages, stopReason: "truncated", modelCalls, elapsedMs: Date.now() - runStartedAt };
        }
        if (partial) {
          if (truncatedSpanStart < 0) truncatedSpanStart = messages.length;
          truncatedText += partial;
          messages.push({ role: "assistant", content: partial });
          // Without its own text the model restarts instead of continuing.
          messages.push({ role: "user", name: TRUNCATION_MARKER, content: dropped
            ? "上一条回复在输出过程中连接中断。请从中断处继续，不要重复已写内容；需要调用工具时直接调用。"
            : "上一条回复在输出长度上限处被截断。请从中断处继续，不要重复已写内容；需要调用工具时直接调用。" });
          truncatedSpanCount += 2;
          lastText = truncatedText;
          await persist();
        }
        if (reconnectingStream) {
          await waitForConnection(new Error("model stream disconnected before completion"), signal);
          step -= 1; // Outages do not consume productive task steps.
        }
        if (!dropped) onEvent({ type: "status", text: `模型输出被输出上限截断（${consumed}），已保留并继续` });
        continue;
      }
      // These are consecutive failures of one output, not failures accumulated
      // across successful tool rounds throughout a long task.
      truncationContinues = 0;
      signal.throwIfAborted();
      const ids = new Set<string>();
      const expanded = completion.toolCalls.flatMap((call) => {
        if (call.function.name !== "read_files") return [call];
        try {
          const args = parseToolArguments(call.function.arguments);
          if (!args || typeof args !== "object" || Array.isArray(args)) return [call];
          const record = args as Record<string, unknown>;
          const entries = record.files;
          if (this.config.permissions?.deny.some(rule => permissionRuleMatches(rule, this.tools.get("read_files")!, record))) return [call];
          if (!Array.isArray(entries) || entries.length < 1 || entries.length > 8) return [call];
          if (!entries.every(entry => entry && typeof entry === "object" && !Array.isArray(entry)
            && typeof entry.path === "string" && Object.keys(entry).every(key => ["path", "offset", "limit"].includes(key))
            && (entry.offset === undefined || Number.isInteger(entry.offset) && entry.offset >= 1)
            && (entry.limit === undefined || Number.isInteger(entry.limit) && entry.limit >= 1 && entry.limit <= 4000))) return [call];
          return entries.map((entry, index) => ({ ...call, id: `${call.id}-${index + 1}`, function: { name: "read_file", arguments: JSON.stringify(entry) } }));
        } catch { return [call]; }
      });
      const toolCalls = expanded.map((original) => {
        const call = normalizeToolCall(original, this.tools);
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
        ...((this.config.model.api === "openai" || this.config.model.api === undefined) && completion.reasoning !== undefined
          ? { reasoning_content: completion.reasoning } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      };
      if (stitches) { messages.splice(truncatedSpanStart, truncatedSpanCount, assistant); truncatedSpanCount = 0; truncatedSpanStart = -1; }
      else messages.push(assistant);
      await persist();
      lastText = answer || lastText;
      if (!toolCalls.length) {
        if (await promote(true)) { step = -1; lastText = ""; lastToolSignature = ""; repeatCount = 0; recentRounds.length = 0; continue; }
        while (this.inbox && !(await this.inbox.finish())) {
          if (await promote(true)) { step = -1; lastText = ""; lastToolSignature = ""; repeatCount = 0; recentRounds.length = 0; continue modelLoop; }
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
      // Check the requested call, so a warning does not block a new strategy.
      const repeatedRounds = recentRounds.filter((round) => round.signature === signature);
      const repeatedResults = new Set(repeatedRounds.map((round) => round.result));
      if (repeatedRounds.length >= LOOP_LIMIT && repeatedResults.size <= Math.floor(repeatedRounds.length / 2)) {
        // Say what looped. A bare "repeated tool-call loop" left the user unable
        // to tell a stuck model from a guard misfiring on a legitimate poll.
        const detail = toolCalls.map((call) => `${call.function.name} ${clipContextText(call.function.arguments, 200)}`).join("; ");
        for (const call of toolCalls) messages.push({ role: "tool", name: call.function.name, tool_call_id: call.id, content: "TOOL ERROR: not executed; repeated tool-call loop stopped." });
        onEvent({ type: "error", text: `Stopped a repeated tool-call loop: ${detail} returned repeated results across ${repeatedRounds.length} rounds` });
        return { ok: false, text: lastText || `Repeated tool-call loop: ${detail}`, steps: totalSteps, messages, stopReason: "loop", modelCalls, elapsedMs: Date.now() - runStartedAt };
      }

      // Prepare and commit each write before touching the next call. Safe reads
      // and explicitly independent commands overlap, with ordered result slots
      // and serialized saves. Each group has at most four calls.
      interface PreparedCall {
        id: string;
        name: string;
        ok: boolean;
        output: string;
        elapsedMs?: number;
        run?: () => Promise<string>;
        slot?: ChatMessage;
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
          const parsed = parseToolArguments(call.function.arguments || "{}");
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
        if (ok && tool) {
          try {
            signal.throwIfAborted();
            validateToolArguments(tool, args);
            if (await this.inbox?.hasSteering()) throw new Error("Not executed: a new user instruction is pending; reconsider this call after reading it");
            if (mode === "ask" && tool.risk !== "read") throw new Error("ASK mode is read-only; switch to AGENT to execute this tool");
            let decision: Approval = "once";
            const rules = this.config.permissions ?? { allow: [], deny: [] };
            if (rules.deny.some((rule) => permissionRuleMatches(rule, tool, args))) {
              throw new Error(`blocked by permission rule for ${tool.name}`);
            }
            const configuredAllow = rules.allow.some((rule) => permissionRuleMatches(rule, tool, args));
            const confirmationReason = tool.confirmationReason?.(args);
            const confirmedRestartCommand = confirmationReason ? String(args.command) : undefined;
            const approvalTool = confirmationReason
              ? { ...tool, approvalReason: confirmationReason, approvalOnceOnly: true, description: confirmationReason }
              : tool;
            // Reads never ask; in edits mode file edits never ask either. Only
            // shell/network-style tools keep prompting unless explicitly trusted.
            const autoAllowed = tool.risk === "read" || (tool.risk === "write" && this.config.permissionMode === "edits");
            if (confirmationReason || (!autoAllowed && !configuredAllow && this.config.permissionMode !== "allow" && !this.trustSession && !this.trustedTools.has(tool.name))) {
              // An unanswered prompt used to park the whole run indefinitely:
              // only Esc released it, so a task left alone looked like it was
              // "working" while it was really waiting for a keypress.
              const timeoutSeconds = this.config.approvalTimeoutSeconds ?? 600;
              const approvalStarted = Date.now();
              try {
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
                    return approve(approvalTool, structuredClone(args));
                  }).then(resolveApproval, reject).finally(() => {
                    if (timer) clearTimeout(timer);
                    signal.removeEventListener("abort", abort);
                  });
                });
              } finally { metrics.approvalMs += Date.now() - approvalStarted; }
            }
            signal.throwIfAborted();
            if (decision === "deny") throw new Error("permission denied by user");
            if (confirmationReason && decision !== "once") throw new Error("restart requires explicit approval for this command only; session/tool trust cannot authorize it");
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
            run = () => tool.execute(args, signal, confirmationReason ? { confirmedRestartCommand } : undefined);
          } catch (error) {
            ok = false;
            output = `TOOL ERROR: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        prepared.push({
          id, name, ok, output,
          ...(run ? { run } : {}),
        });
      };

      const settleCall = async (item: PreparedCall): Promise<ChatMessage> => {
        const { id, name, ok } = item;
        metrics.toolMs += item.elapsedMs ?? 0;
        let { output } = item;
        const editStart = ["write_file", "edit_file", "apply_patch", "delegate_task"].includes(name)
          ? output.search(/^Edited .+ \(\+\d+ -\d+\)/mu) : -1;
        const editPreview = ok && editStart >= 0 ? output.slice(editStart) : undefined;
        try {
          // Retries never re-execute tools: only this single capture runs, and a
          // failed archive preserves the original output for compaction.
          if (name !== "read_tool_output") output = await this.outputs.capture(output, this.config.toolOutputRetentionDays ?? 7, this.config.toolOutputMaxBytes ?? 500 * 1024 * 1024);
        } catch (error) {
          // Tool effects already happened. Preserve the result if archiving fails.
          onEvent({ type: "status", text: `Could not archive tool output: ${error instanceof Error ? error.message : String(error)}` });
        }
        const message: ChatMessage = { role: "tool", name, tool_call_id: id, content: output, ...(editPreview ? { editPreview } : {}) };
        if (item.slot) Object.assign(item.slot, message);
        else messages.push(message);
        onEvent({
          type: "tool-end",
          id,
          name,
          ok,
          elapsedMs: item.elapsedMs ?? 0,
          preview: output.slice(0, 4000),
          editPreview,
        });
        return message;
      };

      const dispatch = async (item: PreparedCall): Promise<void> => {
        if (!item.run) return;
        const started = Date.now();
        try {
          signal.throwIfAborted();
          if (await this.inbox?.hasSteering()) throw new Error("Not executed: a new user instruction is pending; reconsider this call after reading it");
          signal.throwIfAborted();
          item.output = await item.run();
        } catch (error) {
          item.ok = false;
          item.output = `TOOL ERROR: ${error instanceof Error ? error.message : String(error)}`;
        }
        item.elapsedMs = Date.now() - started;
      };
      let saves = Promise.resolve();
      const completeCall = async (item: PreparedCall) => {
        await dispatch(item);
        await settleCall(item);
        const saved = saves.catch(() => undefined).then(persist);
        saves = saved;
        await saved;
      };
      const canParallel = (call: ToolCall) => {
        const tool = this.tools.get(call.function.name);
        if (tool?.parallelSafe === true && tool.risk === "read") return true;
        if (tool?.name !== "bash") return false;
        try {
          const args = parseToolArguments(call.function.arguments || "{}");
          return Boolean(args && typeof args === "object" && !Array.isArray(args)
            && (args as Record<string, unknown>).independent === true);
        } catch { return false; }
      };
      for (let index = 0; index < toolCalls.length;) {
        let end = index + 1;
        if (canParallel(toolCalls[index]!)) {
          while (end < toolCalls.length && end - index < 4 && canParallel(toolCalls[end]!)) end++;
        }
        const first = prepared.length;
        for (const call of toolCalls.slice(index, end)) await prepareCall(call);
        const group = prepared.slice(first);
        for (const item of group) {
          // A crash leaves an honest unknown status, never an invitation to
          // replay effects. Completion replaces this slot in original order.
          item.slot = { role: "tool", name: item.name, tool_call_id: item.id,
            content: "TOOL ERROR: interrupted before a result was recorded. Execution status is unknown; inspect current state before retrying." };
          messages.push(item.slot);
        }
        const settled = await Promise.allSettled(group.map(completeCall));
        const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure) throw failure.reason;
        index = end;
      }
      signal.throwIfAborted();
      // A loop is the same call producing nothing new. Comparing only the last
      // round misses two real patterns seen with DeepSeek on opencode-go:
      // an A→B→C rotation (adjacent signatures always differ) and a noisy
      // result (TTS token counts wobble by one). So keep a short window of
      // rounds and stop when one call signature dominates it while its results
      // keep repeating. A poll whose answer is genuinely new every time —
      // `git status` after edits, a background task reaching a new state —
      // has all-distinct results and never trips this.
      // Compare result text only: tool_call_id is new every round, so folding
      // it in made every result look fresh and the loop never registered.
      const resultSignature = messages.slice(-toolCalls.length)
        .map((message) => String(message.content ?? "")).join("|");
      recentRounds.push({ signature, result: resultSignature });
      if (recentRounds.length > LOOP_WINDOW) recentRounds.shift();
      const sameCall = recentRounds.filter((round) => round.signature === signature);
      const results = new Set(sameCall.map((round) => round.result));
      const stuck = sameCall.length >= LOOP_LIMIT
        && (results.size === 1 || results.size <= Math.floor(sameCall.length / 2));
      repeatCount = stuck ? sameCall.length : 0;
      lastToolSignature = signature;
      lastResultSignature = resultSignature;
      if (repeatCount >= 3) {
        const lastResult = messages.at(-1)!;
        lastResult.content = `${lastResult.content ?? ""}\n[luban runtime] You repeated the identical tool call. Change strategy or give the final answer now.`;
      }
      if (await promote()) { step = -1; lastText = ""; lastToolSignature = ""; repeatCount = 0; recentRounds.length = 0; }
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
      onEvent({ type: "usage", ...final.usage });
      const summary = enforceAgentIdentity(lastUserQuestion(messages), extractFinalAnswer(final.content));
      if (summary.trim()) {
        text = summary;
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (!isModelTimeoutError(error)) onEvent({ type: "status", text: `Could not prepare continuation summary: ${error instanceof Error ? error.message : String(error)}` });
    }
    messages.push({ role: "assistant", content: text });
    await persist();
    onEvent({ type: "status", text: `Paused after ${maxSteps} steps; send “继续” to resume` });
    return { ok: false, text, steps: totalSteps, messages, stopReason: "max_steps", modelCalls, elapsedMs: Date.now() - runStartedAt };
  }
}
