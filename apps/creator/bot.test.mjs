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
