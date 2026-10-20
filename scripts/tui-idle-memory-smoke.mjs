/** Full built App regression: run with node --expose-gc scripts/tui-idle-memory-smoke.mjs. */
import assert from 'node:assert/strict';
import { Writable, PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Match the CLI's first dependency; all React imports must follow this.
await import('../dist/runtime-env.js');
const { createElement } = await import('react');
const { render } = await import('ink');
const { loadConfig } = await import('../dist/core/config.js');
const { App } = await import('../dist/ui/app.js');
const collect = global.gc;
assert.ok(collect, 'Run Node with --expose-gc');
assert.equal(process.env.NODE_ENV, 'production', 'Unset NODE_ENV for the default CLI regression');
const previousHome = process.env.LUBAN_HOME;
const home = await mkdtemp(join(tmpdir(), 'luban-idle-memory-'));
process.env.LUBAN_HOME = home;
let app;
try {
  const config = loadConfig({ workspace: home });
  /** @type {(event: import('../dist/core/mesh/runtime.js').MeshEvent) => void} */
  let notify = (_event) => {};
  const mesh = { peers: () => [], chats: async () => [], jobs: async () => [],
    jobStream: () => ({ events: [] }), onEvent: (/** @type {typeof notify} */ listener) => { notify = listener; return () => {}; } };
  const stdout = Object.assign(new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    { isTTY: true, columns: 240, rows: 50 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  app = render(createElement(App, { config,
    mesh: /** @type {import('../dist/core/mesh/runtime.js').MeshRuntime} */ (/** @type {unknown} */ (mesh)) }),
    { stdout: /** @type {NodeJS.WriteStream} */ (/** @type {unknown} */ (stdout)),
      stdin: /** @type {NodeJS.ReadStream} */ (/** @type {unknown} */ (stdin)),
      debug: true, patchConsole: false, exitOnCtrlC: false });
  await new Promise(resolve => setTimeout(resolve, 300));
  const samples = [];
  for (let batch = 0; batch <= 6; batch++) {
    if (batch) for (let i = 0; i < 1000; i++) {
      notify({ type: 'peer', discovered: false, peer: { name: 'idle-peer', host: '127.0.0.1',
        port: 5000, udpPort: 5001, capabilities: [], version: 'test',
        lastSeen: Date.now() / 1000, note: '', online: true } });
      await new Promise(resolve => setImmediate(resolve));
    }
    collect();
    const heapMiB = process.memoryUsage().heapUsed / 1024 / 1024;
    samples.push(heapMiB);
    console.log(JSON.stringify({ updates: batch * 1000, heapMiB }));
  }
  // Allow JIT/cache warmup, but reject the reproduced ~130 MiB linear growth.
  const last = samples.at(-1);
  assert.ok(last !== undefined && samples[1] !== undefined);
  const growthMiB = last - samples[1];
  assert.ok(growthMiB < 8, `Retained heap grew ${growthMiB.toFixed(2)} MiB after warmup`);
  console.log(JSON.stringify({ ok: true, growthMiB }));
} finally {
  app?.unmount();
  app?.cleanup();
  if (previousHome === undefined) delete process.env.LUBAN_HOME;
  else process.env.LUBAN_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
}
