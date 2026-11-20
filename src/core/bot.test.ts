import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BotQueue } from "./bot.js";
import { botLaunchAgent } from "./bot-command.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function queue() { const home = await mkdtemp(join(tmpdir(), "luban-bot-")); homes.push(home); return new BotQueue(home); }
const input = () => ({ prompt: "Check project", workspace: process.cwd(), at: Date.now(), timeout: 1000 });

it("persists submissions, executes only due work and saves results", async () => {
  const q = await queue();
  const task = await q.add(input());
  await q.add({ ...input(), at: Date.now() + 60_000 });
  const run = vi.fn(async () => ({ ok: true, text: "done" }));
  const restored = new BotQueue(join(q.directory, "..", ".."));
  await restored.tick(run, new AbortController().signal);
  expect(run).toHaveBeenCalledTimes(1);
  expect((await q.list()).find(row => row.task.id === task.id)?.state).toMatchObject({ status: "completed", result: "done" });
});
it("records the tokens each execution spent", async () => {
  const q = await queue();
  await q.add(input());
  await q.tick(async () => ({ ok: true, text: "done", usage: { input: 1200, output: 300, calls: 2 } }), new AbortController().signal);
  expect((await q.list())[0]!.state.usage).toEqual({ input: 1200, output: 300, calls: 2 });
});

it("cancels queued work and never replays interrupted work", async () => {
  const q = await queue();
  const cancelled = await q.add(input());
  const interrupted = await q.add(input());
  await q.cancel(cancelled.id);
  await q.save(interrupted.id, { status: "running", nextAt: Date.now() });
  await q.recover();
  const run = vi.fn();
  await q.tick(run, new AbortController().signal);
  expect(run).not.toHaveBeenCalled();
  expect((await q.list()).map(row => row.state.status).sort()).toEqual(["cancelled", "interrupted"]);
});
it("repeats only successful tasks and skips missed intervals", async () => {
  const q = await queue();
  await q.add({ ...input(), every: 60_000, at: 1 });
  await q.tick(async () => ({ ok: true, text: "ok" }), new AbortController().signal);
  const [{ state }] = await q.list();
  expect(state!.status).toBe("queued");
  expect(state!.nextAt).toBeGreaterThan(Date.now());
  await q.tick(async () => ({ ok: false, text: "denied" }), new AbortController().signal, state!.nextAt);
  expect((await q.list())[0]!.state.status).toBe("failed");
});
it("aborts active tasks on cancellation and shutdown", async () => {
  const q = await queue();
  const task = await q.add(input());
  await q.tick(async (_task, signal) => {
    await q.cancel(task.id);
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    return { ok: false, text: "stopped" };
  }, new AbortController().signal);
  expect((await q.list())[0]!.state.status).toBe("cancelled");
  await q.add(input());
  const stop = new AbortController();
  await q.tick(async () => { stop.abort(); throw new Error("stopping"); }, stop.signal);
  expect((await q.list())[1]!.state.status).toBe("interrupted");
});
it("enforces deadlines and validates scheduling/path inputs", async () => {
  const q = await queue();
  await expect(q.add({ ...input(), every: 1 })).rejects.toThrow("Invalid schedule");
  await expect(q.add({ ...input(), at: NaN })).rejects.toThrow("Invalid schedule");
  expect(() => q.path("../../outside", "cancel")).toThrow("Invalid bot task id");
  await q.add(input());
  await q.tick(async (_task, signal) => {
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    return { ok: true, text: "late" };
  }, new AbortController().signal);
  expect((await q.list())[0]!.state).toMatchObject({ status: "failed", result: "Error: Task timeout" });
});
it("escapes launchd arguments and keeps credentials out of service definitions", () => {
  const plist = botLaunchAgent("/a & b/node", "/c<d>/cli.js", "/home/user", "/bin");
  expect(plist).toContain("/a &amp; b/node");
  expect(plist).toContain("/c&lt;d&gt;/cli.js");
  expect(plist).toContain("<string>bot</string><string>run</string>");
  expect(plist).not.toContain("API_KEY");
});

/* 改任务内容而不是再排一个：历史要留在同一条任务上。 */
it("edits a task in place, keeps its history and re-queues it", async () => {
  const q = await queue();
  const task = await q.add({ ...input(), every: 60_000 });
  await q.tick(async () => ({ ok: true, text: "第一晚的结论" }), new AbortController().signal);
  const at = Date.now() + 120_000;
  const edited = await q.edit(task.id, { prompt: "只看今天新增的 bug", at, every: null });
  expect(edited.id).toBe(task.id);
  expect(edited.prompt).toBe("只看今天新增的 bug");
  expect(edited.every).toBeUndefined();
  const [row] = await q.list();
  // Editing rewrites the booking, not the record: last night's run stays readable.
  expect(row!.state).toMatchObject({ status: "queued", nextAt: at });
  expect(await q.history(task.id)).toMatchObject([{ result: "第一晚的结论" }]);
});

it("refuses to edit a running task and rejects an empty prompt", async () => {
  const q = await queue();
  const task = await q.add(input());
  await q.save(task.id, { status: "running", nextAt: Date.now(), startedAt: Date.now() });
  await expect(q.edit(task.id, { prompt: "改个说法" })).rejects.toThrow(/running/i);
  await q.save(task.id, { status: "completed", nextAt: 0, finishedAt: Date.now() });
  await expect(q.edit(task.id, { prompt: "   " })).rejects.toThrow(/empty/i);
  await expect(q.edit(task.id, { every: 1_000 })).rejects.toThrow(/Invalid schedule/i);
});

it("brings a cancelled task back when it is edited", async () => {
  const q = await queue();
  const task = await q.add(input());
  await q.cancel(task.id);
  expect((await q.list())[0]!.state.status).toBe("cancelled");
  await q.edit(task.id, { at: Date.now() + 1000 });
  expect((await q.list())[0]!.state.status).toBe("queued");
});

it("remembers which transcript each run wrote", async () => {
  const q = await queue();
  const task = await q.add(input());
  await q.tick(async () => ({ ok: true, text: "做完", session: "20261120-120000-abcdef" }), new AbortController().signal);
  expect((await q.list())[0]!.state.session).toBe("20261120-120000-abcdef");
  expect((await q.history(task.id))[0]!.session).toBe("20261120-120000-abcdef");
});
