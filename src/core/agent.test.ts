import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunner, initialMessages } from "./agent.js";
import type { ChatMessage, LubanConfig, ToolCall } from "./types.js";

function config(workspace: string): LubanConfig {
  const model = { id: "test/model", provider: "test", model: "model", name: "model", baseUrl: "", apiKey: "" };
  return {
    home: workspace, workspace, project: "test", model, models: [model], maxTokens: 1000,
    temperature: 0, timeoutMs: 1000, maxSteps: 10, backendUrl: "", permissionMode: "ask",
  };
}

describe("AgentRunner", () => {
  it("persists a safe paused reply when summarization fails and resumes without replaying tools", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-pause-fallback-"));
    const settings = config(workspace);
    settings.maxSteps = 1;
    let calls = 0;
    let executions = 0;
    const runner = new AgentRunner(settings, {
      async complete() {
        calls += 1;
        if (calls === 1) return { content: "private intermediate thought", toolCalls: [{ id: "once", type: "function" as const, function: { name: "count", arguments: "{}" } }], usage: { input: 1, output: 1 } };
        if (calls === 2) throw new Error("summary unavailable");
        return { content: "Completed remaining checks.", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    });
    runner.tools.set("count", { name: "count", description: "count", risk: "read", parameters: {}, async execute() { executions++; return "executed"; } });
    const messages: ChatMessage[] = [...initialMessages(workspace), { role: "user", content: "work" }];
    let saved: ChatMessage[] = [];
    try {
      const paused = await runner.run(messages, "agent", new AbortController().signal, () => undefined, async () => "once", async () => { saved = structuredClone(messages); });
      expect(paused.stopReason).toBe("max_steps");
      expect(paused.text).not.toContain("private intermediate thought");
      expect(saved.at(-1)).toMatchObject({ role: "assistant", content: paused.text });
      messages.push({ role: "user", content: "继续" });
      const resumed = await runner.run(messages, "agent", new AbortController().signal, () => undefined, async () => "once");
      expect(resumed.ok).toBe(true);
      expect(executions).toBe(1);
    } finally { runner.close(); }
  });

  it("summarizes and pauses at the step budget so the task can continue", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-maxsteps-"));
    let calls = 0;
    const client = {
      async complete(messages: ChatMessage[], tools: unknown[]) {
        calls += 1;
        if (tools.length === 0) return { content: "已完成第一步，验证通过；还需要继续处理剩余文件。下一步：继续运行任务。", toolCalls: [], usage: { input: 2, output: 8 } };
        return { content: "", toolCalls: [{ id: "r", type: "function" as const, function: { name: "read_file", arguments: '{"path":"missing.txt"}' } }], usage: { input: 1, output: 1 } };
      },
    };
    const runnerConfig = config(workspace);
    runnerConfig.maxSteps = 1;
    const runner = new AgentRunner(runnerConfig, client);
    const events: string[] = [];
    const result = await runner.run(
      [...initialMessages(workspace), { role: "user", content: "inspect the project" }],
      "agent", new AbortController().signal, (event) => events.push(event.type), async () => "once",
    );
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe("max_steps");
    expect(result.text).toContain("验证通过");
    expect(result.messages.at(-1)?.role).toBe("assistant");
    expect(calls).toBe(2);
    expect(events).toContain("status");
  });

  it("announces every model round trip and relays the client's wait notices", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-model-call-"));
    const client = {
      async complete(_messages: ChatMessage[], _tools: unknown[], _signal: AbortSignal, _onDelta?: unknown, onNotice?: (text: string) => void) {
        onNotice?.("模型返回 HTTP 429，0.4s 后重试（第 2/3 次）");
        return { content: "done", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    };
    const runner = new AgentRunner(config(workspace), client);
    const events: Array<{ type: string; index?: number; text?: string }> = [];
    await runner.run(
      [...initialMessages(workspace), { role: "user", content: "hello" }],
      "agent", new AbortController().signal,
      (event) => events.push(event as { type: string; index?: number; text?: string }),
      async () => "once",
    );
    // The UI needs the round-trip number to say *which* call is in flight, and
    // the client's notice to explain a wait that is a retry rather than work.
    expect(events.filter((event) => event.type === "model-call").map((event) => event.index)).toEqual([1]);
    expect(events.some((event) => event.type === "status" && event.text?.includes("HTTP 429"))).toBe(true);
    runner.close();
  });

  it("marks a step label that repeats as progress but leaves a real notice as record", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-status-progress-"));
    let calls = 0;
    const client = {
      async complete(_messages: ChatMessage[], _tools: unknown[], _signal: AbortSignal, _onDelta?: unknown, onNotice?: (text: string) => void) {
        calls += 1;
        if (calls === 1) onNotice?.("模型返回 HTTP 429，0.4s 后重试（第 2/3 次）");
        if (calls <= 2) {
          return {
            content: "",
            toolCalls: [{ id: `c${calls}`, type: "function" as const, function: { name: "count", arguments: `{"n":${calls}}` } }],
            usage: { input: 1, output: 1 },
          };
        }
        return { content: "done", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    };
    const runner = new AgentRunner(config(workspace), client);
    runner.tools.set("count", { name: "count", description: "count", risk: "read", parameters: {}, async execute() { return "ok"; } });
    const statuses: Array<{ text: string; progress?: boolean }> = [];
    await runner.run(
      [...initialMessages(workspace), { role: "user", content: "work" }],
      "agent", new AbortController().signal,
      (event) => { if (event.type === "status") statuses.push({ text: event.text, ...(event.progress ? { progress: true } : {}) }); },
      async () => "once",
    );
    runner.close();

    // Announced once per step, which is exactly why it cannot be history: every
    // transcript and log that recorded it showed one identical line per step.
    const reviewing = statuses.filter((status) => status.text === "Reviewing tool results");
    expect(reviewing).toHaveLength(2);
    expect(reviewing.every((status) => status.progress === true)).toBe(true);
    // A retry notice is an explanation of a wait, so it stays in the record.
    const notice = statuses.find((status) => status.text.includes("HTTP 429"));
    expect(notice).toBeDefined();
    expect(notice?.progress).toBeUndefined();
  });

  it("keeps a truncated answer, asks for the rest, and reports one whole answer", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-truncated-"));
    let calls = 0;
    const client = {
      async complete() {
        calls += 1;
        if (calls === 1) {
          return { content: "第一段被截断的答案", reasoning: "很长的推理", toolCalls: [], usage: { input: 1, output: 1 }, truncated: true };
        }
        return { content: "，接着写完的第二段。", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    };
    const runner = new AgentRunner(config(workspace), client);
    const events: Array<{ type: string; text?: string }> = [];
    const result = await runner.run(
      [...initialMessages(workspace), { role: "user", content: "写一段长答案" }],
      "agent", new AbortController().signal,
      (event) => events.push(event as { type: string; text?: string }),
      async () => "once",
    );
    runner.close();
    // The provider's cap, not luban's budget, is what stopped it, so the run
    // continues instead of failing and the pieces become one answer.
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(result.text).toBe("第一段被截断的答案，接着写完的第二段。");
    expect(result.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(events.some((event) => event.type === "status" && event.text?.includes("截断"))).toBe(true);
  });

  it("stops with something actionable when reasoning eats the whole output budget", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-starved-"));
    let calls = 0;
    const client = {
      async complete() {
        calls += 1;
        // No prose at all: every token went to reasoning, so a retry repeats it.
        return { content: "", reasoning: "思考".repeat(200), toolCalls: [], usage: { input: 1, output: 400 }, truncated: true };
      },
    };
    const runner = new AgentRunner(config(workspace), client);
    const result = await runner.run(
      [...initialMessages(workspace), { role: "user", content: "长任务" }],
      "agent", new AbortController().signal, () => undefined, async () => "once",
    );
    runner.close();
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe("truncated");
    expect(calls).toBe(2);
    expect(result.text).toContain("reasoning_effort");
  });

  it("executes a tool with permission and returns the final answer", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-agent-"));
    let call = 0;
    const toolCall: ToolCall = {
      id: "call-1", type: "function",
      function: { name: "write_file", arguments: JSON.stringify({ path: "done.txt", content: "ok" }) },
    };
    const client = {
      async complete(_messages: ChatMessage[]) {
        call += 1;
        return call === 1
          ? { content: "I will write it.", toolCalls: [toolCall], usage: { input: 10, output: 4 } }
          : { content: "Created and verified done.txt.", toolCalls: [], usage: { input: 12, output: 5 } };
      },
    };
    const runnerConfig = config(workspace);
    const runner = new AgentRunner(runnerConfig, client);
    const messages = [...initialMessages(workspace), { role: "user", content: "create done.txt" } as ChatMessage];
    const events: string[] = [];
    const result = await runner.run(messages, "agent", new AbortController().signal, (event) => events.push(event.type), async () => "once");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Created and verified");
    expect(await readFile(join(workspace, "done.txt"), "utf8")).toBe("ok");
    expect(events).toContain("tool-start");
    expect(events).toContain("tool-end");
    expect(result.messages.find(message => message.role === "tool")?.editPreview).toContain("Edited done.txt (+1 -0)");
  });

  it("feeds a denied tool call back to the model", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-deny-"));
    let call = 0;
    const client = {
      async complete(messages: ChatMessage[]) {
        call += 1;
        if (call === 1) return {
          content: "", toolCalls: [{ id: "x", type: "function" as const, function: { name: "bash", arguments: '{"command":"touch bad"}' } }],
          usage: { input: 1, output: 1 },
        };
        expect(messages.at(-1)?.content).toContain("permission denied");
        return { content: "Permission was denied.", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    };
    const runnerConfig = config(workspace);
    const runner = new AgentRunner(runnerConfig, client);
    const result = await runner.run(
      [...initialMessages(workspace), { role: "user", content: "run it" }],
      "agent", new AbortController().signal, () => undefined, async () => "deny",
    );
    expect(result.text).toContain("denied");
  });

  it("trusts every tool for the rest of the session after one always approval", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-trust-"));
    let call = 0;
    const client = {
      async complete() {
        call += 1;
        if (call === 1) return {
          content: "", toolCalls: [{ id: "write", type: "function" as const, function: { name: "write_file", arguments: '{"path":"trusted.txt","content":"yes"}' } }],
          usage: { input: 1, output: 1 },
        };
        if (call === 2) return {
          content: "", toolCalls: [{ id: "shell", type: "function" as const, function: { name: "bash", arguments: '{"command":"test -f trusted.txt"}' } }],
          usage: { input: 1, output: 1 },
        };
        return { content: "done", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    };
    const trustConfig = config(workspace);
    const runner = new AgentRunner(trustConfig, client);
    let approvals = 0;
    const result = await runner.run(
      [...initialMessages(workspace), { role: "user", content: "do both" }],
      "agent", new AbortController().signal, () => undefined,
      async () => { approvals += 1; return "always"; },
    );
    expect(result.ok).toBe(true);
    expect(approvals).toBe(1);
    expect(trustConfig.permissionMode).toBe("allow");
  });

  it("auto-approves file edits but still asks for shell in edits mode", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-edits-"));
    let call = 0;
    const client = {
      async complete() {
        call += 1;
        if (call === 1) return {
          content: "", toolCalls: [{ id: "w", type: "function" as const, function: { name: "write_file", arguments: '{"path":"a.txt","content":"1"}' } }],
          usage: { input: 1, output: 1 },
        };
        if (call === 2) return {
          content: "", toolCalls: [{ id: "b", type: "function" as const, function: { name: "bash", arguments: '{"command":"echo hi"}' } }],
          usage: { input: 1, output: 1 },
        };
        return { content: "done", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    };
    const runnerConfig = config(workspace);
    runnerConfig.permissionMode = "edits";
    const runner = new AgentRunner(runnerConfig, client);
    const asked: string[] = [];
    const result = await runner.run(
      [...initialMessages(workspace), { role: "user", content: "edit and run" }],
      "agent", new AbortController().signal, () => undefined,
      async (tool) => { asked.push(tool.name); return "once"; },
    );
    expect(result.ok).toBe(true);
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("1");
    expect(asked).toEqual(["bash"]);
  });

  it("trusts only the approved tool after a tool approval", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-tooltrust-"));
    let call = 0;
    const client = {
      async complete() {
        call += 1;
        if (call === 1) return { content: "", toolCalls: [{ id: "b1", type: "function" as const, function: { name: "bash", arguments: '{"command":"echo one"}' } }], usage: { input: 1, output: 1 } };
        if (call === 2) return { content: "", toolCalls: [{ id: "b2", type: "function" as const, function: { name: "bash", arguments: '{"command":"echo two"}' } }], usage: { input: 1, output: 1 } };
        if (call === 3) return { content: "", toolCalls: [{ id: "w", type: "function" as const, function: { name: "write_file", arguments: '{"path":"t.txt","content":"x"}' } }], usage: { input: 1, output: 1 } };
        return { content: "done", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    };
    const runner = new AgentRunner(config(workspace), client);
    const asked: string[] = [];
    const result = await runner.run(
      [...initialMessages(workspace), { role: "user", content: "go" }],
      "agent", new AbortController().signal, () => undefined,
      async (tool) => { asked.push(tool.name); return tool.name === "bash" ? "tool" : "once"; },
    );
    expect(result.ok).toBe(true);
    expect(asked).toEqual(["bash", "write_file"]);
  });

  it("answers identity questions as luban when a model leaks its brand", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-reasoning-"));
    const leaked = `The user is asking what my name is.

According to the system reminder, I am Qwen, so I should answer in Chinese.

Following the guidelines, I should answer naturally.

我叫千问。`;
    const client = {
      async complete() {
        return { content: leaked, toolCalls: [], usage: { input: 4, output: 8 } };
      },
    };
    const runner = new AgentRunner(config(workspace), client);
    const result = await runner.run(
      [...initialMessages(workspace), { role: "user", content: "你叫什么？" }],
      "ask", new AbortController().signal, () => undefined, async () => "once",
    );
    expect(result.text).toBe("我是 luban，一个直接在你的工作区里工作的编码 Agent。");
    expect(result.messages.at(-1)?.content).toBe("我是 luban，一个直接在你的工作区里工作的编码 Agent。");
  });

  it("lets honest answers through when the user asks which model is configured", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-modelq-"));
    const client = {
      async complete() {
        return { content: "我当前配置的是 Qwen3 Coder。", toolCalls: [], usage: { input: 4, output: 8 } };
      },
    };
    const runner = new AgentRunner(config(workspace), client);
    const result = await runner.run(
      [...initialMessages(workspace, "Qwen3 Coder"), { role: "user", content: "你用的什么模型？" }],
      "ask", new AbortController().signal, () => undefined, async () => "once",
    );
    expect(result.text).toBe("我当前配置的是 Qwen3 Coder。");
  });

  it("runs parallel-safe reads concurrently while keeping call order", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-parallel-"));
    let call = 0;
    const client = {
      async complete() {
        call += 1;
        return call === 1 ? {
          content: "", usage: { input: 1, output: 1 },
          toolCalls: ["one", "two"].map((name) => ({ id: name, type: "function" as const, function: { name, arguments: "{}" } })),
        } : { content: "done", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    };
    const runner = new AgentRunner(config(workspace), client);
    let active = 0;
    let maximum = 0;
    for (const name of ["one", "two"]) runner.tools.set(name, {
      name, description: name, risk: "read", parallelSafe: true, parameters: {},
      async execute() {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return name;
      },
    });
    const result = await runner.run(
      [...initialMessages(workspace), { role: "user", content: "read both" }],
      "agent", new AbortController().signal, () => undefined, async () => "once",
    );
    expect(result.ok).toBe(true);
    // Read-only calls declared parallelSafe overlap; previously they were
    // serialized because preparation and dispatch shared one function.
    expect(maximum).toBe(2);
    // Results are still appended in call order, so the transcript reads right.
    expect(result.messages.filter((message) => message.role === "tool").map((message) => message.name)).toEqual(["one", "two"]);
  });

  it("keeps tools that are not parallel-safe strictly sequential", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-serial-"));
    let call = 0;
    const client = {
      async complete() {
        call += 1;
        return call === 1 ? {
          content: "", usage: { input: 1, output: 1 },
          toolCalls: ["one", "two"].map((name) => ({ id: name, type: "function" as const, function: { name, arguments: "{}" } })),
        } : { content: "done", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    };
    const runner = new AgentRunner(config(workspace), client);
    let active = 0;
    let maximum = 0;
    for (const name of ["one", "two"]) runner.tools.set(name, {
      name, description: name, risk: "read", parameters: {},
      async execute() {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return name;
      },
    });
    const result = await runner.run(
      [...initialMessages(workspace), { role: "user", content: "both" }],
      "agent", new AbortController().signal, () => undefined, async () => "once",
    );
    expect(maximum).toBe(1);
    expect(result.messages.filter((message) => message.role === "tool").map((message) => message.name)).toEqual(["one", "two"]);
  });

  it("enforces configured deny rules before interactive approval", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-rules-"));
    let call = 0;
    const client = {
      async complete(messages: ChatMessage[]) {
        call += 1;
        if (call === 1) return {
          content: "", toolCalls: [{ id: "bad", type: "function" as const, function: { name: "bash", arguments: '{"command":"rm -rf build"}' } }],
          usage: { input: 1, output: 1 },
        };
        expect(messages.at(-1)?.content).toContain("blocked by permission rule");
        return { content: "blocked safely", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    };
    const runnerConfig = config(workspace);
    runnerConfig.permissions = { allow: [], deny: ["bash:rm -rf *"] };
    const runner = new AgentRunner(runnerConfig, client);
    let approvals = 0;
    const result = await runner.run(
      [...initialMessages(workspace), { role: "user", content: "delete build" }],
      "agent", new AbortController().signal, () => undefined,
      async () => { approvals += 1; return "once"; },
    );
    expect(result.text).toBe("blocked safely");
    expect(approvals).toBe(0);
  });

  it("uses semantic compaction for oversized history", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-compact-"));
    let calls = 0;
    const client = {
      async complete(messages: ChatMessage[]) {
        calls += 1;
        if (calls === 1) {
          expect(messages[0]?.content).toContain("Compress prior coding-agent history");
          return { content: "Decision: keep API compatibility.", toolCalls: [], usage: { input: 10, output: 4 } };
        }
        expect(messages.some((message) => String(message.content).includes("Decision: keep API compatibility."))).toBe(true);
        return { content: "continued", toolCalls: [], usage: { input: 5, output: 2 } };
      },
    };
    const runnerConfig = config(workspace);
    runnerConfig.contextWindow = 8_192;
    runnerConfig.contextReserve = 2_048;
    runnerConfig.semanticCompaction = true;
    const runner = new AgentRunner(runnerConfig, client);
    const messages: ChatMessage[] = [
      ...initialMessages(workspace),
      { role: "user", content: "old " + "x".repeat(40_000) },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "continue" },
    ];
    const result = await runner.run(messages, "agent", new AbortController().signal, () => undefined, async () => "once");
    expect(result.text).toBe("continued");
    expect(calls).toBe(2);
  });
});

describe("planning modes", () => {
  it("only the always mode forces a plan as the first tool call", async () => {
    const { systemPrompt } = await import("./agent.js");
    expect(systemPrompt("always")).toContain("make update_plan your first tool call");
    // auto must explicitly permit skipping, or the model plans anyway and the
    // round-trip is not saved.
    expect(systemPrompt("auto")).not.toContain("make update_plan your first tool call");
    expect(systemPrompt("auto")).toContain("do not call update_plan just to satisfy this rule");
    expect(systemPrompt("off")).toContain("do not call update_plan");
    // Every mode still asks for verification, just with different ceremony.
    for (const mode of ["off", "auto", "always"] as const) {
      expect(systemPrompt(mode), mode).toMatch(/verify|verification|record_verification/iu);
    }
  });

  it("defaults to the mode that does not spend a round-trip on a plan", async () => {
    const { SYSTEM_PROMPT } = await import("./agent.js");
    expect(SYSTEM_PROMPT).not.toContain("make update_plan your first tool call");
  });
});

describe("run accounting", () => {
  it("reports model round-trips and wall time", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-accounting-"));
    let call = 0;
    const client = {
      async complete() {
        call += 1;
        return call === 1
          ? { content: "", usage: { input: 1, output: 1 }, toolCalls: [{ id: "c1", type: "function" as const, function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] }
          : { content: "done", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    };
    const runner = new AgentRunner(config(workspace), client);
    runner.tools.set("read_file", { name: "read_file", description: "r", risk: "read", parameters: {}, async execute() { return "ok"; } });
    const result = await runner.run([...initialMessages(workspace), { role: "user", content: "go" }],
      "agent", new AbortController().signal, () => undefined, async () => "once");
    // Two model calls: one that asked for the tool, one that finished.
    expect(result.modelCalls).toBe(2);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
