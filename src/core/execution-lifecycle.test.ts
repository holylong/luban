import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentRunner, initialMessages } from "./agent.js";
import { SessionStore } from "./session-store.js";
import type { AgentEvent, ChatMessage, LubanConfig, ToolCall } from "./types.js";

const roots: string[] = [], runners: AgentRunner[] = [];
afterEach(async () => {
  runners.splice(0).forEach(runner => runner.close());
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })));
});
const call = (name: string, args: unknown = {}): ToolCall => ({ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } });
async function fixture(calls: ToolCall[]) {
  const root = await mkdtemp(join(tmpdir(), "luban-lifecycle-")); roots.push(root);
  let round = 0;
  const runner = new AgentRunner({ workspace: root, home: root, project: "test", model: { name: "test" }, permissionMode: "allow", maxSteps: 5, maxTokens: 1000 } as LubanConfig,
    { async complete() { return { content: ++round === 1 ? "" : "done", toolCalls: round === 1 ? calls : [], usage: { input: 1, output: 1 } }; } });
  runners.push(runner);
  const messages: ChatMessage[] = [...initialMessages(root), { role: "user", content: "do the work" }];
  return { root, runner, messages };
}

it("persists and emits a completed edit before starting a later command, preserving edits after reload", async () => {
  const f = await fixture([call("write_file", { path: "a.txt", content: "new\n" }), call("later")]);
  const store = new SessionStore(f.root);
  const record = store.create("test", f.root, "agent", "test", f.messages);
  const ended: string[] = [];
  f.runner.tools.set("later", { name: "later", description: "later", risk: "execute", parameters: {}, async execute() {
    expect(ended).toContain("write_file");
    const saved = await store.load(record.id, "test");
    expect(saved?.messages.find(message => message.tool_call_id === "write_file")?.editPreview).toContain("Edited a.txt (+1 -0)");
    expect(saved?.edits?.[0].preview).toMatch(/1 \+new/u);
    return "later done";
  } });
  await f.runner.run(f.messages, "agent", new AbortController().signal, event => {
    if (event.type === "tool-end") ended.push(event.name);
  }, async () => "once", () => store.save(record));
});

it("publishes fast parallel reads immediately, but keeps saved results in original call order", async () => {
  const f = await fixture([call("slow"), call("fast")]);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const events: AgentEvent[] = [], snapshots: ChatMessage[][] = [];
  for (const name of ["slow", "fast"]) f.runner.tools.set(name, { name, description: name, risk: "read", parallelSafe: true, parameters: {}, async execute() {
    if (name === "slow") await waiting;
    return `${name} result`;
  } });
  const run = f.runner.run(f.messages, "agent", new AbortController().signal, event => events.push(event), async () => "once", async () => { snapshots.push(structuredClone(f.messages)); });
  try {
    await vi.waitFor(() => {
      expect(events.some(event => event.type === "tool-end" && event.name === "fast")).toBe(true);
      expect(snapshots.some(messages => messages.some(message => message.tool_call_id === "fast" && message.content === "fast result"))).toBe(true);
    });
    expect(events.some(event => event.type === "tool-end" && event.name === "slow")).toBe(false);
  } finally { release(); }
  await run;
  expect(f.messages.filter(message => message.role === "tool").map(message => message.content)).toEqual(["slow result", "fast result"]);
});

it("validates before asking permission and leaves the workspace intact", async () => {
  const f = await fixture([call("write_file", { path: "valuable.txt" })]);
  f.runner.config.permissionMode = "ask";
  await writeFile(join(f.root, "valuable.txt"), "valuable");
  const approve = vi.fn(async () => "once" as const);
  await f.runner.run(f.messages, "agent", new AbortController().signal, () => {}, approve);
  expect(approve).not.toHaveBeenCalled();
  expect(await readFile(join(f.root, "valuable.txt"), "utf8")).toBe("valuable");
  expect(f.messages.find(message => message.role === "tool")?.content).toContain("invalid arguments");
});

it("stops further writes if saving a completed action fails", async () => {
  const f = await fixture([call("write_file", { path: "a.txt", content: "saved effect" }), call("next")]);
  const next = vi.fn(async () => "bad");
  f.runner.tools.set("next", { name: "next", description: "next", risk: "write", parameters: {}, execute: next });
  await expect(f.runner.run(f.messages, "agent", new AbortController().signal, () => {}, async () => "once", async () => {
    if (f.messages.some(message => message.editPreview)) throw new Error("disk full");
  })).rejects.toThrow("disk full");
  expect(next).not.toHaveBeenCalled();
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe("saved effect");
});

it("does not dispatch another effect after cancellation, even when a tool ignores abort", async () => {
  const f = await fixture([call("first"), call("next")]);
  const controller = new AbortController();
  const next = vi.fn(async () => "bad");
  f.runner.tools.set("first", { name: "first", description: "first", risk: "write", parameters: {}, async execute() { controller.abort(new Error("cancelled")); return "first complete"; } });
  f.runner.tools.set("next", { name: "next", description: "next", risk: "write", parameters: {}, execute: next });
  await expect(f.runner.run(f.messages, "agent", controller.signal, () => {}, async () => "once")).rejects.toThrow("cancelled");
  expect(next).not.toHaveBeenCalled();
  expect(f.messages.find(message => message.tool_call_id === "first")?.content).toBe("first complete");
});
