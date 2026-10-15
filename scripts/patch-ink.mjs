import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const marker = "// luban: bounded text caches v1\n";

/** Keep the existing terminal/input behavior and backport only the cache fix.
 * Called by npm postinstall, source builds and both standalone packagers. */
export function patchInk(root = resolve(dirname(fileURLToPath(import.meta.url)), "..")) {
  const require = createRequire(join(root, "package.json"));
  const build = dirname(require.resolve("ink"));
  const { version } = JSON.parse(readFileSync(join(build, "..", "package.json"), "utf8"));
  if (version !== "6.8.0") throw new Error(`Ink ${version}: review the bounded-cache backport before changing Ink versions`);
  const changes = [
    ["measure-text.js", [["const cache = new Map();", "const cache = new TextCache();"]]],
    ["wrap-text.js", [
      ["const cache = {};", "const cache = new TextCache();"],
      ["const cacheKey = text + String(maxWidth) + String(wrapType);", "const cacheKey = JSON.stringify([text, maxWidth, wrapType]);"],
      ["const cachedText = cache[cacheKey];", "const cachedText = cache.get(cacheKey);"],
      ["cache[cacheKey] = wrappedText;", "cache.set(cacheKey, wrappedText);"],
    ]],
  ];
  // Validate all targets before writing, so an incompatible install fails
  // visibly instead of silently shipping an ineffective memory fix.
  const pending = changes.map(([name, replacements]) => {
    const path = join(build, name);
    let text = readFileSync(path, "utf8");
    if (text.startsWith(marker)) return { path, text, changed: false };
    for (const [before, after] of replacements) {
      if (text.split(before).length !== 2) throw new Error(`Ink cache backport: unexpected ${name} contents`);
      text = text.replace(before, after);
    }
    return { path, text: marker + "import TextCache from './luban-text-cache.js';\n" + text, changed: true };
  });
  const helper = readFileSync(new URL("./lib/ink-text-cache.mjs", import.meta.url), "utf8");
  writeFileSync(join(build, "luban-text-cache.js"), helper);
  for (const item of pending) if (item.changed) writeFileSync(item.path, item.text);
  return { version, patched: pending.filter(item => item.changed).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = patchInk();
  process.stdout.write(`Ink ${result.version}: bounded text caches ready (${result.patched} modules patched)\n`);
}
