/**
 * Cross-platform build for luban.
 *
 * Two independent products are produced:
 *   1. the Node runtime (tsc -> dist/)                 — always required
 *   2. the browser workbench (tsc check + vite -> dist/web-ui/) — needs the
 *      frontend toolchain
 *
 * The web step is allowed to be skipped with a loud warning when `vite` is not
 * installed, because the server embeds a fallback console and `npm run build`
 * must not fail in an environment where the optional toolchain is missing.
 * A failing server build, or a failing web build with the toolchain present,
 * is always a hard error.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

function run(label, command, args) {
  process.stdout.write(`\n> ${label}\n`);
  // Invoke Node directly so paths containing spaces remain intact on Windows.
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

function have(specifier) {
  try { require.resolve(specifier); return true; }
  catch { return false; }
}

// Start from a clean tree so stale output from a previous layout can never be
// served. rmSync with force is a no-op when the directory is absent.
rmSync(join(root, "dist"), { recursive: true, force: true });

if (!existsSync(tsc)) {
  process.stderr.write(
    "TypeScript is not installed.\n" +
    "Run `npm install` in this directory first, then retry the build.\n",
  );
  process.exit(1);
}

try {
  run("server (tsc)", process.execPath, [tsc, "-p", "tsconfig.json"]);
} catch (error) {
  process.stderr.write(`\n${error.message}\n`);
  process.exit(1);
}

// The build starts from a clean dist, so the executable bit that `npm link`
// relies on for the global `luban` shim has to be restored here. Leaving
// it to build_lnk.sh means a later plain `npm run build` silently breaks the
// linked command with "permission denied".
if (process.platform !== "win32") {
  try {
    chmodSync(join(root, "dist", "cli.js"), 0o755);
  } catch (error) {
    process.stderr.write(`warning: could not mark dist/cli.js executable: ${error.message}\n`);
  }
}

const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
const webToolchain = existsSync(viteBin) && have("react-dom") && have("react");

if (!webToolchain) {
  process.stderr.write(
    "\n[web] skipping the browser workbench build: the frontend toolchain is missing.\n" +
    "      missing: " +
    [!existsSync(viteBin) && "vite", !have("react-dom") && "react-dom", !have("react") && "react"].filter(Boolean).join(", ") +
    "\n      Run `npm install` to install it. Until then the server still runs and serves the\n" +
    "      built-in fallback console at http://127.0.0.1:<port>/ .\n\n",
  );
  process.exit(0);
}

try {
  run("web types (tsc)", process.execPath, [tsc, "-p", "tsconfig.client.json"]);
  run("web bundle (vite)", process.execPath, [viteBin, "build"]);
} catch (error) {
  process.stderr.write(`\n${error.message}\n`);
  process.exit(1);
}

process.stdout.write("\nbuild ok: dist/ (server) + dist/web-ui/ (browser workbench)\n");
