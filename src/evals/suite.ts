import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunner, initialMessages } from "../core/agent.js";
import { readVerifications } from "../core/plan.js";
import type { ChatMessage, LubanConfig, ToolCall } from "../core/types.js";

export interface EvalCheck { name: string; passed: boolean; detail: string }
export interface EvalReport { task: string; ok: boolean; steps: number; toolCalls: number; ms: number; checks: EvalCheck[] }

interface ScriptedResponse { content: string; toolCalls: ToolCall[] }

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** Deterministic stand-in for a model: replays queued responses in order. */
function scriptClient(queue: ScriptedResponse[]) {
  let index = 0;
  return {
    async complete() {
      const next = queue[Math.min(index++, queue.length - 1)]!;
      return { ...next, reasoning: "", usage: { input: 10, output: 10 } };
    },
  };
}

function testConfig(workspace: string): LubanConfig {
  const model = {
    id: "eval/model", provider: "eval", model: "model", name: "model", baseUrl: "", apiKey: "",
    api: "openai" as const,
    capabilities: { vision: false, thinking: false, tools: true, responses: false },
  };
  return {
    home: workspace, workspace, project: "eval", model, models: [model], maxTokens: 2000,
    temperature: 0, timeoutMs: 10_000, maxSteps: 12, backendUrl: "", permissionMode: "allow",
    permissions: { allow: [], deny: [] },
  } as unknown as LubanConfig;
}

async function runScripted(workspace: string, mode: "agent" | "ask", prompt: string, queue: ScriptedResponse[]) {
  const started = Date.now();
  const config = testConfig(workspace);
  const runner = new AgentRunner(config, scriptClient(queue));
  const toolNames: string[] = [];
  try {
    const messages: ChatMessage[] = [...initialMessages(workspace), { role: "user", content: prompt }];
    const result = await runner.run(messages, mode, new AbortController().signal,
      (event) => { if (event.type === "tool-start") toolNames.push(event.name); },
      async () => "once");
    return { result, messages, toolNames, ms: Date.now() - started };
  } finally {
    runner.close();
  }
}

function check(name: string, passed: boolean, detail = ""): EvalCheck {
  return { name, passed, detail };
}

async function singleFileFix(): Promise<EvalReport> {
  const workspace = await mkdtemp(join(tmpdir(), "eval-single-"));
  await writeFile(join(workspace, "add.ts"), "export function add(a: number, b: number): number { return a - b; }\n");
  const { result, messages, toolNames, ms } = await runScripted(workspace, "agent", "fix add() to sum", [
    { content: "", toolCalls: [call("1", "update_plan", { plan: [{ step: "fix add", status: "in_progress" }, { step: "verify", status: "pending" }] })] },
    { content: "", toolCalls: [call("2", "edit_file", { path: "add.ts", old_text: "return a - b;", new_text: "return a + b;" })] },
    { content: "", toolCalls: [call("3", "record_verification", { command: "npx tsc --noEmit", status: "passed", output: "clean" })] },
    { content: "", toolCalls: [call("4", "update_plan", { plan: [{ step: "fix add", status: "completed" }, { step: "verify", status: "completed" }] })] },
    { content: "Fixed add() to return a + b; typecheck clean.", toolCalls: [] },
  ]);
  const fixed = await readFile(join(workspace, "add.ts"), "utf8");
  const checks = [
    check("completes", result.ok, result.text.slice(0, 80)),
    check("file fixed", fixed.includes("a + b"), fixed.trim()),
    check("verification recorded", readVerifications(messages).some((item) => item.status === "passed")),
    check("plan before edit", toolNames.indexOf("update_plan") < toolNames.indexOf("edit_file"), toolNames.join(",")),
  ];
  return { task: "single-file-fix", ok: result.ok && checks.every((item) => item.passed), steps: result.steps, toolCalls: toolNames.length, ms, checks };
}

async function crossFileRefactor(): Promise<EvalReport> {
  const workspace = await mkdtemp(join(tmpdir(), "eval-cross-"));
  await writeFile(join(workspace, "lib.ts"), "export function greet(name: string): string { return name; }\n");
  await writeFile(join(workspace, "main.ts"), "import { greet } from \"./lib\";\nconsole.log(greet(\"w\"));\n");
  const { result, messages, toolNames, ms } = await runScripted(workspace, "agent", "rename greet to welcome", [
    { content: "", toolCalls: [call("1", "code_intelligence", { path: "main.ts", operation: "references", line: 2, column: 14 })] },
    { content: "", toolCalls: [call("2", "edit_file", { path: "lib.ts", old_text: "greet", new_text: "welcome" })] },
    { content: "", toolCalls: [call("3", "edit_file", { path: "main.ts", old_text: 'import { greet } from "./lib";', new_text: 'import { welcome } from "./lib";' })] },
    { content: "", toolCalls: [call("4", "edit_file", { path: "main.ts", old_text: 'greet("w")', new_text: 'welcome("w")' })] },
    { content: "", toolCalls: [call("5", "record_verification", { command: "grep -r greet --include=*.ts . || true", status: "passed", output: "no matches" })] },
    { content: "Renamed greet to welcome in both files; no stragglers.", toolCalls: [] },
  ]);
  const [lib, main] = await Promise.all([readFile(join(workspace, "lib.ts"), "utf8"), readFile(join(workspace, "main.ts"), "utf8")]);
  const checks = [
    check("completes", result.ok, result.text.slice(0, 80)),
    check("both files updated", lib.includes("welcome") && main.includes("welcome"), `${lib.trim()} / ${main.trim()}`.slice(0, 120)),
    check("inspected before edit", toolNames.includes("code_intelligence"), toolNames.join(",")),
    check("verification recorded", readVerifications(messages).length > 0),
  ];
  return { task: "cross-file-refactor", ok: result.ok && checks.every((item) => item.passed), steps: result.steps, toolCalls: toolNames.length, ms, checks };
}

async function failedCommandRecovery(): Promise<EvalReport> {
  const workspace = await mkdtemp(join(tmpdir(), "eval-recover-"));
  const { result, toolNames, ms } = await runScripted(workspace, "agent", "produce status.txt", [
    { content: "", toolCalls: [call("1", "bash", { command: "exit 3" })] },
    { content: "", toolCalls: [call("2", "write_file", { path: "status.txt", content: "recovered\n" })] },
    { content: "The shell probe failed (exit 3), so I wrote status.txt directly.", toolCalls: [] },
  ]);
  const content = await readFile(join(workspace, "status.txt"), "utf8").catch(() => "");
  const checks = [
    check("completes", result.ok, result.text.slice(0, 80)),
    check("changed strategy after failure", toolNames[0] === "bash" && toolNames[1] === "write_file", toolNames.join(",")),
    check("artifact exists", content.includes("recovered"), content.trim()),
  ];
  return { task: "failed-command-recovery", ok: result.ok && checks.every((item) => item.passed), steps: result.steps, toolCalls: toolNames.length, ms, checks };
}

async function askReadonly(): Promise<EvalReport> {
  const workspace = await mkdtemp(join(tmpdir(), "eval-ask-"));
  const { result, messages, toolNames, ms } = await runScripted(workspace, "ask", "delete everything", [
    { content: "", toolCalls: [call("1", "bash", { command: "rm -rf ." })] },
    { content: "I cannot run that: ask mode is read-only.", toolCalls: [] },
  ]);
  const refused = messages.some((message) => message.role === "tool" && String(message.content).includes("read-only"));
  const checks = [
    check("completes as conversation", result.ok, result.text.slice(0, 80)),
    check("write refused in ask mode", refused, toolNames.join(",")),
  ];
  return { task: "ask-readonly-refusal", ok: result.ok && checks.every((item) => item.passed), steps: result.steps, toolCalls: toolNames.length, ms, checks };
}

export const EVAL_TASKS = ["single-file-fix", "cross-file-refactor", "failed-command-recovery", "ask-readonly-refusal"] as const;

export async function runEvalSuite(): Promise<{ reports: EvalReport[]; passed: boolean; totalMs: number }> {
  const started = Date.now();
  const reports = [await singleFileFix(), await crossFileRefactor(), await failedCommandRecovery(), await askReadonly()];
  return { reports, passed: reports.every((report) => report.ok), totalMs: Date.now() - started };
}
