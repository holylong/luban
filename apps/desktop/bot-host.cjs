// The pet is the bot's body: this module turns the on-disk bot queue into the
// small snapshot the pet window renders. It never writes to the queue.
const { readFileSync, readdirSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { loadavg, totalmem, freemem } = require('node:os');
const { join } = require('node:path');

const ID = /^[0-9a-f-]{36}$/;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}
function readText(path) {
  try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
}
function exists(path) {
  try { readFileSync(path); return true; } catch { return false; }
}
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

/** `stale` means a lock survived a crash; the worker must not be duplicated. */
function workerState(home, alive = isPidAlive) {
  const pid = Number(readText(join(home, 'bot', 'worker.lock', 'pid')));
  if (!Number.isInteger(pid) || pid <= 0) return { state: 'stopped' };
  return alive(pid) ? { state: 'running', pid } : { state: 'stale', pid };
}

function taskRows(home) {
  const directory = join(home, 'bot', 'tasks');
  let names;
  try { names = readdirSync(directory); } catch { return []; }
  const rows = [];
  for (const id of names) {
    if (!ID.test(id)) continue;
    const task = readJson(join(directory, id, 'request.json'));
    if (!task || typeof task.prompt !== 'string') continue;
    const state = readJson(join(directory, id, 'state.json')) || {};
    rows.push({
      id,
      prompt: task.prompt,
      workspace: typeof task.workspace === 'string' ? task.workspace : '',
      status: exists(join(directory, id, 'cancel')) ? 'cancelled' : (typeof state.status === 'string' ? state.status : 'queued'),
      at: Number(task.at) || 0,
      finishedAt: Number(state.finishedAt) || 0,
      result: typeof state.result === 'string' ? state.result : '',
      tokens: Number(state.usage?.input || 0) + Number(state.usage?.output || 0),
      inputTokens: Number(state.usage?.input || 0),
      outputTokens: Number(state.usage?.output || 0),
      modelCalls: Number(state.usage?.calls || 0),
    });
  }
  return rows;
}

function requestRows(home) {
  const directory = join(home, 'bot', 'permission-requests');
  let names;
  try { names = readdirSync(directory); } catch { return []; }
  const rows = [];
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
    const request = readJson(join(directory, name));
    if (!request || typeof request.tool !== 'string') continue;
    rows.push({
      id: String(request.id || name.slice(0, -5)),
      tool: request.tool,
      workspace: typeof request.workspace === 'string' ? request.workspace : '',
      reason: typeof request.reason === 'string' ? request.reason : '',
      createdAt: typeof request.createdAt === 'string' ? request.createdAt : '',
    });
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function execText(command, args) {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (error) { return typeof error?.stdout === 'string' ? error.stdout : ''; }
}

/**
 * OS-level view of the worker: its threads and direct children. Subagents are
 * in-process runners, so they never show up here; see liveStatus instead.
 */
function processTree(pid, run = execText, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const children = run('pgrep', ['-P', String(pid)])
    .split('\n').map(line => Number(line.trim()))
    .filter(value => Number.isInteger(value) && value > 0)
    .slice(0, 12)
    .map(child => ({ pid: child, command: brief(run('ps', ['-o', 'command=', '-p', String(child)]) || '(exited)', 90) }));
  const rss = Number(run('ps', ['-o', 'rss=', '-p', String(pid)]).trim());
  const memoryMb = Number.isFinite(rss) && rss > 0 ? Math.round(rss / 1024) : undefined;
  if (platform !== 'darwin') return { pid, memoryMb, children };
  // `ps -M` prints one row per thread plus a header row.
  const rows = run('ps', ['-M', '-p', String(pid)]).split('\n').filter(line => line.trim()).length;
  return { pid, threads: Math.max(0, rows - 1), memoryMb, children };
}

/**
 * Machine load and memory. macOS `freemem` counts only truly free pages and
 * reports ~98% used on a healthy machine, so reclaimable pages are subtracted.
 */
function machineState(run = execText, platform = process.platform) {
  const total = totalmem();
  const used = run('vm_stat', []).length && platform === 'darwin'
    ? (() => {
      const text = run('vm_stat', []);
      const page = Number((/page size of (\d+)/.exec(text) || [])[1]);
      const pages = name => Number((new RegExp(`${name}:\\s+(\\d+)\\.`).exec(text) || [])[1] || 0);
      const reclaimable = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative');
      return page && reclaimable ? Math.max(0, total - reclaimable * page) : total - freemem();
    })()
    : total - freemem();
  return {
    load1: Math.round(loadavg()[0] * 100) / 100,
    memoryUsedPct: Math.round((used / total) * 100),
  };
}

/** The worker's own heartbeat: which task it is executing right now. */
function liveTask(home, worker) {
  if (worker.state !== 'running') return {};
  const status = readJson(join(home, 'bot', 'status.json'));
  if (!status || status.pid !== worker.pid) return {};
  return status.task && typeof status.task.prompt === 'string'
    ? { task: { prompt: brief(status.task.prompt, 100), startedAt: Number(status.task.startedAt) || 0 } }
    : {};
}

/** Live agents of every running luban process (worker, desktop backend, …). */
function agentProcesses(home, alive = isPidAlive) {
  const directory = join(home, 'agents');
  let names;
  try { names = readdirSync(directory); } catch { return []; }
  const rows = [];
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!alive(pid)) continue;
    const file = readJson(join(directory, name));
    const agents = Array.isArray(file?.agents) ? file.agents.slice(0, 8) : [];
    rows.push({
      pid,
      agents: agents.map(agent => ({
        depth: Number(agent.depth) || 0,
        task: brief(agent.task, 60),
        startedAt: Number(agent.startedAt) || 0,
        tokens: Number(agent.inputTokens || 0) + Number(agent.outputTokens || 0),
      })),
    });
  }
  return rows.sort((a, b) => a.pid - b.pid);
}

function brief(value, limit) {
  const oneLine = String(value || '').replace(/\s+/g, ' ').trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

function snapshot(home, options = {}) {
  const tasks = taskRows(home);
  const counts = { total: tasks.length, running: 0, queued: 0, done: 0, failed: 0, cancelled: 0 };
  for (const task of tasks) {
    if (task.status === 'running') counts.running += 1;
    else if (task.status === 'queued') counts.queued += 1;
    else if (task.status === 'completed') counts.done += 1;
    else if (task.status === 'failed' || task.status === 'interrupted') counts.failed += 1;
    else if (task.status === 'cancelled') counts.cancelled += 1;
  }
  const recent = tasks
    .filter(task => task.status !== 'cancelled')
    .sort((a, b) => (b.finishedAt || b.at) - (a.finishedAt || a.at))
    .slice(0, 4)
    .map(task => ({
      id: task.id,
      status: task.status,
      title: brief(task.prompt, 60),
      result: brief(task.result, 160),
      finishedAt: task.finishedAt || undefined,
      tokens: task.tokens,
      inputTokens: task.inputTokens,
      outputTokens: task.outputTokens,
      modelCalls: task.modelCalls,
    }));
  const requests = requestRows(home);
  const worker = workerState(home, options.alive);
  const owners = agentProcesses(home, options.alive);
  const agents = owners
    .flatMap(owner => owner.agents.map(agent => ({ ...agent, pid: owner.pid })))
    .slice(0, 10);
  const backends = owners
    .filter(owner => owner.pid !== worker.pid)
    .map(owner => processTree(owner.pid, options.run, options.platform))
    .filter(Boolean);
  return {
    worker,
    process: worker.state === 'running' ? processTree(worker.pid, options.run, options.platform) : undefined,
    ...liveTask(home, worker),
    agents,
    backends,
    machine: machineState(options.run, options.platform),
    counts,
    recent,
    requests: requests.slice(0, 5).map(request => ({
      id: request.id,
      tool: request.tool,
      workspace: request.workspace,
      reason: brief(request.reason, 120),
      createdAt: request.createdAt,
    })),
    requestCount: requests.length,
    owned: Boolean(options.owned),
    error: options.error === undefined ? undefined : String(options.error).slice(-400),
  };
}

module.exports = { snapshot, workerState, taskRows, requestRows, processTree, liveTask, agentProcesses, machineState, brief };
