import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import bot from "./bot.cjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const built = existsSync(join(repo, "dist", "cli.js"));

function home() {
  return mkdtempSync(join(tmpdir(), "luban-creator-test-"));
}

function seed(directory, id, task, state) {
  mkdirSync(join(directory, id), { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, id, "request.json"), JSON.stringify(task));
  if (state) writeFileSync(join(directory, id, "state.json"), JSON.stringify(state));
}

test("lists the queue in the shape the window draws", () => {
  const root = home();
  try {
    const tasks = join(root, "bot", "tasks");
    seed(tasks, "11111111-1111-4111-8111-111111111111",
      { id: "11111111-1111-4111-8111-111111111111", prompt: "老的", workspace: root, at: 1000, timeout: 1000 },
      { status: "completed", nextAt: 1000, finishedAt: 5000, result: "done" });
    seed(tasks, "22222222-2222-4222-8222-222222222222",
      { id: "22222222-2222-4222-8222-222222222222", prompt: "新的", workspace: root, at: 9000, every: 3600_000, timeout: 1000 });
    // Not a task directory: the queue ignores it and so must the window.
    mkdirSync(join(tasks, "not-a-task"), { recursive: true });

    const rows = bot.listTasks(root);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].prompt, "新的", "newest deadline first");
    assert.equal(rows[0].status, "queued", "a task without state is queued");
    assert.equal(rows[1].status, "completed");
    assert.equal(rows[1].result, "done");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a cancel marker wins over the last state", () => {
  const root = home();
  try {
    const tasks = join(root, "bot", "tasks");
    const id = "33333333-3333-4333-8333-333333333333";
    seed(tasks, id, { id, prompt: "反复跑", workspace: root, at: 1, every: 60_000, timeout: 1000 }, { status: "running", nextAt: 1 });
    writeFileSync(join(tasks, id, "cancel"), "cancelled");
    assert.equal(bot.listTasks(root)[0].status, "cancelled");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worker status distinguishes stopped, alive and stalled", () => {
  const root = home();
  try {
    assert.equal(bot.workerStatus(root).running, false);

    const lock = join(root, "bot", "worker.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), String(process.pid));
    writeFileSync(join(root, "bot", "status.json"), JSON.stringify({ pid: process.pid, startedAt: 1, updatedAt: 2_000, task: { prompt: "扫描 GitLab", startedAt: 1 } }));

    const alive = bot.workerStatus(root, 3_000);
    assert.equal(alive.running, true);
    assert.equal(alive.task.prompt, "扫描 GitLab");
    assert.equal(alive.stalled, false);

    // Same live process, no heartbeat for a minute: stuck, not idle.
    assert.equal(bot.workerStatus(root, 90_000).stalled, true);

    // A pid that no longer exists is not a running worker, whatever the file says.
    writeFileSync(join(lock, "pid"), "999999");
    assert.equal(bot.workerStatus(root, 3_000).running, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the window writes through the CLI instead of inventing a queue format", { skip: built ? false : "run npm run build first" }, () => {
  const root = home();
  try {
    assert.throws(() => bot.addTask(root, { prompt: "x", workspace: join(root, "missing") }), /工作区不存在/u);
    assert.throws(() => bot.addTask(root, { prompt: "   " }), /不能为空/u);

    const id = bot.addTask(root, { prompt: "每小时看一下 GitLab", workspace: root, every: 30 }).id;
    assert.match(id, /^[0-9a-f-]{36}$/u);

    const [task] = bot.listTasks(root);
    assert.equal(task.prompt, "每小时看一下 GitLab");
    assert.equal(task.workspace, root);
    // The CLI floor is 60s; asking for 30s must not reach the queue as 30s.
    assert.equal(task.every, 60_000);

    bot.cancelTask(root, id);
    assert.equal(bot.listTasks(root)[0].status, "cancelled");
    assert.throws(() => bot.cancelTask(root, "../escape"), /无效的任务 id/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a scheduled task keeps its absolute time", { skip: built ? false : "run npm run build first" }, () => {
  const root = home();
  try {
    const at = Date.now() + 3600_000;
    bot.addTask(root, { prompt: "日报", workspace: root, at });
    const [task] = bot.listTasks(root);
    assert.ok(Math.abs(task.at - at) < 1500, `expected ~${at}, got ${task.at}`);
    assert.equal(task.every, undefined);
    // Nothing ran yet, so the request is intact and the state file absent.
    assert.equal(readdirSync(join(root, "bot", "tasks")).length, 1);
    assert.equal(JSON.parse(readFileSync(join(root, "bot", "tasks", task.id, "request.json"), "utf8")).prompt, "日报");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ships the menu-bar icon at both densities", () => {
  // A text-only status item looked like an empty menu-bar slot, so the tray now
  // loads this mark. Electron resolves tray@2x.png beside tray.png on macOS.
  const art = join(dirname(fileURLToPath(import.meta.url)), "assets");
  for (const [name, px] of [["tray.png", 18], ["tray@2x.png", 36]]) {
    const png = readFileSync(join(art, name));
    assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(png.readUInt32BE(16), px, `${name} width`);
    assert.equal(png.readUInt32BE(20), px, `${name} height`);
    // Alpha matters: a fully opaque square would paint a block over the menu bar.
    assert.equal(png[25], 6, `${name} must be RGBA`);
  }
});

test("runs the CLI under Node, never under Electron", () => {
  const before = process.env.LUBAN_NODE_BIN;
  try {
    delete process.env.LUBAN_NODE_BIN;
    assert.equal(bot.nodeBinary(), process.execPath);
    // Inside Electron without a bundled runtime, ask the child to be plain Node.
    if (process.versions.electron) assert.equal(bot.nodeEnv().ELECTRON_RUN_AS_NODE, "1");
    process.env.LUBAN_NODE_BIN = "/opt/luban/node";
    assert.equal(bot.nodeBinary(), "/opt/luban/node");
    // With a bundled runtime the Electron hint must not leak into the worker.
    assert.equal(bot.nodeEnv().ELECTRON_RUN_AS_NODE, undefined);
  } finally {
    if (before === undefined) delete process.env.LUBAN_NODE_BIN;
    else process.env.LUBAN_NODE_BIN = before;
  }
});

test("edits a task through the CLI and keeps its runs", { skip: built ? false : "run npm run build first" }, () => {
  const root = home();
  try {
    const id = bot.addTask(root, { prompt: "每晚汇总改动", workspace: root, every: 3600 }).id;
    const tasks = join(root, "bot", "tasks", id);
    writeFileSync(join(tasks, "runs.jsonl"), `${JSON.stringify({ from: 1, to: 2, status: "completed", nextAt: 3, result: "第一版日报" })}\n`);

    const at = Date.now() + 600_000;
    bot.editTask(root, id, { prompt: "每晚汇总改动，只看新增", every: null, at });
    const [row] = bot.listTasks(root);
    assert.equal(row.prompt, "每晚汇总改动，只看新增");
    assert.equal(row.every, undefined, "--once clears the repeat");
    assert.equal(row.status, "queued", "an edited task goes back in the queue");
    assert.ok(Math.abs(row.at - at) < 1500, `expected ~${at}, got ${row.at}`);
    // The record is the reason to edit instead of re-adding: it survives.
    assert.equal(bot.taskRuns(root, id).length, 1);
    assert.throws(() => bot.editTask(root, "../escape", { prompt: "x" }), /无效的任务 id/u);
    assert.throws(() => bot.editTask(root, id, { prompt: "   " }), /不能为空/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("finds the conversation a task last ran in", () => {
  const root = home();
  try {
    const id = "44444444-4444-4444-8444-444444444444";
    const tasks = join(root, "bot", "tasks");
    seed(tasks, id, { id, prompt: "扫 bug", workspace: root, at: 1, timeout: 1000 }, { status: "completed", nextAt: 1, result: "done\nSession: 20261112-080000-abcdef" });
    // Old runs only carry the session in their answer; new ones record it.
    assert.equal(bot.taskSession(root, id), "20261112-080000-abcdef");
    writeFileSync(join(tasks, id, "runs.jsonl"),
      `${JSON.stringify({ from: 1, to: 2, status: "completed", nextAt: 3, session: "20261113-090000-fedcba" })}\n`);
    assert.equal(bot.taskSession(root, id), "20261113-090000-fedcba", "newest run wins");

    const sessions = join(root, "sessions-node", "proj");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "20261113-090000-fedcba.json"), JSON.stringify({
      id: "20261113-090000-fedcba", title: "扫 bug", updatedAt: "2026-11-13T09:10:00.000Z",
      messages: [
        { role: "system", content: "base" },
        { role: "user", content: "扫一下本周的 bug" },
        { role: "assistant", content: "" , tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", name: "bash", tool_call_id: "c1", content: "{...}" },
        { role: "assistant", content: "发现 3 个，已写进日报" },
      ],
    }));
    const transcript = bot.sessionTranscript(root, "20261113-090000-fedcba");
    assert.deepEqual(transcript.messages.map(message => message.text), ["扫一下本周的 bug", "发现 3 个，已写进日报"]);
    // A tool row is not a thing to read; the person came for the two sentences.
    assert.deepEqual(bot.sessionTranscript(root, "0".repeat(8) + "-missing").messages, []);
    assert.throws(() => bot.sessionTranscript(root, "../../etc/passwd"), /无效的会话 id/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
