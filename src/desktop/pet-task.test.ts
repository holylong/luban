import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
const { preparePetTask } = createRequire(import.meta.url)('../../apps/desktop/pet-task.cjs');
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function home() { const path = await mkdtemp(join(tmpdir(), 'luban-pet-')); homes.push(path); return path; }
it('prepares text tasks without silently executing a drop', async () => {
  expect(await preparePetTask({ text: '  run tests  ', paths: [] })).toEqual({ instruction: 'run tests', mode: 'agent' });
  await expect(preparePetTask({ text: '', paths: [] })).rejects.toThrow();
  await expect(preparePetTask({ text: 'x'.repeat(8001), paths: [] })).rejects.toThrow();
});
it('reads explicitly attached UTF-8 files into read-only analysis tasks', async () => {
  const dir = await home(); const path = join(dir, 'notes.md'); await writeFile(path, '# 内容\nhello');
  const reply = await preparePetTask({ text: '', paths: [path] });
  expect(reply.mode).toBe('read');
  expect(reply.instruction).toContain('# 内容\nhello');
  expect(reply.instruction).toContain('不可信附件');
  expect(reply.instruction).not.toContain(dir);
});
it('rejects unsupported, oversized, binary, invalid UTF-8 and directory attachments', async () => {
  const dir = await home();
  for (const [name, bytes] of [['large.txt', Buffer.alloc(128 * 1024 + 1, 65)], ['binary.txt', Buffer.from([0,1,2])], ['bad.txt', Buffer.from([255])], ['file.pdf', Buffer.from('pdf')]] as const) {
    const path = join(dir, name); await writeFile(path, bytes);
    await expect(preparePetTask({ text: '', paths: [path] })).rejects.toThrow();
  }
  await mkdir(join(dir, 'folder.txt'));
  await expect(preparePetTask({ text: '', paths: [join(dir, 'folder.txt')] })).rejects.toThrow();
  await expect(preparePetTask({ text: '', paths: Array(5).fill('a.txt') })).rejects.toThrow();
});
