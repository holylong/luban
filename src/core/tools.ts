import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import fg from "fast-glob";
import { terminateProcessTree } from "./process-tree.js";
import { assessShellCommand, defaultSandboxSettings, wrapWithBackend } from "./sandbox.js";
import { codeIntelligenceTool } from "./code-intelligence.js";
import { resolveInside } from "./paths.js";
import { LubanBackend } from "./backend.js";
import { callMcpTool, listMcpTools, searchMcpTools } from "./mcp.js";
import { CheckpointStore } from "./checkpoint.js";
import { createKevTool } from "./kev.js";
import { editPreview } from "./edit-preview.js";
import type { MeshRuntime } from "./mesh/runtime.js";
import type { LubanConfig, ToolDefinition } from "./types.js";

const MAX_OUTPUT = 120_000;
/**
 * Keep the agent responsive when a command is actually a server, watcher, or
 * other long-lived process. This mirrors the short blocking budget used by
 * the other terminal agents; an explicit timeout keeps a finite command in the
 * foreground until it finishes or reaches that timeout.
 */
const AUTO_BACKGROUND_MS = 15_000;

// Windows processes emit text in the active ANSI code page (GBK on zh-CN
// systems, for example), which renders as mojibake when read as raw UTF-8.
// Decode as UTF-8 first; on CJK Windows, retry with the ANSI code page when
// the bytes were not valid UTF-8.
function decodeOutput(buffer: Buffer): string {
  const text = new TextDecoder("utf-8").decode(buffer);
  if (process.platform !== "win32" || !text.includes("\uFFFD")) return text;
  try {
    if (!/^(zh|ja|ko)/iu.test(Intl.DateTimeFormat().resolvedOptions().locale)) return text;
    return new TextDecoder("gbk").decode(buffer);
  } catch {
    return text;
  }
}

export function ptyScriptBinary(): string | null {
  if (process.platform === "win32") return null;
  for (const candidate of ["/usr/bin/script", "/bin/script", "/usr/local/bin/script"]) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // Fall through to the next candidate.
    }
  }
  return null;
}

/** Build a PTY-backed invocation via util-linux/BSD script(1). Null when unsupported. */
export function ptyShellArgs(command: string): { executable: string; args: string[] } | null {
  const script = ptyScriptBinary();
  if (!script) return null;
  // script(1) -c already runs the string through a shell; quoting it again
  // would turn the whole command into a single program name.
  if (process.platform === "darwin") return { executable: script, args: ["-q", "/dev/null", "/bin/bash", "-lc", command] };
  return { executable: script, args: ["-qec", command, "/dev/null"] };
}

function shellCommandArgs(windows: boolean, command: string): string[] {
  if (!windows) return ["-lc", `set -o pipefail\n${command}`];
  // chcp switches the child cmd to UTF-8 so built-ins (ver, dir, …) do not
  // emit code-page bytes; >nul keeps it silent and & preserves exit codes.
  return ["/d", "/s", "/c", `chcp 65001>nul & ${command}`];
}

interface CapturedOutput {
  chunks: Buffer[];
  bytes: number;
}

function capture(stream: NodeJS.ReadableStream, sink: CapturedOutput): void {
  stream.on("data", (chunk: Buffer) => {
    if (sink.bytes >= MAX_OUTPUT * 4) return;
    sink.chunks.push(chunk);
    sink.bytes += chunk.length;
  });
}

function capturedText(sink: CapturedOutput): string {
  return decodeOutput(Buffer.concat(sink.chunks)).replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

interface BackgroundTask {
  id: string;
  command: string;
  status: "running" | "done" | "failed" | "stopping" | "stopped";
  output: CapturedOutput;
  exitCode?: number | null;
  startedAt: string;
  child: ReturnType<typeof spawn>;
}

class BackgroundTasks {
  private readonly tasks = new Map<string, BackgroundTask>();

  adopt(command: string, child: ReturnType<typeof spawn>, output: CapturedOutput, startedAt: string): string {
    const task: BackgroundTask = {
      id: randomUUID(), command, status: "running", output, startedAt, child,
    };
    child.on("error", (error) => { task.output.chunks.push(Buffer.from("\n" + error.message, "utf8")); task.status = "failed"; });
    child.on("close", (code) => {
      task.exitCode = code;
      if (task.status === "stopping") task.status = "stopped";
      else if (task.status === "running") task.status = code === 0 ? "done" : "failed";
    });
    this.tasks.set(task.id, task);
    return task.id;
  }

  start(workspace: string, command: string, signal: AbortSignal, config?: LubanConfig): string {
    signal.throwIfAborted();
    if (config) {
      const blocked = assessShellCommand(command, workspace, config.sandbox ?? defaultSandboxSettings());
      if (blocked) throw new Error(`TOOL ERROR: ${blocked}`);
    }
    if ([...this.tasks.values()].filter((task) => task.status === "running" || task.status === "stopping").length >= 16) throw new Error("background task limit reached (16)");
    const windows = process.platform === "win32";
    const rawExecutable = windows ? (process.env.ComSpec || "cmd.exe") : "/bin/bash";
    const rawArgs = shellCommandArgs(windows, command);
    const wrapped = config ? wrapWithBackend(rawExecutable, rawArgs, workspace, config.sandbox ?? defaultSandboxSettings()) : { executable: rawExecutable, args: rawArgs };
    const child = spawn(wrapped.executable, wrapped.args, { cwd: workspace, env: process.env, windowsHide: true, detached: !windows });
    const task: BackgroundTask = {
      id: randomUUID(), command, status: "running", output: { chunks: [], bytes: 0 }, startedAt: new Date().toISOString(), child,
    };
    capture(child.stdout, task.output);
    capture(child.stderr, task.output);
    child.on("error", (error) => { task.output.chunks.push(Buffer.from(`\n${error.message}`, "utf8")); task.status = "failed"; });
    const abort = () => { this.stop(task.id); };
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      task.exitCode = code;
      if (task.status === "stopping") task.status = "stopped";
      else if (task.status === "running") task.status = code === 0 ? "done" : "failed";
    });
    this.tasks.set(task.id, task);
    signal.addEventListener("abort", abort, { once: true });
    return task.id;
  }

  send(id: string, text: string): string {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`unknown background task: ${id}`);
    if (task.status !== "running") throw new Error(`${id} is ${task.status}; only running tasks accept input`);
    if (!text) throw new Error("input text is empty");
    const payload = text.endsWith("\n") ? text : `${text}\n`;
    const stdin = task.child.stdin;
    if (!stdin || stdin.destroyed) throw new Error(`${id} has no writable stdin`);
    stdin.write(payload);
    return `sent ${payload.length} chars to ${id}`;
  }

  inspect(id: string): string {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`unknown background task: ${id}`);
    return JSON.stringify({
      id: task.id, command: task.command, status: task.status, exit_code: task.exitCode,
      started_at: task.startedAt, output: clipped(capturedText(task.output)),
    }, null, 2);
  }

  stop(id: string): string {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`unknown background task: ${id}`);
    if (task.status !== "running") return `${id} already ${task.status}`;
    task.status = "stopping";
    terminateProcessTree(task.child);
    return `stopping ${id}`;
  }
  close(): void {
    for (const task of this.tasks.values()) if (task.status === "running") this.stop(task.id);
  }
}

function stringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (typeof value !== "string" || (required && !value.trim())) {
    if (required) throw new Error(`missing string argument: ${name}`);
    return "";
  }
  return value;
}

function numberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = Number(args[name]);
  return Number.isFinite(value) ? value : fallback;
}

function clipped(value: string): string {
  if (value.length <= MAX_OUTPUT) return value;
  return `${value.slice(0, MAX_OUTPUT)}\n\n[output truncated: ${value.length - MAX_OUTPUT} chars omitted]`;
}

function htmlToText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}

async function fetchText(url: string, signal: AbortSignal, timeoutSeconds: number): Promise<string> {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("web_fetch only supports http and https URLs");
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason ?? new Error("aborted"));
  const timer = setTimeout(() => controller.abort(new Error(`web request timed out after ${timeoutSeconds}s`)), timeoutSeconds * 1_000);
  signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(parsed, { signal: controller.signal, headers: { "user-agent": "luban/0.3", accept: "text/*, application/json, application/xml;q=0.9, */*;q=0.1" } });
    if (!response.ok) throw new Error(`web HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > 2_000_000) throw new Error(`web response is too large (${declared} bytes)`);
    if (!response.body) throw new Error("web response has no body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) { await reader.cancel(); throw new Error("web response exceeds 2 MB"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const type = response.headers.get("content-type") || "";
    const raw = new TextDecoder().decode(bytes);
    const body = type.includes("html") ? htmlToText(raw) : raw;
    return `URL: ${response.url}\nContent-Type: ${type || "unknown"}\n\n${clipped(body)}`;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}


async function runShell(workspace: string, command: string, signal: AbortSignal, timeoutSeconds: number, config: LubanConfig | undefined, usePty = false, background?: BackgroundTasks, autoBackground = true): Promise<string> {
  signal.throwIfAborted();
  if (config) {
    const blocked = assessShellCommand(command, workspace, config.sandbox ?? defaultSandboxSettings());
    if (blocked) throw new Error(blocked);
  }
  const windows = process.platform === "win32";
  let ptyPrefix: { executable: string; args: string[] } | null = null;
  if (usePty) {
    if (windows) throw new Error("pty mode is not supported on Windows");
    if (config?.sandbox && config.sandbox.backend !== "none") throw new Error("pty mode does not support an OS sandbox backend yet; use backend none");
    ptyPrefix = ptyShellArgs(command);
    if (!ptyPrefix) throw new Error("pty mode needs the script(1) utility, which was not found on PATH");
  }
  const rawExecutable = windows ? (process.env.ComSpec || "cmd.exe") : "/bin/bash";
  const rawArgs = shellCommandArgs(windows, command);
  const wrapped = ptyPrefix ?? (config ? wrapWithBackend(rawExecutable, rawArgs, workspace, config.sandbox ?? defaultSandboxSettings()) : { executable: rawExecutable, args: rawArgs });
  return await new Promise<string>((resolvePromise, reject) => {
    const stdout: CapturedOutput = { chunks: [], bytes: 0 };
    const stderr: CapturedOutput = { chunks: [], bytes: 0 };
    const backgroundOutput: CapturedOutput = { chunks: [], bytes: 0 };
    let settled = false;
    let adopted = false;
    const startedAt = new Date().toISOString();
    const child = spawn(wrapped.executable, wrapped.args, {
      cwd: workspace,
      env: process.env,
      windowsHide: true,
      detached: !windows,
    });
    const finish = (error?: Error, code?: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (autoBackgroundTimer) clearTimeout(autoBackgroundTimer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else {
        const out = capturedText(stdout);
        const err = capturedText(stderr);
        const output = clipped(`${out}${err ? `${out ? "\n" : ""}${err}` : ""}`);
        // A non-zero exit is an ordinary shell signal, not a tool failure:
        // `grep` with no match, `git diff --quiet`, `test -f`, `command -v` and
        // friends all exit non-zero as a matter of course. Rejecting here turned
        // that into "TOOL ERROR" and hid the distinction between "the command
        // ran and returned 1" and "the command could not run at all". The code
        // is reported as data so the model can judge it, matching the
        // [exit code: N] convention the rest of the toolchain uses.
        resolvePromise(code ? `${output}${output ? "\n" : ""}[exit code: ${code}]` : output);
      }
    };
    const terminate = () => terminateProcessTree(child);
    const abort = () => {
      if (adopted) return;
      terminate();
      finish(signal.reason instanceof Error ? signal.reason : new Error("command aborted"));
    };
    const timer = setTimeout(() => {
      if (adopted) return;
      terminate();
      finish(new Error(`command timed out after ${timeoutSeconds}s and was terminated; if it legitimately needs longer, pass a larger timeout or start it with background: true and poll with get_background_task`));
    }, Math.max(1, timeoutSeconds) * 1000);
    const autoBackgroundTimer = autoBackground && background && timeoutSeconds * 1000 > AUTO_BACKGROUND_MS && !isAutoBackgroundExcluded(command)
      ? setTimeout(() => {
        if (settled) return;
        adopted = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        const id = background.adopt(command, child, backgroundOutput, startedAt);
        settled = true;
        resolvePromise("background task " + id + " started after " + AUTO_BACKGROUND_MS / 1000 + "s; use get_background_task with task_id " + id + " to inspect it, or stop_background_task to terminate it");
      }, AUTO_BACKGROUND_MS)
      : undefined;
    signal.addEventListener("abort", abort, { once: true });
    capture(child.stdout, stdout);
    capture(child.stderr, stderr);
    if (background) {
      capture(child.stdout, backgroundOutput);
      capture(child.stderr, backgroundOutput);
    }
    child.on("error", (error) => finish(error));
    child.on("close", (code, terminatedBy) => finish(terminatedBy ? new Error(`command terminated by ${terminatedBy}`) : undefined, code));
  });
}

function isAutoBackgroundExcluded(command: string): boolean {
  const firstToken = command.trim().match(/^(?:env\s+)?(?:command\s+)?([^\s;&|]+)/u)?.[1] ?? "";
  return firstToken === "sleep";
}

async function runProgram(workspace: string, executable: string, args: string[], signal: AbortSignal, input = "", timeoutSeconds = 30): Promise<string> {
  signal.throwIfAborted();
  return await new Promise<string>((resolvePromise, reject) => {
    const stdout: CapturedOutput = { chunks: [], bytes: 0 };
    const stderr: CapturedOutput = { chunks: [], bytes: 0 };
    let settled = false;
    const child = spawn(executable, args, { cwd: workspace, env: process.env, windowsHide: true, detached: process.platform !== "win32" });
    const finish = (error?: Error, code?: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      const output = clipped(`${capturedText(stdout)}${stderr.bytes ? `${stdout.bytes ? "\n" : ""}${capturedText(stderr)}` : ""}`);
      if (error) reject(error);
      else if (code) reject(new Error(`${executable} exited with ${code}${output ? `\n${output}` : ""}`));
      else resolvePromise(output);
    };
    const abort = () => { terminateProcessTree(child); finish(signal.reason instanceof Error ? signal.reason : new Error("aborted")); };
    const timer = setTimeout(() => { terminateProcessTree(child); finish(new Error(`${executable} timed out after ${timeoutSeconds}s`)); }, timeoutSeconds * 1_000);
    signal.addEventListener("abort", abort, { once: true });
    capture(child.stdout, stdout);
    capture(child.stderr, stderr);
    child.on("error", (error) => finish(error));
    child.on("close", (code, terminatedBy) => finish(terminatedBy ? new Error(`command terminated by ${terminatedBy}`) : undefined, code));
    // A short-lived command may exit before stdin.end() reaches its pipe.
    // Empty input needs no delivery; for real input, surface a broken pipe.
    child.stdin.on("error", (error) => { if (input) finish(error); });
    child.stdin.end(input);
  });
}

async function validatePatchPaths(workspace: string, patch: string): Promise<void> {
  if (!patch.trim()) throw new Error("patch is empty");
  const headers = patch.split(/\r?\n/).filter((line) => /^(---|\+\+\+)\s/.test(line));
  if (!headers.length) throw new Error("expected a unified diff with ---/+++ file headers");
  for (const header of headers) {
    let name = header.slice(4).split("\t", 1)[0]!.trim();
    if (name === "/dev/null") continue;
    if ((name.startsWith('"') && name.endsWith('"'))) name = name.slice(1, -1);
    if (name.startsWith("a/") || name.startsWith("b/")) name = name.slice(2);
    if (!name || name.startsWith("/") || /^[A-Za-z]:[\\/]/.test(name)) throw new Error(`unsafe patch path: ${name}`);
    await resolveInside(workspace, name);
  }
}

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

async function discoverSkills(config: LubanConfig): Promise<Map<string, string>> {
  const roots = [
    join(config.workspace, ".luban", "skills"),
    join(config.workspace, ".dagent", "skills"),
    join(config.workspace, ".agents", "skills"),
    join(config.home, "skills"),
  ];
  const found = new Map<string, string>();
  for (const root of roots) {
    const files = await fg("*/SKILL.md", { cwd: root, absolute: true, onlyFiles: true, suppressErrors: true });
    for (const file of files.sort()) found.set(basename(dirname(file)), file);
  }
  return found;
}

export function createTools(config: LubanConfig, mesh?: MeshRuntime): Map<string, ToolDefinition> {
  const workspace = config.workspace;
  const background = new BackgroundTasks();
  const checkpoints = new CheckpointStore(config);
  const tools: ToolDefinition[] = [
    codeIntelligenceTool(workspace, config),
    {
      name: "read_file",
      description: "Read a UTF-8 text file in the workspace, optionally by line range.",
      risk: "read",
      parallelSafe: true,
      parameters: schema({
        path: { type: "string", description: "Workspace-relative path" },
        offset: { type: "integer", minimum: 1, description: "First line, 1-based" },
        limit: { type: "integer", minimum: 1, maximum: 4000 },
      }, ["path"]),
      async execute(args) {
        const path = await resolveInside(workspace, stringArg(args, "path"));
        const info = await stat(path);
        if (info.size > 2_000_000) throw new Error(`file is too large (${info.size} bytes)`);
        // Do not decode binary assets as UTF-8; PNG screenshots otherwise flood
        // the model context and the TUI with unreadable bytes.
        if (/\.(?:png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|wasm)$/iu.test(path)) {
          return `[binary file omitted: ${relative(workspace, path)} (${info.size} bytes)]`;
        }
        const lines = (await readFile(path, "utf8")).split("\n");
        const offset = Math.max(1, numberArg(args, "offset", 1));
        const limit = Math.min(4000, Math.max(1, numberArg(args, "limit", 400)));
        return lines.slice(offset - 1, offset - 1 + limit)
          .map((line, index) => `${String(offset + index).padStart(5)} | ${line}`).join("\n");
      },
    },
    {
      name: "list_dir",
      description: "List files and directories in a workspace directory.",
      risk: "read",
      parallelSafe: true,
      parameters: schema({ path: { type: "string", description: "Directory, defaults to workspace root" } }),
      async execute(args) {
        const path = await resolveInside(workspace, stringArg(args, "path", false) || ".");
        const entries = await readdir(path, { withFileTypes: true });
        return entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((entry) => `${entry.isDirectory() ? "d" : "f"}  ${entry.name}${entry.isDirectory() ? "/" : ""}`).join("\n");
      },
    },
    {
      name: "glob_files",
      description: "Find workspace files with glob patterns.",
      risk: "read",
      parallelSafe: true,
      parameters: schema({ pattern: { type: "string", description: "Glob such as src/**/*.ts" } }, ["pattern"]),
      async execute(args) {
        const matches = await fg(stringArg(args, "pattern"), {
          cwd: workspace,
          onlyFiles: true,
          dot: false,
          unique: true,
          // Do not traverse symlinks: one pointing at a tool cache or at the
          // filesystem root turns a scoped lookup into a whole-disk walk that
          // ends in an EACCES on root-owned directories.
          followSymbolicLinks: false,
          suppressErrors: true,
          ignore: ["**/.git/**", "**/node_modules/**", "**/.luban/**", "**/.dagent/**", "**/dist/**"],
        });
        return matches.slice(0, 2000).join("\n") || "(no matches)";
      },
    },
    {
      name: "grep_files",
      description: "Search text across workspace files using a regular expression.",
      risk: "read",
      parallelSafe: true,
      parameters: schema({
        pattern: { type: "string", description: "JavaScript regular expression" },
        glob: { type: "string", description: "Optional file glob" },
      }, ["pattern"]),
      async execute(args) {
        const expression = new RegExp(stringArg(args, "pattern"), "i");
        const files = await fg(stringArg(args, "glob", false) || "**/*", {
          cwd: workspace,
          onlyFiles: true,
          dot: false,
          followSymbolicLinks: false,
          suppressErrors: true,
          ignore: ["**/.git/**", "**/node_modules/**", "**/.luban/**", "**/.dagent/**", "**/dist/**", "**/*.lock"],
        });
        const matches: string[] = [];
        for (const file of files) {
          if (matches.length >= 1000) break;
          const path = await resolveInside(workspace, file);
          let info;
          try { info = await lstat(path); } catch { continue; }
          if (!info.isFile() || info.size > 1_000_000) continue;
          let lines: string[];
          try { lines = (await readFile(path, "utf8")).split("\n"); } catch { continue; }
          lines.forEach((line, index) => { if (expression.test(line)) matches.push(`${file}:${index + 1}:${line.slice(0, 500)}`); });
        }
        return matches.join("\n") || "(no matches)";
      },
    },
    {
      name: "write_file",
      description: "Create or replace a UTF-8 file in the workspace.",
      risk: "write",
      parameters: schema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
      async execute(args) {
        const path = await resolveInside(workspace, stringArg(args, "path"));
        const content = stringArg(args, "content", false);
        const before = await readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
        await mkdir(resolve(path, ".."), { recursive: true });
        await writeFile(path, content, "utf8");
        return editPreview(relative(workspace, path), before, content);
      },
    },
    {
      name: "edit_file",
      description: "Replace one exact occurrence in a UTF-8 file.",
      risk: "write",
      parameters: schema({ path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, ["path", "old_text", "new_text"]),
      async execute(args) {
        const path = await resolveInside(workspace, stringArg(args, "path"));
        const oldText = stringArg(args, "old_text");
        const newText = stringArg(args, "new_text", false);
        const source = await readFile(path, "utf8");
        const first = source.indexOf(oldText);
        if (first < 0) throw new Error("old_text was not found");
        if (source.indexOf(oldText, first + oldText.length) >= 0) throw new Error("old_text is not unique; include more context");
        const updated = `${source.slice(0, first)}${newText}${source.slice(first + oldText.length)}`;
        await writeFile(path, updated, "utf8");
        return editPreview(relative(workspace, path), source, updated);
      },
    },
    {
      name: "bash",
      close: () => background.close(),
      description: "Run a shell command in the workspace. Git works from a nested workspace; do not cd to the repo parent. Omit timeout to detach after 15s; set timeout to wait for a finite build/test; background: true detaches now.",
      risk: "execute",
      parameters: schema({
        command: { type: "string" },
        timeout: { type: "integer", minimum: 1, maximum: 600 },
        background: { type: "boolean", description: "Return a task id immediately" },
        pty: { type: "boolean", description: "Run under a real PTY via script(1) so curses/progress output and tty detection work. Foreground only." },
      }, ["command"]),
      async execute(args, signal) {
        if (args.background === true) {
          if (args.pty === true) throw new Error("pty mode is foreground-only; use send_background_input for interactive background tasks");
          const id = background.start(workspace, stringArg(args, "command"), signal, config);
          return Promise.resolve(`background task ${id} started`);
        }
        return runShell(workspace, stringArg(args, "command"), signal, Math.min(600, numberArg(args, "timeout", 120)), config, args.pty === true, background, args.timeout === undefined);
      },
    },
    {
      name: "get_background_task",
      description: "Get status and accumulated output for a background shell task.",
      risk: "read",
      parallelSafe: true,
      parameters: schema({ task_id: { type: "string" } }, ["task_id"]),
      async execute(args) { return background.inspect(stringArg(args, "task_id")); },
    },
    {
      name: "stop_background_task",
      description: "Terminate a running background shell task.",
      risk: "execute",
      parameters: schema({ task_id: { type: "string" } }, ["task_id"]),
      async execute(args) { return background.stop(stringArg(args, "task_id")); },
    },
    {
      name: "send_background_input",
      description: "Write stdin to a running background shell task (interactive CLIs, REPLs, prompts). Appends a newline when missing.",
      risk: "execute",
      parameters: schema({ task_id: { type: "string" }, input: { type: "string", description: "Text to write to stdin" } }, ["task_id", "input"]),
      async execute(args) { return background.send(stringArg(args, "task_id"), stringArg(args, "input")); },
    },
    {
      name: "apply_patch",
      description: "Apply a unified diff inside the workspace. Prefer this for multi-file or structured edits.",
      risk: "write",
      parameters: schema({ patch: { type: "string", description: "Unified diff using a/ and b/ paths" } }, ["patch"]),
      async execute(args, signal) {
        const patch = stringArg(args, "patch");
        await validatePatchPaths(workspace, patch);
        const paths = [...new Set(patch.split(/\r?\n/).filter(line => /^(---|\+\+\+) /.test(line)).map(line => line.slice(4).split("\t")[0]!.trim().replace(/^"|"$/g, "").replace(/^[ab]\//, "")).filter(path => path !== "/dev/null"))];
        const before = new Map<string, string>();
        for (const path of paths) before.set(path, await readFile(await resolveInside(workspace, path), "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; }));
        await runProgram(workspace, "git", ["apply", "--check", "--whitespace=nowarn", "-"], signal, patch);
        await runProgram(workspace, "git", ["apply", "--whitespace=nowarn", "-"], signal, patch);
        const files = patch.split(/\r?\n/).filter((line) => line.startsWith("+++ ")).map((line) => line.slice(4).trim()).filter((line) => line !== "/dev/null");
        const previews: string[] = [];
        for (const path of paths) {
          const after = await readFile(await resolveInside(workspace, path), "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
          previews.push(editPreview(path, before.get(path)!, after));
        }
        return previews.join("\n\n") + `\nApplied patch to ${files.length} file${files.length === 1 ? "" : "s"}`;
      },
    },
    {
      name: "git_context",
      description: "Inspect repository status and the current working diff without requiring shell permission.",
      risk: "read",
      parallelSafe: true,
      parameters: schema({ staged: { type: "boolean", description: "Show staged diff instead of unstaged diff" } }),
      async execute(args, signal) {
        const status = await runProgram(workspace, "git", ["status", "--short"], signal);
        const diffArgs = ["diff", "--no-ext-diff", "--stat", "--patch", ...(args.staged === true ? ["--cached"] : [])];
        const diff = await runProgram(workspace, "git", diffArgs, signal);
        return clipped(`STATUS\n${status || "(clean)"}\n\nDIFF\n${diff || "(no diff)"}`);
      },
    },
    {
      name: "git_publish",
      description: "For an explicit request to commit and push this repository: stage all non-ignored changes, create one commit if needed, and push the current branch to its configured upstream. One approval covers the workflow. Never use for a request that only asks to inspect or edit code.",
      risk: "execute",
      parameters: schema({ message: { type: "string", description: "Short commit message describing the actual changes" } }, ["message"]),
      async execute(args, signal) {
        const message = stringArg(args, "message").trim();
        if (!message || message.length > 200 || /[\r\n]/u.test(message)) throw new Error("commit message must be one line of at most 200 characters");
        const root = (await runProgram(workspace, "git", ["rev-parse", "--show-toplevel"], signal)).trim();
        if (resolve(root) !== resolve(workspace)) throw new Error("git_publish requires the workspace to be the repository root");
        // `git rev-parse @{upstream}` exits non-zero when none is configured,
        // and runProgram rejects with git's stderr, which is localized. Catch
        // it here so the user always gets this clear message instead of a
        // locale-dependent "fatal: ..." leaking out as the tool error.
        let upstream = "";
        try {
          upstream = (await runProgram(workspace, "git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], signal)).trim();
        } catch {
          upstream = "";
        }
        if (!upstream || upstream === "HEAD") throw new Error("current branch has no configured upstream; set one with: git push --set-upstream origin <branch>");
        await runProgram(workspace, "git", ["add", "-A", "--", "."], signal);
        const staged = (await runProgram(workspace, "git", ["diff", "--cached", "--name-status"], signal)).trim();
        let commit = "No new commit (working tree has no staged changes).";
        if (staged) {
          await runProgram(workspace, "git", ["commit", "-m", message], signal, "", 120);
          commit = (await runProgram(workspace, "git", ["log", "-1", "--format=%h %s"], signal)).trim();
        }
        const pushed = await runProgram(workspace, "git", ["push"], signal, "", 120);
        const status = (await runProgram(workspace, "git", ["status", "--short", "--branch"], signal)).trim();
        return clipped(`Upstream: ${upstream}\nStaged files:\n${staged || "(none)"}\nCommit: ${commit}\nPush: ${pushed || "completed"}\nStatus: ${status}`);
      },
    },
    {
      name: "create_checkpoint",
      description: "Save a recoverable snapshot of Git working-tree changes and untracked files before broad edits. Does not create a commit.",
      risk: "write",
      parameters: schema({}),
      async execute() { return `created checkpoint ${await checkpoints.create()}`; },
    },
    {
      name: "restore_checkpoint",
      description: "Restore a checkpoint, discarding working-tree changes made after it. Refuses if repository HEAD changed.",
      risk: "write",
      parameters: schema({ checkpoint_id: { type: "string" } }, ["checkpoint_id"]),
      execute(args) { return checkpoints.restore(stringArg(args, "checkpoint_id")); },
    },
    {
      name: "list_skills",
      description: "List reusable agent skills installed for this user or workspace.",
      risk: "read",
      parallelSafe: true,
      parameters: schema({}),
      async execute() {
        const skills = await discoverSkills(config);
        return skills.size ? [...skills.keys()].sort().join("\n") : "(no skills installed)";
      },
    },
    {
      name: "read_skill",
      description: "Load the complete SKILL.md instructions for one installed skill before applying it.",
      risk: "read",
      parallelSafe: true,
      parameters: schema({ name: { type: "string", description: "Exact skill name from list_skills" } }, ["name"]),
      async execute(args) {
        const name = stringArg(args, "name");
        const skills = await discoverSkills(config);
        const path = skills.get(name);
        if (!path) throw new Error(`unknown skill: ${name}`);
        const content = await readFile(path, "utf8");
        if (content.length > 200_000) throw new Error(`skill is too large (${content.length} chars)`);
        return `Skill: ${name}\nSource: ${path}\n\n${content}`;
      },
    },
    {
      name: "mcp_list_tools",
      description: "Start configured MCP servers and list the external tools they provide. Use before mcp_call when an external integration may help.",
      risk: "execute",
      parameters: schema({}),
      execute(_args, signal) {
        return listMcpTools(config, signal);
      },
    },
    {
      name: "mcp_search_tools",
      description: "Search configured MCP tools by keyword without registering every schema. Returns matching server/tool names with descriptions; call mcp_call with the exact names.",
      risk: "read",
      parallelSafe: true,
      parameters: schema({ query: { type: "string", description: "Keyword, e.g. filesystem, browser, linear" }, limit: { type: "integer", minimum: 1, maximum: 50 } }),
      execute(args, signal) {
        const query = typeof args.query === "string" ? args.query : "";
        const limit = Math.max(1, Math.min(50, Number(args.limit ?? 20) || 20));
        return searchMcpTools(config, query, limit, signal);
      },
    },
    {
      name: "read_image",
      description: "Inspect a local image for model input. Reports size and vision capability. To actually see the image, ask the user to @-attach the file path; TUI attachments are sent as native vision parts to vision-capable models.",
      risk: "read",
      parallelSafe: true,
      parameters: schema({ path: { type: "string", description: "Workspace-relative image path" } }, ["path"]),
      async execute(args) {
        const path = await resolveInside(workspace, stringArg(args, "path"));
        if (!/\.(?:png|jpe?g|gif|webp|bmp|ico|avif)$/iu.test(path)) throw new Error("read_image supports png/jpg/gif/webp/bmp/ico/avif");
        const info = await stat(path);
        if (info.size > 8_000_000) throw new Error(`image is too large (${info.size} bytes, max 8 MB)`);
        const vision = config.model.capabilities?.vision === true;
        return JSON.stringify({
          path: relative(workspace, path),
          bytes: info.size,
          vision_capable_model: vision,
          model: config.model.id,
          note: vision
            ? "Model declares vision support. This runtime keeps image bytes out of text context; use web/desktop clients for inline images, or describe the needed region and read surrounding code instead."
            : `Model ${config.model.id} does not declare vision support. Describe the image content in text or switch to a vision-capable model.`,
        }, null, 2);
      },
    },
    {
      name: "mcp_call",
      description: "Invoke a tool on a configured MCP server after discovering its exact name and schema with mcp_list_tools.",
      risk: "network",
      parameters: schema({
        server: { type: "string" },
        tool: { type: "string" },
        arguments: { type: "object", additionalProperties: true },
      }, ["server", "tool", "arguments"]),
      execute(args, signal) {
        const input = args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments) ? args.arguments as Record<string, unknown> : {};
        return callMcpTool(config, stringArg(args, "server"), stringArg(args, "tool"), input, signal);
      },
    },
    {
      name: "web_fetch",
      description: "Fetch an HTTP(S) page or text resource. HTML is converted to readable text and responses are capped at 2 MB.",
      risk: "network",
      parameters: schema({
        url: { type: "string" },
        timeout: { type: "integer", minimum: 1, maximum: 120 },
      }, ["url"]),
      execute(args, signal) {
        return fetchText(stringArg(args, "url"), signal, Math.min(120, Math.max(1, numberArg(args, "timeout", 30))));
      },
    },
  ];

  // Kev is opt-in: the advisor tool only exists in "kev" mode with a server URL.
  if (config.kev?.mode === "kev" && config.kev.url?.trim()) tools.push(createKevTool(config.kev));

  if (mesh) {
    tools.push(
      {
        name: "mesh_get_peers",
        description: "List LAN luban peers, their addresses, capabilities, and current reachability.",
        risk: "read",
        parameters: schema({}),
        async execute() {
          return JSON.stringify(mesh.peers().map((peer) => ({
            name: peer.name,
            address: `${peer.host}:${peer.port}`,
            udp_port: peer.udpPort,
            online: peer.online,
            capabilities: peer.capabilities,
            note: peer.note,
          })), null, 2);
        },
      },
      {
        name: "mesh_ping",
        description: "Check whether a named luban mesh peer is reachable.",
        risk: "network",
        parameters: schema({ peer: { type: "string" } }, ["peer"]),
        execute(args, signal) {
          return mesh.ping(stringArg(args, "peer"), signal);
        },
      },
      {
        name: "mesh_get_status",
        description: "Inspect a peer's worker pool and active remote jobs.",
        risk: "network",
        parameters: schema({ peer: { type: "string" } }, ["peer"]),
        async execute(args, signal) {
          return JSON.stringify(await mesh.status(stringArg(args, "peer"), signal), null, 2);
        },
      },
      {
        name: "mesh_message",
        description: "Send a short human-readable message to a luban mesh peer.",
        risk: "network",
        parameters: schema({ peer: { type: "string" }, message: { type: "string" } }, ["peer", "message"]),
        execute(args, signal) {
          return mesh.message(stringArg(args, "peer"), stringArg(args, "message"), signal);
        },
      },
      {
        name: "mesh_handoff",
        description: "Delegate a coding task to one peer and wait for its durable remote job result. Sync the project first when the peer lacks context.",
        risk: "network",
        parameters: schema({
          peer: { type: "string" },
          instruction: { type: "string" },
          project_id: { type: "string" },
          timeout: { type: "integer", minimum: 30, maximum: 3600 },
        }, ["peer", "instruction"]),
        execute(args, signal) {
          return mesh.handoff(
            stringArg(args, "peer"),
            stringArg(args, "instruction"),
            stringArg(args, "project_id", false) || config.project,
            Math.min(3600, Math.max(30, numberArg(args, "timeout", 300))),
            signal,
          );
        },
      },
      {
        name: "mesh_ask_all",
        description: "Broadcast one task to every known mesh peer and collect all results.",
        risk: "network",
        parameters: schema({
          instruction: { type: "string" },
          project_id: { type: "string" },
          timeout: { type: "integer", minimum: 30, maximum: 3600 },
        }, ["instruction"]),
        execute(args, signal) {
          return mesh.askAll(
            stringArg(args, "instruction"),
            stringArg(args, "project_id", false) || config.project,
            Math.min(3600, Math.max(30, numberArg(args, "timeout", 120))),
            signal,
          );
        },
      },
      {
        name: "mesh_sync_push",
        description: "Synchronize the current project workspace to a peer using git or verified file chunks.",
        risk: "network",
        parameters: schema({ peer: { type: "string" }, project_id: { type: "string" }, mode: { type: "string", enum: ["auto", "git", "chunk"] } }, ["peer"]),
        execute(args, signal) {
          const mode = stringArg(args, "mode", false) || config.mesh.syncMode;
          return mesh.syncPush(stringArg(args, "peer"), stringArg(args, "project_id", false) || config.project, config.workspace, mode as "auto" | "git" | "chunk", signal);
        },
      },
      {
        name: "mesh_sync_pull",
        description: "Pull a peer's project into the current workspace with conflict detection and verified chunks.",
        risk: "write",
        parameters: schema({ peer: { type: "string" }, project_id: { type: "string" }, mode: { type: "string", enum: ["auto", "git", "chunk"] } }, ["peer"]),
        execute(args, signal) {
          const mode = stringArg(args, "mode", false) || config.mesh.syncMode;
          return mesh.syncPull(stringArg(args, "peer"), stringArg(args, "project_id", false) || config.project, config.workspace, mode as "auto" | "git" | "chunk", signal);
        },
      },
      {
        name: "mesh_get_jobs",
        description: "List recent local jobs received from or submitted through the luban mesh.",
        risk: "read",
        parameters: schema({ limit: { type: "integer", minimum: 1, maximum: 200 } }),
        async execute(args) {
          return JSON.stringify(await mesh.jobs(Math.min(200, Math.max(1, numberArg(args, "limit", 30)))), null, 2);
        },
      },
      {
        name: "mesh_cancel_job",
        description: "Cancel an active local mesh job by id.",
        risk: "execute",
        parameters: schema({ job_id: { type: "string" } }, ["job_id"]),
        async execute(args) {
          const id = stringArg(args, "job_id");
          return await mesh.cancelLocalJob(id) ? `cancelled ${id}` : `${id} is not active`;
        },
      },
      {
        name: "mesh_resume_job",
        description: "Resume a paused job from saved history. Set peer for a remote job; omit peer for a local job. Returns a queued job id; use mesh_poll_job to observe it.",
        risk: "execute",
        parameters: schema({ job_id: { type: "string" }, peer: { type: "string" } }, ["job_id"]),
        async execute(args, signal) {
          const id = stringArg(args, "job_id");
          return args.peer ? mesh.resumeRemoteJob(stringArg(args, "peer"), id, signal) : JSON.stringify(await mesh.resumeLocalJob(id));
        },
      },
      {
        name: "mesh_poll_job",
        description: "Read a local or remote job's status and result without waiting for completion.",
        risk: "network",
        parameters: schema({ job_id: { type: "string" }, peer: { type: "string" } }, ["job_id"]),
        async execute(args, signal) {
          const id = stringArg(args, "job_id");
          const job = args.peer ? await mesh.rpc(stringArg(args, "peer"), "job_poll", { job_id: id }, 15_000, signal) : await mesh.store.get(id);
          if (!job) throw new Error(`unknown job: ${id}`);
          return JSON.stringify(job);
        },
      },
    );
  }

  if (config.backendUrl) {
    const backend = new LubanBackend(config.backendUrl);
    tools.push(
      {
        name: "luban_peers",
        description: "List machines connected to the existing luban mesh backend.",
        risk: "network",
        parameters: schema({}),
        async execute() {
          const peers = await backend.peers();
          return JSON.stringify(peers.map((peer) => ({
            name: peer.name,
            address: `${peer.host}:${peer.port}`,
            online: Date.now() / 1000 - (peer.last_seen || 0) < 25,
            capabilities: peer.capabilities || [],
          })), null, 2);
        },
      },
      {
        name: "luban_submit",
        description: "Submit a long-running task to the existing luban backend and wait for its result.",
        risk: "network",
        parameters: schema({ instruction: { type: "string" }, project_id: { type: "string" } }, ["instruction"]),
        async execute(args, signal) {
          const id = await backend.submit(stringArg(args, "instruction"), stringArg(args, "project_id", false) || config.project);
          try {
            const job = await backend.wait(id, signal);
            if (job.status !== "done") throw new Error(job.error || `remote job ${job.status}`);
            return `job ${id} completed\n${job.result || "(no result)"}`;
          } catch (error) {
            if (signal.aborted) await backend.cancel(id).catch(() => undefined);
            throw error;
          }
        },
      },
    );
  }

  return new Map(tools.map((tool) => [tool.name, tool]));
}

export function openAiToolSchemas(tools: Map<string, ToolDefinition>): Array<Record<string, unknown>> {
  return [...tools.values()].map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

export function summarizeToolArgs(name: string, args: Record<string, unknown>): string {
  const keys = name === "bash" ? ["command"] : ["path", "pattern", "peer", "instruction", "project_id", "job_id"];
  const parts = keys.flatMap((key) => args[key] === undefined ? [] : [`${key === "command" ? "" : `${key}=`}${String(args[key]).replace(/\s+/g, " ")}`]);
  return (parts.join(" · ") || JSON.stringify(args)).slice(0, 180);
}
