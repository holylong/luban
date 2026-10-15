import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

it("keeps the installed Ink caches stable for 40k distinct frames with a 128 MiB heap", () => {
  const output = execFileSync(process.execPath, ["--expose-gc", "--max-old-space-size=128", resolve("scripts/ink-memory-smoke.mjs")], {
    encoding: "utf8", timeout: 30_000,
  });
  expect(JSON.parse(output)).toMatchObject({ frames: 40000, ok: true });
}, 35_000);
