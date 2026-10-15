/** Exercise the installed renderer's real caches, not a replacement cache.
 * Run: node --expose-gc --max-old-space-size=128 scripts/ink-memory-smoke.mjs */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import TextCache from "./lib/ink-text-cache.mjs";

if (!global.gc) throw new Error("Run with node --expose-gc");
const build = dirname(createRequire(import.meta.url).resolve("ink"));
const { default: measure } = await import(pathToFileURL(join(build, "measure-text.js")).href);
const { default: wrap } = await import(pathToFileURL(join(build, "wrap-text.js")).href);
assert.deepEqual(measure("你好\nabc"), { width: 4, height: 2 });
assert.equal(wrap("123456", 3, "wrap"), "123\n456");
assert.equal(wrap("123456", 3, "truncate-end"), "12…");
// The old concatenated keys also collided across text/width boundaries.
assert.equal(wrap("abc1", 23, "wrap"), "abc1");
assert.equal(wrap("abc", 123, "wrap"), "abc");
const samples = [];
for (let batch = 0; batch <= 8; batch++) {
  if (batch) for (let index = 0; index < 5000; index++) {
    const text = randomBytes(1024).toString("hex");
    measure(text);
    wrap(text, 80, "truncate-end");
  }
  global.gc();
  samples.push({ frames: batch * 5000, heapMiB: process.memoryUsage().heapUsed / 1024 / 1024 });
}
// Exclude warm-up. The original 6.8.0 caches retain ~84 MiB after 20k
// distinct frames and exceed this child's 128 MiB heap before finishing.
assert.ok(samples.at(-1).heapMiB - samples[2].heapMiB < 8, "retained heap continues growing after cache warm-up");
// A short substring must not pin its multi-megabyte parent in the cache.
const slices = new TextCache(2048, 1024 * 1024);
global.gc();
const beforeSlices = process.memoryUsage().heapUsed;
for (let index = 0; index < 200; index++) {
  const parent = randomBytes(128 * 1024).toString("hex");
  slices.set(parent.slice(50, 150), parent.slice(200, 300));
}
global.gc();
assert.ok(process.memoryUsage().heapUsed - beforeSlices < 8 * 1024 * 1024, "small cached substrings pin large parent strings");
process.stdout.write(JSON.stringify({ frames: 40000, samples, ok: true }) + "\n");
