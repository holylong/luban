import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentInbox } from "./inbox.js";
import { AgentRunner, initialMessages } from "./agent.js";
import { SessionStore } from "./session-store.js";
import type { ChatMessage, LubanConfig, ToolCall, PendingInput } from "./types.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "luban-inbox-")); roots.push(root);
  const config = { home: root, workspace: root, project: "test", model: { name: "test" }, maxSteps: 4, maxTokens: 1000,
    permissionMode: "allow", semanticCompaction: false } as LubanConfig;
  const store = new SessionStore(root);
  const messages: ChatMessage[] = [...initialMessages(root), { role: "user", content: "original task" }];
  const record = store.create("test", root, "agent", "test", messages);
  const persist = () => store.save(record);
  const inbox = new AgentInbox(record, persist);
  return { root, config, store, messages, record, persist, inbox };
}
const write = (id: string, path = "bad.txt"): ToolCall => ({ id, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path, content: "written" }) } });
const completion = (toolCalls: ToolCall[] = [], content = "done") => ({ content, toolCalls, usage: { input: 1, output: 1 } });

it("persists steering during a model request and skips that response's stale write", async () => {
  const f = await fixture(); let turns = 0;
  const runner = new AgentRunner(f.config, { async complete(history) {
    if (++turns === 1) {
      await runner.enqueueInput("Do not write any files; explain instead");
      expect((await f.store.load(f.record.id, "test"))?.pendingInputs?.length).toBe(1);
      return completion([write("a")]);
    }
    expect(history.at(-1)?.content).toContain("Do not write");
    expect(history.some((message) => message.role === "tool" && message.content?.includes("new user instruction"))).toBe(true);
    return completion([], "explained");
  } });
  try {
    expect((await runner.run(f.messages, "agent", new AbortController().signal, () => {}, async () => "always", f.persist, f.inbox)).text).toBe("explained");
    await expect(readFile(join(f.root, "bad.txt"))).rejects.toThrow();
    expect(f.record.pendingInputs).toEqual([]);
  } finally { runner.close(); }
});

it("delivers steering between tools and renews the model-turn allowance", async () => {
  const f = await fixture(); f.config.maxSteps = 1;
  let turns = 0;
  const runner = new AgentRunner(f.config, { async complete(history) {
    if (++turns === 1) return completion([write("first", "first.txt"), write("second", "second.txt")]);
    expect(history.at(-1)?.content).toBe("stop after the first file");
    return completion();
  } });
  const original = runner.tools.get("write_file")!.execute;
  runner.tools.get("write_file")!.execute = async (args, signal) => {
    const output = await original(args, signal);
    await runner.enqueueInput("stop after the first file");
    return output;
  };
  try {
    const result = await runner.run(f.messages, "agent", new AbortController().signal, () => {}, async () => "always", f.persist, f.inbox);
    expect(result.ok).toBe(true); expect(result.steps).toBe(2);
    expect(await readFile(join(f.root, "first.txt"), "utf8")).toBe("written");
    await expect(readFile(join(f.root, "second.txt"))).rejects.toThrow();
  } finally { runner.close(); }
});

it("runs queued tasks individually after the current task, without superseding its tools", async () => {
  const f = await fixture(); let turns = 0;
  const runner = new AgentRunner(f.config, { async complete(history) {
    turns++;
    if (turns === 1) {
      await runner.enqueueInput("task two", "queue");
      await runner.enqueueInput("task three", "queue");
      return completion([write("first", "first.txt")]);
    }
    if (turns === 2) expect(await readFile(join(f.root, "first.txt"), "utf8")).toBe("written");
    if (turns === 3) expect(history.at(-1)?.content).toBe("task two");
    if (turns === 4) expect(history.at(-1)?.content).toBe("task three");
    return completion();
  } });
  try {
    expect((await runner.run(f.messages, "agent", new AbortController().signal, () => {}, async () => "always", f.persist, f.inbox)).steps).toBe(4);
    expect(f.record.pendingInputs).toEqual([]);
    await expect(runner.enqueueInput("late")).rejects.toThrow("No agent run");
  } finally { runner.close(); }
});

it("keeps admitted inputs on cancellation and delivers them after session reload", async () => {
  const f = await fixture(); const controller = new AbortController();
  const runner = new AgentRunner(f.config, { async complete() {
    await runner.enqueueInput("resume this instruction");
    controller.abort(new Error("cancelled"));
    throw controller.signal.reason;
  } });
  try {
    await expect(runner.run(f.messages, "agent", controller.signal, () => {}, async () => "always", f.persist, f.inbox)).rejects.toThrow("cancelled");
    const loaded = (await f.store.load(f.record.id, "test"))!;
    expect(loaded.pendingInputs?.[0]?.content).toBe("resume this instruction");
    const inbox = new AgentInbox(loaded, () => f.store.save(loaded));
    const delivered = await inbox.promote(loaded.messages);
    expect(delivered).toHaveLength(1);
    expect(loaded.messages.at(-1)?.content).toBe("resume this instruction");
    expect((await f.store.load(f.record.id, "test"))?.pendingInputs).toEqual([]);
  } finally { runner.close(); }
});

it("rolls back failed admission and failed delivery without losing queued messages", async () => {
  const state: { pendingInputs?: PendingInput[] } = {};
  let fail = true;
  const inbox = new AgentInbox(state, async () => { if (fail) throw new Error("disk error"); });
  await expect(inbox.enqueue("first")).rejects.toThrow("disk error");
  expect(state.pendingInputs).toEqual([]);
  fail = false; await inbox.enqueue("second"); fail = true;
  const messages: ChatMessage[] = [];
  await expect(inbox.promote(messages)).rejects.toThrow("disk error");
  expect(messages).toEqual([]); expect(state.pendingInputs?.[0]?.content).toBe("second");
  fail = false;
  expect(await inbox.promote(messages)).toHaveLength(1);
  expect(await inbox.finish()).toBe(true);
  await expect(inbox.enqueue("late")).rejects.toThrow("finishing");
});

it("serializes concurrent session snapshots across store instances without temp collisions", async () => {
  const f = await fixture();
  const other = new SessionStore(f.root);
  const writes: Promise<void>[] = [];
  for (let i = 0; i < 30; i++) {
    f.messages.push({ role: "user", content: `message ${i}` });
    writes.push((i % 2 ? other : f.store).save(f.record));
  }
  await Promise.all(writes);
  const loaded = (await f.store.load(f.record.id, "test"))!;
  expect(loaded.messages.at(-1)?.content).toBe("message 29");
  expect(loaded.messages).toHaveLength(f.messages.length);
  expect((await readdir(join(f.store.root, "test"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

it("scopes restored sessions to their workspace even when project names match", async () => {
  const f = await fixture();
  await f.persist();
  const foreign = f.store.create("test", join(f.root, "different-workspace"), "agent", "test", [{ role: "user", content: "different task" }]);
  await f.store.save(foreign);
  expect(await f.store.load(foreign.id, "test", f.root)).toBeUndefined();
  expect((await f.store.load("latest", "test", f.root))?.id).toBe(f.record.id);
  expect((await f.store.list(undefined, f.root)).map((record) => record.id)).toEqual([f.record.id]);
});

it("drains an input admitted while the final answer is being saved", async () => {
  const f = await fixture(); let admitted = false; let turns = 0;
  let inbox: AgentInbox;
  const persist = async () => {
    await f.persist();
    if (!admitted && f.messages.at(-1)?.role === "assistant") {
      admitted = true;
      await inbox.enqueue("one more task", "queue");
    }
  };
  inbox = new AgentInbox(f.record, persist);
  const runner = new AgentRunner(f.config, { async complete(history) {
    if (++turns === 2) expect(history.at(-1)?.content).toBe("one more task");
    return completion();
  } });
  try {
    expect((await runner.run(f.messages, "agent", new AbortController().signal, () => {}, async () => "always", persist, inbox)).steps).toBe(2);
    expect(f.record.pendingInputs).toEqual([]);
  } finally { runner.close(); }
});
