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

/** The CLI runs under Node, never under Electron. A packaged app carries its own
 * runtime and points LUBAN_NODE_BIN at it; in development process.execPath is the
 * Electron binary, so the child has to be told to behave as plain Node. */
function nodeBinary() {
  return process.env.LUBAN_NODE_BIN || process.execPath;
}

function nodeEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (!process.env.LUBAN_NODE_BIN && process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

function queueDirectory(home) {
  return join(home, "bot", "tasks");
}

/** `runs.jsonl` is written by the worker in `src/core/bot.ts`; this only reads it. */
function runsPath(home, id) {
  return join(queueDirectory(home), id, "runs.jsonl");
}

function countRuns(home, id) {
  try {
    const text = readFileSync(runsPath(home, id), "utf8");
    return text.split("\n").filter(line => line.trim()).length;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

/** Finished executions, newest last, capped so one long-lived task cannot stall the UI. */
function taskRuns(home, id, limit = 30) {
  if (!TASK_ID.test(String(id || ""))) throw new Error("无效的任务 id");
  let text;
  try { text = readFileSync(runsPath(home, id), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const runs = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { runs.push(JSON.parse(line)); } catch { /* half-written tail line: keep what parses */ }
  }
  return runs.slice(-limit);
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
      kind: task.kind || "agent",
      timeout: task.timeout,
      status: existsSync(join(directory, id, "cancel")) ? "cancelled" : state.status,
      nextAt: state.nextAt,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      result: state.result,
      usage: state.usage,
      runs: countRuns(home, id),
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
  const result = spawnSync(nodeBinary(), [cli, ...args], {
    env: nodeEnv({ LUBAN_HOME: home }),
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
  // A reminder is a queue entry with a notification, not a model turn.
  if (input.remind) args.push("--remind");
  if (input.every && Number(input.every) > 0) args.push("--every", String(Math.max(60, Math.round(Number(input.every)))));
  const timeout = Number(input.timeout);
  if (Number.isFinite(timeout) && timeout >= 1) args.push("--timeout", String(Math.round(timeout)));
  const output = runCli(args, home);
  const id = /Queued ([0-9a-f-]{36})/u.exec(output)?.[1];
  return { id, workspace, at: input.at ? new Date(input.at).getTime() : Date.now() };
}

/**
 * Change what a task asks for, through the CLI that owns the format.
 *
 * `patch.at` is the only field a caller must compute: everything else is copied
 * from what the person typed. The CLI re-queues the task, so a nightly job whose
 * wording drifted keeps its history instead of growing a second row beside it.
 */
function editTask(home, id, patch) {
  if (!TASK_ID.test(String(id || ""))) throw new Error("无效的任务 id");
  const input = patch || {};
  const args = ["bot", "edit", id];
  // An emptied box is a mistake, not a request to blank the task: say so here, in
  // the window's language, instead of surfacing the CLI's own wording.
  if (typeof input.prompt === "string") {
    if (!input.prompt.trim()) throw new Error("任务内容不能为空");
    args.push("--prompt", input.prompt.trim());
  }
  if (typeof input.workspace === "string" && input.workspace.trim()) args.push("--workspace", input.workspace.trim());
  if (input.at) args.push("--at", new Date(input.at).toISOString());
  if (input.every === null) args.push("--once");
  else if (input.every) args.push("--every", String(Math.max(60, Math.round(Number(input.every)))));
  if (input.runNow) args.push("--run-now");
  const output = runCli(args, home);
  return { id, output: String(output || "").trim() };
}

function cancelTask(home, id) {
  if (!TASK_ID.test(String(id || ""))) throw new Error("无效的任务 id");
  runCli(["bot", "cancel", id], home);
  return { id };
}

/**
 * The transcript the newest run of a task wrote, which is what "接着聊" resumes.
 *
 * New runs record it in runs.jsonl. Old ones only have the `Session: <id>` line
 * the worker appends to its answer, so that line is the fallback rather than a
 * reason to tell the person their task cannot be continued.
 */
function taskSession(home, id) {
  if (!TASK_ID.test(String(id || ""))) throw new Error("无效的任务 id");
  const runs = taskRuns(home, id, 50);
  for (const run of [...runs].reverse()) {
    if (typeof run.session === "string" && run.session) return run.session;
    const match = /Session: ([0-9a-zA-Z-]+)/u.exec(String(run.result || ""));
    if (match) return match[1];
  }
  const state = readJson(join(queueDirectory(home), id, "state.json"));
  const match = /Session: ([0-9a-zA-Z-]+)/u.exec(String(state?.result || ""));
  return match ? match[1] : undefined;
}

/**
 * What a saved conversation said, in the shape the window draws (you / reply).
 *
 * Tool rows are dropped on purpose: this pane is for a person reading the thread
 * back, and a wall of raw tool JSON would bury the two sentences they came for.
 */
function sessionTranscript(home, sessionId) {
  const wanted = String(sessionId || "");
  if (!/^[0-9a-zA-Z-]{6,64}$/u.test(wanted)) throw new Error("无效的会话 id");
  const root = join(home, "sessions-node");
  if (!existsSync(root)) return { id: wanted, messages: [] };
  for (const project of readdirSync(root)) {
    const file = join(root, project, `${wanted}.json`);
    if (!existsSync(file)) continue;
    const record = readJson(file);
    if (!record || !Array.isArray(record.messages)) return { id: wanted, messages: [] };
    const messages = [];
    for (const message of record.messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const text = typeof message.content === "string" ? message.content.trim() : "";
      if (!text) continue;
      messages.push({ role: message.role, text, at: Date.parse(message.at || record.updatedAt) || undefined });
    }
    return { id: wanted, title: record.title, messages: messages.slice(-60), updatedAt: record.updatedAt };
  }
  return { id: wanted, messages: [] };
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

/**
 * Per-project memory, exactly as `luban memory --json` reports it.
 *
 * The Markdown format (sections, `YYYY-MM-DD HH:mm` stamps, caps) belongs to
 * src/core/memory.ts; parsing it a second time here is how a UI drifts from the
 * file it is showing. Clearing goes through the CLI for the same reason.
 */
function memoryList(home) {
  const output = runCli(["memory", "--json"], home);
  const rows = JSON.parse(output || "[]");
  if (!Array.isArray(rows)) throw new Error("luban memory --json 没有返回列表");
  return rows;
}

function clearMemory(home, workspace) {
  const target = String(workspace || "").trim();
  if (!target) throw new Error("缺少工作区路径");
  runCli(["memory", "--clear", target], home);
  return memoryList(home);
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
  const child = spawn(nodeBinary(), [cli, "bot", "run"], {
    env: nodeEnv({ LUBAN_HOME: home }),
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  // Status first: the live lock/pid is the truth, the spawn result only annotates it.
  return { ...workerStatus(home), started: true, reason: "spawned", spawnedPid: child.pid };
}

module.exports = {
  addTask, cancelTask, clearMemory, cliPath, editTask, ensurePolicy, ensureWorker, homeDir, listTasks, memoryList,
  nodeBinary, nodeEnv, permissionRequests, policyPath, sessionTranscript, taskRuns, taskSession, workerStatus,
};
