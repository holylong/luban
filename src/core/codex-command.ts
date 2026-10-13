import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, win32 } from "node:path";

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
