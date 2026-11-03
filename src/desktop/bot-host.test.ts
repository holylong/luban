import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const { snapshot, brief, processTree, machineState } = createRequire(import.meta.url)('../../apps/desktop/bot-host.cjs');
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function home() { const path = await mkdtemp(join(tmpdir(), 'luban-bot-host-')); homes.push(path); return path; }
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function task(dir: string, n: number, prompt: string, state: Record<string, unknown>) {
  const folder = join(dir, 'bot', 'tasks', id(n));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'request.json'), JSON.stringify({ id: id(n), prompt, workspace: dir, at: 1000 + n, timeout: 1000 }));
  await writeFile(join(folder, 'state.json'), JSON.stringify(state));
  return folder;
}

it('reports a never-started bot as stopped with empty counts', async () => {
  const dir = await home();
  expect(snapshot(dir)).toMatchObject({
    worker: { state: 'stopped' },
    counts: { total: 0, running: 0, queued: 0, done: 0, failed: 0, cancelled: 0 },
    recent: [], requests: [], requestCount: 0, owned: false,
  });
});

it('separates a live worker from a lock left by a crash', async () => {
  const dir = await home();
  await mkdir(join(dir, 'bot', 'worker.lock'), { recursive: true });
  await writeFile(join(dir, 'bot', 'worker.lock', 'pid'), String(process.pid));
  expect(snapshot(dir).worker).toEqual({ state: 'running', pid: process.pid });
  expect(snapshot(dir, { alive: () => false }).worker).toEqual({ state: 'stale', pid: process.pid });
});

it('counts task states, honours cancel markers and keeps the newest results', async () => {
  const dir = await home();
  await task(dir, 1, '阅读项目并总结待办', { status: 'completed', finishedAt: 3000, result: '完成'.repeat(200), usage: { input: 900, output: 100, calls: 2 } });
  await task(dir, 2, '检查项目风险', { status: 'running', startedAt: 5000 });
  await task(dir, 3, '生成今日摘要', { status: 'failed', finishedAt: 8000, result: 'boom' });
  const cancelled = await task(dir, 4, '旧任务', { status: 'queued', nextAt: 9000 });
  await writeFile(join(cancelled, 'cancel'), 'cancelled');
  const state = snapshot(dir, { owned: true, error: 'x'.repeat(600) });
  expect(state.counts).toEqual({ total: 4, running: 1, queued: 0, done: 1, failed: 1, cancelled: 1 });
  expect(state.recent.map((row: { id: string }) => row.id)).toEqual([id(3), id(1), id(2)]);
  expect(state.recent[1].result.endsWith('…')).toBe(true);
  expect(state.recent[1].result.length).toBe(160);
  expect(state.recent[1].title.length).toBeLessThanOrEqual(60);
  expect(state.recent[1]).toMatchObject({ tokens: 1000, inputTokens: 900, outputTokens: 100, modelCalls: 2 });
  expect(state.recent[0].tokens).toBe(0);
  expect(state.owned).toBe(true);
  expect(state.error).toHaveLength(400);
});

it('lists pending permission requests newest first and treats cancelled tasks as cancelled', async () => {
  const dir = await home();
  const folder = await task(dir, 5, '写入配置', { status: 'queued', nextAt: 1 });
  await writeFile(join(folder, 'cancel'), 'cancelled');
  await mkdir(join(dir, 'bot', 'permission-requests'), { recursive: true });
  for (const [n, createdAt] of [[1, '2026-01-01T00:00:00.000Z'], [2, '2026-02-01T00:00:00.000Z']] as const) {
    await writeFile(join(dir, 'bot', 'permission-requests', `${id(n)}.json`), JSON.stringify({
      id: id(n), taskId: id(5), workspace: dir, tool: 'write_file', args: {}, reason: '需要授权写入', status: 'pending', createdAt,
    }));
  }
  const state = snapshot(dir);
  expect(state.requestCount).toBe(2);
  expect(state.requests.map((row: { id: string }) => row.id)).toEqual([id(2), id(1)]);
  expect(state.requests[0].tool).toBe('write_file');
  expect(state.recent).toHaveLength(0);
});

it('lists worker threads and direct children from the OS', () => {
  const output: Record<string, string> = {
    'pgrep -P 42': '77\n88\n',
    'ps -o command= -p 77': '/bin/zsh -lc npm test\n',
    'ps -o command= -p 88': 'node dist/cli.js bot run\n',
    'ps -M -p 42': 'USER PID TT\nme 42 ??\nme 42 ??\nme 42 ??\n',
    'ps -o rss= -p 42': '409600\n',
  };
  const run = (command: string, args: string[]) => output[`${command} ${args.join(' ')}`] ?? '';
  expect(processTree(42, run, 'darwin')).toEqual({
    pid: 42,
    threads: 3,
    memoryMb: 400,
    children: [
      { pid: 77, command: '/bin/zsh -lc npm test' },
      { pid: 88, command: 'node dist/cli.js bot run' },
    ],
  });
  expect(processTree(undefined, run, 'darwin')).toBeUndefined();
  expect(processTree(42, run, 'linux').threads).toBeUndefined();
});

it('publishes the running task and live subagents across luban processes', async () => {
  const dir = await home();
  await mkdir(join(dir, 'bot', 'worker.lock'), { recursive: true });
  await writeFile(join(dir, 'bot', 'worker.lock', 'pid'), String(process.pid));
  await writeFile(join(dir, 'bot', 'status.json'), JSON.stringify({
    pid: process.pid, startedAt: 1000, updatedAt: 2000,
    task: { prompt: '整理\n项目结构', startedAt: 2000 },
  }));
  await mkdir(join(dir, 'agents'), { recursive: true });
  await writeFile(join(dir, 'agents', `${process.pid}.json`), JSON.stringify({
    pid: process.pid,
    agents: [
      { depth: 0, task: 'parent', startedAt: 2000, inputTokens: 700, outputTokens: 100 },
      { depth: 1, task: 'child', startedAt: 2100, inputTokens: 0, outputTokens: 0 },
    ],
  }));
  const alive = (pid: number) => pid === process.pid;
  const state = snapshot(dir, { alive });
  expect(state.task).toEqual({ prompt: '整理 项目结构', startedAt: 2000 });
  expect(state.agents).toEqual([
    { depth: 0, task: 'parent', startedAt: 2000, tokens: 800, pid: process.pid },
    { depth: 1, task: 'child', startedAt: 2100, tokens: 0, pid: process.pid },
  ]);
  expect(state.machine.load1).toBeGreaterThanOrEqual(0);
  expect(state.machine.memoryUsedPct).toBeGreaterThanOrEqual(0);
  // Dead processes and stale heartbeats are ignored, never attributed to the worker.
  await writeFile(join(dir, 'agents', '999999.json'), JSON.stringify({ pid: 999999, agents: [{ depth: 0, task: 'dead' }] }));
  expect(snapshot(dir, { alive }).agents).toHaveLength(2);
  await writeFile(join(dir, 'bot', 'status.json'), JSON.stringify({ pid: 999999, task: { prompt: 'old' } }));
  expect(snapshot(dir, { alive }).task).toBeUndefined();
});

it('reports memory used without counting reclaimable macOS pages', () => {
  const vm = ['Mach Virtual Memory Statistics: (page size of 16384 bytes)', 'Pages free: 1000.', 'Pages active: 10000.',
    'Pages inactive: 2000.', 'Pages speculative: 500.'].join('\n');
  const total = totalmem();
  const expected = Math.round(((total - 3500 * 16384) / total) * 100);
  expect(machineState(() => vm, 'darwin').memoryUsedPct).toBe(expected);
  expect(machineState(() => '', 'linux').memoryUsedPct).toBeGreaterThan(0);
});

it('collapses multi-line summaries into one short line', () => {
  expect(brief('  第一行\n\n第二行  ', 40)).toBe('第一行 第二行');
  expect(brief('a'.repeat(10), 5)).toBe('aaaa…');
});
