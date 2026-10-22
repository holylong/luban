import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunner, initialMessages } from "./agent.js";
import { SessionStore } from "./session-store.js";
import { planTools, readPlan } from "./plan.js";
import type { AgentEvent, ChatMessage, LubanConfig } from "./types.js";

const waiting = vi.hoisted(() => vi.fn(async (_ms: number, signal: AbortSignal) => { signal.throwIfAborted(); }));
vi.mock("./opencode-go.js", async importOriginal => ({
  ...await importOriginal<typeof import("./opencode-go.js")>(), waitForModelRetry: waiting,
}));
const roots: string[] = [];
afterEach(async () => {
  waiting.mockReset();
  waiting.mockImplementation(async (_ms, signal) => { signal.throwIfAborted(); });
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function setup(api = "openai") {
  const workspace = await mkdtemp(join(tmpdir(), "luban-recovery-")); roots.push(workspace);
  const config = { workspace, home: workspace, project: "test", model: { name: "test", api },
    maxTokens: 1000, maxSteps: 3, maxRetries: 1, permissionMode: "allow",
    contextWindow: 128000, contextReserve: 16000, semanticCompaction: false } as LubanConfig;
  const messages: ChatMessage[] = [...initialMessages(workspace), { role: "user", content: "finish the original task" }];
  return { config, messages };
}
const done = (content = "done") => ({ content, toolCalls: [], usage: { input: 1, output: 1 } });

it.each(["openai", "anthropic", "responses", "codex"])("keeps %s work alive beyond short retries and preserves saved tool results", async api => {
  const { config, messages } = await setup(api);
  await planTools(messages)[0]!.execute({ plan: [{ step: "finish original task", status: "in_progress" }] }, new AbortController().signal);
  const store = new SessionStore(config.home);
  const session = store.create("test", config.workspace, "agent", "test", messages);
  let calls = 0, effects = 0;
  const events: AgentEvent[] = [];
  const runner = new AgentRunner(config, { async complete(history) {
    calls++;
    if (calls === 1) return { ...done(""), toolCalls: [{ id: "once", type: "function" as const, function: { name: "probe", arguments: "{}" } }] };
    if (calls < 10) throw new Error(api === "codex" ? "Codex CLI failed: stream disconnected before completion" : "model HTTP 503: temporarily unavailable");
    expect(history.some(m => m.tool_call_id === "once" && m.content === "saved result")).toBe(true);
    expect(readPlan(history)?.plan[0]?.step).toBe("finish original task");
    return done();
  } });
  runner.tools.set("probe", { name: "probe", description: "effect", risk: "write", parameters: {}, async execute() { effects++; return "saved result"; } });
  waiting.mockImplementation(async (_delay, signal) => {
    signal.throwIfAborted();
    const saved = (await store.load(session.id, "test"))!;
    expect(saved.messages.some(m => m.tool_call_id === "once" && m.content === "saved result")).toBe(true);
    expect(readPlan(saved.messages)?.plan[0]?.step).toBe("finish original task");
  });
  try {
    const result = await runner.run(messages, "agent", new AbortController().signal, e => events.push(e), async () => "once", () => store.save(session));
    expect(result).toMatchObject({ ok: true, steps: 2, modelCalls: 10 });
    expect(effects).toBe(1);
    expect(waiting.mock.calls.map(([ms]) => ms)).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    expect(events.some(e => e.type === "status" && e.text.includes("已恢复"))).toBe(true);
  } finally { runner.close(); }
});

it("continues repeated dropped streams beyond both truncation and step limits without executing incomplete calls", async () => {
  const { config, messages } = await setup(); config.maxSteps = 1;
  let calls = 0, effects = 0;
  const runner = new AgentRunner(config, { async complete() {
    calls++;
    if (calls <= 8) return { ...done(String(calls)), truncated: true, streamEnded: true,
      toolCalls: [{ id: "partial", type: "function" as const, function: { name: "probe", arguments: "{}" } }] };
    return done("end");
  } });
  runner.tools.set("probe", { name: "probe", description: "effect", risk: "write", parameters: {}, async execute() { effects++; return "bad"; } });
  try {
    const result = await runner.run(messages, "auto", new AbortController().signal, () => {}, async () => "once");
    expect(result).toMatchObject({ ok: true, text: "12345678end", steps: 1, modelCalls: 9 });
    expect(effects).toBe(0);
    expect(waiting).toHaveBeenCalledTimes(8);
  } finally { runner.close(); }
});

it("preserves streamed text after a thrown timeout and excludes reasoning from the final answer", async () => {
  const { config, messages } = await setup(); let calls = 0;
  const runner = new AgentRunner(config, { async complete(history, _tools, _signal, delta) {
    if (++calls === 1) { delta?.("private reasoning", "reasoning"); delta?.("saved ", "content"); throw new Error("model stream idle timeout"); }
    expect(history.some(m => m.role === "assistant" && m.content === "saved")).toBe(true);
    return done("answer");
  } });
  try {
    const result = await runner.run(messages, "agent", new AbortController().signal, () => {}, async () => "once");
    expect(result).toMatchObject({ ok: true, text: "savedanswer" });
    expect(result.text).not.toContain("private reasoning");
  } finally { runner.close(); }
});

it("cancels recovery immediately and does not start another model request", async () => {
  const { config, messages } = await setup("codex");
  let calls = 0; const controller = new AbortController();
  const runner = new AgentRunner(config, { async complete() { calls++; throw new Error("Codex CLI failed: timed out"); } });
  try {
    await expect(runner.run(messages, "agent", controller.signal, e => {
      if (e.type === "status" && e.text.includes("自动重连")) controller.abort(new Error("cancelled"));
    }, async () => "once")).rejects.toThrow("cancelled");
    expect(calls).toBe(1);
  } finally { runner.close(); }
});

it.each(["model HTTP 401: unauthorized", "model HTTP 429: insufficient_quota", "Codex CLI failed: authentication required", "unexpected local failure"])("surfaces actionable non-network failures without a reconnect loop: %s", async error => {
  const { config, messages } = await setup();
  const complete = vi.fn(async () => { throw new Error(error); }); const runner = new AgentRunner(config, { complete });
  try {
    await expect(runner.run(messages, "agent", new AbortController().signal, () => {}, async () => "once")).rejects.toThrow(error);
    expect(complete).toHaveBeenCalledTimes(1); expect(waiting).not.toHaveBeenCalled();
  } finally { runner.close(); }
});

it.each(["ask", "disabled", "zero-retries"])("retains bounded behavior when recovery is %s", async setting => {
  const { config, messages } = await setup("codex");
  if (setting === "disabled") config.modelReconnect = false;
  if (setting === "zero-retries") config.maxRetries = 0;
  const complete = vi.fn(async () => { throw new Error("Codex CLI failed: timed out"); });
  const runner = new AgentRunner(config, { complete });
  try {
    await expect(runner.run(messages, setting === "ask" ? "ask" : "agent", new AbortController().signal, () => {}, async () => "once")).rejects.toThrow("timed out");
    expect(complete).toHaveBeenCalledTimes(1); expect(waiting).not.toHaveBeenCalled();
  } finally { runner.close(); }
});

it("lets the model decide what to do about tool errors", async () => {
  const { config, messages } = await setup(); let calls = 0;
  const runner = new AgentRunner(config, { async complete(history) {
    if (++calls === 1) return { ...done(""), toolCalls: [{ id: "broken", type: "function" as const, function: { name: "probe", arguments: "{}" } }] };
    expect(history.at(-1)?.content).toContain("TOOL ERROR: service unavailable");
    return done("diagnosed tool failure");
  } });
  runner.tools.set("probe", { name: "probe", description: "effect", risk: "write", parameters: {}, async execute() { throw new Error("service unavailable"); } });
  try {
    const result = await runner.run(messages, "agent", new AbortController().signal, () => {}, async () => "once");
    expect(result.text).toBe("diagnosed tool failure"); expect(waiting).not.toHaveBeenCalled();
  } finally { runner.close(); }
});
