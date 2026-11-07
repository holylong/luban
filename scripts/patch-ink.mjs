import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const marker = "// luban: bounded text caches v1\n";

/** @param {string} path @param {string} content */
function installFile(path, content) {
  try { if (readFileSync(path, "utf8") === content) return; } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

/**
 * Import Ink's throttle from the module that defines it instead of the
 * `es-toolkit/compat` barrel. The barrel is lodash-compatible and pulls in ~430
 * modules, which is more than half of everything a cold `luban` start reads
 * from disk; on Windows every one of those opens goes through the antivirus
 * filter, so that barrel alone costs a visible part of the startup time.
 * The compat entry point is a literal `export { throttle }` re-export of this
 * file, so the imported function is identical, not a reimplementation.
 * @param {string} build Ink's build directory (`node_modules/ink/build`).
 */
function patchThrottleImport(build) {
  const entry = join(build, "ink.js");
  if (!existsSync(entry)) return false;
  const text = readFileSync(entry, "utf8");
  const barrel = "import { throttle } from 'es-toolkit/compat';";
  // Already rewritten, or Ink no longer uses the barrel: leave it be.
  if (!text.includes(barrel)) return false;
  if (text.split(barrel).length !== 2) throw new Error("Ink throttle patch: unexpected ink.js contents");
  const inkRoot = resolve(build, "..");
  const require = createRequire(join(inkRoot, "package.json"));
  // Resolve through Ink's own dependency tree: npm may nest es-toolkit instead
  // of hoisting it, and a hard-coded ../../ path would then point nowhere.
  const pkg = require.resolve("es-toolkit/package.json", { paths: [inkRoot, join(inkRoot, "node_modules")] });
  // The package's "exports" map blocks deep subpaths, so the throttle module is
  // located from the resolved package directory rather than by its specifier.
  const target = join(dirname(pkg), "dist", "compat", "function", "throttle.mjs");
  if (!existsSync(target)) throw new Error(`Ink throttle patch: ${target} is missing`);
  const relativePath = relative(build, target).split(sep).join("/");
  const specifier = relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
  installFile(entry, text.replace(barrel, `import { throttle } from '${specifier}';`));
  return true;
}

/** Keep the existing terminal/input behavior and backport only the cache fix.
 * Called by npm postinstall, source builds and both standalone packagers. */
export function patchInk(root = resolve(dirname(fileURLToPath(import.meta.url)), "..")) {
  const require = createRequire(join(root, "package.json"));
  const build = dirname(require.resolve("ink"));
  const { version } = JSON.parse(readFileSync(join(build, "..", "package.json"), "utf8"));
  if (version !== "6.8.0") throw new Error(`Ink ${version}: review the bounded-cache backport before changing Ink versions`);
  /** @type {Array<[string, Array<[string, string]>]>} */
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
  installFile(join(build, "luban-text-cache.js"), helper);
  let changed = 0;
  for (const item of pending) if (item.changed) { installFile(item.path, item.text); changed += 1; }
  if (patchThrottleImport(build)) changed += 1;
  return { version, patched: changed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = patchInk();
  process.stdout.write(`Ink ${result.version}: bounded text caches ready (${result.patched} modules patched)\n`);
}
