import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunner, initialMessages } from "./agent.js";
import { SessionStore } from "./session-store.js";
import type { AgentEvent, LubanConfig, ToolCall } from "./types.js";
const roots: string[] = [];
const runners: AgentRunner[] = [];
afterEach(async () => { runners.splice(0).forEach(r => r.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function setup(calls: ToolCall[], overrides: Partial<LubanConfig> = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "luban-performance-")); roots.push(workspace);
  const model = { id: "test/test", provider: "test", model: "test", name: "test", baseUrl: "", apiKey: "" };
  const config = { home: workspace, workspace, project: "test", model, models: [model], maxTokens: 1000, temperature: 0, timeoutMs: 1000, maxSteps: 10, backendUrl: "", permissionMode: "ask", ...overrides } as LubanConfig;
  let count = 0;
  const runner = new AgentRunner(config, { async complete(_messages, _tools, _signal, onDelta) {
    await delay(5); onDelta?.("working", "content"); count++;
    return { content: count === 1 ? "" : "done", toolCalls: count === 1 ? calls : [], usage: { input: 1, output: 1 } };
  } }); runners.push(runner);
  const events: AgentEvent[] = [];
  const run = (approve = async () => "once" as const) => runner.run([...initialMessages(workspace), { role: "user" as const, content: "inspect" }], "agent", new AbortController().signal, event => events.push(event), approve);
  return { runner, workspace, config, events, run };
}
const call = (id: string, name: string, args = {}): ToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

it("reports a fast tool before the slow tool finishes and saves results in call order", async () => {
  const { runner, events, workspace } = await setup([call("slow", "slow"), call("fast", "fast")]);
  let slowDone = false, fastReportedBeforeSlow = false;
  runner.tools.set("slow", { name: "slow", risk: "read", parallelSafe: true, description: "", parameters: {}, async execute() { await delay(60); slowDone = true; return "slow"; } });
  runner.tools.set("fast", { name: "fast", risk: "read", parallelSafe: true, description: "", parameters: {}, async execute() { await delay(5); return "fast"; } });
  const result = await runner.run([...initialMessages(workspace), { role: "user", content: "inspect" }], "agent", new AbortController().signal, event => {
    events.push(event); if (event.type === "tool-end" && event.id === "fast") fastReportedBeforeSlow = !slowDone;
  }, async () => "once");
  expect(fastReportedBeforeSlow).toBe(true);
  expect(events.filter(e => e.type === "tool-end").map(e => e.id)).toEqual(["fast", "slow"]);
  expect(result.messages.filter(m => m.role === "tool").map(m => m.tool_call_id)).toEqual(["slow", "fast"]);
});

it.each([true, false])("only explicitly independent bash calls overlap (%s)", async independent => {
  const { runner, run } = await setup([call("a", "bash", { command: "one", independent }), call("b", "bash", { command: "two", independent })]);
  let active = 0, maximum = 0, approvals = 0;
  runner.tools.set("bash", { name: "bash", risk: "execute", description: "", parameters: {}, async execute() { maximum = Math.max(maximum, ++active); await delay(15); active--; return "ok"; } });
  const result = await run(async () => { approvals++; await delay(15); return "once"; });
  expect(maximum).toBe(independent ? 2 : 1); expect(approvals).toBe(2);
  expect(result.metrics?.approvalMs).toBeGreaterThanOrEqual(20);
  expect(result.metrics?.toolMs).toBeGreaterThanOrEqual(20);
  expect(result.metrics?.requests).toHaveLength(2);
  expect(result.metrics?.requests.every(r => r.ok && r.firstOutputMs !== undefined && r.elapsedMs >= r.firstOutputMs)).toBe(true);
});

it("expands batch reads while applying each path's deny rule and retaining valid tool history", async () => {
  const { workspace, config, run } = await setup([call("batch", "read_files", { files: [{ path: "public.txt" }, { path: "secret.txt" }] })], { permissions: { allow: [], deny: ["read_file:secret.txt"] } });
  await writeFile(join(workspace, "public.txt"), "public"); await writeFile(join(workspace, "secret.txt"), "secret");
  const result = await run();
  const outputs = result.messages.filter(m => m.role === "tool");
  expect(outputs.map(m => m.tool_call_id)).toEqual(["batch-1", "batch-2"]);
  expect(outputs[0].content).toContain("public"); expect(outputs[1].content).toContain("blocked by permission rule");
  expect(result.messages.find(m => m.tool_calls)?.tool_calls?.map(c => c.function.name)).toEqual(["read_file", "read_file"]);
  const store = new SessionStore(config.home);
  const session = store.create(config.project, workspace, "agent", config.model.id, result.messages);
  session.performance = result.metrics;
  await store.save(session);
  expect((await store.load(session.id, config.project, workspace))?.performance).toEqual(result.metrics);
});

it("denying the batch tool blocks all inner reads", async () => {
  const { run } = await setup([call("batch", "read_files", { files: [{ path: "secret.txt" }] })], { permissions: { allow: [], deny: ["read_files"] } });
  const result = await run();
  expect(result.messages.find(m => m.role === "tool")?.content).toContain("blocked by permission rule");
});

it("caps parallel reads at four and preserves sequential writes even if marked parallel-safe", async () => {
  const calls = Array.from({ length: 9 }, (_, i) => call(String(i), "inspect"));
  calls.push(call("write-1", "modify"), call("write-2", "modify"));
  const { runner, run } = await setup(calls, { permissionMode: "edits" });
  let activeReads = 0, activeWrites = 0, maxReads = 0, maxWrites = 0;
  runner.tools.set("inspect", { name: "inspect", risk: "read", parallelSafe: true, description: "", parameters: {}, async execute() { maxReads = Math.max(maxReads, ++activeReads); await delay(10); activeReads--; return "read"; } });
  runner.tools.set("modify", { name: "modify", risk: "write", parallelSafe: true, description: "", parameters: {}, async execute() { maxWrites = Math.max(maxWrites, ++activeWrites); await delay(10); activeWrites--; return "write"; } });
  await run();
  expect(maxReads).toBe(4); expect(maxWrites).toBe(1);
});
