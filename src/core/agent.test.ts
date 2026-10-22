import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunner, initialMessages } from "./agent.js";
import { SessionStore } from "./session-store.js";
import type { ChatMessage, LubanConfig, ToolCall } from "./types.js";

function config(workspace: string): LubanConfig {
  const model = { id: "test/model", provider: "test", model: "model", name: "model", baseUrl: "", apiKey: "" };
  return {
    home: workspace, workspace, project: "test", model, models: [model], maxTokens: 1000,
    temperature: 0, timeoutMs: 1000, maxSteps: 10, backendUrl: "", permissionMode: "ask", modelReconnect: false,
  };
}

describe("AgentRunner", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["once", "always", "tool", "deny"] as const)("requires explicit single-command restart approval even with automatic trust: %s", async decision => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-restart-approval-"));
    const settings = config(workspace);
    settings.permissionMode = "allow";
    settings.permissions = { allow: ["bash"], deny: [] };
    let rounds = 0;
    let prompts = 0;
    const command = "printf reboot; printf approved";
    const runner = new AgentRunner(settings, { async complete(messages: ChatMessage[]) {
      rounds++;
      if (rounds <= 2) return { content: "", toolCalls: [{ id: `restart-${rounds}`, type: "function" as const,
        function: { name: "bash", arguments: JSON.stringify({ command }) } }], usage: { input: 1, output: 1 } };
      const results = messages.filter(message => message.role === "tool");
      expect(results).toHaveLength(2);
      for (const result of results) expect(result.content).toContain(decision === "once" ? "rebootapproved" : "TOOL ERROR:");
      return { content: "done", toolCalls: [], usage: { input: 1, output: 1 } };
    } });
    try {
      await runner.run([...initialMessages(workspace), { role: "user", content: "test" }], "agent", new AbortController().signal,
        () => undefined, async (tool, args) => {
          prompts++;
          expect(tool.approvalOnceOnly).toBe(true);
          expect(tool.approvalReason).toContain("重启");
          expect(args.command).toBe(command);
          args.command = "reboot"; // UI receives a copy, not executable args.
          return decision;
        });
      expect(prompts).toBe(2);
    } finally { runner.close(); }
  });

  it.each(["json", "sse"])("replays DeepSeek reasoning and tool results across successive %s requests and session reload", async format => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-deepseek-history-"));
    const settings = config(workspace);
    settings.model = { ...settings.model, id: "opencode-go/deepseek-v4.1-flash", provider: "opencode-go", model: "deepseek-v4.1-flash", api: "openai" };
    settings.maxTokens = 32_000;
    settings.maxRetries = 0;
    const bodies: Record<string, unknown>[] = [];
    const executions: number[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      const index = bodies.length;
      const history = body.messages as ChatMessage[];
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.max_tokens).toBe(32_000);
      expect(history.filter(message => message.role === "tool").map(message => message.content))
        .toEqual(Array.from({ length: Math.min(index - 1, 2) }, (_, n) => `result-${n + 1}`));
      expect(history.filter(message => message.role === "assistant").map(message => message.reasoning_content))
        .toEqual(Array.from({ length: index - 1 }, (_, n) => `reasoning-${n + 1}`));
      const message = { content: index < 3 ? "" : "done", reasoning_content: `reasoning-${index}`,
        ...(index < 3 ? { tool_calls: [{ id: `step-${index}`, type: "function",
          function: { name: "probe", arguments: JSON.stringify({ stage: index }) } }] } : {}) };
      const finish_reason = index < 3 ? "tool_calls" : "stop";
      return format === "json" ? Response.json({ choices: [{ message, finish_reason }] })
        : new Response(`data: ${JSON.stringify({ choices: [{ delta: message, finish_reason }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } });
    });
    const runner = new AgentRunner(settings);
    runner.tools.set("probe", { name: "probe", description: "diagnose", risk: "read", parameters: {},
      async execute(args) { executions.push(Number(args.stage)); return `result-${args.stage}`; } });
    const messages: ChatMessage[] = [...initialMessages(workspace), { role: "user", content: "你好" }];
    const store = new SessionStore(workspace);
    const record = store.create("test", workspace, "agent", settings.model.id, messages);
    try {
      const result = await runner.run(messages, "agent", new AbortController().signal, () => undefined, async () => "once", () => store.save(record));
      expect(result).toMatchObject({ ok: true, text: "done" });
      expect(executions).toEqual([1, 2]);
      const loaded = (await store.load(record.id, "test"))!;
      expect(loaded.messages.filter(message => message.role === "assistant").map(message => message.reasoning_content))
        .toEqual(["reasoning-1", "reasoning-2", "reasoning-3"]);
      loaded.messages.push({ role: "user", content: "继续" });
      expect((await runner.run(loaded.messages, "agent", new AbortController().signal, () => undefined, async () => "once")).ok).toBe(true);
      expect(bodies).toHaveLength(4);
      expect(executions).toEqual([1, 2]);
    } finally { runner.close(); }
  });

  it("retains Go's configured retry budget and stable routing after a tool already ran", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-go-retry-tool-"));
    const settings = config(workspace);
    settings.model = { ...settings.model, provider: "opencode-go", model: "cat-jam-free", api: "openai" };
    settings.maxRetries = 3;
    let requests = 0;
    let executions = 0;
    const headers: Headers[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      headers.push(new Headers(init.headers));
      requests++;
      if (requests === 1) return Response.json({ choices: [{ message: { content: "", tool_calls: [{
        id: "read-once", type: "function", function: { name: "read_file", arguments: '{"path":"probe.txt"}' },
      }] }, finish_reason: "tool_calls" }] });
      if (requests < 5) return new Response('{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}',
        { status: 429, headers: { "retry-after": "0" } });
      return Response.json({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] });
    });
    const runner = new AgentRunner(settings);
    runner.tools.set("read_file", { name: "read_file", description: "read", risk: "read", parameters: {},
      async execute() { executions++; return "read result"; } });
    try {
      const result = await runner.run([...initialMessages(workspace), { role: "user", content: "hi" }],
        "agent", new AbortController().signal, () => undefined, async () => "once");
      expect(result.ok).toBe(true);
      expect(requests).toBe(5);
      expect(executions).toBe(1);
      expect(new Set(headers.map(value => value.get("x-opencode-session"))).size).toBe(1);
      expect(headers[0]!.get("x-opencode-session")).not.toBe("luban");
    } finally { runner.close(); }
  });

  it("lets the user cancel a Go empty-stream retry without issuing another request", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-go-retry-cancel-"));
    const settings = config(workspace);
    settings.model.provider = "opencode-go";
    settings.maxRetries = 2;
    let calls = 0;
    const runner = new AgentRunner(settings, { async complete() {
      calls++; throw new Error("model stream ended before completion");
    } });
    const controller = new AbortController();
    try {
      await expect(runner.run([...initialMessages(workspace), { role: "user", content: "hi" }], "agent", controller.signal,
        event => { if (event.type === "status" && event.text.startsWith("Go 模型连接")) controller.abort(new Error("cancelled")); },
        async () => "once")).rejects.toThrow("cancelled");
      expect(calls).toBe(1);
    } finally { runner.close(); }
  });

  it("recovers a Go stream that closes before output without replaying tools", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-go-empty-stream-"));
    const settings = config(workspace);
    settings.model = { ...settings.model, provider: "opencode-go", api: "openai" };
    settings.maxRetries = 1;
    let requests = 0;
    vi.stubGlobal("fetch", async () => {
      requests++;
      return requests === 1 ? new Response("", { headers: { "content-type": "text/event-stream" } })
        : Response.json({ choices: [{ message: { content: "recovered" }, finish_reason: "stop" }] });
    });
    const runner = new AgentRunner(settings);
    try {
      const result = await runner.run([...initialMessages(workspace), { role: "user", content: "hi" }],
        "agent", new AbortController().signal, () => undefined, async () => "once");
      expect(result).toMatchObject({ ok: true, text: "recovered", modelCalls: 2 });
      expect(requests).toBe(2);
    } finally { runner.close(); }
  });

  it("honors max_retries zero and keeps earlier Go tool results when the endpoint stays unavailable", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-go-retry-zero-"));
    const settings = config(workspace);
    settings.model = { ...settings.model, provider: "opencode-go", api: "openai" };
    settings.maxRetries = 0;
    let requests = 0;
    let executions = 0;
    vi.stubGlobal("fetch", async () => {
      requests++;
      return requests === 1 ? Response.json({ choices: [{ message: { content: "", tool_calls: [{
        id: "once", type: "function", function: { name: "read_file", arguments: '{"path":"probe.txt"}' },
      }] }, finish_reason: "tool_calls" }] })
        : new Response('{"error":{"message":"Upstream request failed: Endpoint is unavailable."}}', { status: 429 });
    });
    const runner = new AgentRunner(settings);
    runner.tools.set("read_file", { name: "read_file", description: "read", risk: "read", parameters: {},
      async execute() { executions++; return "saved tool result"; } });
    const messages: ChatMessage[] = [...initialMessages(workspace), { role: "user", content: "hi" }];
    try {
      await expect(runner.run(messages, "agent", new AbortController().signal, () => undefined, async () => "once"))
        .rejects.toThrow("model HTTP 429");
      expect(requests).toBe(2);
      expect(executions).toBe(1);
      expect(messages.some(message => message.role === "tool" && message.content === "saved tool result")).toBe(true);
    } finally { runner.close(); }
  });

  it("keeps Codex's configured timeout, records usage, and avoids automatic title calls", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-codex-controls-"));
    const settings = config(workspace);
    settings.model = { ...settings.model, api: "codex", reasoningEffort: "medium" };
    settings.timeoutMs = 300_000;
    let calls = 0;
    const runner = new AgentRunner(settings, {
      async complete(_messages, _tools, _signal, _delta, _notice, options) {
        calls++;
        expect(options?.timeoutMs).toBeUndefined();
        return { content: "done", toolCalls: [], usage: { input: 120, output: 30, cached: 100, reasoning: 20 } };
      },
    });
    try {
      const messages: ChatMessage[] = [...initialMessages(workspace), { role: "user", content: "hi" }];
      const result = await runner.run(messages, "ask", new AbortController().signal, () => undefined, async () => "once");
      expect(result.metrics?.requests[0]?.usage).toEqual({ input: 120, output: 30, cached: 100, reasoning: 20 });
      expect(await runner.suggestTitle(messages)).toBeUndefined();
      expect(calls).toBe(1);
    } finally { runner.close(); }
  });

  it("does not replay a silent Codex timeout", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-codex-timeout-"));
    const settings = config(workspace);
    settings.model = { ...settings.model, api: "codex" };
    settings.maxRetries = 5;
    let calls = 0;
    const runner = new AgentRunner(settings, { async complete() { calls++; throw new Error("model stream idle timeout"); } });
    try {
      await expect(runner.run([...initialMessages(workspace), { role: "user", content: "hi" }],
        "ask", new AbortController().signal, () => undefined, async () => "once")).rejects.toThrow("idle timeout");
      expect(calls).toBe(1);
    } finally { runner.close(); }
  });
  it("retries a silent stream timeout without surfacing intermediate timeout notices", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-silent-timeout-"));
    let calls = 0;
    const settings = config(workspace);
    settings.maxRetries = 2;
    const runner = new AgentRunner(settings, {
      async complete(_messages: ChatMessage[], _tools: unknown[], _signal: AbortSignal, _onDelta: unknown, onNotice?: (text: string) => void) {
        calls += 1;
        if (calls < 3) {
          onNotice?.("模型已 1s 没有任何输出，已中断本次请求");
          throw new Error("model stream idle timeout after 1s");
        }
        return { content: "已完成", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    });
    const events: Array<{ type: string; text?: string; index?: number }> = [];
    try {
      const result = await runner.run(
        [...initialMessages(workspace), { role: "user", content: "完成任务" }],
        "agent", new AbortController().signal,
        (event) => events.push(event as { type: string; text?: string; index?: number }), async () => "once",
      );
      expect(result.ok).toBe(true);
      expect(result.modelCalls).toBe(3);
      expect(calls).toBe(3);
      expect(events.filter((event) => event.type === "model-call").map((event) => event.index)).toEqual([1, 2, 3]);
      expect(events.some((event) => event.type === "status" && /超时|没有任何输出|timeout/u.test(event.text ?? ""))).toBe(false);
    } finally { runner.close(); }
  });

  it("does not retry a timeout after streamed output has begun", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-partial-timeout-"));
    let calls = 0;
    const runner = new AgentRunner(config(workspace), {
      async complete(_messages: ChatMessage[], _tools: unknown[], _signal: AbortSignal, onDelta?: (text: string, kind: "content" | "reasoning") => void) {
        calls += 1;
        onDelta?.("partial", "content");
        throw new Error("model stream idle timeout after 1s");
      },
    });
    try {
      await expect(runner.run([...initialMessages(workspace), { role: "user", content: "write" }],
        "agent", new AbortController().signal, () => undefined, async () => "once"))
        .rejects.toThrow("idle timeout");
      expect(calls).toBe(1);
    } finally { runner.close(); }
  });

  it("explains how to connect Zen before an uncredentialed model request", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-zen-unconnected-"));
    const settings = config(workspace);
    settings.model = { ...settings.model, id: "opencode-zen/gpt-6-luna", provider: "opencode-zen", model: "gpt-6-luna" };
    const runner = new AgentRunner(settings, { async complete() { throw new Error("model should not be called"); } });
    try {
      await expect(runner.run([...initialMessages(workspace), { role: "user", content: "hi" }],
        "agent", new AbortController().signal, () => undefined, async () => "once"))
        .rejects.toThrow("OPENCODE_ZEN_API_KEY");
    } finally { runner.close(); }
  });
  it("lets the model correct malformed JSON tool arguments without failing the task", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-invalid-tool-json-"));
    let calls = 0;
    let executions = 0;
    const runner = new AgentRunner(config(workspace), {
      async complete(messages: ChatMessage[]) {
        calls += 1;
        if (calls === 1) return {
          content: "", usage: { input: 1, output: 1 },
          toolCalls: [{ id: "bad", type: "function" as const, function: { name: "read_file", arguments: '{"path":"C:\\q"}' } }],
        };
        expect(messages.find((message) => message.tool_call_id === "bad")?.content).toContain("TOOL ERROR: invalid JSON arguments");
        return { content: "recovered", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    });
    runner.tools.set("read_file", { name: "read_file", description: "read", risk: "read", parameters: {}, async execute() { executions++; return "unexpected"; } });
    try {
      const result = await runner.run(
        [...initialMessages(workspace), { role: "user", content: "Read the file" }],
        "agent", new AbortController().signal, () => undefined, async () => "once",
      );
      expect(result.ok).toBe(true);
      expect(result.text).toBe("recovered");
      expect(calls).toBe(2);
      expect(executions).toBe(0);
    } finally { runner.close(); }
  });

  it("runs provider-style Bash and Glob aliases through the registered tools", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-tool-alias-"));
    await writeFile(join(workspace, "sample.txt"), "hello\n");
    const settings = config(workspace);
    settings.permissionMode = "allow";
    let calls = 0;
    const runner = new AgentRunner(settings, {
      async complete(messages: ChatMessage[]) {
        if (++calls === 1) return {
          content: "", usage: { input: 1, output: 1 },
          toolCalls: [
            { id: "shell", type: "function" as const, function: { name: "Bash", arguments: JSON.stringify({ command: process.platform === "win32" ? "echo alias-ok" : "printf alias-ok", description: "check" }) } },
            { id: "files", type: "function" as const, function: { name: "Glob", arguments: '{"pattern":"*.txt"}' } },
          ],
        };
        expect(messages.filter((message) => message.role === "tool").map((message) => message.name)).toEqual(["bash", "glob_files"]);
        expect(messages.find((message) => message.tool_call_id === "shell")?.content).toContain("alias-ok");
        expect(messages.find((message) => message.tool_call_id === "files")?.content).toContain("sample.txt");
        return { content: "done", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    });
    try {
      const result = await runner.run(
        [...initialMessages(workspace), { role: "user", content: "check files" }],
        "agent", new AbortController().signal, () => undefined, async () => "once",
      );
      expect(result.ok).toBe(true);
      expect(result.messages.some((message) => String(message.content).includes("unknown tool"))).toBe(false);
    } finally { runner.close(); }
  });

  it("adapts provider-style file tool argument names before permission and execution", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-file-alias-"));
    await writeFile(join(workspace, "source.txt"), "before\n");
    const settings = config(workspace);
    settings.permissionMode = "allow";
    let calls = 0;
    const runner = new AgentRunner(settings, {
      async complete(messages: ChatMessage[]) {
        if (++calls === 1) return {
          content: "", usage: { input: 1, output: 1 },
          toolCalls: [
            { id: "read", type: "function" as const, function: { name: "Read", arguments: '{"file_path":"source.txt"}' } },
            { id: "write", type: "function" as const, function: { name: "Write", arguments: '{"file_path":"target.txt","content":"old"}' } },
            { id: "edit", type: "function" as const, function: { name: "Edit", arguments: '{"file_path":"target.txt","old_string":"old","new_string":"new"}' } },
          ],
        };
        expect(messages.filter((message) => message.role === "tool").map((message) => message.name)).toEqual(["read_file", "write_file", "edit_file"]);
        expect(messages.find((message) => message.tool_call_id === "read")?.content).toContain("before");
        return { content: "done", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    });
    try {
      const result = await runner.run(
        [...initialMessages(workspace), { role: "user", content: "edit the file" }],
        "agent", new AbortController().signal, () => undefined, async () => "once",
      );
      expect(result.ok).toBe(true);
      expect(await readFile(join(workspace, "target.txt"), "utf8")).toBe("new");
    } finally { runner.close(); }
  });

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

  it("keeps a dropped stream's answer and asks for the rest instead of failing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-dropped-"));
    let calls = 0;
    const client = {
      async complete() {
        calls += 1;
        if (calls === 1) {
          // The connection dropped mid-answer: no finish reason, but real text.
          return { content: "连接中断前的半截答案", toolCalls: [], usage: { input: 1, output: 1 }, truncated: true, streamEnded: true };
        }
        return { content: "，续写完成。", toolCalls: [], usage: { input: 1, output: 1 } };
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
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(result.text).toBe("连接中断前的半截答案，续写完成。");
    expect(events.some((event) => event.type === "status" && event.text?.includes("中断"))).toBe(false);
  });

  it("gives up with network advice after repeated dropped streams", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-dropped-loop-"));
    const client = {
      async complete() {
        return { content: "", toolCalls: [], usage: { input: 1, output: 1 }, truncated: true, streamEnded: true };
      },
    };
    const runner = new AgentRunner(config(workspace), client);
    const result = await runner.run(
      [...initialMessages(workspace), { role: "user", content: "写一段长答案" }],
      "agent", new AbortController().signal, () => undefined, async () => "once",
    );
    runner.close();
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe("truncated");
    expect(result.text).toContain("连接");
  });

  it("does not replay an identical request when reasoning controls and budget cannot change", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-starved-"));
    let calls = 0;
    const client = {
      async complete() {
        calls += 1;
        // No native controls and already using the configured cap.
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
    expect(calls).toBe(1);
    expect(result.text).toContain("reasoning_effort");
  });

  it("restores the full wire budget after reasoning starves fast mode without replaying a completed tool", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-reasoning-budget-"));
    const settings = config(workspace);
    settings.maxTokens = 32_000;
    settings.model = { ...settings.model, api: "openai" };
    const bodies: Record<string, unknown>[] = [];
    let executions = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const index = bodies.length;
      const message = index === 1 ? { content: "", tool_calls: [{ id: "read-once", type: "function", function: { name: "read_file", arguments: "{}" } }] }
        : index === 2 ? { content: "", reasoning_content: "推理".repeat(200) } : { content: "完成" };
      return Response.json({ choices: [{ message, finish_reason: index === 1 ? "tool_calls" : index === 2 ? "length" : "stop" }] });
    });
    const runner = new AgentRunner(settings);
    runner.tools.set("read_file", { name: "read_file", description: "read", risk: "read", parameters: {},
      async execute() { executions++; return "saved result"; } });
    try {
      const result = await runner.run([...initialMessages(workspace), { role: "user", content: "你好" }],
        "agent", new AbortController().signal, () => undefined, async () => "once");
      expect(result.ok).toBe(true);
      expect(executions).toBe(1);
      expect(bodies.map(body => body.max_tokens)).toEqual([8192, 8192, 32_000]);
      expect((bodies[2]!.messages as ChatMessage[]).some(message => message.role === "tool" && message.content === "saved result")).toBe(true);
      expect(bodies[2]).not.toHaveProperty("reasoning_effort");
      expect(settings.enableThinking).toBeUndefined();
    } finally { runner.close(); }
  });

  it.each([false, true])("changes native thinking once, then %s repeated starvation stays bounded", async persistent => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-reasoning-control-"));
    const settings = config(workspace);
    settings.enableThinking = true;
    settings.model = { ...settings.model, api: "openai", model: "deepseek-v4-flash" };
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const truncated = persistent || bodies.length === 1;
      return Response.json({ choices: [{ message: truncated ? { content: "", reasoning_content: "推理" } : { content: "完成" }, finish_reason: truncated ? "length" : "stop" }] });
    });
    const runner = new AgentRunner(settings);
    try {
      const result = await runner.run([...initialMessages(workspace), { role: "user", content: "hi" }],
        "agent", new AbortController().signal, () => undefined, async () => "once");
      expect(result.ok).toBe(!persistent);
      expect(bodies).toHaveLength(2);
      expect(bodies.map(body => body.thinking)).toEqual([{ type: "enabled" }, { type: "disabled" }]);
      expect(bodies.map(body => body.max_tokens)).toEqual([1000, 1000]);
      expect(settings.enableThinking).toBe(true);
    } finally { runner.close(); }
  });

  it("does not accumulate truncations separated by successful tool rounds", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-truncation-rounds-"));
    let requests = 0, executions = 0;
    const client = { async complete() {
      requests++;
      if (requests === 9) return { content: "done", toolCalls: [], usage: { input: 1, output: 1 } };
      if (requests % 2) return { content: `partial-${requests}`, toolCalls: [], usage: { input: 1, output: 1 }, truncated: true };
      return { content: "", toolCalls: [{ id: `tool-${requests}`, type: "function" as const,
        function: { name: "read_file", arguments: JSON.stringify({ round: requests }) } }], usage: { input: 1, output: 1 } };
    } };
    const runner = new AgentRunner(config(workspace), client);
    runner.tools.set("read_file", { name: "read_file", description: "read", risk: "read", parameters: {},
      async execute() { executions++; return "ok"; } });
    try {
      const result = await runner.run([...initialMessages(workspace), { role: "user", content: "hi" }],
        "agent", new AbortController().signal, () => undefined, async () => "once");
      expect(result.ok).toBe(true);
      expect(requests).toBe(9);
      expect(executions).toBe(4);
    } finally { runner.close(); }
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
    runnerConfig.contextWindow = 16_384;
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
