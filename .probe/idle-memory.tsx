import React from 'react';
import { writeHeapSnapshot } from 'node:v8';
import { Writable, PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink';
import { loadConfig } from '../src/core/config.js';
import { App } from '../src/ui/app.js';
import type { MeshRuntime, MeshEvent } from '../src/core/mesh/runtime.js';
const home = await mkdtemp(join(tmpdir(), 'luban-idle-memory-'));
process.env.LUBAN_HOME = home;
const config = loadConfig({ workspace: home });
let notify: (event: MeshEvent) => void = () => {};
const mesh = { peers: () => [], chats: async () => [], jobs: async () => [], jobStream: () => ({events: []}), onEvent: (listener: typeof notify) => { notify = listener; return () => {}; } } as unknown as MeshRuntime;
const stdout = Object.assign(new Writable({ write(_chunk, _encoding, callback) { callback(); } }), { isTTY: true, columns: 240, rows: 50 });
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
const app = render(<App config={config} mesh={mesh} />, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, exitOnCtrlC: false });
const settle = () => new Promise(resolve => setImmediate(resolve));
try {
  await new Promise(resolve => setTimeout(resolve, 300));
  for (let batch = 0; batch <= 6; batch++) {
    if (batch) for (let i = 0; i < 1000; i++) {
      notify({ type: 'peer', discovered: false, peer: { name: 'idle-peer', host: '127.0.0.1', port: 5000, udpPort: 5001, capabilities: [], version: 'test', lastSeen: Date.now()/1000, note: '', online: true } });
      await settle();
    }
    global.gc?.();
    if (process.env.IDLE_SNAPSHOTS && (batch === 0 || batch === 2)) writeHeapSnapshot(`.probe/idle-${batch}.heapsnapshot`);
    console.log(JSON.stringify({ updates: batch*1000, heapMiB: process.memoryUsage().heapUsed/1024/1024, externalMiB: process.memoryUsage().external/1024/1024 }));
  }
} finally { app.unmount(); app.cleanup(); await rm(home, {recursive:true,force:true}); }
