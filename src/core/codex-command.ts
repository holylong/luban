import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { delimiter, dirname, extname, join, win32 } from "node:path";
import { homedir } from "node:os";

/** Resolve npm's Windows shim to its Node entry point without a shell. */
export function codexInvocation(args: string[], options: {
  platform?: NodeJS.Platform;
  command?: string;
  path?: string;
} = {}): [string, string[]] {
  const command = options.command ?? (process.env.LUBAN_CODEX_BIN || "codex");
  if ((options.platform ?? process.platform) !== "win32") return [command, args];

  const isFile = (path: string): boolean => {
    try { return statSync(path).isFile(); } catch { return false; }
  };
  const candidates = /[\\/]/.test(command) || win32.isAbsolute(command)
    ? [command]
    : (options.path ?? process.env.PATH ?? "").split(";")
      .filter(Boolean).map(folder => join(folder.replace(/^"|"$/g, ""), command));
  for (const candidate of candidates) {
    const extension = extname(candidate).toLowerCase();
    if (extension === ".exe" && isFile(candidate)) return [candidate, args];
    if (!extension && isFile(`${candidate}.exe`)) return [`${candidate}.exe`, args];
    if ([".js", ".cjs", ".mjs"].includes(extension) && isFile(candidate)) {
      return [process.execPath, [candidate, ...args]];
    }
    if (isFile(candidate) && ![".cmd", ".bat", ".ps1"].includes(extension)) {
      const header = readFileSync(candidate, "utf8").split(/\r?\n/, 1)[0] ?? "";
      if (/^#!.*\bnode(?:\.exe)?\s*$/.test(header)) return [process.execPath, [candidate, ...args]];
    }
    const npmEntry = join(dirname(candidate), "node_modules", "@openai", "codex", "bin", "codex.js");
    if ((isFile(candidate) || existsSync(`${candidate}.cmd`)) && isFile(npmEntry)) {
      return [process.execPath, [npmEntry, ...args]];
    }
    if (isFile(candidate) && ![".cmd", ".bat", ".ps1"].includes(extension)) return [candidate, args];
  }
  throw new Error(`Cannot find a runnable Codex CLI (${command}). Install it with npm install -g @openai/codex, or set LUBAN_CODEX_BIN to codex.exe or codex.js.`);
}

/** Install locations a GUI launch misses: Finder starts apps with a minimal PATH. */
const COMMON_BIN_DIRS = [".local/bin", ".npm-global/bin", ".bun/bin", ".volta/bin", ".n/bin"];

const resolved = new Map<string, string>();

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function loginShellPath(command: string, env: NodeJS.ProcessEnv, timeoutMs: number): string | undefined {
  // A GUI launch has no shell, and the PATH users add lives in rc files. The
  // login shell is the closest thing to "the PATH the user sees in a terminal".
  const shells = [env.SHELL, process.env.SHELL, "/bin/bash", "/bin/zsh", "/bin/sh"]
    .filter((shell): shell is string => typeof shell === "string" && shell.length > 0 && existsSync(shell));
  for (const shell of new Set(shells)) {
    // `.zshrc`/.bashrc only load for interactive shells: try that after `-l`.
    for (const flags of [["-lc"], ["-ic"]]) {
      try {
        const output = execFileSync(shell, [...flags, `command -v ${command}`], {
          encoding: "utf8", timeout: timeoutMs, env, stdio: ["ignore", "pipe", "ignore"],
        });
        const found = output.split("\n").map(line => line.trim().replace(/\u001b\[[0-9;]*m/gu, "")).find(line => line.startsWith("/"));
        if (found && isExecutable(found)) return found;
      } catch {
        // Shell missing, timed out or printed nothing: try the next combination.
      }
    }
  }
  return undefined;
}

/**
 * Locate a bare `codex` command for spawning on macOS/Linux.
 *
 * A terminal-launched process inherits the user's PATH, but an app started from
 * Finder or a desktop launcher does not, so `spawn("codex")` fails with ENOENT
 * even though `codex` works in the shell. Look at PATH first, then at the usual
 * install directories, then at what the user's login shell reports.
 */
export function resolveCodexExecutable(command: string, options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  loginShellProbe?: boolean;
  timeoutMs?: number;
} = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" || /[\\/]/.test(command)) return command;
  const env = options.env ?? process.env;
  const key = `${command}\u0000${env.PATH ?? ""}\u0000${env.HOME ?? ""}`;
  const cached = resolved.get(key);
  if (cached) return cached;

  const home = env.HOME || homedir();
  const dirs = [...(env.PATH ?? "").split(delimiter), ...COMMON_BIN_DIRS.map(dir => join(home, dir)),
    "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean);
  let found = dirs.map(dir => join(dir, command)).find(isExecutable);
  if (!found && options.loginShellProbe !== false && platform === process.platform) {
    found = loginShellPath(command, env, options.timeoutMs ?? 5_000);
  }
  const result = found ?? command;
  resolved.set(key, result);
  return result;
}

/** True when a script's shebang needs a `node` on PATH that a GUI launch lacks. */
const nodeShebangCache = new Map<string, boolean>();
function needsNodeInterpreter(path: string): boolean {
  const cached = nodeShebangCache.get(path);
  if (cached !== undefined) return cached;
  let needed = false;
  try {
    const head = readFileSync(path, "utf8").slice(0, 200).split("\n", 1)[0] ?? "";
    needed = head.startsWith("#!") && /\bnode\b/u.test(head);
  } catch {
    needed = false;
  }
  nodeShebangCache.set(path, needed);
  return needed;
}

/**
 * Spawn args for the Codex CLI, with GUI-proof executable resolution.
 *
 * npm's `codex` shim starts with `#!/usr/bin/env node`, so an app launched from
 * Finder — whose PATH has no node — would run it and exit 127 even when the
 * shim itself was found. Run such scripts with our own node instead.
 */
export function codexSpawn(args: string[]): [string, string[]] {
  const [command, argv] = codexInvocation(args);
  const executable = resolveCodexExecutable(command);
  if (process.platform !== "win32" && executable !== process.execPath && needsNodeInterpreter(executable)) {
    return [process.execPath, [executable, ...argv]];
  }
  return [executable, argv];
}
