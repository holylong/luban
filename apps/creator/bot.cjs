/**
 * The 造物主 data layer: everything the tray app needs from the durable bot
 * queue, without a second server.
 *
 * The queue format is owned by `src/core/bot.ts` (request.json + state.json per
 * task directory, exact-shape validation, atomic writes). This module only reads
 * that format and writes through the CLI, so the app can never drift into a
 * second, slightly different schema — the worst case is a stale read, never a
 * corrupt task.
 */
const { spawn, spawnSync } = require("node:child_process");
const { existsSync, readFileSync, readdirSync, mkdirSync, openSync, statSync } = require("node:fs");
const { homedir } = require("node:os");
const { join, resolve } = require("node:path");

const TASK_ID = /^[0-9a-f-]{36}$/;

function homeDir(env = process.env) {
  return resolve(env.LUBAN_HOME || join(homedir(), ".luban"));
}

/** The built CLI is the only writer. Source checkouts must build first; a packaged
 * 造物主 app points LUBAN_CLI at the CLI it carries in its own bundle. */
function cliPath(repo = resolve(__dirname, "../..")) {
  const override = process.env.LUBAN_CLI;
  return override && existsSync(override) ? override : join(repo, "dist", "cli.js");
}

function queueDirectory(home) {
  return join(home, "bot", "tasks");
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/**
 * Every task with its last known state, newest deadline first.
 *
 * A task directory without a readable request.json is skipped: `BotQueue.list`
 * treats a half-written submission the same way, and the tray must never show a
 * row it cannot cancel.
 */
function listTasks(home) {
  const directory = queueDirectory(home);
  if (!existsSync(directory)) return [];
  const rows = [];
  for (const id of readdirSync(directory)) {
    if (!TASK_ID.test(id)) continue;
    const task = readJson(join(directory, id, "request.json"));
    if (!task) continue;
    const state = readJson(join(directory, id, "state.json")) || { status: "queued", nextAt: task.at };
    rows.push({
      id,
      prompt: task.prompt,
      workspace: task.workspace,
      model: task.model,
      at: task.at,
      every: task.every,
      timeout: task.timeout,
      status: existsSync(join(directory, id, "cancel")) ? "cancelled" : state.status,
      nextAt: state.nextAt,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      result: state.result,
      usage: state.usage,
    });
  }
  return rows.sort((left, right) => (right.finishedAt || right.at) - (left.finishedAt || left.at));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

/**
 * Whether the serial worker is up, and what it is doing.
 *
 * The lock directory is the authoritative claim (`luban bot run` acquires it
 * exclusively), the status file is only a heartbeat: a stopped worker leaves the
 * last task in place, so freshness matters more than existence.
 */
function workerStatus(home, now = Date.now()) {
  const pid = Number((readJson(join(home, "bot", "worker.lock", "pid")) ?? "").toString().trim()) || 0;
  const status = readJson(join(home, "bot", "status.json"));
  const alive = processAlive(pid);
  const heartbeat = status && Number.isFinite(status.updatedAt) ? status.updatedAt : 0;
  return {
    running: alive,
    pid: pid || undefined,
    task: alive && status && status.task ? status.task : undefined,
    heartbeat: heartbeat || undefined,
    // A worker that has a live process but no recent heartbeat is stuck, not idle.
    stalled: alive && heartbeat > 0 && now - heartbeat > 30_000,
    launchAgent: existsSync(join(homedir(), "Library", "LaunchAgents", "dev.luban.bot.plist")),
  };
}

function runCli(args, home) {
  const cli = cliPath();
  if (!existsSync(cli)) throw new Error(`找不到 ${cli}，先执行 npm run build`);
  const result = spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, LUBAN_HOME: home },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `luban bot ${args[0]} 失败`).trim());
  }
  return result.stdout;
}

/** Queue one task. `every` is seconds; 0/undefined means run once. */
function addTask(home, input) {
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw new Error("任务内容不能为空");
  const workspace = resolve(input.workspace || homedir());
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) throw new Error(`工作区不存在：${workspace}`);
  const args = ["bot", "add", prompt, "-w", workspace];
  if (input.model) args.push("-m", String(input.model));
  if (input.at) args.push("--at", new Date(input.at).toISOString());
  if (input.every && Number(input.every) > 0) args.push("--every", String(Math.max(60, Math.round(Number(input.every)))));
  const timeout = Number(input.timeout);
  if (Number.isFinite(timeout) && timeout >= 1) args.push("--timeout", String(Math.round(timeout)));
  const output = runCli(args, home);
  const id = /Queued ([0-9a-f-]{36})/u.exec(output)?.[1];
  return { id, workspace, at: input.at ? new Date(input.at).getTime() : Date.now() };
}

function cancelTask(home, id) {
  if (!TASK_ID.test(String(id || ""))) throw new Error("无效的任务 id");
  runCli(["bot", "cancel", id], home);
  return { id };
}

/** Permission the worker asked for but nobody granted; grants stay manual by design. */
function permissionRequests(home) {
  const directory = join(home, "bot", "permission-requests");
  if (!existsSync(directory)) return [];
  const rows = [];
  for (const file of readdirSync(directory)) {
    if (!/^[0-9a-f-]{36}\.json$/u.test(file)) continue;
    const request = readJson(join(directory, file));
    if (request) rows.push(request);
  }
  return rows.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function policyPath(home) {
  return join(home, "bot", "permissions.json");
}

/** Create the empty policy through the CLI; this app never writes grants itself. */
function ensurePolicy(home) {
  runCli(["bot", "permissions"], home);
  return policyPath(home);
}

/**
 * Start the worker when nothing else owns it.
 *
 * A LaunchAgent (installed with `luban bot service`) already supervises the
 * worker; spawning a second copy would only fight it for the lock, so that case
 * reports back instead of starting anything.
 */
function ensureWorker(home) {
  const status = workerStatus(home);
  if (status.running) return { started: false, reason: "already-running", ...status };
  if (status.launchAgent) return { started: false, reason: "launch-agent", ...status };
  const cli = cliPath();
  if (!existsSync(cli)) throw new Error(`找不到 ${cli}，先执行 npm run build`);
  const directory = join(home, "bot");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const log = openSync(join(directory, "worker.log"), "a", 0o600);
  const child = spawn(process.execPath, [cli, "bot", "run"], {
    env: { ...process.env, LUBAN_HOME: home },
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  // Status first: the live lock/pid is the truth, the spawn result only annotates it.
  return { ...workerStatus(home), started: true, reason: "spawned", spawnedPid: child.pid };
}

module.exports = {
  addTask, cancelTask, cliPath, ensurePolicy, ensureWorker, homeDir, listTasks, permissionRequests, policyPath, workerStatus,
};
