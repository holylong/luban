import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner, initialMessages } from "./agent.js";
import { compactMessages, estimateMessagesTokens } from "./context.js";
import { repairToolHistory } from "./history.js";
import { planTools, readPlan } from "./plan.js";
import { SessionStore } from "./session-store.js";
import type { ChatMessage, LubanConfig, ToolCall } from "./types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }))); });
async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), "luban-reliability-"));
  roots.push(workspace);
  const config = {
    workspace, home: workspace, project: "test", model: { name: "test" }, maxTokens: 1000,
    maxSteps: 10, permissionMode: "allow", contextWindow: 128000, contextReserve: 16000,
    semanticCompaction: false,
  } as LubanConfig;
  const messages: ChatMessage[] = [...initialMessages(workspace), { role: "user", content: "finish the task" }];
  return { config, messages };
}
const call = (id: string, name = "read_file", args = "{}"): ToolCall => ({ id, type: "function", function: { name, arguments: args } });
const completion = (calls: ToolCall[] = []) => ({ content: calls.length ? "working" : "done", toolCalls: calls, usage: { input: 1, output: 1 } });
function expectPaired(messages: ChatMessage[]) {
  let pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      expect(pending.has(message.tool_call_id!)).toBe(true);
      pending.delete(message.tool_call_id!);
    } else if (message.role === "system") {
      // Plan/verification records are inserted mid-batch; they do not end it.
    } else {
      expect(pending.size).toBe(0);
      pending = new Set(message.tool_calls?.map((call) => call.id));
      expect(pending.size).toBe(message.tool_calls?.length ?? 0);
    }
  }
  expect(pending.size).toBe(0);
}

describe("long-running agent reliability", () => {
  it("compacts exchanges within a single task and preserves the request, rules, and tool pairs", () => {
    const request: ChatMessage = { role: "user", content: "Implement compatibility; do not change the public API." };
    const messages: ChatMessage[] = [{ role: "system", content: "rules" }, request];
    for (let i = 0; i < 15; i++) messages.push(
      { role: "assistant", content: "", tool_calls: [call(String(i))] },
      { role: "tool", tool_call_id: String(i), content: "header " + "x".repeat(5000) + " TEST FAILED" },
    );
    const before = JSON.stringify(messages);
    const result = compactMessages(messages, 1000);
    expect(result.removed).toBeGreaterThan(0);
    expect(estimateMessagesTokens(result.messages)).toBeLessThanOrEqual(1000);
    expect(result.messages).toContain(request);
    expect(result.messages.at(-1)?.content).toContain("TEST FAILED");
    expectPaired(result.messages);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("bounds one oversized parallel tool batch without altering its arguments", () => {
    const calls = [call("a", "read_file", '{"path":"a.ts"}'), call("b", "read_file", '{"path":"b.ts"}')];
    const messages: ChatMessage[] = [{ role: "system", content: "rules" }, { role: "user", content: "fix it" },
      { role: "assistant", content: "", tool_calls: calls },
      ...calls.map((item) => ({ role: "tool" as const, tool_call_id: item.id, content: "BEGIN " + "x".repeat(10000) + " END" }))];
    const result = compactMessages(messages, 800);
    expect(estimateMessagesTokens(result.messages)).toBeLessThanOrEqual(800);
    expect(result.messages.find((message) => message.tool_calls)?.tool_calls).toEqual(calls);
    expect(result.messages.filter((message) => message.role === "tool").every((message) => message.content?.includes("END"))).toBe(true);
    expectPaired(result.messages);
  });

  it("repairs interrupted historical batches without claiming they never executed", () => {
    const messages: ChatMessage[] = [{ role: "assistant", content: "", tool_calls: [call("a"), call("b")] },
      { role: "tool", tool_call_id: "a", content: "saved" }, { role: "user", content: "continue" },
      { role: "tool", tool_call_id: "orphan", content: "bad" }];
    repairToolHistory(messages);
    expectPaired(messages);
    expect(messages[2]?.content).toContain("Execution status is unknown");
    const before = JSON.stringify(messages);
    repairToolHistory(messages);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("keeps a tool result that a plan/verification system record sits in front of", () => {
    // update_plan/record_verification insert a [luban …] system message while the
    // batch is still settling, so it lands between the call and its result. That
    // record must not be mistaken for the end of the batch.
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", tool_calls: [call("a", "record_verification", '{"command":"npm test","status":"passed"}')] },
      { role: "system", content: "[luban verification]\n{}" },
      { role: "tool", tool_call_id: "a", name: "record_verification", content: "recorded" },
    ];
    repairToolHistory(messages);
    expectPaired(messages);
    expect(messages.some((message) => message.role === "tool" && message.tool_call_id === "a" && message.content === "recorded")).toBe(true);
    expect(messages.some((message) => String(message.content).includes("interrupted before"))).toBe(false);
  });

  it("blocks writes in ASK even with allow-all and hides effectful tool schemas", async () => {
    const { config, messages } = await setup();
    const approve = vi.fn(async () => "always" as const);
    let turns = 0;
    const runner = new AgentRunner(config, { async complete(history, schemas) {
      expect(schemas.some((schema) => (schema.function as { name: string }).name === "write_file")).toBe(false);
      if (++turns === 1) return completion([call("a", "write_file", '{"path":"bad.txt","content":"bad"}')]);
      expect(history.at(-1)?.content).toContain("ASK mode is read-only");
      return completion();
    } });
    try {
      await runner.run(messages, "ask", new AbortController().signal, () => {}, approve);
      expect(approve).not.toHaveBeenCalled();
      await expect(readFile(join(config.workspace, "bad.txt"))).rejects.toThrow();
    } finally { runner.close(); }
  });

  it("stops repeated calls with complete history that can be resumed", async () => {
    const { config, messages } = await setup();
    const execute = vi.fn(async () => "same result");
    const runner = new AgentRunner(config, { async complete(history) { expectPaired(history); return completion([call("a", "probe")]); } });
    runner.tools.set("probe", { name: "probe", description: "probe", risk: "read", parameters: {}, execute });
    try {
      const result = await runner.run(messages, "agent", new AbortController().signal, () => {}, async () => "deny");
      expect(result.ok).toBe(false);
      expect(execute).toHaveBeenCalledTimes(5);
      expectPaired(messages);
      expect(messages.at(-1)?.content).toContain("not executed");
    } finally { runner.close(); }
  });

  it("cancels while approval is pending, skips remaining writes, and persists closed history", async () => {
    const { config, messages } = await setup();
    config.permissionMode = "ask";
    const controller = new AbortController();
    const snapshots: ChatMessage[][] = [];
    const runner = new AgentRunner(config, { async complete() { return completion([
      call("a", "write_file", '{"path":"a.txt","content":"bad"}'),
      call("b", "write_file", '{"path":"b.txt","content":"bad"}'),
    ]); } });
    try {
      const run = runner.run(messages, "agent", controller.signal, () => {}, async () => {
        controller.abort(new Error("cancelled"));
        return await new Promise<never>(() => {});
      }, async () => { snapshots.push(structuredClone(messages)); });
      await expect(run).rejects.toThrow("cancelled");
      expectPaired(messages);
      expectPaired(snapshots.at(-1)!);
      for (const file of ["a.txt", "b.txt"]) await expect(readFile(join(config.workspace, file))).rejects.toThrow();
    } finally { runner.close(); }
  });

  it("saves plans before the next model request and preserves them across compaction and reload", async () => {
    const { config, messages } = await setup();
    const store = new SessionStore(config.home);
    const record = store.create("test", config.workspace, "agent", "test", messages);
    const plan = [{ step: "Implement fix", status: "completed" }, { step: "Run regression test", status: "in_progress" }];
    let turns = 0;
    const runner = new AgentRunner(config, { async complete() {
      if (++turns === 1) return completion([call("p", "update_plan", JSON.stringify({ plan }))]);
      expect(readPlan((await store.load(record.id, "test"))!.messages)?.plan).toEqual(plan);
      return completion();
    } });
    try {
      await runner.run(messages, "agent", new AbortController().signal, () => {}, async () => "deny", () => store.save(record));
      const loaded = (await store.load(record.id, "test"))!;
      loaded.messages.push({ role: "assistant", content: "old output".repeat(3000) }, { role: "user", content: "continue" });
      expect(readPlan(compactMessages(loaded.messages, 1800).messages)?.plan).toEqual(plan);
      const other: ChatMessage[] = [];
      expect(await planTools(other)[1]!.execute({}, new AbortController().signal)).toContain("No plan yet");
    } finally { runner.close(); }
  });

  it("rejects invalid plan transitions without changing saved state", async () => {
    const messages: ChatMessage[] = [];
    const tool = planTools(messages)[0]!;
    const signal = new AbortController().signal;
    await tool.execute({ plan: [{ step: "test", status: "pending" }] }, signal);
    const before = JSON.stringify(messages);
    await expect(tool.execute({ plan: [{ step: "a", status: "in_progress" }, { step: "b", status: "in_progress" }] }, signal)).rejects.toThrow("at most one");
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("refuses irreducible context before sending any model request", async () => {
    const { config, messages } = await setup();
    config.contextWindow = 4000;
    config.contextReserve = 2000;
    messages.push({ role: "user", content: "x".repeat(50000) });
    const complete = vi.fn(async () => completion());
    const runner = new AgentRunner(config, { complete });
    try {
      const result = await runner.run(messages, "agent", new AbortController().signal, () => {}, async () => "deny");
      expect(result.ok).toBe(false);
      expect(result.text).toContain("Context budget exceeded");
      expect(complete).not.toHaveBeenCalled();
      expect(messages.at(-1)?.content?.length).toBe(50000);
    } finally { runner.close(); }
  });
  it("normalizes duplicate model call IDs before execution", async () => {
    const { config, messages } = await setup();
    let turns = 0;
    const runner = new AgentRunner(config, { async complete(history) {
      expectPaired(history);
      return ++turns === 1 ? completion([call("same", "read_plan"), call("same", "read_plan")]) : completion();
    } });
    try {
      await runner.run(messages, "agent", new AbortController().signal, () => {}, async () => "deny");
      expectPaired(messages);
      const ids = messages.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []);
      expect(new Set(ids).size).toBe(2);
    } finally { runner.close(); }
  });

  it("does not execute effects when saving the pending call fails", async () => {
    const { config, messages } = await setup();
    const runner = new AgentRunner(config, { async complete() {
      return completion([call("a", "write_file", '{"path":"bad.txt","content":"bad"}')]);
    } });
    try {
      await expect(runner.run(messages, "agent", new AbortController().signal, () => {}, async () => "always", async () => {
        if (messages.some((message) => message.tool_calls?.length)) throw new Error("disk unavailable");
      })).rejects.toThrow("disk unavailable");
      expectPaired(messages);
      await expect(readFile(join(config.workspace, "bad.txt"))).rejects.toThrow();
    } finally { runner.close(); }
  });

  it("prevents overlapping runs on one runner from replacing session-local tools", async () => {
    const { config, messages } = await setup();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const runner = new AgentRunner(config, { async complete() { await waiting; return completion(); } });
    try {
      const active = runner.run(messages, "agent", new AbortController().signal, () => {}, async () => "deny");
      await expect(runner.run([], "agent", new AbortController().signal, () => {}, async () => "deny")).rejects.toThrow("active run");
      release();
      expect((await active).ok).toBe(true);
    } finally { release(); runner.close(); }
  });

});
