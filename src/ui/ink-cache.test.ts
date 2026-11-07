import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

// The scripts are plain JS so postinstall also works before TypeScript exists.
// @ts-expect-error The build-time JS helper has no TypeScript declaration.
import TextCache from "../../scripts/lib/ink-text-cache.mjs";
// @ts-expect-error The installer is shared with the standalone packagers.
import { patchInk } from "../../scripts/patch-ink.mjs";

it("evicts by entry count and bytes, refreshes on reads, and skips oversized values", () => {
  const cache = new TextCache(2, 1000);
  cache.set("one", "a"); cache.set("two", "b");
  expect(cache.get("one")).toBe("a");
  cache.set("three", "c");
  expect(cache.get("two")).toBeUndefined();
  expect(cache.get("one")).toBe("a");
  cache.set("huge", "x".repeat(1000));
  expect(cache.get("huge")).toBeUndefined();
  expect(cache.size).toBe(2);
  cache.set("one", "updated");
  expect(cache.get("one")).toBe("updated");
  const bytes = new TextCache(100, 400);
  for (let i = 0; i < 100; i++) bytes.set(String(i), "x".repeat(40));
  expect(bytes.bytes).toBeLessThanOrEqual(400);
  expect(bytes.size).toBe(1);
  const unicode = "中文 👩‍💻 \ud800";
  cache.set(unicode, unicode);
  expect(cache.get(unicode)).toBe(unicode);
});

it("installs idempotently and rejects an incompatible renderer without modifying it", () => {
  patchInk();
  expect(patchInk().patched).toBe(0);
  const root = mkdtempSync(join(tmpdir(), "luban-ink-patch-"));
  try {
    const ink = join(root, "node_modules", "ink");
    mkdirSync(join(ink, "build"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(ink, "package.json"), JSON.stringify({ version: "6.8.0", main: "build/index.js" }));
    writeFileSync(join(ink, "build/index.js"), "");
    writeFileSync(join(ink, "build/measure-text.js"), "const cache = new Map();");
    writeFileSync(join(ink, "build/wrap-text.js"), "unexpected layout");
    expect(() => patchInk(root)).toThrow("unexpected wrap-text.js");
    expect(readFileSync(join(ink, "build/measure-text.js"), "utf8")).toBe("const cache = new Map();");
    writeFileSync(join(ink, "package.json"), JSON.stringify({ version: "8.0.0", main: "build/index.js" }));
    expect(() => patchInk(root)).toThrow("review the bounded-cache backport");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("does not rewrite the helper during repeated installation while other processes may import it", () => {
  const root = mkdtempSync(join(tmpdir(), "luban-ink-idempotent-"));
  try {
    const ink = join(root, "node_modules", "ink");
    const build = join(ink, "build");
    mkdirSync(build, { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(ink, "package.json"), JSON.stringify({ version: "6.8.0", main: "build/index.js" }));
    writeFileSync(join(build, "index.js"), "");
    writeFileSync(join(build, "measure-text.js"), "const cache = new Map();");
    writeFileSync(join(build, "wrap-text.js"), ["const cache = {};", "const cacheKey = text + String(maxWidth) + String(wrapType);", "const cachedText = cache[cacheKey];", "cache[cacheKey] = wrappedText;"].join("\n"));
    patchInk(root);
    const helper = join(build, "luban-text-cache.js");
    const content = readFileSync(helper, "utf8");
    const past = new Date("2000-01-01T00:00:00Z");
    utimesSync(helper, past, past);
    expect(patchInk(root).patched).toBe(0);
    expect(statSync(helper).mtimeMs).toBe(+past);
    expect(readFileSync(helper, "utf8")).toBe(content);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("points Ink's throttle at the module itself instead of the whole es-toolkit barrel", () => {
  const root = mkdtempSync(join(tmpdir(), "luban-ink-throttle-"));
  try {
    const build = join(root, "node_modules", "ink", "build");
    mkdirSync(build, { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "node_modules", "ink", "package.json"), JSON.stringify({ version: "6.8.0", main: "build/index.js" }));
    writeFileSync(join(build, "index.js"), "");
    writeFileSync(join(build, "measure-text.js"), "const cache = new Map();");
    writeFileSync(join(build, "wrap-text.js"), ["const cache = {};", "const cacheKey = text + String(maxWidth) + String(wrapType);", "const cachedText = cache[cacheKey];", "cache[cacheKey] = wrappedText;"].join("\n"));
    const barrel = "import { throttle } from 'es-toolkit/compat';";
    writeFileSync(join(build, "ink.js"), `import React from 'react';\n${barrel}\n`);
    // Without es-toolkit the rewrite must fail loudly rather than leave a
    // half-installed import behind.
    expect(() => patchInk(root)).toThrow("es-toolkit");

    const throttle = join(root, "node_modules", "es-toolkit", "dist", "compat", "function", "throttle.mjs");
    mkdirSync(join(throttle, ".."), { recursive: true });
    writeFileSync(throttle, "export { throttle };\n");
    writeFileSync(join(root, "node_modules", "es-toolkit", "package.json"), JSON.stringify({ name: "es-toolkit", version: "1.0.0" }));

    // The cache backports were already written by the failed attempt, so only
    // ink.js is left to rewrite on this pass.
    expect(patchInk(root).patched).toBe(1);
    const patched = readFileSync(join(build, "ink.js"), "utf8");
    // One module file instead of the ~430 the lodash-compatible barrel loads.
    expect(patched).toContain("from '../../es-toolkit/dist/compat/function/throttle.mjs'");
    expect(patched).not.toContain("es-toolkit/compat'");
    expect(patchInk(root).patched).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps the installed Ink caches stable for 40k distinct frames with a 128 MiB heap", () => {
  const output = execFileSync(process.execPath, ["--expose-gc", "--max-old-space-size=128", resolve("scripts/ink-memory-smoke.mjs")], {
    encoding: "utf8", timeout: 30_000,
  });
  expect(JSON.parse(output)).toMatchObject({ frames: 40000, ok: true });
}, 35_000);
